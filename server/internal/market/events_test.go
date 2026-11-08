package market

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
)

func eventEngine(t *testing.T) *Engine {
	t.Helper()
	zero := 0
	e, err := New(Options{Seed: "external-market", HistoryDays: &zero, EventSeed: "private-test-events"})
	if err != nil {
		t.Fatal(err)
	}
	e.AddPlayer("alice")
	e.AddPlayer("bob")
	return e
}
func testEventPlan(e *Engine, seconds int64) externalEventPlan {
	return externalEventPlan{Time: timestamp(e.s.Date, seconds), Tick: e.s.Tick + tradingOrdinal(seconds) - tradingOrdinal(e.s.Seconds), DayIndex: e.s.DayIndex, Category: "disaster", Severity: "extreme", Scope: "company", Impact: "negative", Symbols: []string{"600301"}, Shock: -.34}
}
func TestExternalEventSeedIsolationAndPublication(t *testing.T) {
	e := eventEngine(t)
	before, _ := e.Clone()
	wallets, _ := json.Marshal(e.s.Wallets)
	rng := e.s.RNG
	companyRNG := e.s.Companies[0].RNG
	plan := testEventPlan(e, e.s.Seconds)
	e.s.Events.Plans = []externalEventPlan{plan}
	if err := e.publishExternalEvent(plan); err != nil {
		t.Fatal(err)
	}
	afterWallets, _ := json.Marshal(e.s.Wallets)
	if !bytes.Equal(wallets, afterWallets) || e.s.RNG != rng || e.s.Companies[0].RNG != companyRNG {
		t.Fatal("announcement mutated exchange wallets or old RNG")
	}
	for i, q := range e.s.Stocks {
		old := before.s.Stocks[i]
		if q.Last != old.Last || !reflect.DeepEqual(q.MinuteBars, old.MinuteBars) || !reflect.DeepEqual(q.DailyBars, old.DailyBars) {
			t.Fatal("announcement directly set market price")
		}
		if q.Symbol == "600301" {
			if q.Fundamental >= old.Fundamental {
				t.Fatal("negative event belief missing")
			}
		} else if q.Fundamental != old.Fundamental || q.Sentiment != old.Sentiment {
			t.Fatal("company event leaked scope")
		}
	}
	a, b := snap(t, e, "alice"), snap(t, e, "bob")
	if a.News[0].Kind != "external" || a.News[0].Event == nil || !reflect.DeepEqual(a.News, b.News) {
		t.Fatal("shared public event missing")
	}
	if err := e.publishExternalEvent(plan); err == nil {
		t.Fatal("duplicate announcement accepted")
	}
	public, _ := json.Marshal(a)
	if bytes.Contains(public, []byte(e.s.Events.Key)) || bytes.Contains(public, []byte("Plans")) {
		t.Fatal("future private state exposed")
	}
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal(err)
	}
}
func TestExternalEventDecayAndDeterministicReplay(t *testing.T) {
	e := eventEngine(t)
	e.s.Events.Plans = []externalEventPlan{testEventPlan(e, e.s.Seconds+30)}
	control, _ := e.Clone()
	control.s.Events.Disabled = true
	control.s.Events.Plans = []externalEventPlan{}
	e.Step(1)
	control.Step(1)
	for i, q := range e.s.Stocks {
		if q.Last != control.s.Stocks[i].Last || q.Turnover != control.s.Stocks[i].Turnover {
			t.Fatal("event traded before publication")
		}
	}
	at := e.s.Events.Records[0].Tick
	s0, r0 := e.eventResponseAt("600301", at)
	s1, r1 := e.eventResponseAt("600301", at+240)
	if math.Abs(s1-s0/2) > 1e-12 || math.Abs(r1-r0/2) > 1e-12 {
		t.Fatal("half-life is not 240 trading ticks")
	}
	if s, r := e.eventResponseAt("600301", at+1440); s != 0 || r != 0 {
		t.Fatal("effect did not expire")
	}
	if s, r := e.eventResponseAt("600101", at); s != 0 || r != 0 {
		t.Fatal("response outside scope")
	}
	restored, err := Restore(serialized(t, e))
	if err != nil {
		t.Fatal(err)
	}
	e.Step(40)
	for i := 0; i < 40; i++ {
		restored.Step(1)
	}
	if !bytes.Equal(serialized(t, e), serialized(t, restored)) {
		t.Fatal("events broke batch/restore determinism")
	}
	q := e.findStock("600301")
	if q.Volume <= control.findStock("600301").Volume || q.Last < q.LimitDown || q.Last > q.LimitUp {
		t.Fatal("event bypassed matching/band")
	}
}
func TestEventPrivateSeedAndNoEventGoldenPath(t *testing.T) {
	a := eventEngine(t)
	b := eventEngine(t)
	if !bytes.Equal(serialized(t, a), serialized(t, b)) {
		t.Fatal("fixed private seed not deterministic")
	}
	zero := 0
	c, _ := New(Options{Seed: "external-market", HistoryDays: &zero, EventSeed: "another-private"})
	if a.s.Events.Key == c.s.Events.Key || a.s.RNG != c.s.RNG {
		t.Fatal("event stream isolation")
	}
	x, _ := New(Options{Seed: "same-public", HistoryDays: &zero})
	y, _ := New(Options{Seed: "same-public", HistoryDays: &zero})
	if x.s.Events.Key == y.s.Events.Key {
		t.Fatal("production events predictable from public seed")
	}
	a.s.Events.Plans = []externalEventPlan{}
	b.s.Events.Plans = []externalEventPlan{}
	b.s.Events.Disabled = true
	a.Step(50)
	b.Step(50)
	a.s.Events = nil
	b.s.Events = nil
	if !bytes.Equal(serialized(t, a), serialized(t, b)) {
		t.Fatal("inactive events consumed market/company RNG")
	}
}
func TestEventSaveMigrationAndRequiredState(t *testing.T) {
	e := eventEngine(t)
	raw := serialized(t, e)
	var doc map[string]json.RawMessage
	json.Unmarshal(raw, &doc)
	if string(doc["schemaVersion"]) != "5" {
		t.Fatal("not schema 5")
	}
	var data map[string]json.RawMessage
	json.Unmarshal(doc["data"], &data)
	delete(data, "Events")
	doc["data"], _ = json.Marshal(data)
	missing, _ := json.Marshal(doc)
	if _, err := Restore(missing); err == nil {
		t.Fatal("schema5 missing event state accepted")
	}
	doc["schemaVersion"] = json.RawMessage("4")
	legacy, _ := json.Marshal(doc)
	migrated, err := Restore(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.s.Events == nil || migrated.s.Events.StartAt != e.Clock().Timestamp {
		t.Fatal("legacy baseline wrong")
	}
	migrated.s.Events = nil
	e.s.Events = nil
	if !bytes.Equal(serialized(t, migrated), serialized(t, e)) {
		t.Fatal("migration rewrote original market")
	}
	roundTrip, err := Restore(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, serialized(t, roundTrip)) {
		t.Fatal("schema5 reload resampled event")
	}
}

func TestEventRequiredEmbeddedFields(t *testing.T) {
	e := eventEngine(t)
	p := testEventPlan(e, e.s.Seconds)
	e.s.Events.Plans = []externalEventPlan{p}
	if err := e.publishExternalEvent(p); err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	json.Unmarshal(serialized(t, e), &doc)
	records := doc["data"].(map[string]any)["Events"].(map[string]any)["Records"].([]any)
	delete(records[0].(map[string]any), "DayIndex")
	raw, _ := json.Marshal(doc)
	if _, err := Restore(raw); err == nil {
		t.Fatal("missing embedded event day accepted")
	}
}

func TestExternalMigrationReferenceFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../test-results/pre-events-go4-engine.json")
	if os.IsNotExist(err) {
		t.Skip("optional real Go4 baseline fixture")
	}
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := os.ReadFile("../../../test-results/pre-events-go4-snapshots.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected map[string]json.RawMessage
	json.Unmarshal(baseline, &expected)
	e, err := Restore(raw)
	if err != nil {
		t.Fatal(err)
	}
	for id, before := range expected {
		var want MarketSnapshot
		if err = json.Unmarshal(before, &want); err != nil {
			t.Fatal(err)
		}
		actual := snap(t, e, id)
		if !reflect.DeepEqual(actual, want) {
			t.Fatal("real v4 snapshot changed", id)
		}
	}
	var old, newDoc map[string]json.RawMessage
	json.Unmarshal(raw, &old)
	json.Unmarshal(serialized(t, e), &newDoc)
	var a, b map[string]any
	json.Unmarshal(old["data"], &a)
	json.Unmarshal(newDoc["data"], &b)
	delete(b, "Events")
	ma, _ := json.Marshal(a)
	mb, _ := json.Marshal(b)
	if !bytes.Equal(ma, mb) {
		t.Fatal("real v4 internal fields changed")
	}
}
func minimalScheduler(t *testing.T, seed string) *Engine {
	t.Helper()
	s := &state{Date: "2026-11-09", Seconds: openSeconds, Stocks: []*stock{}, News: []NewsItem{}}
	for _, u := range universe {
		s.Stocks = append(s.Stocks, &stock{Symbol: u.Symbol, Name: u.Name, Sector: u.Sector, Last: u.Price, Fundamental: float64(u.Price)})
	}
	v, err := newEventState(Options{EventSeed: seed}, s)
	if err != nil {
		t.Fatal(err)
	}
	s.Events = v
	return &Engine{s: s}
}
func TestExternalEventSchedulerStatistics(t *testing.T) {
	if testing.Short() {
		t.Skip("million-day scheduler sample")
	}
	counts := map[string]int64{}
	var events, gaps, gapTotal int64
	for run := 0; run < 10; run++ {
		e := minimalScheduler(t, fmt.Sprintf("event-frequency-%d", run))
		last := int64(-1)
		for day := 0; day < 100000; day++ {
			e.scheduleEvents()
			if len(e.s.Events.Plans) > 0 {
				p := e.s.Events.Plans[0]
				if last >= 0 {
					gap := p.DayIndex - last
					if gap < 4 {
						t.Fatal("cooldown violated")
					}
					gaps++
					gapTotal += gap
				}
				last = p.DayIndex
				events++
				counts[p.Scope]++
				counts[p.Impact]++
				counts[p.Severity]++
				_, e.s.Seconds = eventDateAndSeconds(p.Time)
				e.s.Tick = p.Tick
				if err := e.publishExternalEvent(p); err != nil {
					t.Fatal(err)
				}
			}
			e.s.Tick += 480 - tradingOrdinal(e.s.Seconds)
			e.s.Seconds = openSeconds
			e.s.DayIndex++
			e.s.Date = shiftDate(e.s.Date, 1)
		}
	}
	mean := float64(gapTotal) / float64(gaps)
	if math.Abs(mean-100) > 4 || events < 9600 || events > 10400 {
		t.Fatal("event frequency", events, mean)
	}
	for key, want := range map[string]float64{"market": .15, "sector": .45, "company": .40, "positive": .5, "negative": .5, "extreme": .2} {
		if math.Abs(float64(counts[key])/float64(events)-want) > .025 {
			t.Fatal("event distribution", key, counts[key], events)
		}
	}
	t.Logf("1000000 scheduler-days: events=%d mean interval=%.4f days counts=%v", events, mean, counts)
}
func TestExternalEventUIFixture(t *testing.T) {
	path := os.Getenv("STOCKSIM_EVENT_FIXTURE_PATH")
	if path == "" {
		t.Skip("explicit offline fixture output only")
	}
	seed := os.Getenv("STOCKSIM_EVENT_FIXTURE_SEED")
	if seed == "" {
		for i := 0; i < 200000; i++ {
			candidate := fmt.Sprintf("external-ui-%d", i)
			e := minimalScheduler(t, candidate)
			e.s.Seconds = openSeconds + 300
			e.s.Tick = 10
			e.s.Events.StartAt = timestamp(e.s.Date, e.s.Seconds)
			e.s.Events.StartTick = 10
			e.scheduleEvents()
			if len(e.s.Events.Plans) > 0 && e.s.Events.Plans[0].Time <= timestamp(e.s.Date, openSeconds+420) {
				seed = candidate
				break
			}
		}
	}
	if seed == "" {
		t.Fatal("no fixture seed in search")
	}
	zero := 0
	e, err := New(Options{Seed: "external-ui-market", EventSeed: seed, HistoryDays: &zero})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range strings.Split(os.Getenv("STOCKSIM_EVENT_PLAYER_IDS"), ",") {
		if id != "" {
			if err = e.AddPlayer(id); err != nil {
				t.Fatal(err)
			}
		}
	}
	if len(e.s.Events.Plans) != 1 {
		t.Fatal("fixture did not schedule day0")
	}
	p := e.s.Events.Plans[0]
	raw := serialized(t, e)
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("OFFLINE FAKE FIXTURE seed=%q due=%s day=%d time=%d symbols=%v direction=%s severity=%s category=%s path=%s", seed, e.s.Date, p.DayIndex, p.Time, p.Symbols, p.Impact, p.Severity, p.Category, path)
}

func TestExternalAnnouncementCannotDisappearInsideNewsWindow(t *testing.T) {
	e := eventEngine(t)
	p := testEventPlan(e, e.s.Seconds)
	e.s.Events.Plans = []externalEventPlan{p}
	if err := e.publishExternalEvent(p); err != nil {
		t.Fatal(err)
	}
	e.s.News = e.s.News[1:]
	if _, err := Restore(serialized(t, e)); err == nil {
		t.Fatal("active event restored without its public announcement")
	}
}

func TestExternalAnnouncementMayExpireBeyondNewsWindow(t *testing.T) {
	e := eventEngine(t)
	p := testEventPlan(e, e.s.Seconds)
	e.s.Events.Plans = []externalEventPlan{p}
	if err := e.publishExternalEvent(p); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		e.s.Seq++
		e.prependNews(NewsItem{ID: fmt.Sprintf("N%d", e.s.Seq), Time: e.Clock().Timestamp, Headline: "later announcement", Body: "fixture", Scope: "market", Symbols: []string{}, Impact: "neutral"})
	}
	for _, n := range e.s.News {
		if n.Kind == "external" {
			t.Fatal("fixture did not trim event")
		}
	}
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal("naturally expired announcement rejected", err)
	}
}

func TestExternalEventsProduceLargeBoundedMatchedMoves(t *testing.T) {
	for _, scope := range []string{"company", "sector", "market"} {
		for _, direction := range []string{"positive", "negative"} {
			t.Run(scope+"/"+direction, func(t *testing.T) {
				e := eventEngine(t)
				p := testEventPlan(e, e.s.Seconds+30)
				p.Category = "policy"
				p.Scope = scope
				p.Impact = direction
				p.Shock = .34
				if direction == "negative" {
					p.Shock = -.34
				}
				if scope == "sector" {
					p.Symbols = []string{"600301", "600302"}
				} else if scope == "market" {
					p.Symbols = []string{}
					for _, q := range e.s.Stocks {
						p.Symbols = append(p.Symbols, q.Symbol)
					}
				}
				e.s.Events.Plans = []externalEventPlan{p}
				e.Step(1)
				before := e.findStock("600301").Last
				volume := e.findStock("600301").Volume
				e.Step(90)
				after := e.findStock("600301")
				move := (float64(after.Last)/float64(before) - 1) * 100
				if math.Abs(move) < 3 {
					t.Fatalf("deterministic strong-event fixture had only %.3f%% move", move)
				}
				if after.Volume <= volume {
					t.Fatal("price moved without new trades")
				}
				for _, q := range e.s.Stocks {
					if q.Last < q.LimitDown || q.Last > q.LimitUp {
						t.Fatal("price limit bypass")
					}
					for _, tr := range q.Tape {
						if tr.Price < q.LimitDown || tr.Price > q.LimitUp {
							t.Fatal("trade outside band")
						}
					}
				}
				if _, err := Restore(serialized(t, e)); err != nil {
					t.Fatal(err)
				}
				t.Logf("90 post-announcement ticks: symbol=600301 move=%+.3f%% addedVolume=%d", move, after.Volume-volume)
			})
		}
	}
}
