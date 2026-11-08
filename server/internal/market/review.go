package market

import (
	"errors"
	"math"
)

const (
	reviewMaxDays   = 30
	reviewMaxPoints = 1024
	reviewMaxTotal  = 15000
)

type observation struct {
	Time, Equity, Cash, MarketValue                            int64
	Index                                                      float64
	Realized, Fees, BuyCount, SellCount, BuyAmount, SellAmount int64
}
type reviewDay struct {
	DayIndex                   int64
	Date                       string
	Partial, Closed, Compacted bool
	Points                     []observation
}
type reviewState struct {
	CoverageStartAt int64
	Days            []*reviewDay
}

func (e *Engine) indexValue() float64 {
	v := 0.
	for _, q := range e.s.Stocks {
		v += float64(q.Last) / float64(q.Base)
	}
	return v / 12 * 1000
}
func (e *Engine) observation(p *player, prior observation) observation {
	w := e.s.Wallets[p.Owner]
	var market int64
	for _, q := range e.s.Stocks {
		if h := w.Positions[q.Symbol]; h != nil {
			market += h.Quantity * q.Last
		}
	}
	return observation{Time: timestamp(e.s.Date, e.s.Seconds), Equity: w.Cash + market, Cash: w.Cash, MarketValue: market, Index: e.indexValue(), Realized: p.RealizedPnl, Fees: p.FeesPaid, BuyCount: prior.BuyCount, SellCount: prior.SellCount, BuyAmount: prior.BuyAmount, SellAmount: prior.SellAmount}
}
func (e *Engine) initializeReview(p *player) {
	point := e.observation(p, observation{})
	p.Review = reviewState{CoverageStartAt: point.Time, Days: []*reviewDay{{DayIndex: e.s.DayIndex, Date: e.s.Date, Partial: e.s.Seconds != openSeconds, Closed: e.s.Seconds == closeSeconds, Points: []observation{point}}}}
}
func (e *Engine) openReviewDay(p *player) {
	r := &p.Review
	lastDay := r.Days[len(r.Days)-1]
	last := lastDay.Points[len(lastDay.Points)-1]
	r.Days = append(r.Days, &reviewDay{DayIndex: e.s.DayIndex, Date: e.s.Date, Points: []observation{e.observation(p, last)}})
	if len(r.Days) > reviewMaxDays {
		r.Days = r.Days[1:]
	}
}
func compactReview(day *reviewDay, forced bool) {
	if !forced && len(day.Points) <= reviewMaxPoints {
		return
	}
	p := day.Points
	if len(p) <= 2 {
		return
	}
	keep := map[int]bool{0: true, len(p) - 1: true}
	peak, peakAt, troughAt, low, high, indexLow, indexHigh := 0, 0, 0, 0, 0, 0, 0
	worst := -1.
	for i := range p {
		if p[i].Equity > p[peak].Equity {
			peak = i
		}
		dd := 0.
		if p[peak].Equity > 0 {
			dd = float64(p[peak].Equity-p[i].Equity) / float64(p[peak].Equity)
		}
		if dd > worst {
			worst = dd
			peakAt = peak
			troughAt = i
		}
		if p[i].Equity < p[low].Equity {
			low = i
		}
		if p[i].Equity > p[high].Equity {
			high = i
		}
		if p[i].Index < p[indexLow].Index {
			indexLow = i
		}
		if p[i].Index > p[indexHigh].Index {
			indexHigh = i
		}
		if i%2 == 0 {
			keep[i] = true
		}
	}
	for _, i := range []int{peakAt, troughAt, low, high, indexLow, indexHigh} {
		keep[i] = true
	}
	points := make([]observation, 0, len(keep))
	for i, v := range p {
		if keep[i] {
			points = append(points, v)
		}
	}
	day.Points = points
	day.Compacted = true
}
func (e *Engine) recordReview(p *player, side string, amount int64, close bool) {
	r := &p.Review
	if len(r.Days) == 0 {
		return
	}
	day := r.Days[len(r.Days)-1]
	last := day.Points[len(day.Points)-1]
	point := e.observation(p, last)
	if side == "buy" {
		point.BuyCount++
		point.BuyAmount += amount
	} else if side == "sell" {
		point.SellCount++
		point.SellAmount += amount
	}
	if point != last {
		day.Points = append(day.Points, point)
	}
	if close {
		day.Closed = true
	}
	compactReview(day, false)
	total := 0
	for _, d := range r.Days {
		total += len(d.Points)
	}
	for total > reviewMaxTotal {
		largest := r.Days[0]
		for _, d := range r.Days {
			if len(d.Points) > len(largest.Points) {
				largest = d
			}
		}
		before := len(largest.Points)
		compactReview(largest, true)
		total -= before - len(largest.Points)
	}
}
func (e *Engine) recordAll(close bool) {
	for _, id := range e.s.PlayerIDs {
		e.recordReview(e.s.Players[id], "", 0, close)
	}
}
func pct(end, start int64) *float64 {
	if start <= 0 {
		return nil
	}
	return ptr((float64(end)/float64(start) - 1) * 100)
}
func publicPoint(p observation, dayIndex int64) EquityPoint {
	position := 0.
	if p.Equity > 0 {
		position = float64(p.MarketValue) / float64(p.Equity) * 100
	}
	return EquityPoint{Time: p.Time, DayIndex: dayIndex, Equity: p.Equity, Cash: p.Cash, MarketValue: p.MarketValue, PositionPct: position, IndexValue: p.Index}
}
func drawdown(points []EquityPoint) float64 {
	var peak int64
	worst := 0.
	for _, p := range points {
		peak = max(peak, p.Equity)
		if peak > 0 {
			worst = math.Max(worst, float64(peak-p.Equity)/float64(peak)*100)
		}
	}
	return worst
}
func dailyReview(day *reviewDay) DailyReview {
	a, b := day.Points[0], day.Points[len(day.Points)-1]
	net, realized, fees := b.Equity-a.Equity, b.Realized-a.Realized, b.Fees-a.Fees
	ret := pct(b.Equity, a.Equity)
	benchmark := (b.Index/a.Index - 1) * 100
	var excess *float64
	if ret != nil {
		excess = ptr(*ret - benchmark)
	}
	points := make([]EquityPoint, 0, len(day.Points))
	for _, p := range day.Points {
		points = append(points, publicPoint(p, day.DayIndex))
	}
	status := "in-progress"
	if day.Closed {
		status = "closed"
	}
	return DailyReview{DayIndex: day.DayIndex, Date: day.Date, Status: status, Partial: day.Partial, CoverageStartAt: a.Time, StartAt: a.Time, EndAt: b.Time, StartEquity: a.Equity, EndEquity: b.Equity, NetPnl: net, ReturnPct: ret, BenchmarkReturnPct: benchmark, ExcessReturnPct: excess, BuyFillCount: b.BuyCount - a.BuyCount, SellFillCount: b.SellCount - a.SellCount, BuyAmount: b.BuyAmount - a.BuyAmount, SellAmount: b.SellAmount - a.SellAmount, Fees: fees, RealizedPnl: realized, UnrealizedPnlChange: net - realized, GrossPnl: net + fees, MaxDrawdownPct: drawdown(points)}
}
func (e *Engine) publicReview(p *player) InvestmentReview {
	r := p.Review
	out := InvestmentReview{Points: []EquityPoint{}, Days: []DailyReview{}, CoverageStartAt: r.CoverageStartAt, RetentionDays: 30, Sampling: "30s-and-fills"}
	for _, d := range r.Days {
		summary := dailyReview(d)
		if d.Closed {
			out.Days = append(out.Days, summary)
		}
		out.CurrentDay = summary
		out.Compacted = out.Compacted || d.Compacted
		for _, point := range d.Points {
			out.Points = append(out.Points, publicPoint(point, d.DayIndex))
		}
	}
	return out
}
func NormalizeEquityCurve(points []EquityPoint) []NormalizedEquityPoint {
	out := []NormalizedEquityPoint{}
	if len(points) == 0 {
		return out
	}
	base := points[0]
	for _, p := range points {
		ret := pct(p.Equity, base.Equity)
		benchmark := (p.IndexValue/base.IndexValue - 1) * 100
		var excess *float64
		if ret != nil {
			excess = ptr(*ret - benchmark)
		}
		out = append(out, NormalizedEquityPoint{EquityPoint: p, ReturnPct: ret, BenchmarkReturnPct: benchmark, ExcessReturnPct: excess})
	}
	return out
}
func (e *Engine) GetReview(id string, period ReviewPeriod) (ReviewSelection, error) {
	p := e.s.Players[id]
	if p == nil {
		return ReviewSelection{}, errors.New("玩家不存在")
	}
	days := p.Review.Days
	switch period.Kind {
	case "all":
	case "recent":
		if period.Days <= 0 {
			return ReviewSelection{}, errors.New("复盘天数无效")
		}
		days = days[max(0, len(days)-period.Days):]
	case "day":
		days = nil
		for _, d := range p.Review.Days {
			if d.DayIndex == period.DayIndex {
				days = []*reviewDay{d}
				break
			}
		}
	default:
		return ReviewSelection{}, errors.New("复盘区间无效")
	}
	if len(days) == 0 {
		return ReviewSelection{}, errors.New("所选交易日没有真实资产记录")
	}
	points := []EquityPoint{}
	var buys, sells, buyAmount, sellAmount, fees, realized int64
	partial := false
	for _, d := range days {
		summary := dailyReview(d)
		buys += summary.BuyFillCount
		sells += summary.SellFillCount
		buyAmount += summary.BuyAmount
		sellAmount += summary.SellAmount
		fees += summary.Fees
		realized += summary.RealizedPnl
		partial = partial || d.Partial
		for _, v := range d.Points {
			points = append(points, publicPoint(v, d.DayIndex))
		}
	}
	normalized := NormalizeEquityCurve(points)
	first, last := normalized[0], normalized[len(normalized)-1]
	net := last.Equity - first.Equity
	status := "in-progress"
	if days[len(days)-1].Closed {
		status = "closed"
	}
	summary := ReviewPeriodSummary{StartDate: days[0].Date, EndDate: days[len(days)-1].Date, DayCount: int64(len(days)), Status: status, Partial: partial, CoverageStartAt: first.Time, StartAt: first.Time, EndAt: last.Time, StartEquity: first.Equity, EndEquity: last.Equity, NetPnl: net, ReturnPct: last.ReturnPct, BenchmarkReturnPct: last.BenchmarkReturnPct, ExcessReturnPct: last.ExcessReturnPct, BuyFillCount: buys, SellFillCount: sells, BuyAmount: buyAmount, SellAmount: sellAmount, Fees: fees, RealizedPnl: realized, UnrealizedPnlChange: net - realized, GrossPnl: net + fees, MaxDrawdownPct: drawdown(points)}
	return ReviewSelection{Points: normalized, Summary: summary}, nil
}
