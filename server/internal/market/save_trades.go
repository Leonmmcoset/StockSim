package market

import (
	"fmt"
	"strconv"
	"strings"
)

type retainedFills struct {
	Quantity, Amount, Fee int64
	Trades                []PlayerTrade
}

func (e *Engine) validatePlayerTrades(p *player) error {
	fail := func() error { return fmt.Errorf("玩家%s逐笔成交与委托累计量额费用不一致", p.ID) }
	groups := map[string]*retainedFills{}
	seen := map[string]bool{}
	previousSeq, previousTime := maxSafeInteger+1, timestamp(e.s.Date, e.s.Seconds)
	oldestSeq := int64(0)
	for _, tr := range p.Trades {
		o := e.s.Orders[tr.OrderID]
		if o == nil || o.Owner != p.Owner || seen[tr.ID] || tr.Symbol != o.Symbol || tr.Side != o.Side || tr.Quantity <= 0 || tr.Quantity > o.Filled || tr.Price <= 0 || tr.Fee < 0 || tr.Time > previousTime || tr.Time < o.CreatedAt || tr.Side == "buy" && tr.Price > o.Price || tr.Side == "sell" && tr.Price < o.Price {
			return fail()
		}
		amount, ok := safeProduct(tr.Price, tr.Quantity)
		if !ok || amount != tr.Amount {
			return fail()
		}
		// Trade sequences identify the oldest retained execution even when thousands
		// of fills share a timestamp. An order created after it cannot have lost fills.
		suffix := "-" + tr.OrderID
		if !strings.HasPrefix(tr.ID, "T") || !strings.HasSuffix(tr.ID, suffix) {
			return fail()
		}
		seq, err := strconv.ParseInt(strings.TrimSuffix(tr.ID[1:], suffix), 10, 64)
		if err != nil || seq <= o.Seq || seq > e.s.Seq || seq >= previousSeq || fmt.Sprintf("T%d-%s", seq, tr.OrderID) != tr.ID {
			return fail()
		}
		previousSeq, previousTime, oldestSeq = seq, tr.Time, seq
		seen[tr.ID] = true
		g := groups[tr.OrderID]
		if g == nil {
			g = &retainedFills{}
			groups[tr.OrderID] = g
		}
		g.Quantity, ok = boundedSum(g.Quantity, tr.Quantity, o.Filled)
		if !ok {
			return fail()
		}
		g.Amount, ok = boundedSum(g.Amount, tr.Amount, o.Notional)
		if !ok {
			return fail()
		}
		g.Fee, ok = boundedSum(g.Fee, tr.Fee, o.Fee)
		if !ok {
			return fail()
		}
		g.Trades = append(g.Trades, tr)
	}
	completeHistory := len(p.Trades) < 5000
	if len(p.Review.Days) > 0 {
		day := p.Review.Days[len(p.Review.Days)-1]
		if day != nil && len(day.Points) > 0 {
			last := day.Points[len(day.Points)-1]
			if last.BuyCount+last.SellCount == int64(len(p.Trades)) {
				completeHistory = true
			}
		}
	}
	for _, id := range p.OrderIDs {
		o := e.s.Orders[id]
		g := groups[id]
		if g == nil {
			g = &retainedFills{}
		}
		complete := completeHistory || o.Seq > oldestSeq || g.Quantity == o.Filled
		if complete && (g.Quantity != o.Filled || g.Amount != o.Notional || g.Fee != o.Fee) {
			return fail()
		}
		prefixQuantity, prefixAmount := o.Filled-g.Quantity, o.Notional-g.Amount
		if prefixQuantity < 0 || prefixAmount < 0 || prefixQuantity == 0 && prefixAmount != 0 || prefixQuantity > 0 && prefixAmount < prefixQuantity {
			return fail()
		}
		// A retained window is a suffix of each order's fills. Reconstruct only its
		// cumulative fee base; never invent missing executions or historical prices.
		cumulative := prefixAmount
		priorFee := fees(cumulative, o.Side).Total
		for i := len(g.Trades) - 1; i >= 0; i-- {
			tr := g.Trades[i]
			next, ok := boundedSum(cumulative, tr.Amount, o.Notional)
			if !ok {
				return fail()
			}
			nextFee := fees(next, o.Side).Total
			if tr.Fee != nextFee-priorFee {
				return fail()
			}
			cumulative, priorFee = next, nextFee
		}
	}
	return nil
}
