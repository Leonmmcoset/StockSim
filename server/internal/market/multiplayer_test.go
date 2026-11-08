package market

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// Clearing a single symbol's book preserves wallet reservations and total assets.
// This fixture only removes liquidity; every fill still uses the actual matching ledger.
func clearBook(e *Engine, q *stock) {
	for _, o := range append(e.book(q, "buy"), e.book(q, "sell")...) {
		e.cancelInternal(q, o, "cancelled")
	}
}
func buyShares(t *testing.T, e *Engine, id string, quantity int64) {
	t.Helper()
	q := snap(t, e, id).Quotes[0]
	r := e.PlaceOrder(id, OrderInput{q.Symbol, "buy", q.Asks[0].Price + 3, quantity})
	if !r.OK || r.Order.Filled != quantity {
		t.Fatalf("acquire shares %+v", r)
	}
}
func TestPlayerToPlayerFIFOAndBothLedgers(t *testing.T) {
	e := testEngine(t)
	buyShares(t, e, "alice", 200)
	buyShares(t, e, "observer", 100)
	e.NextDay()
	q := e.s.Stocks[0]
	clearBook(e, q)
	price := q.Last + 1
	first := e.PlaceOrder("alice", OrderInput{q.Symbol, "sell", price, 100})
	second := e.PlaceOrder("alice", OrderInput{q.Symbol, "sell", price, 100})
	if !first.OK || !second.OK {
		t.Fatal(first, second)
	}
	beforeAlice := snap(t, e, "alice")
	beforeBob := snap(t, e, "bob")
	beforeObserver := snap(t, e, "observer")
	r := e.PlaceOrder("bob", OrderInput{q.Symbol, "buy", price, 200})
	if !r.OK || r.Order.Filled != 200 {
		t.Fatal(r)
	}
	a, b, o := snap(t, e, "alice"), snap(t, e, "bob"), snap(t, e, "observer")
	if len(b.Trades) != 2 || b.Trades[1].OrderID != r.Order.ID || a.Trades[1].OrderID != first.Order.ID || a.Trades[0].OrderID != second.Order.ID {
		t.Fatal("price/time FIFO / bilateral fills")
	}
	if b.Trades[1].Fee < 500 || b.Trades[0].Fee >= 500 {
		t.Fatal("minimum commission charged for every partial")
	}
	if a.Account.Cash-beforeAlice.Account.Cash != 200*price-(a.Account.FeesPaid-beforeAlice.Account.FeesPaid) || beforeBob.Account.Cash-b.Account.Cash != 200*price+r.Order.Fee {
		t.Fatal("bilateral cash")
	}
	if b.Review.CurrentDay.BuyFillCount != 2 || a.Review.CurrentDay.SellFillCount != 2 || b.Review.CurrentDay.Fees != r.Order.Fee {
		t.Fatal("both reviews must count fills")
	}
	if o.Account.Equity == beforeObserver.Account.Equity || o.Review.Points[len(o.Review.Points)-1].Equity != o.Account.Equity {
		t.Fatal("third-party mark-to-market stale")
	}
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal(err)
	}
	sum := e.s.FeePool
	for _, w := range e.s.Wallets {
		sum += w.Cash
	}
	if sum != e.s.TotalCash {
		t.Fatal("cash conservation")
	}
	var shares int64
	for _, w := range e.s.Wallets {
		if h := w.Positions[q.Symbol]; h != nil {
			shares += h.Quantity
		}
	}
	if shares != 4800000 {
		t.Fatal("share conservation")
	}
}
func TestPartialFillCancelAndReadOnlyRejectedCommands(t *testing.T) {
	e := testEngine(t)
	buyShares(t, e, "alice", 100)
	e.NextDay()
	q := e.s.Stocks[0]
	clearBook(e, q)
	price := q.Last + 1
	sell := e.PlaceOrder("alice", OrderInput{q.Symbol, "sell", price, 100})
	if !sell.OK {
		t.Fatal(sell)
	}
	buy := e.PlaceOrder("bob", OrderInput{q.Symbol, "buy", price, 200})
	if !buy.OK || buy.Order.Filled != 100 || buy.Order.Remaining != 100 {
		t.Fatal(buy)
	}
	before := serialized(t, e)
	if e.CancelOrder("observer", buy.Order.ID).Code != "ORDER_NOT_FOUND" {
		t.Fatal("foreign cancel")
	}
	if !bytes.Equal(before, serialized(t, e)) {
		t.Fatal("foreign cancel mutated")
	}
	b := snap(t, e, "bob")
	expectedReserve := price*100 + fees(price*200, "buy").Total - buy.Order.Fee
	if b.Account.FrozenCash != expectedReserve {
		t.Fatal("partial reserve")
	}
	if !e.CancelOrder("bob", buy.Order.ID).OK {
		t.Fatal("cancel")
	}
	b = snap(t, e, "bob")
	if b.Account.FrozenCash != 0 || b.Account.Cash != 500000-price*100-buy.Order.Fee {
		t.Fatal("cancel paid commission again")
	}
	if _, err := Restore(serialized(t, e)); err != nil {
		t.Fatal(err)
	}
}
func TestAuctionAndBandValidation(t *testing.T) {
	makeOrder := func(side string, p, q, seq int64) *internalOrder {
		return &internalOrder{Order: Order{Side: side, Price: p, Remaining: q}, Seq: seq}
	}
	for _, tc := range []struct {
		buy, ask, buyQty, askQty, want int64
		ok                             bool
	}{{1010, 1000, 100, 100, 1005, true}, {1010, 1000, 200, 100, 1010, true}, {990, 1000, 100, 100, 0, false}} {
		p, ok := clearingPrice([]*internalOrder{makeOrder("buy", tc.buy, tc.buyQty, 1), makeOrder("sell", tc.ask, tc.askQty, 2)})
		if ok != tc.ok || ok && p != tc.want {
			t.Fatal(p, ok, tc)
		}
	}
	e := testEngine(t)
	q := snap(t, e, "alice").Quotes[0]
	for _, tc := range []struct {
		in   OrderInput
		code string
	}{{OrderInput{q.Symbol, "buy", q.Last, 99}, "INVALID_QUANTITY"}, {OrderInput{q.Symbol, "buy", q.Last, 1000000}, "INSUFFICIENT_CASH"}, {OrderInput{q.Symbol, "buy", q.LimitUp + 1, 100}, "OUTSIDE_LIMIT"}, {OrderInput{q.Symbol, "buy", q.LimitUp, 100}, "PRICE_CAGE"}} {
		before := serialized(t, e)
		if r := e.PlaceOrder("alice", tc.in); r.Code != tc.code {
			t.Fatalf("%+v", r)
		}
		if !bytes.Equal(before, serialized(t, e)) {
			t.Fatal("rejection changed state")
		}
	}
	e.Step(1000)
	e.SkipLunch()
	e.Step(234)
	if e.Clock().Phase != "closing-auction" {
		t.Fatal(e.Clock())
	}
	r := e.PlaceOrder("alice", OrderInput{q.Symbol, "buy", e.s.Stocks[0].LimitDown, 100})
	if !r.OK || e.CancelOrder("alice", r.Order.ID).Code != "CANCEL_RESTRICTED" {
		t.Fatal("auction submission/cancel")
	}
}
func TestRejectCorruptSaveAndPrivateDataProjection(t *testing.T) {
	e := testEngine(t)
	buyShares(t, e, "alice", 100)
	q := e.s.Stocks[0]
	e.PlaceOrder("bob", OrderInput{q.Symbol, "buy", q.LimitDown, 100})
	cases := map[string]func(*Engine){"cash": func(c *Engine) { c.s.Wallets[c.s.Players["alice"].Owner].Cash++ }, "owner": func(c *Engine) { p := c.s.Players["bob"]; c.s.Orders[p.OrderIDs[0]].Owner = c.s.Players["alice"].Owner }, "reserve": func(c *Engine) {
		p := c.s.Players["bob"]
		o := c.s.Orders[p.OrderIDs[0]]
		o.Reserve++
		c.s.Wallets[p.Owner].FrozenCash++
	}, "basis": func(c *Engine) { c.s.Wallets[c.s.Players["alice"].Owner].Positions[q.Symbol].CostBasis++ }, "future report": func(c *Engine) { c.s.Companies[0].Reports[0].PublishedAt += 1000000000000 }, "financial": func(c *Engine) { c.s.Companies[0].Reports[0].Assets++ }, "review": func(c *Engine) { p := c.s.Players["alice"]; d := p.Review.Days[0]; d.Points[len(d.Points)-1].Cash++ }, "missing bars": func(c *Engine) { c.s.Stocks[0].DailyBars = nil }, "duplicate player": func(c *Engine) { c.s.PlayerIDs = append(c.s.PlayerIDs, "alice") }}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			c, _ := e.Clone()
			mutate(c)
			if _, err := Restore(serialized(t, c)); err == nil {
				t.Fatal("accepted corrupt save")
			}
		})
	}
	raw := serialized(t, e)
	if _, err := Restore(append(raw, []byte("{}")...)); err == nil {
		t.Fatal("trailing JSON accepted")
	}
	unknown := bytes.Replace(raw, []byte(`"schemaVersion":5`), []byte(`"schemaVersion":5,"injected":true`), 1)
	if _, err := Restore(unknown); err == nil {
		t.Fatal("unknown field")
	}
	s := snap(t, e, "observer")
	b, _ := json.Marshal(s)
	for _, secret := range []string{`"RNG"`, `"Fundamental"`, `"Wallets"`, `"PlayerID"`, `"OrderIDs"`} {
		if bytes.Contains(b, []byte(secret)) {
			t.Fatal("private state exposed", secret)
		}
	}
	if strings.Contains(string(b), ":null") { // only nullable financial ratios are valid null values
		var object map[string]json.RawMessage
		json.Unmarshal(b, &object)
		for _, key := range []string{"orders", "trades", "news", "quotes", "companies"} {
			if string(object[key]) == "null" {
				t.Fatal("null public list", key)
			}
		}
	}
}
func TestTSGoldenMarketAndPRNG(t *testing.T) {
	raw, err := os.ReadFile("testdata/ts-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	type quote struct {
		Symbol                            string
		Last, PrevClose, Volume, Turnover int64
		Bids, Asks                        []Level
	}
	type report struct {
		Symbol                     string
		Period, Revenue, NetProfit int64
	}
	var fixture struct {
		Cases []struct {
			Seed                 string
			HistoryDays, Elapsed int
			Quotes               []quote
			Reports              []report
		}
		Rng []struct {
			Seed   string
			Hash   uint32
			Values []float64
		}
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, r := range fixture.Rng {
		v := hashSeed(r.Seed)
		if v != r.Hash {
			t.Fatal("UTF16 hash", r.Seed)
		}
		for _, want := range r.Values {
			if got := random(&v); got != want {
				t.Fatal("mulberry32", got, want)
			}
		}
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Seed+"/"+strconv.Itoa(tc.Elapsed), func(t *testing.T) {
			e, err := New(Options{DisableEvents: true, EventSeed: "reference-tests", Seed: tc.Seed, HistoryDays: &tc.HistoryDays})
			if err != nil {
				t.Fatal(err)
			}
			e.AddPlayer("p")
			e.Step(tc.Elapsed)
			s := snap(t, e, "p")
			quotes := []quote{}
			reports := []report{}
			for _, q := range s.Quotes {
				quotes = append(quotes, quote{q.Symbol, q.Last, q.PrevClose, q.Volume, q.Turnover, q.Bids, q.Asks})
			}
			for _, c := range s.Companies {
				r := c.Reports[0]
				reports = append(reports, report{c.Symbol, r.Period, r.Revenue, r.NetProfit})
			}
			if !reflect.DeepEqual(quotes, tc.Quotes) {
				for i := range quotes {
					if !reflect.DeepEqual(quotes[i], tc.Quotes[i]) {
						t.Errorf("quote %s got %+v want %+v", quotes[i].Symbol, quotes[i], tc.Quotes[i])
						break
					}
				}
			}
			if !reflect.DeepEqual(reports, tc.Reports) {
				t.Errorf("reports got %+v want %+v", reports, tc.Reports)
			}
		})
	}
}

func TestRestoreRejectsMissingEmptyCollectionsAndMalformedCalendar(t *testing.T) {
	e := testEngine(t)
	for name, mutate := range map[string]func(*Engine){"trades": func(c *Engine) { c.s.Players["alice"].Trades = nil }, "orders": func(c *Engine) { c.s.Players["alice"].OrderIDs = nil }, "news": func(c *Engine) { c.s.News = nil }, "holiday time": func(c *Engine) { c.s.Date = "2026-11-08" }} {
		t.Run(name, func(t *testing.T) {
			c, _ := e.Clone()
			mutate(c)
			if _, err := Restore(serialized(t, c)); err == nil {
				t.Fatal("malformed collection/calendar accepted")
			}
		})
	}
}

func TestRestoreRequiresPersistedZeroValuedFields(t *testing.T) {
	e := testEngine(t)
	raw := serialized(t, e)
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	var data map[string]json.RawMessage
	json.Unmarshal(doc["data"], &data)
	delete(data, "RNG")
	doc["data"], _ = json.Marshal(data)
	broken, _ := json.Marshal(doc)
	if _, err := Restore(broken); err == nil {
		t.Fatal("missing RNG silently became a new random stream")
	}
}
