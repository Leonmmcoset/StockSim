package market

import (
	"errors"
	"math"
	"sort"
)

// PlayerMetrics contains account statistics. Callers must explicitly select
// public fields: Equity and TotalPnl are intended only for the account owner.
type PlayerMetrics struct {
	JoinedAt       int64               `json:"joinedAt"`
	Equity         Money               `json:"equity"`
	TotalPnl       Money               `json:"totalPnl"`
	TotalReturnPct *float64            `json:"totalReturnPct"`
	Recent5        PerformanceWindow   `json:"recent5"`
	Drawdown       PerformanceDrawdown `json:"drawdown"`
}

type PerformanceWindow struct {
	RequestedStartDayIndex int64    `json:"requestedStartDayIndex"`
	RequestedStartAt       int64    `json:"requestedStartAt"`
	StartAt                int64    `json:"startAt"`
	EndAt                  int64    `json:"endAt"`
	CoveredDays            int64    `json:"coveredDays"`
	Complete               bool     `json:"complete"`
	NetPnl                 *Money   `json:"netPnl"`
	ReturnPct              *float64 `json:"returnPct"`
}

type PerformanceDrawdown struct {
	StartAt        int64    `json:"startAt"`
	EndAt          int64    `json:"endAt"`
	MaxDrawdownPct *float64 `json:"maxDrawdownPct"`
	RetentionDays  int      `json:"retentionDays"`
	Compacted      bool     `json:"compacted"`
}

type PerformancePoint struct {
	Time     int64 `json:"time"`
	DayIndex int64 `json:"dayIndex"`
	Equity   Money `json:"equity"`
}

type PerformanceDay struct {
	DayIndex  int64    `json:"dayIndex"`
	Date      string   `json:"date"`
	NetPnl    Money    `json:"netPnl"`
	ReturnPct *float64 `json:"returnPct"`
}

type PlayerPerformance struct {
	PlayerMetrics
	Points                  []PerformancePoint `json:"points"`
	FillCount               int64              `json:"fillCount"`
	BuyFillCount            int64              `json:"buyFillCount"`
	SellFillCount           int64              `json:"sellFillCount"`
	FeesPaid                Money              `json:"feesPaid"`
	BestDay                 *PerformanceDay    `json:"bestDay"`
	WorstDay                *PerformanceDay    `json:"worstDay"`
	ClosedDayCount          int64              `json:"closedDayCount"`
	ExcludedPartialDayCount int64              `json:"excludedPartialDayCount"`
}

// PlayerID is an internal join key for the app's authorized public identity.
type PlayerRank struct {
	PlayerID string        `json:"-"`
	Rank     *int64        `json:"rank"`
	Metrics  PlayerMetrics `json:"metrics"`
}

func (e *Engine) performanceMetrics(p *player) PlayerMetrics {
	account := e.account(p)
	startDay := max(int64(0), e.s.DayIndex-4)
	requestedStart := timestamp(shiftDate(e.s.Date, int(startDay-e.s.DayIndex)), openSeconds)
	out := PlayerMetrics{
		JoinedAt: p.Review.CoverageStartAt, Equity: account.Equity,
		TotalPnl: account.Equity - p.InitialCash, TotalReturnPct: pct(account.Equity, p.InitialCash),
		Recent5:  PerformanceWindow{RequestedStartDayIndex: startDay, RequestedStartAt: requestedStart},
		Drawdown: PerformanceDrawdown{RetentionDays: reviewMaxDays},
	}
	var firstRecent, lastRecent *observation
	var peak int64
	worst := 0.
	observed := false
	for _, day := range p.Review.Days {
		out.Drawdown.Compacted = out.Drawdown.Compacted || day.Compacted
		if day.DayIndex >= startDay && day.DayIndex <= e.s.DayIndex && len(day.Points) > 0 {
			if firstRecent == nil {
				firstRecent = &day.Points[0]
			}
			lastRecent = &day.Points[len(day.Points)-1]
			out.Recent5.CoveredDays++
		}
		for _, point := range day.Points {
			if !observed {
				out.Drawdown.StartAt = point.Time
				observed = true
			}
			out.Drawdown.EndAt = point.Time
			peak = max(peak, point.Equity)
			if peak > 0 {
				worst = math.Max(worst, float64(peak-point.Equity)/float64(peak)*100)
			}
		}
	}
	if observed {
		out.Drawdown.MaxDrawdownPct = ptr(worst)
	}
	if firstRecent != nil {
		out.Recent5.StartAt = firstRecent.Time
		out.Recent5.EndAt = lastRecent.Time
		net := lastRecent.Equity - firstRecent.Equity
		out.Recent5.NetPnl = &net
		out.Recent5.ReturnPct = pct(lastRecent.Equity, firstRecent.Equity)
		out.Recent5.Complete = e.s.DayIndex >= 4 && out.Recent5.CoveredDays == 5 && firstRecent.Time == requestedStart
	}
	return out
}

// PlayerPerformance reads retained observations and lifetime accounting totals.
// It neither records new observations nor modifies the simulation's RNG/state.
func (e *Engine) PlayerPerformance(id string) (PlayerPerformance, error) {
	p := e.s.Players[id]
	if p == nil {
		return PlayerPerformance{}, errors.New("玩家不存在")
	}
	out := PlayerPerformance{PlayerMetrics: e.performanceMetrics(p), Points: []PerformancePoint{}, FeesPaid: p.FeesPaid}
	for _, day := range p.Review.Days {
		for _, point := range day.Points {
			out.Points = append(out.Points, PerformancePoint{Time: point.Time, DayIndex: day.DayIndex, Equity: point.Equity})
			out.BuyFillCount = point.BuyCount
			out.SellFillCount = point.SellCount
		}
		if !day.Closed || len(day.Points) == 0 {
			continue
		}
		if day.Partial {
			out.ExcludedPartialDayCount++
			continue
		}
		out.ClosedDayCount++
		first, last := day.Points[0], day.Points[len(day.Points)-1]
		daily := PerformanceDay{DayIndex: day.DayIndex, Date: day.Date, NetPnl: last.Equity - first.Equity, ReturnPct: pct(last.Equity, first.Equity)}
		if daily.ReturnPct == nil {
			continue
		}
		// Retained days are chronological; strict comparisons keep earlier ties.
		if out.BestDay == nil || *daily.ReturnPct > *out.BestDay.ReturnPct {
			out.BestDay = &daily
		}
		if out.WorstDay == nil || *daily.ReturnPct < *out.WorstDay.ReturnPct {
			out.WorstDay = &daily
		}
	}
	out.FillCount = out.BuyFillCount + out.SellFillCount
	return out, nil
}

func performanceRankValue(metrics PlayerMetrics, sortBy string) *float64 {
	switch sortBy {
	case "totalReturnPct":
		return metrics.TotalReturnPct
	case "recent5ReturnPct":
		if metrics.Recent5.Complete {
			return metrics.Recent5.ReturnPct
		}
	case "maxDrawdownPct":
		return metrics.Drawdown.MaxDrawdownPct
	}
	return nil
}

// RankPlayers ranks only the caller-supplied eligible set. The app owns
// consent/authorization and must whitelist public output fields separately.
// Equal metrics share competition ranks (1, 1, 3); undefined metrics are last
// with a nil rank. Internal player ID resolves ties deterministically.
func (e *Engine) RankPlayers(participantIDs []string, sortBy string) ([]PlayerRank, error) {
	if sortBy != "totalReturnPct" && sortBy != "recent5ReturnPct" && sortBy != "maxDrawdownPct" {
		return nil, errors.New("排行榜排序无效")
	}
	rows := []PlayerRank{}
	seen := make(map[string]bool, len(participantIDs))
	for _, id := range participantIDs {
		if seen[id] {
			continue
		}
		p := e.s.Players[id]
		if p == nil {
			return nil, errors.New("玩家不存在")
		}
		seen[id] = true
		rows = append(rows, PlayerRank{PlayerID: id, Metrics: e.performanceMetrics(p)})
	}
	sort.Slice(rows, func(i, j int) bool {
		a, b := performanceRankValue(rows[i].Metrics, sortBy), performanceRankValue(rows[j].Metrics, sortBy)
		if a == nil || b == nil {
			if (a == nil) != (b == nil) {
				return a != nil
			}
		} else if *a != *b {
			if sortBy == "maxDrawdownPct" {
				return *a < *b
			}
			return *a > *b
		}
		return rows[i].PlayerID < rows[j].PlayerID
	})
	var prior *float64
	var rank int64
	for i := range rows {
		value := performanceRankValue(rows[i].Metrics, sortBy)
		if value == nil {
			continue
		}
		if prior == nil || *value != *prior {
			rank = int64(i + 1)
		}
		rowRank := rank
		rows[i].Rank = &rowRank
		prior = value
	}
	return rows, nil
}
