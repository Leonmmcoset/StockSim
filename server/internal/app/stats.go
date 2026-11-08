package app

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"stocksim/server/internal/market"
)

const visibilityReceiptPrefix = "visibility:"

type playerPreference struct {
	UserID           string `json:"userId"`
	LeaderboardOptIn bool   `json:"leaderboardOptIn"`
}

type profileResponse struct {
	UserID           string                   `json:"userId"`
	Revision         int64                    `json:"revision"`
	Username         string                   `json:"username"`
	CreatedAt        string                   `json:"createdAt"`
	LeaderboardOptIn bool                     `json:"leaderboardOptIn"`
	Performance      market.PlayerPerformance `json:"performance"`
}

// Public ranking fields are an explicit allowlist. The engine's metric types
// also contain monetary account data and must never be serialized wholesale.
type leaderboardWindow struct {
	RequestedStartDayIndex int64    `json:"requestedStartDayIndex"`
	RequestedStartAt       int64    `json:"requestedStartAt"`
	StartAt                int64    `json:"startAt"`
	EndAt                  int64    `json:"endAt"`
	CoveredDays            int64    `json:"coveredDays"`
	Complete               bool     `json:"complete"`
	ReturnPct              *float64 `json:"returnPct"`
}

type leaderboardEntry struct {
	Username       string                     `json:"username"`
	Rank           *int64                     `json:"rank"`
	JoinedAt       int64                      `json:"joinedAt"`
	TotalReturnPct *float64                   `json:"totalReturnPct"`
	Recent5        leaderboardWindow          `json:"recent5"`
	Drawdown       market.PerformanceDrawdown `json:"drawdown"`
}

func (a *App) leaderboardOptIn(userID string) (bool, error) {
	var enabled bool
	err := a.db.QueryRow("SELECT leaderboard_opt_in FROM player_preferences WHERE user_id=?", userID).Scan(&enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return enabled, err
}

func (a *App) profileFor(user *User) (profileResponse, error) {
	enabled, err := a.leaderboardOptIn(user.ID)
	if err != nil {
		return profileResponse{}, err
	}
	performance, err := a.engine.PlayerPerformance(user.ID)
	if err != nil {
		return profileResponse{}, err
	}
	return profileResponse{UserID: user.ID, Revision: a.runtime.Revision, Username: user.Username, CreatedAt: user.CreatedAt, LeaderboardOptIn: enabled, Performance: performance}, nil
}

func (a *App) profile(w http.ResponseWriter, r *http.Request) {
	a.withSession(w, r, true, false, func(id identity) {
		profile, err := a.profileFor(id.user)
		if err != nil {
			storageError(w)
			return
		}
		writeJSON(w, 200, profile)
	})
}

func (a *App) profileVisibility(w http.ResponseWriter, r *http.Request) {
	var input struct {
		LeaderboardOptIn *bool `json:"leaderboardOptIn"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.LeaderboardOptIn == nil {
		apiError(w, 400, "leaderboardOptIn 必须为布尔值")
		return
	}
	a.withSession(w, r, true, false, func(id identity) {
		key := r.Header.Get("Idempotency-Key")
		if !idempotencyPattern.MatchString(key) {
			apiError(w, 400, "上榜设置需要 8–128 位 Idempotency-Key")
			return
		}
		body, _ := json.Marshal(input)
		digest := sha256.Sum256(append([]byte(r.Method+" "+r.URL.Path+"\n"), body...))
		hash := visibilityReceiptPrefix + hex.EncodeToString(digest[:])
		var previous string
		var created int64
		err := a.db.QueryRow("SELECT body_hash,created_at FROM idempotency WHERE user_id=? AND key=?", id.user.ID, key).Scan(&previous, &created)
		cutoff := a.now().Add(-7 * 24 * time.Hour).Unix()
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			storageError(w)
			return
		}
		replayed := err == nil && (strings.HasPrefix(previous, visibilityReceiptPrefix) || created > cutoff)
		if replayed && previous != hash {
			apiError(w, 409, "同一请求编号不能用于不同操作")
			return
		}
		profile, err := a.profileFor(id.user)
		if err != nil {
			storageError(w)
			return
		}
		if replayed {
			// Acknowledging the old operation must not apply its intent again:
			// another completed operation may already have changed visibility.
			w.Header().Set("Idempotency-Replayed", "true")
			writeJSON(w, 200, profile)
			return
		}
		changed := profile.LeaderboardOptIn != *input.LeaderboardOptIn
		run := a.runtime
		if changed {
			run = a.nextRuntime()
		}
		profile.Revision, profile.LeaderboardOptIn = run.Revision, *input.LeaderboardOptIn
		tx, err := a.db.Begin()
		if err != nil {
			storageError(w)
			return
		}
		defer tx.Rollback()
		if changed {
			var runtimeJSON []byte
			runtimeJSON, err = json.Marshal(run)
			if err == nil {
				_, err = tx.Exec("INSERT INTO player_preferences(user_id,leaderboard_opt_in) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET leaderboard_opt_in=excluded.leaderboard_opt_in", id.user.ID, *input.LeaderboardOptIn)
			}
			if err == nil {
				_, err = tx.Exec("UPDATE market_state SET runtime=? WHERE id=1", runtimeJSON)
			}
		}
		if err == nil {
			_, err = tx.Exec("DELETE FROM idempotency WHERE created_at <= ? AND body_hash NOT LIKE 'visibility:%'", cutoff)
		}
		if err == nil {
			// Even a no-change request must be remembered, so a late retry
			// cannot reverse a subsequently completed visibility operation.
			// Store only the small intent receipt; replays read the current
			// profile instead of retaining another copy of its private curve.
			_, err = tx.Exec("INSERT INTO idempotency(user_id,key,body_hash,status,response,created_at) VALUES(?,?,?,?,?,?)", id.user.ID, key, hash, 200, body, a.now().Unix())
		}
		if err != nil || tx.Commit() != nil {
			storageError(w)
			return
		}
		a.runtime = run
		w.Header().Set("Idempotency-Replayed", "false")
		writeJSON(w, 200, profile)
	})
}

func (a *App) leaderboard(w http.ResponseWriter, r *http.Request) {
	sortBy := r.URL.Query().Get("sortBy")
	if sortBy == "" {
		sortBy = "totalReturnPct"
	}
	if sortBy != "totalReturnPct" && sortBy != "recent5ReturnPct" && sortBy != "maxDrawdownPct" {
		apiError(w, 400, "排行榜排序必须为 totalReturnPct、recent5ReturnPct 或 maxDrawdownPct")
		return
	}
	a.withSession(w, r, true, false, func(id identity) {
		rows, err := a.db.Query("SELECT u.id,u.username FROM users u JOIN player_preferences p ON p.user_id=u.id WHERE p.leaderboard_opt_in=1 AND u.banned=0 ORDER BY u.id")
		if err != nil {
			storageError(w)
			return
		}
		ids := make([]string, 0)
		names := map[string]string{}
		for rows.Next() {
			var userID, username string
			if err = rows.Scan(&userID, &username); err != nil {
				rows.Close()
				storageError(w)
				return
			}
			ids = append(ids, userID)
			names[userID] = username
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			storageError(w)
			return
		}
		ranks, err := a.engine.RankPlayers(ids, sortBy)
		if err != nil {
			storageError(w)
			return
		}
		entries := make([]leaderboardEntry, 0, len(ranks))
		for _, rank := range ranks {
			metrics := rank.Metrics
			window := metrics.Recent5
			entries = append(entries, leaderboardEntry{Username: names[rank.PlayerID], Rank: rank.Rank, JoinedAt: metrics.JoinedAt, TotalReturnPct: metrics.TotalReturnPct,
				Recent5: leaderboardWindow{RequestedStartDayIndex: window.RequestedStartDayIndex, RequestedStartAt: window.RequestedStartAt, StartAt: window.StartAt, EndAt: window.EndAt, CoveredDays: window.CoveredDays, Complete: window.Complete, ReturnPct: window.ReturnPct}, Drawdown: metrics.Drawdown})
		}
		writeJSON(w, 200, struct {
			UserID   string             `json:"userId"`
			Revision int64              `json:"revision"`
			SortBy   string             `json:"sortBy"`
			Entries  []leaderboardEntry `json:"entries"`
		}{id.user.ID, a.runtime.Revision, sortBy, entries})
	})
}

func (a *App) playerPreferences() ([]playerPreference, error) {
	rows, err := a.db.Query("SELECT user_id,leaderboard_opt_in FROM player_preferences ORDER BY user_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	preferences := make([]playerPreference, 0)
	for rows.Next() {
		var preference playerPreference
		if err := rows.Scan(&preference.UserID, &preference.LeaderboardOptIn); err != nil {
			return nil, err
		}
		preferences = append(preferences, preference)
	}
	return preferences, rows.Err()
}
