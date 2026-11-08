package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func statsJSON(t *testing.T, c *testClient, method, path string, body any) map[string]any {
	t.Helper()
	key := ""
	if path == "/api/profile/visibility" {
		var err error
		key, err = randomToken(18)
		if err != nil {
			t.Fatal(err)
		}
	}
	return statsJSONKey(t, c, method, path, body, key)
}

func statsJSONKey(t *testing.T, c *testClient, method, path string, body any, key string) map[string]any {
	t.Helper()
	status, raw := c.req(t, method, path, body, key)
	if status != 200 {
		t.Fatalf("%s %s: %d %s", method, path, status, raw)
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestStatsOptInPrivacyAndBan(t *testing.T) {
	_, ts := startTest(t)
	alice := newClient(t, ts.URL)
	au := alice.register(t, "stats_alice")
	bob := newClient(t, ts.URL)
	bu := bob.register(t, "stats_bob")
	profile := statsJSON(t, alice, "GET", "/api/profile?userId="+bu["id"].(string), nil)
	if profile["userId"] != au["id"] || profile["username"] != "stats_alice" || profile["leaderboardOptIn"] != false || profile["performance"] == nil {
		t.Fatalf("private profile: %#v", profile)
	}
	board := statsJSON(t, alice, "GET", "/api/leaderboard", nil)
	if board["userId"] != au["id"] || board["sortBy"] != "totalReturnPct" || len(board["entries"].([]any)) != 0 {
		t.Fatalf("default board: %#v", board)
	}
	opted := statsJSON(t, bob, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true})
	if opted["userId"] != bu["id"] || opted["leaderboardOptIn"] != true {
		t.Fatalf("opt in: %#v", opted)
	}
	for _, sortBy := range []string{"totalReturnPct", "recent5ReturnPct", "maxDrawdownPct"} {
		board = statsJSON(t, alice, "GET", "/api/leaderboard?sortBy="+sortBy, nil)
		entries := board["entries"].([]any)
		if len(entries) != 1 || entries[0].(map[string]any)["username"] != "stats_bob" || board["sortBy"] != sortBy {
			t.Fatalf("opted board: %#v", board)
		}
		entry := entries[0].(map[string]any)
		allowed := map[string]bool{"username": true, "rank": true, "joinedAt": true, "totalReturnPct": true, "recent5": true, "drawdown": true}
		for key := range entry {
			if !allowed[key] {
				t.Fatalf("leaderboard disclosed %s", key)
			}
		}
		raw, _ := json.Marshal(entry)
		for _, private := range []string{"equity", "totalPnl", "netPnl", "cash", "positions", "orders", "trades", "password", bu["id"].(string)} {
			if bytes.Contains(raw, []byte(private)) {
				t.Fatalf("leaderboard disclosed %s: %s", private, raw)
			}
		}
	}
	statsJSON(t, bob, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": false})
	if entries := statsJSON(t, alice, "GET", "/api/leaderboard", nil)["entries"].([]any); len(entries) != 0 {
		t.Fatalf("opt out retained player: %#v", entries)
	}
	statsJSON(t, bob, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true})
	if status, b := alice.req(t, "POST", "/api/admin/users/"+bu["id"].(string)+"/ban", map[string]bool{"banned": true}, ""); status != 200 {
		t.Fatalf("ban %d %s", status, b)
	}
	if entries := statsJSON(t, alice, "GET", "/api/leaderboard", nil)["entries"].([]any); len(entries) != 0 {
		t.Fatalf("banned player retained: %#v", entries)
	}
}

func TestStatsIdentityCSRFAndValidation(t *testing.T) {
	_, ts := startTest(t)
	c := newClient(t, ts.URL)
	for _, path := range []string{"/api/profile", "/api/leaderboard"} {
		if status, _ := c.req(t, "GET", path, nil, ""); status != 401 {
			t.Fatalf("anonymous %s = %d", path, status)
		}
	}
	u := c.register(t, "stats_identity")
	for _, path := range []string{"/api/profile", "/api/leaderboard", "/api/profile/visibility"} {
		method := "GET"
		var body io.Reader
		if strings.HasSuffix(path, "visibility") {
			method, body = "POST", strings.NewReader(`{"leaderboardOptIn":true}`)
		}
		req, _ := http.NewRequest(method, ts.URL+path, body)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", c.csrf)
		req.Header.Set("X-Expected-User-Id", "stale-user")
		res, err := c.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 401 {
			t.Fatalf("stale identity %s = %d", path, res.StatusCode)
		}
	}
	for _, path := range []string{"/api/profile", "/api/leaderboard"} {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		res, err := c.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 || res.Header.Get("X-User-Id") != u["id"] || res.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("identity header %s: %d %v", path, res.StatusCode, res.Header)
		}
	}
	csrf := c.csrf
	c.csrf = "wrong"
	if status, _ := c.req(t, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, ""); status != 403 {
		t.Fatalf("csrf %d", status)
	}
	c.csrf = csrf
	for _, body := range []any{map[string]any{}, map[string]any{"leaderboardOptIn": nil}, map[string]any{"leaderboardOptIn": "true"}, map[string]any{"leaderboardOptIn": true, "userId": "another"}} {
		if status, _ := c.req(t, "POST", "/api/profile/visibility", body, ""); status != 400 {
			t.Fatalf("invalid body %#v = %d", body, status)
		}
	}
	if status, _ := c.req(t, "GET", "/api/leaderboard?sortBy=equity", nil, ""); status != 400 {
		t.Fatalf("invalid sort %d", status)
	}
}

func TestStatsPreferencesPersistAndBackup(t *testing.T) {
	zero := 0
	config := Config{DBPath: filepath.Join(t.TempDir(), "stats.db"), HistoryDays: &zero}
	a, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(a.Handler())
	c := newClient(t, ts.URL)
	u := c.register(t, "stats_persist")
	before := statsJSON(t, c, "GET", "/api/profile", nil)
	opted := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "persist-visibility-a")
	if opted["revision"].(float64) != before["revision"].(float64)+1 {
		t.Fatalf("visibility revision: before=%v after=%v", before["revision"], opted["revision"])
	}
	duplicate := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "persist-no-change")
	if duplicate["revision"] != opted["revision"] {
		t.Fatal("repeated preference changed revision")
	}
	backup := statsJSON(t, c, "GET", "/api/admin/backup", nil)
	prefs := backup["playerPreferences"].([]any)
	if backup["schemaVersion"] != float64(2) || len(prefs) != 1 || prefs[0].(map[string]any)["userId"] != u["id"] || prefs[0].(map[string]any)["leaderboardOptIn"] != true {
		t.Fatalf("backup preferences: %#v", backup)
	}
	ts.Close()
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	a, err = New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	ts = httptest.NewServer(a.Handler())
	defer ts.Close()
	c.base = ts.URL
	restored := statsJSON(t, c, "GET", "/api/profile", nil)
	if restored["leaderboardOptIn"] != true || restored["revision"] != opted["revision"] {
		t.Fatalf("restart preference: %#v", restored)
	}
	latest := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": false}, "persist-visibility-b")
	replayed := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "persist-visibility-a")
	if replayed["leaderboardOptIn"] != false || replayed["revision"] != latest["revision"] {
		t.Fatalf("replay after restart overwrote newer privacy: %#v", replayed)
	}
	replayed = statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "persist-no-change")
	if replayed["leaderboardOptIn"] != false || replayed["revision"] != latest["revision"] {
		t.Fatalf("no-change replay after restart overwrote newer privacy: %#v", replayed)
	}
}

func TestStatsVisibilityFailureIsAtomic(t *testing.T) {
	a, ts := startTest(t)
	c := newClient(t, ts.URL)
	c.register(t, "stats_rollback")
	before := statsJSON(t, c, "GET", "/api/profile", nil)
	a.mu.Lock()
	_, err := a.db.Exec(`CREATE TRIGGER fail_stats_runtime BEFORE UPDATE ON market_state BEGIN SELECT RAISE(FAIL,'injected'); END`)
	a.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if status, raw := c.req(t, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "rollback-visibility"); status != 503 {
		t.Fatalf("failed storage %d %s", status, raw)
	}
	after := statsJSON(t, c, "GET", "/api/profile", nil)
	if after["revision"] != before["revision"] || after["leaderboardOptIn"] != false {
		t.Fatalf("failed visibility committed: %#v", after)
	}
	a.mu.Lock()
	var keys int
	err = a.db.QueryRow("SELECT COUNT(*) FROM idempotency WHERE key=?", "rollback-visibility").Scan(&keys)
	if err != nil || keys != 0 {
		a.mu.Unlock()
		t.Fatalf("failed transaction retained key: %d %v", keys, err)
	}
	_, err = a.db.Exec("DROP TRIGGER fail_stats_runtime")
	a.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "rollback-visibility")
}

func TestStatsVisibilityRequiresIdempotencyKeyAndRejectsConflicts(t *testing.T) {
	_, ts := startTest(t)
	c := newClient(t, ts.URL)
	c.register(t, "stats_key_guard")
	for _, key := range []string{"", "short", strings.Repeat("a", 129), "invalid key"} {
		if status, raw := c.req(t, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, key); status != 400 {
			t.Fatalf("key %q = %d %s", key, status, raw)
		}
	}
	statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "shared-command-key")
	if status, raw := c.req(t, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": false}, "shared-command-key"); status != 409 {
		t.Fatalf("different body accepted: %d %s", status, raw)
	}
	if status, raw := c.req(t, "POST", "/api/orders", map[string]any{}, "shared-command-key"); status != 409 {
		t.Fatalf("cross-endpoint key accepted: %d %s", status, raw)
	}
	statsJSONKey(t, c, "POST", "/api/orders", map[string]any{}, "order-before-visibility")
	if status, raw := c.req(t, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": false}, "order-before-visibility"); status != 409 {
		t.Fatalf("order key reused for visibility: %d %s", status, raw)
	}
}

func TestStatsVisibilityReplaysCurrentStateWithoutReapplying(t *testing.T) {
	_, ts := startTest(t)
	c := newClient(t, ts.URL)
	c.register(t, "stats_replay")
	initial := statsJSON(t, c, "GET", "/api/profile", nil)
	noChange := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": false}, "visibility-no-change")
	if noChange["revision"] != initial["revision"] {
		t.Fatal("no-change write advanced revision")
	}
	opted := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "visibility-public-a")
	replayedNoChange := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": false}, "visibility-no-change")
	if replayedNoChange["leaderboardOptIn"] != true || replayedNoChange["revision"] != opted["revision"] {
		t.Fatalf("no-change replay mutated newer state: %#v", replayedNoChange)
	}
	private := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": false}, "visibility-private-b")
	replayed := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "visibility-public-a")
	if replayed["leaderboardOptIn"] != false || replayed["revision"] != private["revision"] {
		t.Fatalf("old opt-in replay republished account: %#v", replayed)
	}
}

func TestStatsVisibilityIdempotencyInsertFailureRollsBack(t *testing.T) {
	a, ts := startTest(t)
	c := newClient(t, ts.URL)
	c.register(t, "stats_key_rollback")
	before := statsJSON(t, c, "GET", "/api/profile", nil)
	a.mu.Lock()
	_, err := a.db.Exec(`CREATE TRIGGER fail_stats_key BEFORE INSERT ON idempotency BEGIN SELECT RAISE(FAIL,'injected'); END`)
	a.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, enabled := range []bool{true, false} {
		if status, raw := c.req(t, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": enabled}, "key-insert-rollback"); status != 503 {
			t.Fatalf("insert failure enabled=%t: %d %s", enabled, status, raw)
		}
		after := statsJSON(t, c, "GET", "/api/profile", nil)
		if after["leaderboardOptIn"] != false || after["revision"] != before["revision"] {
			t.Fatalf("insert failure changed privacy: %#v", after)
		}
	}
	a.mu.Lock()
	_, err = a.db.Exec("DROP TRIGGER fail_stats_key")
	a.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "key-insert-rollback")
}

func TestStatsVisibilityCanonicalReplayReturnsCurrentProfile(t *testing.T) {
	_, ts := startTest(t)
	c := newClient(t, ts.URL)
	u := c.register(t, "stats_canonical")
	statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": true}, "canonical-visibility-a")
	latest := statsJSONKey(t, c, "POST", "/api/profile/visibility", map[string]bool{"leaderboardOptIn": false}, "canonical-visibility-b")
	req, _ := http.NewRequest("POST", ts.URL+"/api/profile/visibility", strings.NewReader("{ \n \"leaderboardOptIn\" : true }"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", c.csrf)
	req.Header.Set("Idempotency-Key", "canonical-visibility-a")
	res, err := c.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var profile map[string]any
	if err = json.NewDecoder(res.Body).Decode(&profile); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || res.Header.Get("Idempotency-Replayed") != "true" || res.Header.Get("X-User-Id") != u["id"] || profile["userId"] != u["id"] || profile["leaderboardOptIn"] != false || profile["revision"] != latest["revision"] {
		t.Fatalf("canonical replay headers=%v profile=%#v", res.Header, profile)
	}
}

func TestStatsExistingUsersDefaultPrivateOnSchemaUpgrade(t *testing.T) {
	zero := 0
	config := Config{DBPath: filepath.Join(t.TempDir(), "legacy.db"), HistoryDays: &zero}
	a, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(a.Handler())
	c := newClient(t, ts.URL)
	c.register(t, "stats_legacy")
	a.mu.Lock()
	before, err := a.engine.Export()
	revision := a.runtime.Revision
	if err == nil {
		_, err = a.db.Exec("DROP TABLE player_preferences")
	}
	a.mu.Unlock()
	ts.Close()
	a.Close()
	if err != nil {
		t.Fatal(err)
	}
	a, err = New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	ts = httptest.NewServer(a.Handler())
	defer ts.Close()
	c.base = ts.URL
	profile := statsJSON(t, c, "GET", "/api/profile", nil)
	if profile["leaderboardOptIn"] != false {
		t.Fatalf("existing user opted in: %#v", profile)
	}
	board := statsJSON(t, c, "GET", "/api/leaderboard", nil)
	if len(board["entries"].([]any)) != 0 {
		t.Fatalf("existing user listed: %#v", board)
	}
	a.mu.Lock()
	after, err := a.engine.Export()
	afterRevision := a.runtime.Revision
	a.mu.Unlock()
	if err != nil || !bytes.Equal(before, after) || revision != afterRevision {
		t.Fatalf("preferences migration or reads changed market: err=%v revision=%d/%d", err, revision, afterRevision)
	}
}
