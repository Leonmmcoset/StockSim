package market

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

// This fixture separates an excluded partial day's 50% gain, a full day's
// 20% loss, and a still-open day's gain. The counters exceed trade retention.
func performanceFixture() *Engine {
	e := &Engine{s: &state{Date: "2026-11-16", DayIndex: 5, Seconds: 36000,
		Players: map[string]*player{}, Wallets: []*wallet{newWallet("player", 191664, 0)}}}
	p := &player{ID: "alice", InitialCash: 100000, FeesPaid: 1700}
	e.s.Players[p.ID] = p
	p.Review.CoverageStartAt = timestamp("2026-11-09", 34500)
	values := []int64{100000, 150000, 165000, 132000, 145200, 174240, 191664}
	for i := range 6 {
		date := shiftDate("2026-11-09", i)
		start, end := openSeconds, closeSeconds
		if i == 0 {
			start = 34500
		}
		if i == 5 {
			end = 36000
		}
		p.Review.Days = append(p.Review.Days, &reviewDay{DayIndex: int64(i), Date: date, Partial: i == 0, Closed: i != 5, Points: []observation{
			{Time: timestamp(date, start), Equity: values[i]},
			{Time: timestamp(date, end), Equity: values[i+1], BuyCount: 6001, SellCount: 1002},
		}})
	}
	return e
}

func assertPerformancePct(t *testing.T, got *float64, want float64) {
	t.Helper()
	if got == nil || math.Abs(*got-want) > 1e-9 {
		t.Fatalf("percentage got %v, want %.9f", got, want)
	}
}

func TestPlayerPerformanceUsesGlobalWindowAndLifetimeCounters(t *testing.T) {
	e := performanceFixture()
	s, err := e.PlayerPerformance("alice")
	if err != nil {
		t.Fatal(err)
	}
	assertPerformancePct(t, s.TotalReturnPct, 91.664)
	assertPerformancePct(t, s.Recent5.ReturnPct, 27.776)
	assertPerformancePct(t, s.Drawdown.MaxDrawdownPct, 20)
	if s.TotalPnl != 91664 || s.Equity != 191664 || s.Recent5.NetPnl == nil || *s.Recent5.NetPnl != 41664 {
		t.Fatal("net account/window returns", s)
	}
	if !s.Recent5.Complete || s.Recent5.CoveredDays != 5 || s.Recent5.RequestedStartDayIndex != 1 || s.Recent5.StartAt != timestamp("2026-11-10", openSeconds) || s.Recent5.StartAt != s.Recent5.RequestedStartAt || s.Recent5.EndAt != timestamp("2026-11-16", 36000) {
		t.Fatal("window must start at shared day 1 open", s.Recent5)
	}
	if s.JoinedAt != timestamp("2026-11-09", 34500) || s.Drawdown.StartAt != s.JoinedAt || s.Drawdown.EndAt != s.Recent5.EndAt || s.Drawdown.RetentionDays != 30 {
		t.Fatal("observed drawdown coverage", s)
	}
	if s.FillCount != 7003 || s.BuyFillCount != 6001 || s.SellFillCount != 1002 || s.FeesPaid != 1700 {
		t.Fatal("lifetime fills must survive the 5000 trade retention cap", s)
	}
}

func TestPlayerPerformanceBestWorstExcludePartialAndOpenDays(t *testing.T) {
	e := performanceFixture()
	s, err := e.PlayerPerformance("alice")
	if err != nil {
		t.Fatal(err)
	}
	if s.BestDay == nil || s.WorstDay == nil || s.BestDay.DayIndex != 4 || s.WorstDay.DayIndex != 2 || s.ClosedDayCount != 4 || s.ExcludedPartialDayCount != 1 {
		t.Fatal("only complete, closed days are eligible", s)
	}
	assertPerformancePct(t, s.BestDay.ReturnPct, 20)
	assertPerformancePct(t, s.WorstDay.ReturnPct, -20)
	// Make the latest full day's return exactly the same as day 1: earlier wins.
	e.s.Players["alice"].Review.Days[4].Points[1].Equity = 159720
	s, _ = e.PlayerPerformance("alice")
	if s.BestDay.DayIndex != 1 {
		t.Fatal("equal daily returns must choose earliest day", s.BestDay)
	}
}

func TestPlayerPerformanceLateAndEarlyWorldCoverage(t *testing.T) {
	e := performanceFixture()
	p := e.s.Players["alice"]
	p.Review.Days = p.Review.Days[5:]
	p.Review.Days[0].Partial = true
	p.Review.Days[0].Points[0].Time += 300000
	p.Review.CoverageStartAt = p.Review.Days[0].Points[0].Time
	s, _ := e.PlayerPerformance("alice")
	if s.Recent5.Complete || s.Recent5.CoveredDays != 1 || s.Recent5.StartAt != s.JoinedAt || s.Recent5.RequestedStartAt >= s.JoinedAt || s.BestDay != nil || s.WorstDay != nil {
		t.Fatal("late join must preserve the actual baseline", s)
	}
	assertPerformancePct(t, s.Recent5.ReturnPct, 10)

	e = testEngine(t)
	s, _ = e.PlayerPerformance("alice")
	if s.Recent5.Complete || s.Recent5.CoveredDays != 1 || s.Recent5.RequestedStartDayIndex != 0 || s.Recent5.StartAt != s.JoinedAt {
		t.Fatal("a new world does not have five days of coverage", s)
	}
	assertPerformancePct(t, s.Recent5.ReturnPct, 0)
}

func TestPlayerPerformanceFiveDayCoverageBoundary(t *testing.T) {
	for _, tc := range []struct {
		name     string
		day      int64
		atOpen   bool
		complete bool
	}{
		{"only-four-global-days-even-at-open", 3, true, false},
		{"five-global-days-from-open", 4, true, true},
		{"five-global-days-but-late-first-baseline", 4, false, false},
		{"warmup-first-day-outside-window", 5, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := performanceFixture()
			e.s.DayIndex = tc.day
			e.s.Date = shiftDate("2026-11-09", int(tc.day))
			p := e.s.Players["alice"]
			p.Review.Days = p.Review.Days[:tc.day+1]
			if tc.atOpen {
				p.Review.Days[0].Partial = false
				p.Review.Days[0].Points[0].Time = timestamp("2026-11-09", openSeconds)
			}
			s, _ := e.PlayerPerformance("alice")
			if s.Recent5.Complete != tc.complete {
				t.Fatal("incorrect complete five-day coverage", s.Recent5)
			}
		})
	}
}

func TestPlayerPerformanceRealRetentionKeepsJoinAndLifetimeBaseline(t *testing.T) {
	e := testEngine(t)
	before, _ := e.PlayerPerformance("alice")
	buyShares(t, e, "alice", 100)
	for range 31 {
		e.NextDay()
	}
	s, _ := e.PlayerPerformance("alice")
	a := snap(t, e, "alice").Account
	if s.JoinedAt != before.JoinedAt || s.Drawdown.StartAt <= s.JoinedAt || len(e.s.Players["alice"].Review.Days) != 30 || s.TotalPnl != a.Equity-500000 || s.FillCount == 0 || !s.Recent5.Complete {
		t.Fatal("retention changed the lifetime baseline or coverage", s.PlayerMetrics)
	}
	assertPerformancePct(t, s.TotalReturnPct, a.TotalPnlPct)
	restored, err := Restore(serialized(t, e))
	if err != nil {
		t.Fatal(err)
	}
	again, _ := restored.PlayerPerformance("alice")
	if !reflect.DeepEqual(s, again) {
		t.Fatal("reload changed derived performance")
	}
}

func TestPlayerPerformanceDrawdownIncludesCrossDayPeak(t *testing.T) {
	e := performanceFixture()
	p := e.s.Players["alice"]
	p.Review.Days = p.Review.Days[:3]
	for i, endpoints := range [][2]int64{{100000, 200000}, {200000, 180000}, {180000, 100000}} {
		p.Review.Days[i].Points[0].Equity = endpoints[0]
		p.Review.Days[i].Points[1].Equity = endpoints[1]
	}
	s, _ := e.PlayerPerformance("alice")
	assertPerformancePct(t, s.Drawdown.MaxDrawdownPct, 50)
}

func TestPlayerPerformanceRetentionDoesNotClaimLifetimeDrawdown(t *testing.T) {
	e := performanceFixture()
	p := e.s.Players["alice"]
	p.Review.Days = p.Review.Days[3:]
	p.Review.Days[0].Compacted = true
	s, _ := e.PlayerPerformance("alice")
	if s.Drawdown.StartAt <= s.JoinedAt || !s.Drawdown.Compacted || len(s.Points) != 6 || s.ClosedDayCount != 2 || s.Recent5.Complete {
		t.Fatal("retention range and compaction must be explicit", s)
	}
	assertPerformancePct(t, s.Drawdown.MaxDrawdownPct, 0)
	assertPerformancePct(t, s.TotalReturnPct, 91.664)
	if s.FillCount != 7003 {
		t.Fatal("retention must not reset lifetime fill count")
	}
}

func TestPlayerRanksCompetitionTiesNullsAndEligibility(t *testing.T) {
	e := testEngine(t)
	for id, cash := range map[string]int64{"alice": 600000, "bob": 600000, "observer": 400000} {
		p := e.s.Players[id]
		e.s.Wallets[p.Owner].Cash = cash
	}
	ids := []string{"observer", "bob", "alice", "bob"}
	before := append([]string{}, ids...)
	rows, err := e.RankPlayers(ids, "totalReturnPct")
	if err != nil || len(rows) != 3 || !reflect.DeepEqual(ids, before) {
		t.Fatal("must deduplicate without changing input", rows, err)
	}
	for i, want := range []struct {
		id   string
		rank int64
	}{{"alice", 1}, {"bob", 1}, {"observer", 3}} {
		if rows[i].PlayerID != want.id || rows[i].Rank == nil || *rows[i].Rank != want.rank {
			t.Fatal("stable competition ranking", rows)
		}
	}
	rows, _ = e.RankPlayers(ids, "recent5ReturnPct")
	for i, want := range []string{"alice", "bob", "observer"} {
		if rows[i].PlayerID != want || rows[i].Rank != nil {
			t.Fatal("incomplete five-day windows have no rank", rows)
		}
	}
	e.s.Players["alice"].InitialCash = 0
	rows, _ = e.RankPlayers(ids, "totalReturnPct")
	if rows[2].PlayerID != "alice" || rows[2].Rank != nil {
		t.Fatal("undefined baseline is unranked and last", rows)
	}
	rows, _ = e.RankPlayers([]string{"bob"}, "totalReturnPct")
	if len(rows) != 1 || rows[0].PlayerID != "bob" {
		t.Fatal("must rank only authorized participants", rows)
	}
	if _, err := e.RankPlayers([]string{"nobody"}, "totalReturnPct"); err == nil {
		t.Fatal("unknown participant accepted")
	}
	if _, err := e.RankPlayers(nil, "bogus"); err == nil {
		t.Fatal("unknown sort accepted")
	}
	rows, err = e.RankPlayers(nil, "totalReturnPct")
	if err != nil || rows == nil || len(rows) != 0 {
		t.Fatal("empty authorized set must be []", rows, err)
	}
}

func TestPlayerRanksDrawdownAscendingAndRecentCompleteFirst(t *testing.T) {
	e := performanceFixture()
	p := e.s.Players["alice"]
	b := *p
	b.ID = "bob"
	b.Review.Days = []*reviewDay{{DayIndex: 5, Date: e.s.Date, Partial: true, Points: []observation{{Time: timestamp(e.s.Date, 35000), Equity: 100000}, {Time: timestamp(e.s.Date, 36000), Equity: 500000}}}}
	e.s.Players[b.ID] = &b
	rows, _ := e.RankPlayers([]string{"alice", "bob"}, "maxDrawdownPct")
	if rows[0].PlayerID != "bob" || rows[0].Rank == nil || *rows[0].Rank != 1 {
		t.Fatal("lower drawdown ranks first", rows)
	}
	rows, _ = e.RankPlayers([]string{"alice", "bob"}, "recent5ReturnPct")
	if rows[0].PlayerID != "alice" || rows[0].Rank == nil || rows[1].Rank != nil {
		t.Fatal("short 400% gain cannot outrank a complete five-day window", rows)
	}
}

func TestPlayerPerformanceReadsDoNotMutateOrExposePortfolio(t *testing.T) {
	e := testEngine(t)
	buyShares(t, e, "alice", 100)
	before := serialized(t, e)
	s, err := e.PlayerPerformance("alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.RankPlayers([]string{"alice", "bob"}, "maxDrawdownPct"); err != nil {
		t.Fatal(err)
	}
	s.Points[0].Equity = 0
	if !bytes.Equal(before, serialized(t, e)) {
		t.Fatal("read mutated state, RNG, or returned aliased points")
	}
	raw, _ := json.Marshal(s)
	var obj map[string]json.RawMessage
	json.Unmarshal(raw, &obj)
	for _, key := range []string{"positions", "orders", "trades", "cash", "marketValue", "playerId"} {
		if _, ok := obj[key]; ok {
			t.Fatal("unexpected portfolio detail", key)
		}
	}
	var points []map[string]json.RawMessage
	json.Unmarshal(obj["points"], &points)
	if len(points) == 0 || len(points[0]) != 3 {
		t.Fatal("curve should expose only time, dayIndex, equity", points)
	}
	if _, err := e.PlayerPerformance("nobody"); err == nil {
		t.Fatal("unknown player accepted")
	}
}
