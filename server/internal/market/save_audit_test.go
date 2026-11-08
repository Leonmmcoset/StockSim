package market

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
)

func TestRestoreRejectsWrappedConservationAndUnsafeIntegers(t *testing.T) {
	e := testEngine(t)
	for name, mutate := range map[string]func(*Engine){
		"cash sum wrap": func(c *Engine) {
			for i := 0; i < 4; i++ {
				c.s.Wallets[i].Cash += 1 << 62
			}
		},
		"share sum wrap": func(c *Engine) {
			for i := 0; i < 4; i++ {
				c.s.Wallets[i].Positions[c.s.Stocks[0].Symbol].Quantity += 1 << 62
			}
		},
		"unsafe JS integer":            func(c *Engine) { c.s.Seq = 1 << 53 },
		"holding exceeds total supply": func(c *Engine) { c.s.Wallets[0].Positions[c.s.Stocks[0].Symbol].Quantity = 4800001 },
	} {
		t.Run(name, func(t *testing.T) {
			c, _ := e.Clone()
			mutate(c)
			if _, err := Restore(serialized(t, c)); err == nil {
				t.Fatal("unsafe conservation state accepted")
			}
		})
	}
}
func TestRestoreReconcilesCompleteTradeHistory(t *testing.T) {
	e := testEngine(t)
	buyShares(t, e, "alice", 100)
	for name, mutate := range map[string]func(*PlayerTrade){
		"inflated fee":            func(tr *PlayerTrade) { tr.Fee += 10000 },
		"changed execution price": func(tr *PlayerTrade) { tr.Price++; tr.Amount = tr.Price * tr.Quantity },
		"reduced fee":             func(tr *PlayerTrade) { tr.Fee-- },
	} {
		t.Run(name, func(t *testing.T) {
			c, _ := e.Clone()
			mutate(&c.s.Players["alice"].Trades[0])
			if _, err := Restore(serialized(t, c)); err == nil {
				t.Fatal("trade disagrees with settled order")
			}
		})
	}
}

// A thin-book fixture splits one NPC's available sell inventory into one-share
// resting asks. Matching and both ledgers remain real; tiny fills exercise the
// retained-trade window without thousands of separately charged player orders.
func fillWindowFixture(t *testing.T) *Engine {
	t.Helper()
	e := testEngine(t)
	q := e.s.Stocks[0]
	clearBook(e, q)
	q.Last = 1
	q.PrevClose = 1
	q.Open = 1
	q.High = 1
	q.Low = 1
	q.LimitUp = 1
	q.LimitDown = 1
	q.Volume = 0
	q.Turnover = 0
	q.MinuteBars = []Bar{}
	q.Tape = []TapeTrade{}
	q.DailyBars = []Bar{emptyBar(timestamp(e.s.Date, openSeconds), 1)}
	for _, id := range e.s.PlayerIDs {
		e.initializeReview(e.s.Players[id])
	}
	owner := q.Agents[8]
	h := e.s.Wallets[owner].Positions[q.Symbol]
	if h.Quantity-h.TodayBought-h.Frozen < 6100 {
		t.Fatal("fixture seller inventory")
	}
	for i := 0; i < 6100; i++ {
		e.s.Seq++
		id := fmt.Sprintf("O%d", e.s.Seq)
		o := &internalOrder{Order: Order{ID: id, Symbol: q.Symbol, Side: "sell", Price: 1, Quantity: 1, Remaining: 1, Status: "open", CreatedAt: timestamp(e.s.Date, e.s.Seconds)}, Owner: owner, Seq: e.s.Seq, Expires: e.s.Tick + 10000}
		e.s.Orders[id] = o
		q.Asks = append(q.Asks, id)
		h.Frozen++
	}
	for _, qty := range []int64{6000, 100} {
		r := e.PlaceOrder("alice", OrderInput{q.Symbol, "buy", 1, qty})
		if !r.OK || r.Order.Filled != qty {
			t.Fatal("fixture execution", r)
		}
	}
	p := e.s.Players["alice"]
	if len(p.Trades) != 5000 || len(p.OrderIDs) != 2 {
		t.Fatal("fixture did not reach truncated window")
	}
	return e
}
func TestRestoreReconcilesTruncatedTradeWindow(t *testing.T) {
	e := fillWindowFixture(t)
	restored, err := Restore(serialized(t, e))
	if err != nil {
		t.Fatal("valid prefix truncation rejected", err)
	}
	if snap(t, restored, "alice").Account.Cash != 492900 {
		t.Fatal("6100 fen execution plus two 500-fen commissions")
	}
	for name, mutate := range map[string]func(*Engine){
		"boundary order fee": func(c *Engine) { c.s.Players["alice"].Trades[100].Fee = 1 },
		"complete order fee": func(c *Engine) { c.s.Players["alice"].Trades[99].Fee-- },
		"missing recent order fills": func(c *Engine) {
			p := c.s.Players["alice"]
			// Remove the new order's first execution, then extend the old
			// order's retained suffix by one real chronological slot. Both
			// per-order subsets and cumulative fee bases remain plausible;
			// the new order's creation sequence proves its missing fill.
			older := p.Trades[len(p.Trades)-1]
			seq, _ := strconv.ParseInt(strings.SplitN(older.ID, "-", 2)[0][1:], 10, 64)
			older.ID = fmt.Sprintf("T%d-%s", seq-1, older.OrderID)
			p.Trades = append(p.Trades[:99], p.Trades[100:]...)
			p.Trades = append(p.Trades, older)
		},
	} {
		t.Run(name, func(t *testing.T) {
			c, _ := e.Clone()
			mutate(c)
			if _, err := Restore(serialized(t, c)); err == nil {
				t.Fatal("corrupt retained window accepted")
			}
		})
	}
}
