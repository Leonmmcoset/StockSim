package market

import (
	"math"
	"time"
	"unicode/utf16"
)

const DefaultSeed = "stock-sim-2026"
const initialCash int64 = 500000
const (
	openSeconds      int64 = 34200
	noonSeconds      int64 = 41400
	afternoonSeconds int64 = 46800
	auctionSeconds   int64 = 53820
	closeSeconds     int64 = 54000
)

var china = time.FixedZone("CST", 8*3600)

type universeEntry struct {
	Symbol, Name, Sector string
	Price                int64
	Beta                 float64
}

var universe = []universeEntry{
	{"600101", "华川银行", "金融", 680, .65}, {"600102", "东衡证券", "金融", 1240, 1.35},
	{"600201", "南岭食品", "消费", 1820, .7}, {"600202", "锦禾商贸", "消费", 895, .9},
	{"600301", "江海能源", "能源", 745, 1.1}, {"600302", "天泽电力", "能源", 560, .6},
	{"600401", "云杉科技", "科技", 2670, 1.4}, {"600402", "星辰电子", "科技", 1580, 1.25},
	{"600501", "安和医药", "医药", 2250, .8}, {"600502", "瑞宁生物", "医药", 1180, 1.15},
	{"600601", "远航装备", "制造", 1380, 1.05}, {"600602", "金桥精工", "制造", 960, .95},
}
var sectors = []string{"金融", "消费", "能源", "科技", "医药", "制造"}

type holdingState struct{ Quantity, TodayBought, Frozen, CostBasis int64 }
type wallet struct {
	Cash, FrozenCash int64
	Positions        map[string]*holdingState
	Kind, PlayerID   string
	Bias             float64
}
type internalOrder struct {
	Order
	Owner                           int
	Seq, Notional, Reserve, Expires int64
}
type stock struct {
	Symbol, Name, Sector                                                   string
	Beta                                                                   float64
	Base                                                                   int64
	Fundamental, Sentiment, EMA, Variance                                  float64
	Last, PrevClose, Open, High, Low, Volume, Turnover, LimitUp, LimitDown int64
	Bids, Asks                                                             []string
	Agents                                                                 []int
	MinuteBars, DailyBars                                                  []Bar
	Tape                                                                   []TapeTrade
}
type player struct {
	ID                                 string
	Owner                              int
	InitialCash, RealizedPnl, FeesPaid int64
	OrderIDs                           []string
	Trades                             []PlayerTrade
	Review                             reviewState
}
type state struct {
	Seed               string
	RNG                uint32
	Seq, Tick          int64
	Date               string
	Seconds, DayIndex  int64
	FeePool, TotalCash int64
	Wallets            []*wallet
	Stocks             []*stock
	Orders             map[string]*internalOrder
	Players            map[string]*player
	PlayerIDs          []string
	News               []NewsItem
	Macro              float64
	SectorFactors      map[string]float64
	TotalShares        map[string]int64
	Companies          []*companyState
}
type Engine struct{ s *state }

func round(v float64) int64           { return int64(math.Floor(v + .5)) }
func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }
func clampInt(v, lo, hi int64) int64  { return max(lo, min(hi, v)) }
func timestamp(date string, seconds int64) int64 {
	d, _ := time.ParseInLocation("2006-01-02", date, china)
	return d.UnixMilli() + seconds*1000
}
func shiftDate(date string, days int) string {
	d, _ := time.Parse("2006-01-02", date)
	direction := 1
	if days < 0 {
		direction = -1
		days = -days
	}
	for i := 0; i < days; i++ {
		for {
			d = d.AddDate(0, 0, direction)
			if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
				break
			}
		}
	}
	return d.Format("2006-01-02")
}
func hashSeed(seed string) uint32 {
	h := uint32(2166136261)
	for _, v := range utf16.Encode([]rune(seed)) {
		h = (h ^ uint32(v)) * 16777619
	}
	return h
}
func random(rng *uint32) float64 {
	*rng += 0x6D2B79F5
	t := *rng
	t = (t ^ (t >> 15)) * (t | 1)
	t ^= t + (t^(t>>7))*(t|61)
	return float64(t^(t>>14)) / 4294967296
}
func normal(rng *uint32) float64 {
	return math.Sqrt(-2*math.Log(math.Max(1e-12, random(rng)))) * math.Cos(2*math.Pi*random(rng))
}
func phase(s *state) string {
	if s.Seconds >= closeSeconds {
		return "closed"
	}
	if s.Seconds >= noonSeconds && s.Seconds < afternoonSeconds {
		return "lunch"
	}
	if s.Seconds >= auctionSeconds {
		return "closing-auction"
	}
	return "continuous"
}
func newWallet(kind string, cash int64, bias float64) *wallet {
	return &wallet{Kind: kind, Cash: cash, Bias: bias, Positions: map[string]*holdingState{}}
}
func holding(w *wallet, symbol string) *holdingState {
	h := w.Positions[symbol]
	if h == nil {
		h = &holdingState{}
		w.Positions[symbol] = h
	}
	return h
}
func emptyBar(at, price int64) Bar {
	return Bar{Time: at, Open: price, High: price, Low: price, Close: price}
}
func limits(q *stock) {
	q.LimitUp = round(float64(q.PrevClose) * 1.1)
	q.LimitDown = max(1, round(float64(q.PrevClose)*.9))
}
func (e *Engine) findStock(symbol string) *stock {
	for _, q := range e.s.Stocks {
		if q.Symbol == symbol {
			return q
		}
	}
	return nil
}
func (e *Engine) isPlayer(owner int) bool { return e.s.Wallets[owner].Kind == "player" }
func active(o *internalOrder) bool        { return o.Status == "open" || o.Status == "partial" }
func fees(amount int64, side string) FeeBreakdown {
	if amount <= 0 {
		return FeeBreakdown{}
	}
	f := FeeBreakdown{Commission: max(500, round(float64(amount)*.00025)), Transfer: round(float64(amount) * .00001)}
	if side == "sell" {
		f.Stamp = round(float64(amount) * .0005)
	}
	f.Total = f.Commission + f.Transfer + f.Stamp
	return f
}
func (e *Engine) updateReserve(o *internalOrder) {
	w := e.s.Wallets[o.Owner]
	if o.Side == "buy" {
		w.FrozenCash -= o.Reserve
		o.Reserve = 0
		if o.Remaining > 0 {
			o.Reserve = o.Remaining*o.Price + fees(o.Notional+o.Remaining*o.Price, "buy").Total - o.Fee
		}
		w.FrozenCash += o.Reserve
	}
}
func (e *Engine) settle(o *internalOrder, price, quantity int64) int64 {
	s := e.s
	w := s.Wallets[o.Owner]
	h := holding(w, o.Symbol)
	amount := price * quantity
	newFee := fees(o.Notional+amount, o.Side).Total
	delta := newFee - o.Fee
	o.Notional += amount
	o.Fee = newFee
	o.Filled += quantity
	o.Remaining -= quantity
	o.AvgFillPrice = round(float64(o.Notional) / float64(o.Filled))
	o.Status = "filled"
	if o.Remaining > 0 {
		o.Status = "partial"
	}
	if o.Side == "buy" {
		w.Cash -= amount + delta
		h.Quantity += quantity
		h.TodayBought += quantity
		h.CostBasis += amount + delta
		e.updateReserve(o)
	} else {
		cost := h.CostBasis
		if quantity != h.Quantity {
			cost = h.CostBasis * quantity / h.Quantity
		}
		h.Quantity -= quantity
		h.Frozen -= quantity
		h.CostBasis -= cost
		w.Cash += amount - delta
		if w.Kind == "player" {
			s.Players[w.PlayerID].RealizedPnl += amount - delta - cost
		}
	}
	s.FeePool += delta
	if w.Kind == "player" {
		s.Players[w.PlayerID].FeesPaid += delta
	}
	return delta
}
