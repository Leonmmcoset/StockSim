package market

import (
	"bytes"
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestReviewReconciliationSelectionAndRetention(t *testing.T) {
	e := testEngine(t)
	buyShares(t, e, "alice", 200)
	a := snap(t, e, "alice")
	if a.Review.CurrentDay.Fees != a.Account.FeesPaid || a.Review.CurrentDay.NetPnl != a.Account.TotalPnl || a.Review.CurrentDay.GrossPnl != a.Review.CurrentDay.NetPnl+a.Review.CurrentDay.Fees {
		t.Fatal("initial fee/net reconciliation")
	}
	e.NextDay()
	before := snap(t, e, "alice")
	q := before.Quotes[0]
	r := e.PlaceOrder("alice", OrderInput{q.Symbol, "sell", q.Bids[0].Price, 100})
	if !r.OK || r.Order.Filled != 100 {
		t.Fatal(r)
	}
	after := snap(t, e, "alice")
	beforeUnreal := before.Account.Positions[0].Pnl
	afterUnreal := after.Account.Positions[0].Pnl
	d := after.Review.CurrentDay
	if d.UnrealizedPnlChange != afterUnreal-beforeUnreal || d.NetPnl != d.RealizedPnl+d.UnrealizedPnlChange {
		t.Fatal("unrealized change and realized split")
	}
	all, err := e.GetReview("alice", ReviewPeriod{Kind: "all"})
	if err != nil {
		t.Fatal(err)
	}
	last := all.Points[len(all.Points)-1]
	if all.Summary.NetPnl != last.Equity-500000 || all.Summary.RealizedPnl != after.Account.RealizedPnl || all.Summary.Fees != after.Account.FeesPaid {
		t.Fatal("period reconciliation")
	}
	if last.ReturnPct == nil || math.Abs(*last.ReturnPct-float64(all.Summary.NetPnl)/500000*100) > 1e-10 {
		t.Fatal("normalization")
	}
	benchmark := (last.IndexValue/all.Points[0].IndexValue - 1) * 100
	if last.BenchmarkReturnPct != benchmark {
		t.Fatal("benchmark mismatch")
	}
	for i := 0; i < 31; i++ {
		e.NextDay()
	}
	s := snap(t, e, "alice")
	if len(s.Review.Days) != 29 || len(s.Review.Points) > 15000 {
		t.Fatal("review retention")
	}
	for _, p := range s.Review.Points {
		if p.DayIndex < s.Clock.DayIndex-29 {
			t.Fatal("expired point retained")
		}
	}
	if _, err := e.GetReview("alice", ReviewPeriod{Kind: "day", DayIndex: 0}); err == nil {
		t.Fatal("unknown old day")
	}
	recent, err := e.GetReview("alice", ReviewPeriod{Kind: "recent", Days: 5})
	if err != nil || recent.Summary.DayCount != 5 {
		t.Fatal("recent days", err)
	}
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal(err)
	}
}
func TestReviewCompactionKeepsObservedDrawdown(t *testing.T) {
	e := testEngine(t)
	p := e.s.Players["alice"]
	d := p.Review.Days[0]
	base := d.Points[0]
	d.Points = nil
	for i := 0; i < 2500; i++ {
		v := base
		v.Equity = 200000 + int64(i%2)
		if i == 3 {
			v.Equity = 220000
		}
		if i == 997 {
			v.Equity = 180000
		}
		v.MarketValue = v.Equity
		v.Cash = 0
		d.Points = append(d.Points, v)
	}
	want := 40000. / 220000 * 100
	compactReview(d, false)
	for len(d.Points) > 1024 {
		compactReview(d, false)
	}
	if !d.Compacted || math.Abs(dailyReview(d).MaxDrawdownPct-want) > 1e-12 {
		t.Fatal("drawdown extrema lost")
	}
	hasPeak, hasTrough := false, false
	for _, v := range d.Points {
		hasPeak = hasPeak || v.Equity == 220000
		hasTrough = hasTrough || v.Equity == 180000
	}
	if !hasPeak || !hasTrough {
		t.Fatal("anchors missing")
	}
	peak, trough := base, base
	peak.Equity = 230000
	trough.Equity = 190000
	d.Points = append(d.Points, peak, trough)
	if math.Abs(dailyReview(d).MaxDrawdownPct-want) > 1e-12 {
		t.Fatal("later observation forgot prior worst")
	}
	zero := NormalizeEquityCurve([]EquityPoint{{Equity: 0, IndexValue: 1000}, {Equity: 100, IndexValue: 1010}})
	if zero[0].ReturnPct != nil || zero[1].ReturnPct != nil || zero[1].ExcessReturnPct != nil {
		t.Fatal("zero baseline fabricated return")
	}
}
func TestSnapshotDoesNotAliasEngineOrExposeNullCollections(t *testing.T) {
	e := testEngine(t)
	before := serialized(t, e)
	s := snap(t, e, "alice")
	s.Quotes[0].Bids[0].Quantity = 0
	s.Companies[0].Reports[0].NetProfit = 0
	s.Review.Points[0].Equity = 0
	if !bytes.Equal(before, serialized(t, e)) {
		t.Fatal("snapshot aliases state")
	}
	b, _ := json.Marshal(snap(t, e, "alice"))
	var v map[string]any
	json.Unmarshal(b, &v)
	for _, key := range []string{"quotes", "orders", "trades", "news", "companies"} {
		if _, ok := v[key].([]any); !ok {
			t.Fatal("null array", key)
		}
	}
	account := v["account"].(map[string]any)
	if _, ok := account["positions"].([]any); !ok {
		t.Fatal("null positions")
	}
	review := v["review"].(map[string]any)
	for _, key := range []string{"points", "days"} {
		if _, ok := review[key].([]any); !ok {
			t.Fatal("null review array", key)
		}
	}
}
func TestPlayersJoiningDuringLunchAndClosedHaveTrueBaselines(t *testing.T) {
	zero := 0
	e, _ := New(Options{HistoryDays: &zero})
	e.Step(1000)
	e.AddPlayer("lunch")
	s := snap(t, e, "lunch")
	if len(s.Review.Points) != 1 || s.Review.Points[0].Time != s.Clock.Timestamp || s.Review.CurrentDay.NetPnl != 0 || !s.Review.CurrentDay.Partial {
		t.Fatal("lunch join")
	}
	e.SkipLunch()
	e.Step(1000)
	e.AddPlayer("closed")
	c := snap(t, e, "closed")
	if len(c.Review.Points) != 1 || c.Review.CurrentDay.Status != "closed" || c.Review.CurrentDay.NetPnl != 0 {
		t.Fatal("closed join")
	}
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal(err)
	}
	e.NextDay()
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal(err)
	}
}
func TestCompanyReleaseDoesNotSetPriceOrInjectWalletMoney(t *testing.T) {
	e := testEngine(t)
	q := e.s.Stocks[0]
	beforePrice, beforeCash, beforeRNG := q.Last, e.s.TotalCash, e.s.RNG
	up, down := *q, *q
	r := e.s.Companies[0].Reports[0]
	r.ProfitSurprisePct = 20
	r.RevenueSurprisePct = 0
	applyEarningsSignal(&up, r)
	r.ProfitSurprisePct = -20
	applyEarningsSignal(&down, r)
	if up.Fundamental <= q.Fundamental || down.Fundamental >= q.Fundamental || up.Last != q.Last || down.Last != q.Last {
		t.Fatal("signal directly set price")
	}
	e.s.Seconds = 36000
	e.releaseDueEarnings()
	if q.Last != beforePrice || e.s.TotalCash != beforeCash || e.s.RNG != beforeRNG {
		t.Fatal("financial release changed exchange ledger/RNG")
	}
	for _, c := range e.s.Companies {
		for _, r := range c.Reports {
			if r.PublishedAt > timestamp(e.s.Date, e.s.Seconds) {
				t.Fatal("future financial disclosure")
			}
		}
	}
}
func TestOperationalCostSample(t *testing.T) {
	if testing.Short() {
		t.Skip("cost sample")
	}
	e := testEngine(t)
	start := time.Now()
	for i := 0; i < 30; i++ {
		e.NextDay()
	}
	simulation := time.Since(start)
	b := serialized(t, e)
	start = time.Now()
	for i := 0; i < 10; i++ {
		if _, err := e.Clone(); err != nil {
			t.Fatal(err)
		}
	}
	clone := time.Since(start) / 10
	start = time.Now()
	if _, err := Restore(b); err != nil {
		t.Fatal(err)
	}
	restore := time.Since(start)
	t.Logf("3 players/30 days: simulation=%s saved=%d bytes clone=%s restore=%s", simulation, len(b), clone, restore)
}
