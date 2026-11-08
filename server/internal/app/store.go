package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	_ "modernc.org/sqlite"
	"stocksim/server/internal/market"
)

type Config struct {
	DBPath, Seed, StaticDir, PublicOrigin string
	SecureCookies                         bool
	HistoryDays                           *int
	Now                                   func() time.Time
}
type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	Role      string `json:"role"`
	Banned    bool   `json:"banned"`
	CreatedAt string `json:"createdAt"`
}
type MarketMeta struct {
	Revision int64  `json:"revision"`
	Running  bool   `json:"running"`
	Speed    int    `json:"speed"`
	SavedAt  string `json:"savedAt"`
}
type runtimeState struct {
	MarketMeta
	PhaseWait int `json:"phaseWait"`
}
type SnapshotResponse struct {
	UserID   string                `json:"userId"`
	Snapshot market.MarketSnapshot `json:"snapshot"`
	Market   MarketMeta            `json:"market"`
}
type commandResponse struct {
	SnapshotResponse
	Result market.CommandResult `json:"result"`
}
type subscription struct {
	userID, sessionHash string
	expires             int64
	updates             chan []byte
	done                chan struct{}
}
type rateBucket struct {
	count int
	reset time.Time
}
type App struct {
	mu               sync.Mutex
	db               *sql.DB
	engine           *market.Engine
	runtime          runtimeState
	registrationOpen bool
	config           Config
	subs             map[*subscription]struct{}
	limits           map[string]rateBucket
	kdf              chan struct{}
	closed           bool
}

const schema = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('admin','user')),banned INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_administrator ON users(role) WHERE role='admin';
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS market_state(id INTEGER PRIMARY KEY CHECK(id=1),payload BLOB NOT NULL,runtime BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),registration_open INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency(user_id TEXT NOT NULL REFERENCES users(id),key TEXT NOT NULL,body_hash TEXT NOT NULL,status INTEGER NOT NULL,response BLOB NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,key));
`

// Serializing startup also prevents a newly created raw file descriptor from
// closing after another App in this process has already acquired SQLite's lock.
var databaseOpenMu sync.Mutex

func New(config Config) (*App, error) {
	databaseOpenMu.Lock()
	defer databaseOpenMu.Unlock()
	if config.DBPath == "" {
		config.DBPath = "data/stocksim.db"
	}
	if config.Seed == "" {
		config.Seed = "stock-sim-2026"
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.DBPath != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(config.DBPath), 0700); err != nil {
			return nil, err
		}
		// Never open and close an existing SQLite file outside its driver: POSIX
		// close() can release this process's locks held by another live App.
		file, createErr := os.OpenFile(config.DBPath, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
		if createErr == nil {
			if err := file.Close(); err != nil {
				return nil, err
			}
		} else if !errors.Is(createErr, os.ErrExist) {
			return nil, createErr
		}
		if err := os.Chmod(config.DBPath, 0600); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", config.DBPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	fail := func(err error) (*App, error) { db.Close(); return nil, err }
	// The live engine is the only writer, including across processes. Set EXCLUSIVE
	// before the first WAL access so SQLite retains an OS-backed lock until Close.
	// The single pooled connection must remain open for the whole App lifetime.
	var lockingMode string
	if err = db.QueryRow("PRAGMA locking_mode=EXCLUSIVE").Scan(&lockingMode); err != nil {
		return fail(err)
	}
	if lockingMode != "exclusive" {
		return fail(errors.New("无法取得市场数据库独占模式"))
	}
	for _, p := range []string{"PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000", "PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL"} {
		if _, err = db.Exec(p); err != nil {
			return fail(fmt.Errorf("无法独占市场数据库（同一数据库只能运行一个服务）: %w", err))
		}
	}
	if _, err = db.Exec(schema); err != nil {
		return fail(err)
	}
	a := &App{db: db, config: config, registrationOpen: true, subs: map[*subscription]struct{}{}, limits: map[string]rateBucket{}, kdf: make(chan struct{}, 2)}
	var payload, run []byte
	err = db.QueryRow("SELECT payload,runtime FROM market_state WHERE id=1").Scan(&payload, &run)
	if errors.Is(err, sql.ErrNoRows) {
		var users int
		if err = db.QueryRow("SELECT COUNT(*) FROM users").Scan(&users); err != nil {
			return fail(err)
		}
		if users != 0 {
			return fail(errors.New("市场存档缺失，拒绝覆盖已有账户"))
		}
		a.engine, err = market.New(market.Options{Seed: config.Seed, HistoryDays: config.HistoryDays})
		if err != nil {
			return fail(err)
		}
		a.runtime = runtimeState{MarketMeta: MarketMeta{Revision: 1, Speed: 1, SavedAt: a.now().Format(time.RFC3339Nano)}}
		payload, err = a.engine.Export()
		if err != nil {
			return fail(err)
		}
		run, _ = json.Marshal(a.runtime)
		tx, e := db.Begin()
		if e != nil {
			return fail(e)
		}
		if _, e = tx.Exec("INSERT INTO market_state(id,payload,runtime) VALUES(1,?,?)", payload, run); e == nil {
			_, e = tx.Exec("INSERT INTO settings(id,registration_open) VALUES(1,1)")
		}
		if e != nil {
			tx.Rollback()
			return fail(e)
		}
		if e = tx.Commit(); e != nil {
			return fail(e)
		}
	} else if err != nil {
		return fail(err)
	} else {
		a.engine, err = market.Restore(payload)
		if err != nil {
			return fail(fmt.Errorf("市场存档恢复失败: %w", err))
		}
		if err = json.Unmarshal(run, &a.runtime); err != nil {
			return fail(err)
		}
		if a.runtime.Revision < 1 || !validSpeed(a.runtime.Speed) || a.runtime.PhaseWait < 0 || a.runtime.PhaseWait > 5 {
			return fail(errors.New("市场运行配置损坏"))
		}
		if err = db.QueryRow("SELECT registration_open FROM settings WHERE id=1").Scan(&a.registrationOpen); err != nil {
			return fail(err)
		}
	}
	rows, err := db.Query("SELECT id FROM users ORDER BY created_at,id")
	if err != nil {
		return fail(err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return fail(err)
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fail(err)
	}
	players := a.engine.PlayerIDs()
	sort.Strings(ids)
	sort.Strings(players)
	if len(ids) != len(players) {
		return fail(errors.New("账户与市场玩家数量不一致"))
	}
	for i := range ids {
		if ids[i] != players[i] {
			return fail(errors.New("账户与市场玩家不一致"))
		}
	}
	// Restore can upgrade private engine state. Commit that candidate only after
	// all runtime configuration and user/player mappings have passed validation,
	// even if the market is paused and no future tick will trigger a save.
	normalized, err := a.engine.Export()
	if err != nil {
		return fail(err)
	}
	if !bytes.Equal(payload, normalized) {
		migratedRuntime := a.nextRuntime()
		tx, migrationErr := db.Begin()
		if migrationErr != nil {
			return fail(migrationErr)
		}
		if migrationErr = a.saveCandidate(tx, a.engine, migratedRuntime); migrationErr == nil {
			_, migrationErr = tx.Exec("DELETE FROM sessions WHERE expires_at <= ?", a.now().Unix())
		}
		if migrationErr == nil {
			migrationErr = tx.Commit()
		}
		if migrationErr != nil {
			tx.Rollback()
			return fail(fmt.Errorf("市场存档升级保存失败: %w", migrationErr))
		}
		a.runtime = migratedRuntime
	} else if _, err = db.Exec("DELETE FROM sessions WHERE expires_at <= ?", a.now().Unix()); err != nil {
		return fail(err)
	}
	return a, nil
}
func (a *App) now() time.Time { return a.config.Now().UTC() }
func validSpeed(s int) bool   { return s == 1 || s == 4 || s == 16 || s == 64 }
func (a *App) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil
	}
	a.closed = true
	for s := range a.subs {
		close(s.done)
		delete(a.subs, s)
	}
	return a.db.Close()
}
func (a *App) saveCandidate(tx *sql.Tx, e *market.Engine, run runtimeState) error {
	payload, err := e.Export()
	if err != nil {
		return err
	}
	b, err := json.Marshal(run)
	if err != nil {
		return err
	}
	_, err = tx.Exec("UPDATE market_state SET payload=?,runtime=? WHERE id=1", payload, b)
	return err
}
func (a *App) nextRuntime() runtimeState {
	v := a.runtime
	v.Revision++
	v.SavedAt = a.now().Format(time.RFC3339Nano)
	return v
}
func (a *App) snapshot(e *market.Engine, userID string, meta MarketMeta) (SnapshotResponse, error) {
	s, err := e.Snapshot(userID)
	if err != nil {
		return SnapshotResponse{}, err
	}
	s.Review.Points = make([]market.EquityPoint, 0)
	return SnapshotResponse{UserID: userID, Snapshot: s, Market: meta}, nil
}
func (a *App) broadcast() {
	cache := map[string][]byte{}
	for s := range a.subs {
		if s.expires <= a.now().Unix() {
			close(s.done)
			delete(a.subs, s)
			continue
		}
		b, ok := cache[s.userID]
		if !ok {
			snap, err := a.snapshot(a.engine, s.userID, a.runtime.MarketMeta)
			if err != nil {
				continue
			}
			b, _ = json.Marshal(snap)
			cache[s.userID] = b
		}
		select {
		case s.updates <- b:
		default:
			select {
			case <-s.updates:
			default:
			}
			select {
			case s.updates <- b:
			default:
			}
		}
	}
}
func (a *App) closeSessions(userID, hash string) {
	for s := range a.subs {
		if (userID != "" && s.userID == userID) || (hash != "" && s.sessionHash == hash) {
			close(s.done)
			delete(a.subs, s)
		}
	}
}
func (a *App) Tick() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || !a.runtime.Running {
		return nil
	}
	candidate, err := a.engine.Clone()
	if err != nil {
		return err
	}
	run := a.nextRuntime()
	phase := candidate.Clock().Phase
	switch phase {
	case "lunch":
		run.PhaseWait++
		if run.PhaseWait >= 3 {
			candidate.SkipLunch()
			run.PhaseWait = 0
		}
	case "closed":
		run.PhaseWait++
		if run.PhaseWait >= 5 {
			candidate.NextDay()
			run.PhaseWait = 0
		}
	default:
		run.PhaseWait = 0
		if err = candidate.Step(run.Speed); err != nil {
			return err
		}
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = a.saveCandidate(tx, candidate, run); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	a.engine = candidate
	a.runtime = run
	a.broadcast()
	return nil
}
func (a *App) Run(ctx context.Context, onError func(error)) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.Tick(); err != nil && onError != nil {
				onError(err)
			}
		}
	}
}
