package market

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"strings"
	"time"
)

type savedMarket struct {
	SchemaVersion int    `json:"schemaVersion"`
	Data          *state `json:"data"`
}

func (e *Engine) Export() ([]byte, error) {
	return json.Marshal(savedMarket{SchemaVersion: 5, Data: e.s})
}
func (e *Engine) Clone() (*Engine, error) {
	s, err := deepCopy(e.s)
	if err != nil {
		return nil, err
	}
	return &Engine{s: s}, nil
}
func Restore(data []byte) (*Engine, error) {
	if len(data) == 0 || len(data) > 256*1024*1024 {
		return nil, errors.New("存档为空或过大")
	}
	var header struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return nil, err
	}
	if header.SchemaVersion == 4 {
		return restoreV4(data)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var saved savedMarket
	if err := decoder.Decode(&saved); err != nil {
		return nil, fmt.Errorf("存档格式错误: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("存档包含尾随数据")
	}
	if saved.SchemaVersion != 5 || saved.Data == nil {
		return nil, errors.New("存档版本不兼容")
	}
	if err := requireJSONFields(data, reflect.TypeOf(saved)); err != nil {
		return nil, fmt.Errorf("存档字段缺失或空值: %w", err)
	}
	e := &Engine{s: saved.Data}
	if err := e.Validate(); err != nil {
		return nil, err
	}
	return e, nil
}
func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func validDate(date string) bool {
	d, err := time.Parse("2006-01-02", date)
	return err == nil && d.Format("2006-01-02") == date && d.Weekday() != time.Saturday && d.Weekday() != time.Sunday
}
func (e *Engine) Validate() error {
	if err := e.validateCore(); err != nil {
		return err
	}
	return e.validateEvents()
}
func (e *Engine) validateCore() error {
	s := e.s
	fail := func(what string) error { return fmt.Errorf("市场存档校验失败：%s", what) }
	if !safePersistedNumbers(reflect.ValueOf(s)) {
		return fail("数值超出JSON安全整数或有限值范围")
	}
	if s == nil || len(s.Stocks) != 12 || len(s.Wallets) != 576+len(s.Players) || len(s.Players) != len(s.PlayerIDs) || s.Orders == nil || s.Players == nil || s.PlayerIDs == nil || s.News == nil || s.TotalShares == nil || s.SectorFactors == nil || !validDate(s.Date) || s.Seconds < openSeconds || s.Seconds > closeSeconds || s.Seconds%30 != 0 || s.Seconds > noonSeconds && s.Seconds < afternoonSeconds || s.DayIndex < 0 || s.Tick < 0 || s.Seq < 0 || s.FeePool < 0 || s.TotalCash < 0 || len(s.Seed) > 1200 || !finite(s.Macro) {
		return fail("结构或时钟")
	}
	now, dayStart := timestamp(s.Date, s.Seconds), timestamp(s.Date, 0)
	owners := map[int]string{}
	seenPlayers := map[string]bool{}
	for _, id := range s.PlayerIDs {
		p := s.Players[id]
		if p == nil || p.ID != id || id == "" || len(id) > 200 || seenPlayers[id] || p.Owner < 576 || p.Owner >= len(s.Wallets) || owners[p.Owner] != "" || p.InitialCash != initialCash || p.FeesPaid < 0 || p.OrderIDs == nil || p.Trades == nil {
			return fail("玩家归属")
		}
		seenPlayers[id] = true
		owners[p.Owner] = id
	}
	for _, sector := range sectors {
		v, ok := s.SectorFactors[sector]
		if !ok || !finite(v) {
			return fail("行业因子")
		}
	}
	bookIDs := map[string]bool{}
	agentOwners := map[int]bool{}
	var marketVolume, marketTurnover int64
	for i, q := range s.Stocks {
		u := universe[i]
		if q == nil || q.Bids == nil || q.Asks == nil || q.MinuteBars == nil || q.Tape == nil || q.Symbol != u.Symbol || q.Name != u.Name || q.Sector != u.Sector || q.Base != u.Price || q.Beta != u.Beta || q.Last <= 0 || q.PrevClose <= 0 || q.LimitUp != round(float64(q.PrevClose)*1.1) || q.LimitDown != max(1, round(float64(q.PrevClose)*.9)) || q.Last < q.LimitDown || q.Last > q.LimitUp || q.High < q.Low || q.Volume < 0 || q.Turnover < 0 || !finite(q.Fundamental) || q.Fundamental <= 0 || !finite(q.Sentiment) || !finite(q.EMA) || q.EMA <= 0 || !finite(q.Variance) || q.Variance < 0 || len(q.Agents) != 48 || len(q.DailyBars) < 1 || len(q.DailyBars) > 251 || len(q.MinuteBars) > 242 || len(q.Tape) > 100 || s.TotalShares[q.Symbol] != 4800000 {
			return fail("证券状态")
		}
		var aggregateOK bool
		marketVolume, aggregateOK = boundedSum(marketVolume, q.Volume, maxSafeInteger)
		if !aggregateOK {
			return fail("市场成交量合计溢出")
		}
		marketTurnover, aggregateOK = boundedSum(marketTurnover, q.Turnover, maxSafeInteger)
		if !aggregateOK {
			return fail("市场成交额合计溢出")
		}
		if _, ok := safeProduct(q.LimitUp, s.TotalShares[q.Symbol]); !ok {
			return fail("证券估值溢出")
		}
		for _, owner := range q.Agents {
			if owner < 0 || owner >= 576 || agentOwners[owner] {
				return fail("交易者归属")
			}
			agentOwners[owner] = true
		}
		current := q.DailyBars[len(q.DailyBars)-1]
		if current.Time != dayStart+openSeconds*1000 || current.Open != q.Open || current.High != q.High || current.Low != q.Low || current.Close != q.Last || current.Volume != q.Volume || current.Turnover != q.Turnover {
			return fail("当日日线")
		}
		previous := int64(-1)
		for _, b := range q.DailyBars {
			if b.Time <= previous || b.Time > current.Time || !validBar(b) {
				return fail("日线")
			}
			previous = b.Time
		}
		previous = -1
		var volume, turnover int64
		for _, b := range q.MinuteBars {
			seconds := (b.Time - dayStart) / 1000
			session := (seconds >= openSeconds && seconds < noonSeconds) || (seconds >= afternoonSeconds && seconds < auctionSeconds) || (seconds == closeSeconds && s.Seconds == closeSeconds)
			if b.Time <= previous || b.Time > now || b.Time%60000 != 0 || !session || !validBar(b) {
				return fail("分时")
			}
			previous = b.Time
			var ok bool
			volume, ok = boundedSum(volume, b.Volume, q.Volume)
			if !ok {
				return fail("分时成交量溢出")
			}
			turnover, ok = boundedSum(turnover, b.Turnover, q.Turnover)
			if !ok {
				return fail("分时成交额溢出")
			}
		}
		if volume != q.Volume || turnover != q.Turnover || q.Volume > 0 && len(q.Tape) == 0 {
			return fail("行情量额")
		}
		for _, tr := range q.Tape {
			if tr.Symbol != q.Symbol || tr.Time < dayStart+openSeconds*1000 || tr.Time > now || tr.Price < q.LimitDown || tr.Price > q.LimitUp || tr.Quantity <= 0 || tr.Quantity > 1000000 || (tr.Side != "buy" && tr.Side != "sell") {
				return fail("逐笔行情")
			}
		}
		for _, side := range []string{"buy", "sell"} {
			ids := q.Bids
			if side == "sell" {
				ids = q.Asks
			}
			var prev *internalOrder
			for _, id := range ids {
				o := s.Orders[id]
				if bookIDs[id] || o == nil || o.Symbol != q.Symbol || o.Side != side || !active(o) || o.Price < q.LimitDown || o.Price > q.LimitUp {
					return fail("盘口引用")
				}
				bookIDs[id] = true
				if prev != nil && (side == "buy" && prev.Price < o.Price || side == "sell" && prev.Price > o.Price || prev.Price == o.Price && prev.Seq >= o.Seq) {
					return fail("盘口排序")
				}
				prev = o
			}
		}
	}
	orderOwner := map[string]int{}
	for _, id := range s.PlayerIDs {
		p := s.Players[id]
		for _, oid := range p.OrderIDs {
			if _, ok := orderOwner[oid]; ok {
				return fail("重复玩家委托")
			}
			o := s.Orders[oid]
			if o == nil || o.Owner != p.Owner {
				return fail("玩家委托引用")
			}
			orderOwner[oid] = p.Owner
		}
	}
	reserves := make([]int64, len(s.Wallets))
	reservedShares := make([]map[string]int64, len(s.Wallets))
	for i := range reservedShares {
		reservedShares[i] = map[string]int64{}
	}
	for id, o := range s.Orders {
		if o == nil || o.ID != id || o.ID != fmt.Sprintf("O%d", o.Seq) || o.Owner < 0 || o.Owner >= len(s.Wallets) || o.Quantity <= 0 || o.Quantity > 1000000 || o.Filled < 0 || o.Remaining < 0 || o.Filled+o.Remaining != o.Quantity || o.Price <= 0 || o.Price > 9007199254740991 || o.Seq <= 0 || o.Seq > s.Seq || o.Notional < 0 || o.Fee < 0 || o.Reserve < 0 || o.CreatedAt > now || o.Expires < 0 || e.findStock(o.Symbol) == nil || (o.Side != "buy" && o.Side != "sell") {
			return fail("委托结构")
		}
		if _, ok := safeProduct(o.Price, o.Quantity); !ok {
			return fail("委托金额溢出")
		}
		if o.Status != "open" && o.Status != "partial" && o.Status != "filled" && o.Status != "cancelled" && o.Status != "expired" {
			return fail("委托状态")
		}
		isActive := active(o)
		if isActive != (bookIDs[id]) || isActive && o.Remaining <= 0 || o.Status == "open" && o.Filled != 0 || o.Status == "partial" && o.Filled == 0 || o.Status == "filled" && o.Remaining != 0 || o.Filled == 0 && o.Notional != 0 {
			return fail("委托数量状态")
		}
		if o.Fee != fees(o.Notional, o.Side).Total {
			return fail("累计费用")
		}
		avg := int64(0)
		if o.Filled > 0 {
			avg = round(float64(o.Notional) / float64(o.Filled))
		}
		if o.AvgFillPrice != avg {
			return fail("成交均价")
		}
		_, human := owners[o.Owner]
		listed, hasList := orderOwner[id]
		if human != hasList || hasList && listed != o.Owner || !human && !isActive {
			return fail("委托所有权")
		}
		expected := int64(0)
		if isActive && o.Side == "buy" {
			budget, ok := safeProduct(o.Price, o.Remaining)
			if !ok {
				return fail("预留金额溢出")
			}
			total, ok := boundedSum(o.Notional, budget, maxSafeInteger)
			if !ok {
				return fail("累计委托金额溢出")
			}
			remainingFee := fees(total, "buy").Total - o.Fee
			expected, ok = boundedSum(budget, remainingFee, maxSafeInteger)
			if !ok {
				return fail("预留费用溢出")
			}
		}
		if o.Reserve != expected {
			return fail("买入预留")
		}
		if isActive {
			if o.Side == "buy" {
				sum, ok := boundedSum(reserves[o.Owner], o.Reserve, maxSafeInteger)
				if !ok {
					return fail("现金预留累加溢出")
				}
				reserves[o.Owner] = sum
			} else {
				sum, ok := boundedSum(reservedShares[o.Owner][o.Symbol], o.Remaining, s.TotalShares[o.Symbol])
				if !ok {
					return fail("股票预留累加溢出")
				}
				reservedShares[o.Owner][o.Symbol] = sum
			}
		}
	}
	shares := map[string]int64{}
	cash := s.FeePool
	for i, w := range s.Wallets {
		if w == nil || w.Cash < 0 || w.FrozenCash < 0 || w.FrozenCash != reserves[i] || w.FrozenCash > w.Cash || w.Positions == nil || !finite(w.Bias) {
			return fail("钱包")
		}
		if id, ok := owners[i]; ok {
			if w.Kind != "player" || w.PlayerID != id {
				return fail("玩家钱包")
			}
		} else if w.Kind != "liquidity" && w.Kind != "fundamental" && w.Kind != "trend" && w.Kind != "noise" || w.PlayerID != "" {
			return fail("交易者钱包")
		}
		var ok bool
		cash, ok = boundedSum(cash, w.Cash, s.TotalCash)
		if !ok {
			return fail("现金守恒累加溢出")
		}
		for symbol, reserved := range reservedShares[i] {
			h := w.Positions[symbol]
			if h == nil || h.Frozen != reserved {
				return fail("卖出预留")
			}
		}
		for symbol, h := range w.Positions {
			if h == nil || e.findStock(symbol) == nil || h.Quantity < 0 || h.Quantity > s.TotalShares[symbol] || h.TodayBought < 0 || h.Frozen < 0 || h.CostBasis < 0 || h.TodayBought+h.Frozen > h.Quantity || h.Frozen != reservedShares[i][symbol] || (h.Quantity == 0) != (h.CostBasis == 0) {
				return fail("持仓")
			}
			sum, ok := boundedSum(shares[symbol], h.Quantity, s.TotalShares[symbol])
			if !ok {
				return fail("股份守恒累加溢出")
			}
			shares[symbol] = sum
		}
	}
	if cash != s.TotalCash {
		return fail("现金守恒")
	}
	for _, q := range s.Stocks {
		if shares[q.Symbol] != s.TotalShares[q.Symbol] {
			return fail("股份守恒")
		}
	}
	for _, id := range s.PlayerIDs {
		p := s.Players[id]
		w := s.Wallets[p.Owner]
		var basis, paid, marketValue int64
		for symbol, h := range w.Positions {
			amount, ok := safeProduct(h.Quantity, e.findStock(symbol).Last)
			if !ok {
				return fail("玩家持仓估值溢出")
			}
			marketValue, ok = boundedSum(marketValue, amount, maxSafeInteger)
			if !ok {
				return fail("玩家持仓估值合计溢出")
			}
			sum, ok := boundedSum(basis, h.CostBasis, maxSafeInteger)
			if !ok {
				return fail("持仓成本累加溢出")
			}
			basis = sum
		}
		for _, oid := range p.OrderIDs {
			sum, ok := boundedSum(paid, s.Orders[oid].Fee, p.FeesPaid)
			if !ok {
				return fail("玩家费用累加溢出")
			}
			paid = sum
		}
		if _, ok := boundedSum(w.Cash, marketValue, maxSafeInteger); !ok {
			return fail("玩家总资产溢出")
		}
		capital, ok := boundedSum(w.Cash, basis, maxSafeInteger)
		if !ok {
			return fail("玩家资本合计溢出")
		}
		if capital != p.InitialCash+p.RealizedPnl || paid != p.FeesPaid || len(p.Trades) > 5000 {
			return fail("玩家损益")
		}
		if err := e.validatePlayerTrades(p); err != nil {
			return err
		}

		if err := e.validateReview(p); err != nil {
			return err
		}
	}
	if err := e.validateCompanies(); err != nil {
		return err
	}
	if len(s.News) > 100 {
		return fail("新闻上限")
	}
	for _, n := range s.News {
		if n.ID == "" || n.Symbols == nil || n.Time > now || len(n.Headline) > 1200 || len(n.Body) > 8000 || n.Scope != "market" && n.Scope != "sector" && n.Scope != "company" || n.Impact != "positive" && n.Impact != "negative" && n.Impact != "neutral" {
			return fail("新闻")
		}
		for _, symbol := range n.Symbols {
			if e.findStock(symbol) == nil {
				return fail("新闻证券")
			}
		}
	}
	return nil
}
func validBar(b Bar) bool {
	return b.Time >= 0 && b.Open > 0 && b.High >= max(b.Open, b.Close) && b.Low <= min(b.Open, b.Close) && b.Low > 0 && b.Low <= b.High && b.Close > 0 && b.Volume >= 0 && b.Turnover >= 0
}
func floatPointerEqual(a, b *float64) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
func (e *Engine) validateCompanies() error {
	s := e.s
	fail := func() error { return errors.New("存档公司财报、预期或发布日期校验失败") }
	if len(s.Companies) != 12 {
		return fail()
	}
	now := timestamp(s.Date, s.Seconds)
	for i, c := range s.Companies {
		if c == nil || c.Symbol != s.Stocks[i].Symbol || c.Shares != s.TotalShares[c.Symbol] || !finite(c.Trend) || c.Trend < -.08 || c.Trend > .10 || !finite(c.CostRatio) || c.CostRatio < .45 || c.CostRatio > 1.12 || len(c.Reports) < 4 || len(c.Reports) > 24 {
			return fail()
		}
		var ttm int64
		for j := 0; j < min(4, len(c.Reports)); j++ {
			sum, ok := safeSignedSum(ttm, c.Reports[j].NetProfit)
			if !ok {
				return fail()
			}
			ttm = sum
		}
		next, last := c.Pending, c.Reports[0]
		days := next.DayIndex - s.DayIndex
		if days < 0 || days > 5 || shiftDate(s.Date, int(days)) != next.Date || next.PublishedAt != timestamp(next.Date, 36000) || next.PublishedAt <= now || next.Period != last.Period+1 || next.Label != periodLabel(next.Period) || next.Date != shiftDate(time.UnixMilli(last.PublishedAt).In(china).Format("2006-01-02"), 5) {
			return fail()
		}
		forecast := expectedReport(c, next.DayIndex, next.Date)
		if next.ExpectedRevenue != forecast.ExpectedRevenue || next.ExpectedNetProfit != forecast.ExpectedNetProfit {
			return fail()
		}
		for j, r := range c.Reports {
			date := time.UnixMilli(r.PublishedAt).In(china).Format("2006-01-02")
			if r.Period < 1 || r.ID != fmt.Sprintf("%s-R%d", c.Symbol, r.Period) || r.Label != periodLabel(r.Period) || r.PublishedAt > now || r.PublishedAt != timestamp(date, 36000) || !validDate(date) || r.Synthetic != (r.Period <= 4) || r.Revenue <= 0 || r.OperatingCosts < 0 || r.Depreciation < 0 || r.InterestExpense < 0 || r.TaxExpense < 0 || r.Cash < 0 || r.FixedAssets < 0 || r.WorkingCapital < 0 || r.Assets <= 0 || r.Liabilities < 0 || r.Capex < 0 || r.ExpectedRevenue <= 0 || r.Assets != r.Liabilities+r.Equity || r.Assets != r.Cash+r.FixedAssets+r.WorkingCapital || r.NetProfit != r.Revenue-r.OperatingCosts-r.Depreciation-r.InterestExpense-r.TaxExpense || r.OperatingCashFlow != r.NetProfit+r.Depreciation-r.WorkingCapitalChange || r.Eps != float64(r.NetProfit)/float64(c.Shares) || r.Bps != float64(r.Equity)/float64(c.Shares) || r.TaxExpense != max(0, round(float64(r.Revenue-r.OperatingCosts-r.Depreciation-r.InterestExpense)*.25)) || r.RevenueSurprisePct != surprise(r.Revenue, r.ExpectedRevenue, r.ExpectedRevenue) || r.ProfitSurprisePct != surprise(r.NetProfit, r.ExpectedNetProfit, r.ExpectedRevenue) {
				return fail()
			}
			if r.Period == 1 && (r.RevenueGrowthPct != nil || r.ProfitGrowthPct != nil) {
				return fail()
			}
			if j+1 < len(c.Reports) {
				prev := c.Reports[j+1]
				if j+2 < len(c.Reports) || prev.Period == 1 {
					copy := *c
					copy.Reports = c.Reports[j+1:]
					forecast := expectedReport(&copy, 0, date)
					if r.ExpectedRevenue != forecast.ExpectedRevenue || r.ExpectedNetProfit != forecast.ExpectedNetProfit {
						return fail()
					}
				}
				priorDate := time.UnixMilli(prev.PublishedAt).In(china).Format("2006-01-02")
				if r.Period != prev.Period+1 || date != shiftDate(priorDate, 5) || r.Cash != prev.Cash+r.OperatingCashFlow-r.Capex || r.FixedAssets != prev.FixedAssets+r.Capex-r.Depreciation || r.WorkingCapital != prev.WorkingCapital+r.WorkingCapitalChange || r.Equity != prev.Equity+r.NetProfit || r.Liabilities != prev.Liabilities || !floatPointerEqual(r.RevenueGrowthPct, growth(r.Revenue, prev.Revenue)) || !floatPointerEqual(r.ProfitGrowthPct, growth(r.NetProfit, prev.NetProfit)) {
					return fail()
				}
			}
		}
	}
	seen := map[string]bool{}
	for _, n := range s.News {
		if n.Kind == "external" {
			continue
		}
		if n.Kind == "" {
			if n.ReportID != "" {
				return fail()
			}
			continue
		}
		if n.Kind != "earnings" || len(n.Symbols) != 1 || seen[n.ReportID] || n.Scope != "company" {
			return fail()
		}
		seen[n.ReportID] = true
		found := false
		for _, c := range s.Companies {
			if c.Symbol != n.Symbols[0] {
				continue
			}
			for _, r := range c.Reports {
				if r.ID == n.ReportID {
					impact := "neutral"
					if r.ProfitSurprisePct > .5 {
						impact = "positive"
					} else if r.ProfitSurprisePct < -.5 {
						impact = "negative"
					}
					found = !r.Synthetic && r.PublishedAt == n.Time && n.Impact == impact
				}
			}
		}
		if !found {
			return fail()
		}
	}
	return nil
}
func (e *Engine) validateReview(p *player) error {
	r := p.Review
	s := e.s
	now := timestamp(s.Date, s.Seconds)
	fail := func() error { return fmt.Errorf("玩家%s投资复盘记录校验失败", p.ID) }
	if len(r.Days) < 1 || len(r.Days) > reviewMaxDays || r.CoverageStartAt < 0 {
		return fail()
	}
	current := r.Days[len(r.Days)-1]
	if current == nil || current.DayIndex != s.DayIndex || current.Date != s.Date || current.Closed != (s.Seconds == closeSeconds) {
		return fail()
	}
	total := 0
	var previous *reviewDay
	for _, day := range r.Days {
		if day == nil || len(day.Points) < 1 || len(day.Points) > reviewMaxPoints || !validDate(day.Date) || day.DayIndex < 0 || day.DayIndex > s.DayIndex {
			return fail()
		}
		total += len(day.Points)
		start := timestamp(day.Date, 0)
		first, last := day.Points[0], day.Points[len(day.Points)-1]
		if first.Time < r.CoverageStartAt || day.Partial != (first.Time != start+openSeconds*1000) || day.Closed && last.Time != start+closeSeconds*1000 || day != current && !day.Closed {
			return fail()
		}
		if previous != nil {
			before := previous.Points[len(previous.Points)-1]
			same := first
			same.Time = before.Time
			if day.Date != shiftDate(previous.Date, 1) || day.DayIndex != previous.DayIndex+1 || day.Partial || same != before {
				return fail()
			}
		}
		for i, v := range day.Points {
			seconds := (v.Time - start) / 1000
			if v.Time > now || v.Time < start || v.Time%30000 != 0 || !((seconds >= openSeconds && seconds <= noonSeconds) || (seconds >= afternoonSeconds && seconds <= closeSeconds)) || v.Equity < 0 || v.Cash < 0 || v.MarketValue < 0 || v.Equity != v.Cash+v.MarketValue || !finite(v.Index) || v.Index <= 0 || v.Fees < 0 || v.BuyCount < 0 || v.SellCount < 0 || v.BuyAmount < 0 || v.SellAmount < 0 || v.BuyCount+v.SellCount > s.Seq {
				return fail()
			}
			capital, ok := safeSignedSum(p.InitialCash, v.Realized)
			if !ok {
				return fail()
			}
			basis := capital - v.Cash
			if basis < 0 || (basis == 0) != (v.MarketValue == 0) || v.Cash != p.InitialCash+v.SellAmount-v.BuyAmount-v.Fees {
				return fail()
			}
			if i > 0 {
				a := day.Points[i-1]
				if v.Time < a.Time || v == a || v.Fees < a.Fees || v.BuyCount < a.BuyCount || v.SellCount < a.SellCount || v.BuyAmount < a.BuyAmount || v.SellAmount < a.SellAmount || v.Cash-a.Cash != v.SellAmount-a.SellAmount-(v.BuyAmount-a.BuyAmount)-(v.Fees-a.Fees) || (v.BuyCount == a.BuyCount) != (v.BuyAmount == a.BuyAmount) || (v.SellCount == a.SellCount) != (v.SellAmount == a.SellAmount) || v.SellCount == a.SellCount && v.Realized != a.Realized || v.BuyCount == a.BuyCount && v.SellCount == a.SellCount && v.Fees != a.Fees {
					return fail()
				}
			}
		}
		previous = day
	}
	if total > reviewMaxTotal || r.CoverageStartAt > r.Days[0].Points[0].Time {
		return fail()
	}
	last := current.Points[len(current.Points)-1]
	expected := e.observation(p, last)
	if !reflect.DeepEqual(expected, last) || last.Time != now {
		return fail()
	}
	var buyAmount, sellAmount, buyCount, sellCount int64
	for _, id := range p.OrderIDs {
		o := s.Orders[id]
		if o.Side == "buy" {
			sum, ok := boundedSum(buyAmount, o.Notional, maxSafeInteger)
			if !ok {
				return fail()
			}
			buyAmount = sum
		} else {
			sum, ok := boundedSum(sellAmount, o.Notional, maxSafeInteger)
			if !ok {
				return fail()
			}
			sellAmount = sum
		}
	}
	for _, t := range p.Trades {
		if t.Side == "buy" {
			buyCount++
		} else {
			sellCount++
		}
	}
	if last.BuyAmount != buyAmount || last.SellAmount != sellAmount || len(p.Trades) < 5000 && (last.BuyCount != buyCount || last.SellCount != sellCount) || len(p.Trades) == 5000 && (last.BuyCount < buyCount || last.SellCount < sellCount) {
		return fail()
	}
	return nil
}

// encoding/json rejects malformed numeric values but silently zeroes absent fields.
// Require the complete persisted schema so a missing RNG/counter cannot alter replay.
func requireJSONFields(raw json.RawMessage, typ reflect.Type) error {
	if typ.Kind() == reflect.Pointer {
		if typ.Elem().Kind() == reflect.Float64 && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil
		}
		typ = typ.Elem()
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return errors.New("必须字段为null")
	}
	switch typ.Kind() {
	case reflect.Struct:
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil {
			return err
		}
		return requireObjectFields(object, typ)
	case reflect.Slice, reflect.Array:
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return err
		}
		for _, item := range items {
			if err := requireJSONFields(item, typ.Elem()); err != nil {
				return err
			}
		}
	case reflect.Map:
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil {
			return err
		}
		for _, item := range object {
			if err := requireJSONFields(item, typ.Elem()); err != nil {
				return err
			}
		}
	}
	return nil
}
func requireObjectFields(object map[string]json.RawMessage, typ reflect.Type) error {
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		// encoding/json flattens exported members of anonymous private structs.
		if field.Anonymous && field.Type.Kind() == reflect.Struct && field.Tag.Get("json") == "" {
			if err := requireObjectFields(object, field.Type); err != nil {
				return err
			}
			continue
		}
		if !field.IsExported() {
			continue
		}
		tag := field.Tag.Get("json")
		if tag == "-" {
			continue
		}
		if field.Anonymous && tag == "" {
			if err := requireObjectFields(object, field.Type); err != nil {
				return err
			}
			continue
		}
		name := strings.Split(tag, ",")[0]
		if name == "" {
			name = field.Name
		}
		value, ok := object[name]
		if !ok {
			if strings.Contains(tag, ",omitempty") {
				continue
			}
			return fmt.Errorf("缺少%s", name)
		}
		if err := requireJSONFields(value, field.Type); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}
