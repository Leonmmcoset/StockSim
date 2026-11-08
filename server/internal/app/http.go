package app

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"stocksim/server/internal/market"
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func apiError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
func storageError(w http.ResponseWriter) {
	apiError(w, 503, "服务器存档暂不可用，操作未提交，请稍后使用原请求重试")
}
func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		apiError(w, 400, "请求 JSON 超过 16KiB 或读取失败")
		return false
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		apiError(w, 400, "请求必须为 JSON 对象")
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		apiError(w, 400, "请求 JSON 无效、包含未知字段或超过 16KiB")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		apiError(w, 400, "请求只能包含一个 JSON 对象")
		return false
	}
	return true
}
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/session", a.handleSession)
	mux.HandleFunc("POST /api/register", func(w http.ResponseWriter, r *http.Request) { a.handleCredentials(w, r, true) })
	mux.HandleFunc("POST /api/login", func(w http.ResponseWriter, r *http.Request) { a.handleCredentials(w, r, false) })
	mux.HandleFunc("POST /api/logout", a.logout)
	mux.HandleFunc("GET /api/snapshot", func(w http.ResponseWriter, r *http.Request) {
		a.withSession(w, r, true, false, func(id identity) {
			s, err := a.snapshot(a.engine, id.user.ID, a.runtime.MarketMeta)
			if err != nil {
				storageError(w)
				return
			}
			writeJSON(w, 200, s)
		})
	})
	mux.HandleFunc("GET /api/events", a.events)
	mux.HandleFunc("POST /api/orders", a.order)
	mux.HandleFunc("POST /api/orders/preview", a.preview)
	mux.HandleFunc("POST /api/orders/{id}/cancel", a.cancel)
	mux.HandleFunc("GET /api/review", a.review)
	mux.HandleFunc("GET /api/profile", a.profile)
	mux.HandleFunc("POST /api/profile/visibility", a.profileVisibility)
	mux.HandleFunc("GET /api/leaderboard", a.leaderboard)
	mux.HandleFunc("POST /api/admin/market", a.adminMarket)
	mux.HandleFunc("GET /api/admin/users", func(w http.ResponseWriter, r *http.Request) {
		a.withSession(w, r, true, true, func(id identity) { a.writeUsers(w) })
	})
	mux.HandleFunc("POST /api/admin/users/{id}/ban", a.ban)
	mux.HandleFunc("POST /api/admin/settings", a.settings)
	mux.HandleFunc("GET /api/admin/backup", a.backup)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.closed || a.db.Ping() != nil {
			apiError(w, 503, "unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { apiError(w, 404, "接口不存在") })
	mux.HandleFunc("/", a.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if r.Method == "POST" {
			content, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || content != "application/json" {
				apiError(w, 415, "请求必须使用 application/json")
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				expected := strings.TrimSuffix(a.config.PublicOrigin, "/")
				if expected == "" {
					scheme := "http"
					if r.TLS != nil {
						scheme = "https"
					}
					expected = scheme + "://" + r.Host
				}
				u, err := url.Parse(origin)
				if err != nil || u.User != nil || origin != expected {
					apiError(w, 403, "仅允许同源请求")
					return
				}
			}
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				apiError(w, 403, "仅允许同源请求")
				return
			}
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/events" {
			// Encode under the owner lock, then release it before writing to a slow network client.
			buffered := &responseBuffer{headers: w.Header().Clone()}
			mux.ServeHTTP(buffered, r)
			for key, values := range buffered.headers {
				w.Header()[key] = values
			}
			status := buffered.status
			if status == 0 {
				status = 200
			}
			w.WriteHeader(status)
			_, _ = w.Write(buffered.body.Bytes())
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func (a *App) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		http.NotFound(w, r)
		return
	}
	if a.config.StaticDir == "" {
		http.NotFound(w, r)
		return
	}
	clean := filepath.Clean("/" + r.URL.Path)
	path := filepath.Join(a.config.StaticDir, clean)
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		http.ServeFile(w, r, path)
		return
	}
	if filepath.Ext(clean) == "" || clean == "/" {
		http.ServeFile(w, r, filepath.Join(a.config.StaticDir, "index.html"))
		return
	}
	http.NotFound(w, r)
}
func (a *App) preview(w http.ResponseWriter, r *http.Request) {
	var input market.OrderInput
	if !decodeJSON(w, r, &input) {
		return
	}
	a.withSession(w, r, true, false, func(id identity) {
		p, err := a.engine.PreviewOrder(id.user.ID, input)
		if err != nil {
			apiError(w, 400, "委托预览失败")
			return
		}
		writeJSON(w, 200, p)
	})
}
func (a *App) order(w http.ResponseWriter, r *http.Request) {
	var input market.OrderInput
	if !decodeJSON(w, r, &input) {
		return
	}
	body, _ := json.Marshal(input)
	a.withSession(w, r, true, false, func(id identity) {
		a.command(w, r, id, body, func(e *market.Engine) market.CommandResult { return e.PlaceOrder(id.user.ID, input) })
	})
}
func (a *App) cancel(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeJSON(w, r, &input) {
		return
	}
	a.withSession(w, r, true, false, func(id identity) {
		a.command(w, r, id, []byte("{}"), func(e *market.Engine) market.CommandResult { return e.CancelOrder(id.user.ID, r.PathValue("id")) })
	})
}
func (a *App) command(w http.ResponseWriter, r *http.Request, id identity, body []byte, apply func(*market.Engine) market.CommandResult) {
	key := r.Header.Get("Idempotency-Key")
	if !idempotencyPattern.MatchString(key) {
		apiError(w, 400, "下单和撤单需要 8–128 位 Idempotency-Key")
		return
	}
	digest := sha256.Sum256(append([]byte(r.Method+" "+r.URL.Path+"\n"), body...))
	hash := hex.EncodeToString(digest[:])
	var previous string
	var response []byte
	var status int
	var created int64
	err := a.db.QueryRow("SELECT body_hash,status,response,created_at FROM idempotency WHERE user_id=? AND key=?", id.user.ID, key).Scan(&previous, &status, &response, &created)
	cutoff := a.now().Add(-7 * 24 * time.Hour).Unix()
	if err == nil && created > cutoff {
		if previous != hash {
			apiError(w, 409, "同一请求编号不能用于不同操作")
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		w.Write(response)
		return
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		storageError(w)
		return
	}
	candidate, err := a.engine.Clone()
	if err != nil {
		storageError(w)
		return
	}
	result := apply(candidate)
	run := a.nextRuntime()
	snapshot, err := a.snapshot(candidate, id.user.ID, run.MarketMeta)
	if err != nil {
		storageError(w)
		return
	}
	response, err = json.Marshal(commandResponse{SnapshotResponse: snapshot, Result: result})
	if err != nil {
		storageError(w)
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		storageError(w)
		return
	}
	defer tx.Rollback()
	if err = a.saveCandidate(tx, candidate, run); err == nil {
		_, err = tx.Exec("DELETE FROM idempotency WHERE created_at <= ?", cutoff)
	}
	if err == nil {
		_, err = tx.Exec("INSERT INTO idempotency(user_id,key,body_hash,status,response,created_at) VALUES(?,?,?,?,?,?)", id.user.ID, key, hash, 200, response, a.now().Unix())
	}
	if err != nil || tx.Commit() != nil {
		storageError(w)
		return
	}
	a.engine = candidate
	a.runtime = run
	a.broadcast()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	w.Write(response)
}
func (a *App) adminMarket(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Action string `json:"action"`
		Speed  int    `json:"speed"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	a.withSession(w, r, true, true, func(id identity) {
		candidate, err := a.engine.Clone()
		if err != nil {
			storageError(w)
			return
		}
		run := a.nextRuntime()
		switch input.Action {
		case "pause":
			run.Running = false
		case "resume":
			run.Running = true
		case "speed":
			if !validSpeed(input.Speed) {
				apiError(w, 400, "速率必须为 1、4、16 或 64")
				return
			}
			run.Speed = input.Speed
		case "skipLunch":
			candidate.SkipLunch()
			run.PhaseWait = 0
		case "nextDay":
			candidate.NextDay()
			run.PhaseWait = 0
		default:
			apiError(w, 400, "未知市场操作")
			return
		}
		tx, err := a.db.Begin()
		if err != nil {
			storageError(w)
			return
		}
		defer tx.Rollback()
		if err = a.saveCandidate(tx, candidate, run); err != nil || tx.Commit() != nil {
			storageError(w)
			return
		}
		a.engine = candidate
		a.runtime = run
		a.broadcast()
		snap, err := a.snapshot(candidate, id.user.ID, run.MarketMeta)
		if err != nil {
			storageError(w)
			return
		}
		writeJSON(w, 200, snap)
	})
}
func (a *App) listUsers() ([]User, error) {
	rows, err := a.db.Query("SELECT id,username,role,banned,created_at FROM users ORDER BY created_at,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := make([]User, 0)
	for rows.Next() {
		u := User{}
		if err = rows.Scan(&u.ID, &u.Username, &u.Role, &u.Banned, &u.CreatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}
func (a *App) writeUsers(w http.ResponseWriter) {
	users, err := a.listUsers()
	if err != nil {
		storageError(w)
		return
	}
	writeJSON(w, 200, struct {
		Users            []User `json:"users"`
		RegistrationOpen bool   `json:"registrationOpen"`
	}{users, a.registrationOpen})
}
func (a *App) ban(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Banned *bool `json:"banned"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Banned == nil {
		apiError(w, 400, "缺少 banned")
		return
	}
	a.withSession(w, r, true, true, func(id identity) {
		target := r.PathValue("id")
		var role string
		if err := a.db.QueryRow("SELECT role FROM users WHERE id=?", target).Scan(&role); err != nil {
			apiError(w, 404, "用户不存在")
			return
		}
		if role == "admin" {
			apiError(w, 409, "不能封禁管理员")
			return
		}
		tx, err := a.db.Begin()
		if err != nil {
			storageError(w)
			return
		}
		defer tx.Rollback()
		_, err = tx.Exec("UPDATE users SET banned=? WHERE id=?", *input.Banned, target)
		if err == nil && *input.Banned {
			_, err = tx.Exec("DELETE FROM sessions WHERE user_id=?", target)
		}
		if err != nil || tx.Commit() != nil {
			storageError(w)
			return
		}
		if *input.Banned {
			a.closeSessions(target, "")
		}
		a.writeUsers(w)
	})
}
func (a *App) settings(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RegistrationOpen *bool `json:"registrationOpen"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.RegistrationOpen == nil {
		apiError(w, 400, "缺少 registrationOpen")
		return
	}
	a.withSession(w, r, true, true, func(id identity) {
		if _, err := a.db.Exec("UPDATE settings SET registration_open=? WHERE id=1", *input.RegistrationOpen); err != nil {
			storageError(w)
			return
		}
		a.registrationOpen = *input.RegistrationOpen
		a.writeUsers(w)
	})
}
func (a *App) backup(w http.ResponseWriter, r *http.Request) {
	a.withSession(w, r, true, true, func(id identity) {
		state, err := a.engine.Export()
		if err != nil {
			storageError(w)
			return
		}
		rows, err := a.db.Query("SELECT id,username,role,banned,created_at,password_hash FROM users ORDER BY created_at,id")
		if err != nil {
			storageError(w)
			return
		}
		type backupUser struct {
			User
			PasswordHash string `json:"passwordHash"`
		}
		users := make([]backupUser, 0)
		for rows.Next() {
			u := backupUser{}
			if err = rows.Scan(&u.ID, &u.Username, &u.Role, &u.Banned, &u.CreatedAt, &u.PasswordHash); err != nil {
				rows.Close()
				storageError(w)
				return
			}
			users = append(users, u)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			storageError(w)
			return
		}
		preferences, err := a.playerPreferences()
		if err != nil {
			storageError(w)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="stocksim-backup.json"`)
		writeJSON(w, 200, struct {
			SchemaVersion     int                `json:"schemaVersion"`
			ExportedAt        string             `json:"exportedAt"`
			Engine            json.RawMessage    `json:"engine"`
			Runtime           runtimeState       `json:"runtime"`
			RegistrationOpen  bool               `json:"registrationOpen"`
			Users             []backupUser       `json:"users"`
			PlayerPreferences []playerPreference `json:"playerPreferences"`
		}{2, a.now().Format(time.RFC3339Nano), state, a.runtime, a.registrationOpen, users, preferences})
	})
}
func (a *App) events(w http.ResponseWriter, r *http.Request) {
	var sub *subscription
	a.withSession(w, r, true, false, func(id identity) {
		count := 0
		for s := range a.subs {
			if s.sessionHash == id.hash {
				count++
			}
		}
		if count >= 2 {
			apiError(w, 429, "每个会话最多允许两个实时连接")
			return
		}
		snapshot, err := a.snapshot(a.engine, id.user.ID, a.runtime.MarketMeta)
		if err != nil {
			storageError(w)
			return
		}
		b, err := json.Marshal(snapshot)
		if err != nil {
			storageError(w)
			return
		}
		sub = &subscription{userID: id.user.ID, sessionHash: id.hash, expires: id.expires, updates: make(chan []byte, 1), done: make(chan struct{})}
		sub.updates <- b
		a.subs[sub] = struct{}{}
	})
	if sub == nil {
		return
	}
	defer func() { a.mu.Lock(); delete(a.subs, sub); a.mu.Unlock() }()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-sub.done:
			return
		case b := <-sub.updates:
			http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err := fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", b); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			a.mu.Lock()
			_, err := a.readIdentity(r)
			a.mu.Unlock()
			if err != nil {
				return
			}
			http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err = io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
func (a *App) review(w http.ResponseWriter, r *http.Request) {
	rangeValue := r.URL.Query().Get("range")
	day := int64(-1)
	switch rangeValue {
	case "all", "5", "20":
	case "day":
		value, err := strconv.ParseInt(r.URL.Query().Get("dayIndex"), 10, 64)
		if err != nil || value < 0 {
			apiError(w, 400, "请选择有效交易日")
			return
		}
		day = value
	default:
		apiError(w, 400, "复盘区间必须为 day、5、20 或 all")
		return
	}
	a.withSession(w, r, true, false, func(id identity) { a.writeReview(w, id.user.ID, rangeValue, day) })
}

func (a *App) writeReview(w http.ResponseWriter, userID, rangeValue string, day int64) {
	period := market.ReviewPeriod{Kind: "all"}
	switch rangeValue {
	case "day":
		period.Kind = "day"
		period.DayIndex = day
	case "5", "20":
		period.Kind = "recent"
		period.Days, _ = strconv.Atoi(rangeValue)
	}
	selection, err := a.engine.GetReview(userID, period)
	if err != nil {
		apiError(w, 400, "复盘数据不可用或交易日不存在")
		return
	}
	writeJSON(w, 200, struct {
		market.ReviewSelection
		UserID   string `json:"userId"`
		Revision int64  `json:"revision"`
	}{selection, userID, a.runtime.Revision})
}

type responseBuffer struct {
	headers http.Header
	status  int
	body    bytes.Buffer
}

func (b *responseBuffer) Header() http.Header { return b.headers }
func (b *responseBuffer) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}
func (b *responseBuffer) Write(data []byte) (int, error) {
	if b.status == 0 {
		b.status = 200
	}
	return b.body.Write(data)
}
