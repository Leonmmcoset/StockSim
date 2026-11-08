package market

import (
	"bytes"
	"encoding/json"
	"testing"
)

func testEngine(t *testing.T) *Engine {
	t.Helper()
	zero := 0
	e, err := New(Options{DisableEvents: true, EventSeed: "reference-tests", Seed: "go-multiplayer-tests", HistoryDays: &zero})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"alice", "bob", "observer"} {
		if err = e.AddPlayer(id); err != nil {
			t.Fatal(err)
		}
	}
	return e
}
func snap(t *testing.T, e *Engine, id string) MarketSnapshot {
	t.Helper()
	s, err := e.Snapshot(id)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func serialized(t *testing.T, e *Engine) []byte {
	t.Helper()
	b, err := e.Export()
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func TestPlayersIsolatedAndJoinDoesNotAlterMarket(t *testing.T) {
	e := testEngine(t)
	a := snap(t, e, "alice")
	b := snap(t, e, "bob")
	if a.Account.Cash != 500000 || b.Account.Cash != 500000 || len(a.Quotes) != 12 {
		t.Fatal("independent initial capital / market missing")
	}
	before := serialized(t, e)
	if e.AddPlayer("alice") == nil {
		t.Fatal("duplicate player accepted")
	}
	if !bytes.Equal(before, serialized(t, e)) {
		t.Fatal("duplicate join mutated state")
	}
	if err := e.AddPlayer("late"); err != nil {
		t.Fatal(err)
	}
	after := snap(t, e, "alice")
	qa, _ := json.Marshal(a.Quotes)
	qb, _ := json.Marshal(after.Quotes)
	if !bytes.Equal(qa, qb) {
		t.Fatal("join changed prices")
	}
	if _, err := e.Snapshot("nobody"); err == nil {
		t.Fatal("unknown player accepted")
	}
}
func TestOrderIsolationFeesTPlusOneAndCancel(t *testing.T) {
	e := testEngine(t)
	q := snap(t, e, "alice").Quotes[0]
	r := e.PlaceOrder("alice", OrderInput{Symbol: q.Symbol, Side: "buy", Price: q.Asks[0].Price, Quantity: 100})
	if !r.OK || r.Order.Filled != 100 {
		t.Fatalf("buy: %+v", r)
	}
	a := snap(t, e, "alice")
	b := snap(t, e, "bob")
	if len(b.Orders) != 0 || len(b.Trades) != 0 || len(b.Account.Positions) != 0 || b.Account.Cash != 500000 {
		t.Fatal("private account leaked")
	}
	if a.Account.Cash != 500000-r.Order.AvgFillPrice*100-r.Order.Fee || a.Account.Positions[0].Sellable != 0 {
		t.Fatal("cash or T+1")
	}
	if e.CancelOrder("bob", r.Order.ID).Code != "ORDER_NOT_FOUND" {
		t.Fatal("foreign cancellation")
	}
	if e.PlaceOrder("alice", OrderInput{Symbol: q.Symbol, Side: "sell", Price: q.Bids[0].Price, Quantity: 100}).Code != "INSUFFICIENT_SHARES" {
		t.Fatal("same-day sale allowed")
	}
	pending := e.PlaceOrder("bob", OrderInput{Symbol: q.Symbol, Side: "buy", Price: q.LimitDown, Quantity: 100})
	if !pending.OK {
		t.Fatal(pending)
	}
	if !e.CancelOrder("bob", pending.Order.ID).OK || e.CancelOrder("bob", pending.Order.ID).OK {
		t.Fatal("cancel twice")
	}
	if snap(t, e, "bob").Account.Cash != 500000 || snap(t, e, "bob").Account.FrozenCash != 0 {
		t.Fatal("reserve refund")
	}
	e.NextDay()
	if snap(t, e, "alice").Account.Positions[0].Sellable != 100 {
		t.Fatal("next day unlock")
	}
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal(err)
	}
}
func TestBatchRestoreAndPreviewAreDeterministic(t *testing.T) {
	a := testEngine(t)
	before := serialized(t, a)
	_, err := a.PreviewOrder("alice", OrderInput{Symbol: "600101", Side: "buy", Price: 680, Quantity: 100})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, serialized(t, a)) {
		t.Fatal("preview mutated")
	}
	b, err := Restore(before)
	if err != nil {
		t.Fatal(err)
	}
	a.Step(80)
	for i := 0; i < 80; i++ {
		b.Step(1)
	}
	if !bytes.Equal(serialized(t, a), serialized(t, b)) {
		t.Fatal("batch/restore diverged")
	}
	c, err := a.Clone()
	if err != nil {
		t.Fatal(err)
	}
	c.Step(1)
	if bytes.Equal(serialized(t, c), serialized(t, a)) {
		t.Fatal("clone alias or no step")
	}
}
func TestClockHaltsAndExpiresOrders(t *testing.T) {
	e := testEngine(t)
	q := snap(t, e, "alice").Quotes[0]
	r := e.PlaceOrder("alice", OrderInput{q.Symbol, "buy", q.LimitDown, 100})
	e.Step(1000)
	if e.Clock().Phase != "lunch" {
		t.Fatal(e.Clock())
	}
	s := serialized(t, e)
	e.Step(2)
	if !bytes.Equal(s, serialized(t, e)) {
		t.Fatal("lunch advanced")
	}
	e.SkipLunch()
	e.Step(1000)
	if e.Clock().Phase != "closed" {
		t.Fatal(e.Clock())
	}
	a := snap(t, e, "alice")
	if a.Orders[0].ID != r.Order.ID || a.Orders[0].Status != "expired" || a.Account.FrozenCash != 0 {
		t.Fatal("day order not expired")
	}
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal(err)
	}
}
func TestFinancialReportsAndReview(t *testing.T) {
	e := testEngine(t)
	before := snap(t, e, "alice")
	if len(before.Companies) != 12 || len(before.Review.Points) != 1 || before.Review.Points[0].Equity != 500000 {
		t.Fatal("initial reports/review")
	}
	e.Step(49)
	if snap(t, e, "alice").Companies[0].Reports[0].Period != 4 {
		t.Fatal("early financial disclosure")
	}
	e.Step(1)
	s := snap(t, e, "alice")
	r := s.Companies[0].Reports[0]
	if r.Period != 5 || r.PublishedAt != s.Clock.Timestamp || r.Assets != r.Liabilities+r.Equity || r.NetProfit != r.Revenue-r.OperatingCosts-r.Depreciation-r.InterestExpense-r.TaxExpense {
		t.Fatal("financial identity / schedule")
	}
	if s.Review.CurrentDay.NetPnl != 0 || s.Review.CurrentDay.Fees != 0 {
		t.Fatal("empty portfolio invented return")
	}
	selection, err := e.GetReview("alice", ReviewPeriod{Kind: "all"})
	if err != nil || selection.Summary.NetPnl != 0 || len(selection.Points) < 2 {
		t.Fatal("review selection", err)
	}
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal(err)
	}
}
