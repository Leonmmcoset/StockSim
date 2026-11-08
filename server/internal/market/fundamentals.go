package market

import (
	"fmt"
	"math"
)

type companyState struct {
	Symbol           string
	Shares           int64
	RNG              uint32
	Trend, CostRatio float64
	Reports          []FinancialReport
	Pending          ReportSchedule
}

var businesses = []string{"面向区域企业与居民提供存贷、结算和财富管理服务。", "提供证券经纪、资产管理与企业融资顾问服务。", "生产和销售包装食品、调味品与区域特色消费品。", "经营连锁零售、供应链采购及线上线下商贸服务。", "从事传统能源供应、储运及工业客户能源服务。", "经营发电设施与区域电力供应，推进低碳电源投资。", "研发企业软件、云平台及工业数字化解决方案。", "设计与制造电子元件、智能终端配套器件。", "研发生产常用药品，提供医药流通和健康产品服务。", "从事创新生物制品研发，处于投入较高的商业化阶段。", "生产工业装备，提供制造产线与设备维护服务。", "制造精密零件、自动化部件及工业配套产品。"}

func ptr(v float64) *float64 { return &v }
func growth(actual, base int64) *float64 {
	if base <= 0 {
		return nil
	}
	return ptr((float64(actual)/float64(base) - 1) * 100)
}
func surprise(actual, expected, revenue int64) float64 {
	return float64(actual-expected) / math.Max(math.Abs(float64(expected)), float64(revenue)*.01) * 100
}
func periodLabel(period int64) string { return fmt.Sprintf("第%d期（模拟季报）", period) }
func expectedReport(c *companyState, dayIndex int64, date string) ReportSchedule {
	last := c.Reports[0]
	revenueTrend, profitTrend := .02, 0.
	if len(c.Reports) > 1 {
		prev := c.Reports[1]
		revenueTrend = clamp(float64(last.Revenue)/float64(prev.Revenue)-1, -.04, .08)
		if prev.NetProfit > 0 {
			profitTrend = clamp(float64(last.NetProfit)/float64(prev.NetProfit)-1, -.10, .14)
		}
	}
	optimism := .015
	if c.Symbol == "600101" {
		optimism = .12
	}
	return ReportSchedule{Period: last.Period + 1, Label: periodLabel(last.Period + 1), DayIndex: dayIndex, Date: date, PublishedAt: timestamp(date, 36000), ExpectedRevenue: max(1, round(float64(last.Revenue)*(1+.5*revenueTrend+.015))), ExpectedNetProfit: round(float64(last.NetProfit) + math.Abs(float64(last.NetProfit))*(.5*profitTrend+optimism))}
}
func operate(c *companyState, plan ReportSchedule, synthetic bool, opening *FinancialReport) FinancialReport {
	var prev FinancialReport
	if opening != nil {
		prev = *opening
	} else {
		prev = c.Reports[0]
	}
	c.Trend = clamp(.72*c.Trend+.28*.018+normal(&c.RNG)*.018, -.08, .10)
	revenue := max(c.Shares, round(float64(prev.Revenue)*(1+clamp(c.Trend+normal(&c.RNG)*.022, -.16, .16))))
	depreciation := round(float64(prev.FixedAssets) * .015)
	interest := round(float64(prev.Liabilities) * .003)
	cost := max(0, round(float64(revenue)*clamp(c.CostRatio+normal(&c.RNG)*.012, .45, 1.12)))
	cost = min(cost, max(0, revenue-depreciation-interest+int64(math.Floor(float64(prev.Cash)*.10))))
	pretax := revenue - cost - depreciation - interest
	tax := max(0, round(float64(pretax)*.25))
	profit := pretax - tax
	target := round(float64(revenue) * .16)
	workingChange := clampInt(target-prev.WorkingCapital, -prev.WorkingCapital, max(0, int64(math.Floor(float64(prev.Cash+profit+depreciation)*.15))))
	operating := profit + depreciation - workingChange
	capex := max(0, min(round(float64(depreciation)*1.2), int64(math.Floor(float64(prev.Cash+operating)*.25))))
	cash := prev.Cash + operating - capex
	fixed := prev.FixedAssets + capex - depreciation
	working := prev.WorkingCapital + workingChange
	assets := cash + fixed + working
	equity := assets - prev.Liabilities
	r := FinancialReport{ID: fmt.Sprintf("%s-R%d", c.Symbol, plan.Period), Period: plan.Period, Label: plan.Label, PublishedAt: plan.PublishedAt, Synthetic: synthetic, Revenue: revenue, OperatingCosts: cost, Depreciation: depreciation, InterestExpense: interest, TaxExpense: tax, NetProfit: profit, OperatingCashFlow: operating, Capex: capex, WorkingCapitalChange: workingChange, Cash: cash, FixedAssets: fixed, WorkingCapital: working, Assets: assets, Liabilities: prev.Liabilities, Equity: equity, Eps: float64(profit) / float64(c.Shares), Bps: float64(equity) / float64(c.Shares), ExpectedRevenue: plan.ExpectedRevenue, ExpectedNetProfit: plan.ExpectedNetProfit, RevenueSurprisePct: surprise(revenue, plan.ExpectedRevenue, plan.ExpectedRevenue), ProfitSurprisePct: surprise(profit, plan.ExpectedNetProfit, plan.ExpectedRevenue)}
	if opening == nil {
		r.RevenueGrowthPct = growth(revenue, prev.Revenue)
		r.ProfitGrowthPct = growth(profit, prev.NetProfit)
	}
	return r
}
func (e *Engine) initializeCompanies() {
	s := e.s
	margins := []float64{.16, .13, .10, .055, .12, .09, .15, .08, .13, -.025, .08, .07}
	s.Companies = []*companyState{}
	for index, q := range s.Stocks {
		shares := s.TotalShares[q.Symbol]
		assets := q.Last * shares
		liabilities := round(float64(assets) * .3)
		revenue := round(float64(assets) * .24)
		fixed := round(float64(assets) * .35)
		working := round(float64(revenue) * .16)
		divisor := 1.
		if margins[index] > 0 {
			divisor = .75
		}
		c := &companyState{Symbol: q.Symbol, Shares: shares, RNG: hashSeed(s.Seed + ":company:" + q.Symbol), Trend: .025, CostRatio: 1 - margins[index]/divisor - float64(fixed)*.015/float64(revenue) - float64(liabilities)*.003/float64(revenue), Reports: []FinancialReport{}}
		opening := FinancialReport{Revenue: revenue, Cash: assets - fixed - working, FixedAssets: fixed, WorkingCapital: working, Liabilities: liabilities, NetProfit: round(float64(revenue) * margins[index])}
		offset := index % 5
		if s.Seconds >= 36000 {
			offset++
		}
		for period := int64(1); period <= 4; period++ {
			date := shiftDate(s.Date, offset-int(5-period)*5)
			var plan ReportSchedule
			var o *FinancialReport
			if period == 1 {
				plan = ReportSchedule{Period: period, Label: periodLabel(period), Date: date, DayIndex: s.DayIndex + int64(offset) - 20, PublishedAt: timestamp(date, 36000), ExpectedRevenue: revenue, ExpectedNetProfit: opening.NetProfit}
				o = &opening
			} else {
				plan = expectedReport(c, s.DayIndex+int64(offset)-(5-period)*5, date)
			}
			r := operate(c, plan, true, o)
			c.Reports = append([]FinancialReport{r}, c.Reports...)
		}
		c.Pending = expectedReport(c, s.DayIndex+int64(offset), shiftDate(s.Date, offset))
		s.Companies = append(s.Companies, c)
	}
}
func applyEarningsSignal(q *stock, r FinancialReport) {
	surprise := clamp(r.ProfitSurprisePct/100, -.8, .8)
	sales := clamp(r.RevenueSurprisePct/100, -.3, .3)
	q.Fundamental *= math.Exp(.055*surprise + .025*sales)
	q.Sentiment = clamp(q.Sentiment+.018*surprise+.006*sales, -.035, .035)
}
func (e *Engine) releaseDueEarnings() {
	s := e.s
	now := timestamp(s.Date, s.Seconds)
	for _, c := range s.Companies {
		if c.Pending.PublishedAt > now {
			continue
		}
		q := e.findStock(c.Symbol)
		r := operate(c, c.Pending, false, nil)
		c.Reports = append([]FinancialReport{r}, c.Reports...)
		if len(c.Reports) > 24 {
			c.Reports = c.Reports[:24]
		}
		c.Pending = expectedReport(c, c.Pending.DayIndex+5, shiftDate(c.Pending.Date, 5))
		applyEarningsSignal(q, r)
		impact, description := "neutral", "净利润符合预期"
		if r.ProfitSurprisePct > .5 {
			impact, description = "positive", "净利润超出预期"
		} else if r.ProfitSurprisePct < -.5 {
			impact, description = "negative", "净利润不及预期"
		}
		s.Seq++
		e.prependNews(NewsItem{ID: fmt.Sprintf("N%d", s.Seq), Time: r.PublishedAt, Kind: "earnings", ReportID: r.ID, Scope: "company", Symbols: []string{c.Symbol}, Impact: impact, Headline: q.Name + " " + r.Label + "：" + description, Body: fmt.Sprintf("营业收入%.2f元（此前预期%.2f元）；净利润%.2f元（此前预期%.2f元），盈利预期差%+.2f%%；经营现金流%.2f元。每5交易日约一模拟季度；预期差以预期净利绝对值与预期营收1%%中的较大值为分母。公告影响交易者判断，成交方向取决于订单撮合。", float64(r.Revenue)/100, float64(r.ExpectedRevenue)/100, float64(r.NetProfit)/100, float64(r.ExpectedNetProfit)/100, r.ProfitSurprisePct, float64(r.OperatingCashFlow)/100)})
	}
}
func (e *Engine) publicCompanies() []CompanyFundamentals {
	out := []CompanyFundamentals{}
	for i, c := range e.s.Companies {
		q := e.findStock(c.Symbol)
		last := c.Reports[0]
		var ttm int64
		for j := 0; j < min(4, len(c.Reports)); j++ {
			ttm += c.Reports[j].NetProfit
		}
		cap := q.Last * c.Shares
		v := CompanyFundamentalsValuation{MarketCap: cap, Eps: last.Eps, Bps: last.Bps, TtmNetProfit: ttm, DebtRatioPct: float64(last.Liabilities) / float64(last.Assets) * 100}
		if ttm > 0 {
			v.Pe = ptr(float64(cap) / float64(ttm))
		}
		if last.Equity > 0 {
			v.Pb = ptr(float64(cap) / float64(last.Equity))
			v.RoePct = ptr(float64(ttm) / float64(last.Equity) * 100)
		}
		peers := []string{}
		for _, p := range e.s.Stocks {
			if p.Sector == q.Sector && p.Symbol != q.Symbol {
				peers = append(peers, p.Symbol)
			}
		}
		out = append(out, CompanyFundamentals{Symbol: c.Symbol, Shares: c.Shares, Profile: CompanyFundamentalsProfile{Name: q.Name, Sector: q.Sector, Business: businesses[i], Description: q.Name + "是股海模拟市场中的虚构" + q.Sector + "公司。经营、财报和估值均为服务器模拟；不对应现实发行人。"}, Reports: c.Reports, NextReport: c.Pending, CycleTradingDays: 5, PeerSymbols: peers, Valuation: v})
	}
	return out
}
