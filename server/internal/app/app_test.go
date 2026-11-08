package app

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type testClient struct {
	client     *http.Client
	base, csrf string
}

func startTest(t *testing.T) (*App, *httptest.Server) {
	t.Helper()
	zero := 0
	a, err := New(Config{DBPath: filepath.Join(t.TempDir(), "market.db"), HistoryDays: &zero})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	ts := httptest.NewServer(a.Handler())
	t.Cleanup(ts.Close)
	return a, ts
}
func newClient(t *testing.T, base string) *testClient {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	c := &testClient{client: &http.Client{Jar: jar}, base: base}
	status, b := c.req(t, "GET", "/api/session", nil, "")
	if status != 200 {
		t.Fatalf("bootstrap %d %s", status, b)
	}
	var v struct {
		CSRF string `json:"csrfToken"`
	}
	json.Unmarshal(b, &v)
	c.csrf = v.CSRF
	if c.csrf == "" {
		t.Fatal("missing csrf")
	}
	return c
}
func (c *testClient) req(t *testing.T, method, path string, body any, key string) (int, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", c.csrf)
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	res, err := c.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}
func (c *testClient) register(t *testing.T, name string) map[string]any {
	t.Helper()
	status, b := c.req(t, "POST", "/api/register", map[string]any{"username": name, "password": "correct horse battery"}, "")
	if status != 201 {
		t.Fatalf("register %d %s", status, b)
	}
	var v map[string]any
	json.Unmarshal(b, &v)
	c.csrf = v["csrfToken"].(string)
	return v["user"].(map[string]any)
}

// Removing the serialized first-user transaction permits multiple administrators.
func TestConcurrentFirstRegistrationCreatesOneAdmin(t *testing.T) {
	a, ts := startTest(t)
	const n = 6
	clients := make([]*testClient, n)
	for i := range clients {
		clients[i] = newClient(t, ts.URL)
	}
	var wg sync.WaitGroup
	roles := make(chan string, n)
	for i, c := range clients {
		wg.Add(1)
		go func(i int, c *testClient) {
			defer wg.Done()
			u := c.register(t, fmt.Sprintf("user_%d", i))
			roles <- u["role"].(string)
		}(i, c)
	}
	wg.Wait()
	close(roles)
	admins := 0
	for role := range roles {
		if role == "admin" {
			admins++
		}
	}
	if admins != 1 {
		t.Fatalf("admins=%d", admins)
	}
	a.mu.Lock()
	ids := a.engine.PlayerIDs()
	a.mu.Unlock()
	if len(ids) != n {
		t.Fatalf("players=%d", len(ids))
	}
	for _, c := range clients {
		status, b := c.req(t, "GET", "/api/snapshot", nil, "")
		var v struct {
			Snapshot struct {
				Account struct{ InitialCash, Cash int64 }
				Review  struct{ Points []any }
			}
		}
		json.Unmarshal(b, &v)
		if status != 200 || v.Snapshot.Account.InitialCash != 500000 || v.Snapshot.Account.Cash != 500000 {
			t.Fatalf("account %d %s", status, b)
		}
		if v.Snapshot.Review.Points == nil || len(v.Snapshot.Review.Points) != 0 {
			t.Fatalf("ordinary snapshot contains history: %s", b)
		}
	}
}

// Missing CSRF, same-origin checks, role checks, or ban revocation must fail here.
func TestAuthenticationCSRFAndAdminIsolation(t *testing.T) {
	_, ts := startTest(t)
	admin := newClient(t, ts.URL)
	admin.register(t, "administrator")
	player := newClient(t, ts.URL)
	user := player.register(t, "ordinary")
	status, _ := player.req(t, "GET", "/api/admin/users", nil, "")
	if status != 403 {
		t.Fatalf("ordinary admin access %d", status)
	}
	old := player.csrf
	player.csrf = "wrong"
	status, _ = player.req(t, "POST", "/api/orders", map[string]any{}, "csrf-key-1")
	if status != 403 {
		t.Fatalf("csrf %d", status)
	}
	player.csrf = old
	req, _ := http.NewRequest("POST", ts.URL+"/api/orders", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("X-CSRF-Token", old)
	res, _ := player.client.Do(req)
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("cross origin %d", res.StatusCode)
	}
	status, b := admin.req(t, "POST", "/api/admin/users/"+user["id"].(string)+"/ban", map[string]bool{"banned": true}, "")
	if status != 200 {
		t.Fatalf("ban %d %s", status, b)
	}
	status, _ = player.req(t, "GET", "/api/snapshot", nil, "")
	if status != 401 {
		t.Fatalf("banned session %d", status)
	}
}

// A rejected SQLite transaction must not inject a player or consume first admin.
func TestRegistrationPersistenceFailureDoesNotMutateMarket(t *testing.T) {
	a, ts := startTest(t)
	c := newClient(t, ts.URL)
	_, err := a.db.Exec(`CREATE TRIGGER reject_market BEFORE UPDATE ON market_state BEGIN SELECT RAISE(ABORT,'simulated persistence failure'); END`)
	if err != nil {
		t.Fatal(err)
	}
	status, _ := c.req(t, "POST", "/api/register", map[string]string{"username": "failed_user", "password": "correct horse battery"}, "")
	if status != 503 {
		t.Fatalf("failure status=%d", status)
	}
	a.mu.Lock()
	n := len(a.engine.PlayerIDs())
	a.mu.Unlock()
	if n != 0 {
		t.Fatalf("uncommitted players=%d", n)
	}
	var count int
	a.db.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if count != 0 {
		t.Fatalf("uncommitted users=%d", count)
	}
	a.db.Exec("DROP TRIGGER reject_market")
	u := c.register(t, "real_admin")
	if u["role"] != "admin" {
		t.Fatalf("first role %v", u)
	}
}

// Repeating a timed-out request must not add an order; restart must preserve its response and session.
func TestOrderIdempotencyOwnershipAndRestart(t *testing.T) {
	zero := 0
	path := filepath.Join(t.TempDir(), "market.db")
	a, err := New(Config{DBPath: path, HistoryDays: &zero})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	ts := httptest.NewServer(a.Handler())
	defer ts.Close()
	alice := newClient(t, ts.URL)
	alice.register(t, "alice")
	bob := newClient(t, ts.URL)
	bob.register(t, "bobby")
	status, b := alice.req(t, "GET", "/api/snapshot", nil, "")
	var snap SnapshotResponse
	if err = json.Unmarshal(b, &snap); err != nil || status != 200 {
		t.Fatalf("snapshot %d %s", status, b)
	}
	q := snap.Snapshot.Quotes[0]
	for _, other := range snap.Snapshot.Quotes {
		if other.Last < q.Last {
			q = other
		}
	}
	body := map[string]any{"symbol": q.Symbol, "side": "buy", "price": q.Last, "quantity": 100}
	status, first := alice.req(t, "POST", "/api/orders", body, "order-key-0001")
	if status != 200 {
		t.Fatalf("order %d %s", status, first)
	}
	var response commandResponse
	json.Unmarshal(first, &response)
	if !response.Result.OK {
		t.Fatalf("order rejected %s", first)
	}
	status, replay := alice.req(t, "POST", "/api/orders", body, "order-key-0001")
	if status != 200 || !bytes.Equal(first, replay) {
		t.Fatalf("replay differs %d", status)
	}
	body["quantity"] = 200
	status, _ = alice.req(t, "POST", "/api/orders", body, "order-key-0001")
	if status != 409 {
		t.Fatalf("key changed body %d", status)
	}
	body["quantity"] = 100
	if len(response.Snapshot.Orders) != 1 {
		t.Fatalf("orders=%d", len(response.Snapshot.Orders))
	}
	orderID := response.Snapshot.Orders[0].ID
	status, b = bob.req(t, "POST", "/api/orders/"+orderID+"/cancel", struct{}{}, "cancel-key-0001")
	if status != 200 || bytes.Contains(b, []byte(`"ok":true`)) {
		t.Fatalf("cancel another player %d %s", status, b)
	}
	status, b = alice.req(t, "GET", "/api/snapshot", nil, "")
	if status != 200 {
		t.Fatal(status)
	}
	var before SnapshotResponse
	json.Unmarshal(b, &before)
	ts.Close()
	a.Close()
	reopened, err := New(Config{DBPath: path, HistoryDays: &zero})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	ts2 := httptest.NewServer(reopened.Handler())
	defer ts2.Close()
	alice.base = ts2.URL
	status, b = alice.req(t, "GET", "/api/snapshot", nil, "")
	var after SnapshotResponse
	json.Unmarshal(b, &after)
	if status != 200 || after.Snapshot.Clock.Timestamp != before.Snapshot.Clock.Timestamp || after.Snapshot.Account.Cash != before.Snapshot.Account.Cash || len(after.Snapshot.Orders) != 1 {
		t.Fatalf("restart changed state %d %s", status, b)
	}
	status, replay = alice.req(t, "POST", "/api/orders", body, "order-key-0001")
	if status != 200 || !bytes.Equal(first, replay) {
		t.Fatalf("persisted replay %d", status)
	}
}

// Transaction failure must roll back order creation, the result cache, and public revision.
func TestOrderPersistenceFailureRollsBackAndCanRetry(t *testing.T) {
	a, ts := startTest(t)
	c := newClient(t, ts.URL)
	c.register(t, "trader")
	a.mu.Lock()
	before, _ := a.engine.Export()
	revision := a.runtime.Revision
	a.mu.Unlock()
	_, err := a.db.Exec(`CREATE TRIGGER reject_order_save BEFORE UPDATE ON market_state BEGIN SELECT RAISE(ABORT,'disk unavailable'); END`)
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"symbol": "600101", "side": "buy", "price": 850, "quantity": 100}
	status, _ := c.req(t, "POST", "/api/orders", body, "rollback-key-1")
	if status != 503 {
		t.Fatal(status)
	}
	a.mu.Lock()
	after, _ := a.engine.Export()
	afterRevision := a.runtime.Revision
	a.mu.Unlock()
	if !bytes.Equal(before, after) || revision != afterRevision {
		t.Fatal("failed persistence changed live engine")
	}
	var count int
	a.db.QueryRow("SELECT COUNT(*) FROM idempotency").Scan(&count)
	if count != 0 {
		t.Fatal("failed operation was cached")
	}
	a.db.Exec("DROP TRIGGER reject_order_save")
	status, b := c.req(t, "POST", "/api/orders", body, "rollback-key-1")
	if status != 200 {
		t.Fatalf("retry %d %s", status, b)
	}
}

// A public broadcast must be rebuilt for each authenticated player, including after fills.
func TestSSEPrivateSnapshotsAndBanClosesStream(t *testing.T) {
	_, ts := startTest(t)
	alice := newClient(t, ts.URL)
	alice.register(t, "alice")
	bob := newClient(t, ts.URL)
	bobUser := bob.register(t, "bobby")
	connect := func(c *testClient) (*http.Response, *bufio.Scanner) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		t.Cleanup(cancel)
		req, _ := http.NewRequestWithContext(ctx, "GET", c.base+"/api/events", nil)
		res, err := c.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { res.Body.Close() })
		if res.StatusCode != 200 {
			t.Fatal(res.StatusCode)
		}
		scan := bufio.NewScanner(res.Body)
		scan.Buffer(make([]byte, 4096), 4*1024*1024)
		return res, scan
	}
	_, as := connect(alice)
	_, bs := connect(bob)
	read := func(s *bufio.Scanner) SnapshotResponse {
		for s.Scan() {
			if strings.HasPrefix(s.Text(), "data: ") {
				var v SnapshotResponse
				if err := json.Unmarshal([]byte(strings.TrimPrefix(s.Text(), "data: ")), &v); err != nil {
					t.Fatal(err)
				}
				return v
			}
		}
		t.Fatalf("SSE ended: %v", s.Err())
		return SnapshotResponse{}
	}
	a0, b0 := read(as), read(bs)
	if a0.Snapshot.Clock.Timestamp != b0.Snapshot.Clock.Timestamp {
		t.Fatal("different shared clock")
	}
	q := a0.Snapshot.Quotes[0]
	for _, other := range a0.Snapshot.Quotes {
		if other.Last < q.Last {
			q = other
		}
	}
	status, b := alice.req(t, "POST", "/api/orders", map[string]any{"symbol": q.Symbol, "side": "buy", "price": q.Last, "quantity": 100}, "sse-order-0001")
	if status != 200 {
		t.Fatalf("order %d %s", status, b)
	}
	a1, b1 := read(as), read(bs)
	if len(a1.Snapshot.Orders) != 1 || len(b1.Snapshot.Orders) != 0 || len(b1.Snapshot.Trades) != 0 || b1.Snapshot.Account.Cash != 500000 {
		t.Fatal("private account leaked or omitted")
	}
	if a1.Market.Revision != b1.Market.Revision {
		t.Fatal("different broadcast revision")
	}
	status, b = alice.req(t, "POST", "/api/admin/users/"+bobUser["id"].(string)+"/ban", map[string]bool{"banned": true}, "")
	if status != 200 {
		t.Fatalf("ban %d %s", status, b)
	}
	for bs.Scan() {
		if strings.HasPrefix(bs.Text(), "data: ") {
			t.Fatalf("banned stream continued: %s", bs.Text())
		}
	}
}

// Removing server-owned progression or wait-state persistence breaks unattended lunch/close transitions.
func TestServerTickAutomaticallyContinuesLunchAndClose(t *testing.T) {
	a, ts := startTest(t)
	admin := newClient(t, ts.URL)
	admin.register(t, "clock_admin")
	status, b := admin.req(t, "POST", "/api/admin/market", map[string]any{"action": "speed", "speed": 64}, "")
	if status != 200 {
		t.Fatalf("speed %d %s", status, b)
	}
	for i := 0; i < 10; i++ {
		a.mu.Lock()
		phase := a.engine.Clock().Phase
		a.mu.Unlock()
		if phase == "lunch" {
			break
		}
		if err := a.Tick(); err != nil {
			t.Fatal(err)
		}
	}
	a.mu.Lock()
	phase := a.engine.Clock().Phase
	a.mu.Unlock()
	if phase != "lunch" {
		t.Fatalf("expected lunch, got %s", phase)
	}
	if err := a.Tick(); err != nil {
		t.Fatal(err)
	}
	status, _ = admin.req(t, "POST", "/api/admin/market", map[string]any{"action": "pause"}, "")
	if status != 200 {
		t.Fatal(status)
	}
	a.mu.Lock()
	revision := a.runtime.Revision
	a.mu.Unlock()
	if err := a.Tick(); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	wait, afterRevision := a.runtime.PhaseWait, a.runtime.Revision
	a.mu.Unlock()
	if wait != 1 || revision != afterRevision {
		t.Fatalf("pause advanced wait=%d revision=%d/%d", wait, revision, afterRevision)
	}
	status, _ = admin.req(t, "POST", "/api/admin/market", map[string]any{"action": "resume"}, "")
	if status != 200 {
		t.Fatal(status)
	}
	for i := 0; i < 2; i++ {
		if err := a.Tick(); err != nil {
			t.Fatal(err)
		}
	}
	a.mu.Lock()
	phase = a.engine.Clock().Phase
	a.mu.Unlock()
	if phase != "continuous" {
		t.Fatalf("lunch did not resume: %s", phase)
	}
	for i := 0; i < 10; i++ {
		a.mu.Lock()
		phase = a.engine.Clock().Phase
		a.mu.Unlock()
		if phase == "closed" {
			break
		}
		if err := a.Tick(); err != nil {
			t.Fatal(err)
		}
	}
	a.mu.Lock()
	day := a.engine.Clock().DayIndex
	phase = a.engine.Clock().Phase
	a.mu.Unlock()
	if phase != "closed" {
		t.Fatalf("expected close: %s", phase)
	}
	for i := 0; i < 5; i++ {
		if err := a.Tick(); err != nil {
			t.Fatal(err)
		}
	}
	a.mu.Lock()
	nextDay, nextPhase := a.engine.Clock().DayIndex, a.engine.Clock().Phase
	a.mu.Unlock()
	if nextDay != day+1 || nextPhase != "continuous" {
		t.Fatalf("close did not continue %d %s", nextDay, nextPhase)
	}
}

// Parsing must reject extra fields and multiple objects before they can reach engine commands.
func TestStrictJSONAndRegistrationSettings(t *testing.T) {
	_, ts := startTest(t)
	admin := newClient(t, ts.URL)
	u := admin.register(t, "admin_user")
	for _, raw := range []string{`{"action":"pause","role":"admin"}`, `{"action":"pause"} {}`, `null`} {
		req, _ := http.NewRequest("POST", ts.URL+"/api/admin/market", strings.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", admin.csrf)
		res, err := admin.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != 400 {
			t.Fatalf("accepted bad JSON %q status=%d", raw, res.StatusCode)
		}
	}
	status, _ := admin.req(t, "POST", "/api/admin/users/"+u["id"].(string)+"/ban", map[string]bool{"banned": true}, "")
	if status != 409 {
		t.Fatal("admin can ban self")
	}
	status, _ = admin.req(t, "POST", "/api/admin/settings", map[string]bool{"registrationOpen": false}, "")
	if status != 200 {
		t.Fatal(status)
	}
	other := newClient(t, ts.URL)
	status, _ = other.req(t, "POST", "/api/register", map[string]string{"username": "closed", "password": "long enough password"}, "")
	if status != 403 {
		t.Fatal("registration setting ignored")
	}
	status, b := admin.req(t, "GET", "/api/admin/backup", nil, "")
	if status != 200 || !bytes.Contains(b, []byte(`"passwordHash"`)) || bytes.Contains(b, []byte(`"csrfToken"`)) {
		t.Fatalf("backup shape %d", status)
	}
}

// null is not a JSON command object and must never be interpreted as a zero-value order.
func TestOrdersRejectNullObject(t *testing.T) {
	_, ts := startTest(t)
	c := newClient(t, ts.URL)
	c.register(t, "null_tester")
	req, _ := http.NewRequest("POST", ts.URL+"/api/orders", strings.NewReader(`null`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", c.csrf)
	req.Header.Set("Idempotency-Key", "null-body-key")
	res, err := c.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("null was accepted: %d", res.StatusCode)
	}
}

// A session expiry must stop private broadcasts, even when a continuously active market avoids heartbeats.
func TestExpiredSessionCannotReceiveTickBroadcast(t *testing.T) {
	zero := 0
	now := time.Now()
	a, err := New(Config{DBPath: filepath.Join(t.TempDir(), "expiry.db"), HistoryDays: &zero, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	ts := httptest.NewServer(a.Handler())
	defer ts.Close()
	c := newClient(t, ts.URL)
	c.register(t, "expiry_user")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/events", nil)
	res, err := c.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			break
		}
	}
	a.mu.Lock()
	now = now.Add(8 * 24 * time.Hour)
	a.mu.Unlock()
	if err = a.Tick(); err != nil {
		t.Fatal(err)
	}
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			t.Fatal("expired session received another private snapshot")
		}
	}
	if scanner.Err() != nil {
		t.Fatalf("stream did not close promptly: %v", scanner.Err())
	}
	status, _ := c.req(t, "GET", "/api/snapshot", nil, "")
	if status != 401 {
		t.Fatal(status)
	}
}

// Password hashes and complete market state must not become readable by other host users.
func TestDatabaseAndCookiesArePrivate(t *testing.T) {
	zero := 0
	path := filepath.Join(t.TempDir(), "private.db")
	a, err := New(Config{DBPath: path, HistoryDays: &zero, SecureCookies: true})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 {
		t.Fatalf("database permissions=%o", info.Mode().Perm())
	}
	ts := httptest.NewServer(a.Handler())
	defer ts.Close()
	res, err := http.Get(ts.URL + "/api/session")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	cookies := res.Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("insecure cookies: %+v", cookies)
	}
}

// An unsuccessful durable write must not publish a candidate snapshot to already connected players.
func TestFailedOrderDoesNotBroadcast(t *testing.T) {
	a, ts := startTest(t)
	c := newClient(t, ts.URL)
	c.register(t, "failure_stream")
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/events", nil)
	res, err := c.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			break
		}
	}
	_, err = a.db.Exec(`CREATE TRIGGER reject_broadcast BEFORE UPDATE ON market_state BEGIN SELECT RAISE(ABORT,'not durable'); END`)
	if err != nil {
		t.Fatal(err)
	}
	status, _ := c.req(t, "POST", "/api/orders", map[string]any{"symbol": "600101", "side": "buy", "price": 850, "quantity": 100}, "failed-broadcast-key")
	if status != 503 {
		t.Fatal(status)
	}
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			t.Fatal("uncommitted snapshot was broadcast")
		}
	}
	if ctx.Err() == nil {
		t.Fatalf("stream ended unexpectedly: %v", scanner.Err())
	}
}

// Initial persistence failure cannot create half a market; malformed existing data cannot be replaced by New.
func TestInitializationFailureAndCorruptSaveAreNotOverwritten(t *testing.T) {
	zero := 0
	path := filepath.Join(t.TempDir(), "initial.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(schema); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TRIGGER reject_initial BEFORE INSERT ON market_state BEGIN SELECT RAISE(ABORT,'initial save failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if a, initErr := New(Config{DBPath: path, HistoryDays: &zero}); initErr == nil {
		a.Close()
		t.Fatal("initial persistence failure was ignored")
	} else if !strings.Contains(initErr.Error(), "initial save failure") {
		t.Fatalf("wrong initialization failure: %v", initErr)
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	db.QueryRow("SELECT COUNT(*) FROM market_state").Scan(&count)
	if count != 0 {
		t.Fatal("half-initialized market saved")
	}
	if _, err = db.Exec("DROP TRIGGER reject_initial"); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	a, err := New(Config{DBPath: path, HistoryDays: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec("UPDATE market_state SET payload=? WHERE id=1", []byte(`{"broken":true}`)); err != nil {
		t.Fatal(err)
	}
	a.Close()
	if bad, err := New(Config{DBPath: path, HistoryDays: &zero}); err == nil {
		bad.Close()
		t.Fatal("corrupt archive was silently replaced")
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var payload []byte
	if err = db.QueryRow("SELECT payload FROM market_state WHERE id=1").Scan(&payload); err != nil || string(payload) != `{"broken":true}` {
		t.Fatalf("corrupt archive changed: %s %v", payload, err)
	}
}

// A snapshot must identify the authenticated account so a tab can reject another tab's rotated-cookie response.
func TestPrivateEnvelopesBindAuthenticatedUser(t *testing.T) {
	_, ts := startTest(t)
	alice := newClient(t, ts.URL)
	au := alice.register(t, "identity_alice")
	bob := newClient(t, ts.URL)
	bu := bob.register(t, "identity_bob")
	for _, pair := range []struct {
		client *testClient
		id     string
	}{{alice, au["id"].(string)}, {bob, bu["id"].(string)}} {
		for _, path := range []string{"/api/snapshot", "/api/review?range=all"} {
			status, b := pair.client.req(t, "GET", path, nil, "")
			var payload map[string]any
			json.Unmarshal(b, &payload)
			if status != 200 || payload["userId"] != pair.id {
				t.Fatalf("missing authenticated identity %s: status=%d userId=%v", path, status, payload["userId"])
			}
		}
	}
}

// Password login must rotate both credentials; logout must revoke the old session rather than only clearing a cookie.
func TestPasswordLoginRotationAndLogout(t *testing.T) {
	_, ts := startTest(t)
	c := newClient(t, ts.URL)
	user := c.register(t, "login_user")
	registeredCSRF := c.csrf
	status, _ := c.req(t, "POST", "/api/logout", struct{}{}, "")
	if status != 204 {
		t.Fatal(status)
	}
	status, _ = c.req(t, "GET", "/api/snapshot", nil, "")
	if status != 401 {
		t.Fatal("logout left old session usable")
	}
	status, b := c.req(t, "GET", "/api/session", nil, "")
	if status != 200 {
		t.Fatal(status)
	}
	var session struct {
		CSRF string `json:"csrfToken"`
		User *User  `json:"user"`
	}
	json.Unmarshal(b, &session)
	c.csrf = session.CSRF
	if session.User != nil || c.csrf == registeredCSRF {
		t.Fatal("anonymous bootstrap reused logged-out session")
	}
	status, _ = c.req(t, "POST", "/api/login", map[string]string{"username": "LOGIN_USER", "password": "incorrect password"}, "")
	if status != 401 {
		t.Fatal("incorrect password accepted")
	}
	status, b = c.req(t, "POST", "/api/login", map[string]string{"username": "LOGIN_USER", "password": "correct horse battery"}, "")
	if status != 200 {
		t.Fatalf("login %d", status)
	}
	oldCSRF := c.csrf
	json.Unmarshal(b, &session)
	if session.User == nil || session.User.ID != user["id"] || session.CSRF == oldCSRF {
		t.Fatal("login did not rotate and authenticate")
	}
	c.csrf = session.CSRF
	status, _ = c.req(t, "GET", "/api/snapshot", nil, "")
	if status != 200 {
		t.Fatal("authenticated session unusable")
	}
}

// Private auxiliary responses need the same identity binding as snapshot and SSE payloads.
func TestPrivateResponseIdentityHeaders(t *testing.T) {
	_, ts := startTest(t)
	alice := newClient(t, ts.URL)
	au := alice.register(t, "header_alice")
	bob := newClient(t, ts.URL)
	bu := bob.register(t, "header_bob")
	for _, pair := range []struct {
		client *testClient
		id     string
		admin  bool
	}{{alice, au["id"].(string), true}, {bob, bu["id"].(string), false}} {
		paths := []string{"/api/session", "/api/snapshot", "/api/orders/preview"}
		if pair.admin {
			paths = append(paths, "/api/admin/backup")
		}
		for _, path := range paths {
			method := "GET"
			var body io.Reader
			if path == "/api/orders/preview" {
				method = "POST"
				body = strings.NewReader(`{}`)
			}
			req, _ := http.NewRequest(method, ts.URL+path, body)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-CSRF-Token", pair.client.csrf)
			res, err := pair.client.client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode != 200 || res.Header.Get("X-User-Id") != pair.id {
				t.Fatalf("%s identity header=%q status=%d", path, res.Header.Get("X-User-Id"), res.StatusCode)
			}
		}
	}
}

// A stale tab's expected identity must be checked before an order can change the currently authenticated account.
func TestExpectedIdentityMismatchRejectsBeforeOrderMutation(t *testing.T) {
	a, ts := startTest(t)
	c := newClient(t, ts.URL)
	c.register(t, "identity_guard")
	a.mu.Lock()
	before, _ := a.engine.Export()
	revision := a.runtime.Revision
	a.mu.Unlock()
	req, _ := http.NewRequest("POST", ts.URL+"/api/orders", strings.NewReader(`{"symbol":"600101","side":"buy","price":679,"quantity":100}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", c.csrf)
	req.Header.Set("Idempotency-Key", "identity-guard-key")
	req.Header.Set("X-Expected-User-Id", "another-user")
	res, err := c.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("mismatched identity status=%d", res.StatusCode)
	}
	a.mu.Lock()
	after, _ := a.engine.Export()
	afterRevision := a.runtime.Revision
	a.mu.Unlock()
	if !bytes.Equal(before, after) || revision != afterRevision {
		t.Fatal("mismatched identity mutated market")
	}
	status, _ := c.req(t, "GET", "/api/snapshot", nil, "")
	if status != 200 {
		t.Fatal("identity mismatch revoked current cookie")
	}
}

// Two owners of one durable market must never alternate stale in-memory writes to the same file.
func TestDatabaseAllowsOnlyOneLiveOwner(t *testing.T) {
	zero := 0
	path := filepath.Join(t.TempDir(), "single-owner.db")
	first, err := New(Config{DBPath: path, HistoryDays: &zero})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	ts := httptest.NewServer(first.Handler())
	defer ts.Close()
	c := newClient(t, ts.URL)
	user := c.register(t, "single_owner")
	first.mu.Lock()
	before, _ := first.engine.Export()
	revision := first.runtime.Revision
	first.mu.Unlock()
	second, err := New(Config{DBPath: path, HistoryDays: &zero})
	if err == nil {
		second.Close()
		t.Fatal("second owner opened the same market database")
	}
	probe := exec.Command(os.Args[0], "-test.run=^TestDatabaseExclusiveLockSubprocessProbe$")
	probe.Env = append(os.Environ(), "STOCKSIM_TEST_LOCK_DB="+path)
	if output, probeErr := probe.CombinedOutput(); probeErr != nil {
		t.Fatalf("OS-level ownership failed: %v %s", probeErr, output)
	}
	first.mu.Lock()
	after, _ := first.engine.Export()
	afterRevision := first.runtime.Revision
	first.mu.Unlock()
	if !bytes.Equal(before, after) || revision != afterRevision {
		t.Fatal("rejected second owner changed first market")
	}
	status, b := c.req(t, "GET", "/api/snapshot", nil, "")
	var snapshot SnapshotResponse
	json.Unmarshal(b, &snapshot)
	if status != 200 || snapshot.UserID != user["id"] || snapshot.Snapshot.Account.Cash != 500000 {
		t.Fatal("original account changed")
	}
	ts.Close()
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(Config{DBPath: path, HistoryDays: &zero})
	if err != nil {
		t.Fatalf("ownership not released on close: %v", err)
	}
	defer reopened.Close()
	reopened.mu.Lock()
	restored, _ := reopened.engine.Export()
	reopened.mu.Unlock()
	if !bytes.Equal(before, restored) {
		t.Fatal("reopening changed persistent account")
	}
	var version string
	if err = reopened.db.QueryRow("SELECT sqlite_version()").Scan(&version); err != nil {
		t.Fatal(err)
	}
	t.Logf("SQLite runtime: %s", version)
}

// This helper is a separate operating-system process, so a Go-only mutex cannot satisfy the ownership test.
func TestDatabaseExclusiveLockSubprocessProbe(t *testing.T) {
	path := os.Getenv("STOCKSIM_TEST_LOCK_DB")
	if path == "" {
		t.Skip("subprocess lock probe")
	}
	zero := 0
	a, err := New(Config{DBPath: path, HistoryDays: &zero})
	if err == nil {
		a.Close()
		t.Fatal("another process acquired the live database")
	}
}
