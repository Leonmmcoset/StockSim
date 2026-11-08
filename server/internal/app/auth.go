package app

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

const cookieName = "stocksim_session"
const sessionLifetime = 7 * 24 * time.Hour

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{3,24}$`)
var idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,128}$`)

type identity struct {
	hash, csrf string
	expires    int64
	user       *User
}

func randomToken(size int) (string, error) {
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func tokenHash(token string) string {
	s := sha256.Sum256([]byte(token))
	return hex.EncodeToString(s[:])
}
func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, 3, 64*1024, 1, 32)
	return "argon2id$v=19$m=65536,t=3,p=1$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key), nil
}
func verifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	var salt, want []byte
	valid := len(parts) == 5 && parts[0] == "argon2id" && parts[1] == "v=19" && parts[2] == "m=65536,t=3,p=1"
	if valid {
		salt, _ = base64.RawStdEncoding.DecodeString(parts[3])
		want, _ = base64.RawStdEncoding.DecodeString(parts[4])
		valid = len(salt) == 16 && len(want) == 32
	}
	if !valid {
		salt = []byte("stocksim-dummy!!")
		want = make([]byte, 32)
	}
	got := argon2.IDKey([]byte(password), salt, 3, 64*1024, 1, 32)
	return valid && subtle.ConstantTimeCompare(got, want) == 1
}
func (a *App) createSession(tx *sql.Tx, userID string) (identity, string, error) {
	token, err := randomToken(32)
	if err != nil {
		return identity{}, "", err
	}
	csrf, err := randomToken(32)
	if err != nil {
		return identity{}, "", err
	}
	id := identity{hash: tokenHash(token), csrf: csrf, expires: a.now().Add(sessionLifetime).Unix()}
	var uid any
	if userID != "" {
		uid = userID
	}
	_, err = tx.Exec("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)", id.hash, uid, id.csrf, id.expires)
	return id, token, err
}
func (a *App) setCookie(w http.ResponseWriter, r *http.Request, token string, expires int64) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/", HttpOnly: true, Secure: a.config.SecureCookies || r.TLS != nil, SameSite: http.SameSiteLaxMode, Expires: time.Unix(expires, 0), MaxAge: int(sessionLifetime.Seconds())})
}
func (a *App) readIdentity(r *http.Request) (identity, error) {
	cookie, err := r.Cookie(cookieName)
	if err != nil || len(cookie.Value) > 128 {
		return identity{}, errors.New("需要登录")
	}
	id := identity{hash: tokenHash(cookie.Value)}
	var uid sql.NullString
	if err = a.db.QueryRow("SELECT user_id,csrf_token,expires_at FROM sessions WHERE token_hash=?", id.hash).Scan(&uid, &id.csrf, &id.expires); err != nil {
		return identity{}, err
	}
	if id.expires <= a.now().Unix() {
		return identity{}, errors.New("会话已过期")
	}
	if uid.Valid {
		u := User{}
		if err = a.db.QueryRow("SELECT id,username,role,banned,created_at FROM users WHERE id=?", uid.String).Scan(&u.ID, &u.Username, &u.Role, &u.Banned, &u.CreatedAt); err != nil {
			return identity{}, err
		}
		if u.Banned {
			return identity{}, errors.New("账户已封禁")
		}
		id.user = &u
	}
	return id, nil
}
func (a *App) sessionPayload(id identity) any {
	return struct {
		User             *User      `json:"user"`
		CSRF             string     `json:"csrfToken"`
		RegistrationOpen bool       `json:"registrationOpen"`
		Market           MarketMeta `json:"market"`
	}{id.user, id.csrf, a.registrationOpen, a.runtime.MarketMeta}
}
func (a *App) allowRate(key string, limit int, window time.Duration) bool {
	now := a.now()
	bucket := a.limits[key]
	if !now.Before(bucket.reset) {
		bucket = rateBucket{reset: now.Add(window)}
	}
	if bucket.count >= limit {
		return false
	}
	bucket.count++
	if len(a.limits) > 10000 {
		for k, v := range a.limits {
			if !now.Before(v.reset) {
				delete(a.limits, k)
			}
		}
		if len(a.limits) > 10000 {
			return false
		}
	}
	a.limits[key] = bucket
	return true
}
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}
func (a *App) withSession(w http.ResponseWriter, r *http.Request, userRequired, admin bool, fn func(identity)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		apiError(w, 503, "服务正在停止")
		return
	}
	id, err := a.readIdentity(r)
	if err != nil || (userRequired && id.user == nil) {
		apiError(w, 401, "登录已失效，请重新登录")
		return
	}
	if expected := r.Header.Get("X-Expected-User-Id"); expected != "" && (id.user == nil || id.user.ID != expected) {
		apiError(w, 401, "会话已切换，请重新连接")
		return
	}
	if r.Method == "POST" {
		if subtle.ConstantTimeCompare([]byte(id.csrf), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
			apiError(w, 403, "CSRF 校验失败，请刷新后重试")
			return
		}
		if !a.allowRate("mutate:"+id.hash, 10, time.Second) {
			apiError(w, 429, "操作过于频繁，请稍后重试")
			return
		}
	}
	if admin && (id.user == nil || id.user.Role != "admin") {
		apiError(w, 403, "需要管理员权限")
		return
	}
	if id.user != nil {
		w.Header().Set("X-User-Id", id.user.ID)
	}
	fn(id)
}
func (a *App) handleSession(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	id, err := a.readIdentity(r)
	if err == nil {
		if id.user != nil {
			w.Header().Set("X-User-Id", id.user.ID)
		}
		writeJSON(w, 200, a.sessionPayload(id))
		return
	}
	if !a.allowRate("session:"+remoteIP(r), 60, time.Minute) {
		apiError(w, 429, "请求过于频繁")
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		storageError(w)
		return
	}
	defer tx.Rollback()
	id, token, err := a.createSession(tx, "")
	if err == nil {
		_, err = tx.Exec("DELETE FROM sessions WHERE expires_at <= ?", a.now().Unix())
	}
	if err != nil || tx.Commit() != nil {
		storageError(w)
		return
	}
	a.setCookie(w, r, token, id.expires)
	writeJSON(w, 200, a.sessionPayload(id))
}
func (a *App) handleCredentials(w http.ResponseWriter, r *http.Request, register bool) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if !usernamePattern.MatchString(input.Username) || len(input.Password) < 8 || len(input.Password) > 128 {
		apiError(w, 400, "用户名需为 3–24 位字母数字、下划线或短横，密码需为 8–128 字节")
		return
	}
	var initial identity
	var encoded string
	allowed := false
	a.withSession(w, r, false, false, func(id identity) {
		if !a.allowRate("auth:"+remoteIP(r), 10, time.Minute) {
			apiError(w, 429, "登录尝试过于频繁，请稍后重试")
			return
		}
		if !a.allowRate("auth-user:"+strings.ToLower(input.Username), 10, time.Minute) {
			apiError(w, 429, "登录尝试过于频繁，请稍后重试")
			return
		}
		if register && !a.registrationOpen {
			apiError(w, 403, "管理员已关闭注册")
			return
		}
		initial = id
		allowed = true
		if !register {
			a.db.QueryRow("SELECT password_hash FROM users WHERE username=?", input.Username).Scan(&encoded)
		}
	})
	if !allowed {
		return
	}
	select {
	case a.kdf <- struct{}{}:
		defer func() { <-a.kdf }()
	case <-r.Context().Done():
		return
	case <-time.After(10 * time.Second):
		apiError(w, 429, "认证繁忙，请稍后重试")
		return
	}
	var hash string
	var err error
	if register {
		hash, err = hashPassword(input.Password)
		if err != nil {
			storageError(w)
			return
		}
	} else if !verifyPassword(input.Password, encoded) {
		apiError(w, 401, "用户名或密码错误，或账户不可用")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	current, err := a.readIdentity(r)
	if err != nil || current.hash != initial.hash || subtle.ConstantTimeCompare([]byte(current.csrf), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
		apiError(w, 401, "会话已失效，请刷新重试")
		return
	}
	if register {
		a.registerLocked(w, r, input.Username, hash, current)
		return
	}
	user := User{}
	if err = a.db.QueryRow("SELECT id,username,role,banned,created_at FROM users WHERE username=?", input.Username).Scan(&user.ID, &user.Username, &user.Role, &user.Banned, &user.CreatedAt); err != nil || user.Banned {
		apiError(w, 401, "用户名或密码错误，或账户不可用")
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		storageError(w)
		return
	}
	defer tx.Rollback()
	id, token, err := a.createSession(tx, user.ID)
	if err == nil {
		_, err = tx.Exec("DELETE FROM sessions WHERE token_hash=?", current.hash)
	}
	if err != nil || tx.Commit() != nil {
		storageError(w)
		return
	}
	id.user = &user
	w.Header().Set("X-User-Id", user.ID)
	a.closeSessions("", current.hash)
	a.setCookie(w, r, token, id.expires)
	writeJSON(w, 200, a.sessionPayload(id))
}
func (a *App) registerLocked(w http.ResponseWriter, r *http.Request, username, hash string, old identity) {
	if !a.registrationOpen {
		apiError(w, 403, "管理员已关闭注册")
		return
	}
	if old.user != nil {
		apiError(w, 409, "请先退出当前账户再注册")
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		storageError(w)
		return
	}
	defer tx.Rollback()
	var exists int
	if err = tx.QueryRow("SELECT COUNT(*) FROM users WHERE username=?", username).Scan(&exists); err != nil {
		storageError(w)
		return
	}
	if exists != 0 {
		apiError(w, 409, "用户名已存在")
		return
	}
	var count int
	if err = tx.QueryRow("SELECT COUNT(*) FROM users").Scan(&count); err != nil {
		storageError(w)
		return
	}
	userID, err := randomToken(18)
	if err != nil {
		storageError(w)
		return
	}
	role := "user"
	if count == 0 {
		role = "admin"
	}
	user := User{ID: userID, Username: username, Role: role, CreatedAt: a.now().Format(time.RFC3339Nano)}
	candidate, err := a.engine.Clone()
	if err != nil {
		storageError(w)
		return
	}
	if err = candidate.AddPlayer(user.ID); err != nil {
		storageError(w)
		return
	}
	run := a.nextRuntime()
	if count == 0 {
		run.Running = true
		run.PhaseWait = 0
	}
	_, err = tx.Exec("INSERT INTO users(id,username,password_hash,role,banned,created_at) VALUES(?,?,?,?,0,?)", user.ID, user.Username, hash, user.Role, user.CreatedAt)
	if err != nil {
		storageError(w)
		return
	}
	id, token, err := a.createSession(tx, user.ID)
	if err == nil {
		_, err = tx.Exec("DELETE FROM sessions WHERE token_hash=?", old.hash)
	}
	if err == nil {
		err = a.saveCandidate(tx, candidate, run)
	}
	if err != nil || tx.Commit() != nil {
		storageError(w)
		return
	}
	a.engine = candidate
	a.runtime = run
	id.user = &user
	w.Header().Set("X-User-Id", user.ID)
	a.closeSessions("", old.hash)
	a.setCookie(w, r, token, id.expires)
	a.broadcast()
	writeJSON(w, 201, a.sessionPayload(id))
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	a.withSession(w, r, false, false, func(id identity) {
		if _, err := a.db.Exec("DELETE FROM sessions WHERE token_hash=?", id.hash); err != nil {
			storageError(w)
			return
		}
		a.closeSessions("", id.hash)
		http.SetCookie(w, &http.Cookie{Name: cookieName, Path: "/", HttpOnly: true, Secure: a.config.SecureCookies || r.TLS != nil, SameSite: http.SameSiteLaxMode, MaxAge: -1})
		w.WriteHeader(204)
	})
}
