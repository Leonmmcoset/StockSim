package market

import (
	"encoding/json"
	"errors"
	"sort"
)

func deepCopy[T any](value T) (T, error) {
	var out T
	b, err := json.Marshal(value)
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(b, &out)
	return out, err
}
func (e *Engine) levels(q *stock, side string) []Level {
	out := []Level{}
	for _, o := range e.book(q, side) {
		if len(out) > 0 && out[len(out)-1].Price == o.Price {
			out[len(out)-1].Quantity += o.Remaining
		} else {
			if len(out) == 5 {
				break
			}
			out = append(out, Level{Price: o.Price, Quantity: o.Remaining})
		}
	}
	return out
}
func (e *Engine) account(p *player) Account {
	w := e.s.Wallets[p.Owner]
	positions := []Position{}
	symbols := []string{}
	for symbol, h := range w.Positions {
		if h.Quantity > 0 {
			symbols = append(symbols, symbol)
		}
	}
	sort.Strings(symbols)
	var total int64
	for _, symbol := range symbols {
		h := w.Positions[symbol]
		market := e.findStock(symbol).Last * h.Quantity
		pnl := market - h.CostBasis
		pct := 0.
		if h.CostBasis > 0 {
			pct = float64(pnl) / float64(h.CostBasis) * 100
		}
		positions = append(positions, Position{Symbol: symbol, Quantity: h.Quantity, Sellable: h.Quantity - h.TodayBought - h.Frozen, Frozen: h.Frozen, TodayBought: h.TodayBought, CostBasis: h.CostBasis, AverageCost: round(float64(h.CostBasis) / float64(h.Quantity)), MarketValue: market, Pnl: pnl, PnlPct: pct})
		total += market
	}
	equity := w.Cash + total
	pct := 0.
	if p.InitialCash > 0 {
		pct = (float64(equity)/float64(p.InitialCash) - 1) * 100
	}
	return Account{InitialCash: p.InitialCash, Cash: w.Cash, AvailableCash: w.Cash - w.FrozenCash, FrozenCash: w.FrozenCash, MarketValue: total, Equity: equity, TotalPnl: equity - p.InitialCash, TotalPnlPct: pct, RealizedPnl: p.RealizedPnl, FeesPaid: p.FeesPaid, Positions: positions}
}
func (e *Engine) Snapshot(id string) (MarketSnapshot, error) {
	p := e.s.Players[id]
	if p == nil {
		return MarketSnapshot{}, errors.New("玩家不存在")
	}
	quotes := []Quote{}
	index := MarketIndex{Name: "股海综合"}
	previous := 0.
	for _, q := range e.s.Stocks {
		vwap := q.Last
		if q.Volume > 0 {
			vwap = round(float64(q.Turnover) / float64(q.Volume))
		}
		quote := Quote{Symbol: q.Symbol, Name: q.Name, Sector: q.Sector, Last: q.Last, PrevClose: q.PrevClose, Open: q.Open, High: q.High, Low: q.Low, Change: q.Last - q.PrevClose, ChangePct: (float64(q.Last)/float64(q.PrevClose) - 1) * 100, Volume: q.Volume, Turnover: q.Turnover, Vwap: vwap, LimitUp: q.LimitUp, LimitDown: q.LimitDown, Bids: e.levels(q, "buy"), Asks: e.levels(q, "sell"), MinuteBars: q.MinuteBars, DailyBars: q.DailyBars, RecentTrades: q.Tape[:min(30, len(q.Tape))]}
		quotes = append(quotes, quote)
		index.Value += float64(q.Last) / float64(q.Base)
		previous += float64(q.PrevClose) / float64(q.Base)
		if quote.Change > 0 {
			index.Advancing++
		} else if quote.Change < 0 {
			index.Declining++
		} else {
			index.Unchanged++
		}
		index.Volume += q.Volume
		index.Turnover += q.Turnover
	}
	index.ChangePct = (index.Value/previous - 1) * 100
	index.Value = index.Value / 12 * 1000
	orders := []Order{}
	for i := len(p.OrderIDs) - 1; i >= 0; i-- {
		orders = append(orders, e.s.Orders[p.OrderIDs[i]].Order)
	}
	return deepCopy(MarketSnapshot{Version: 1, Seed: e.s.Seed, Clock: e.Clock(), Quotes: quotes, Account: e.account(p), Companies: e.publicCompanies(), Review: e.publicReview(p), Orders: orders, Trades: p.Trades, News: e.s.News, Index: index})
}
