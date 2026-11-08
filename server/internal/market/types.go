package market

type Money = int64
type Price = int64
type Side = string
type MarketPhase = string
type OrderStatus = string
type ErrorCode = string

type Level struct {
	Price    Price `json:"price"`
	Quantity int64 `json:"quantity"`
}

type Bar struct {
	Time     int64 `json:"time"`
	Open     Price `json:"open"`
	High     Price `json:"high"`
	Low      Price `json:"low"`
	Close    Price `json:"close"`
	Volume   int64 `json:"volume"`
	Turnover Money `json:"turnover"`
}

type TapeTrade struct {
	ID       string `json:"id"`
	Symbol   string `json:"symbol"`
	Time     int64  `json:"time"`
	Price    Price  `json:"price"`
	Quantity int64  `json:"quantity"`
	Side     Side   `json:"side"`
}

type Quote struct {
	Symbol       string      `json:"symbol"`
	Name         string      `json:"name"`
	Sector       string      `json:"sector"`
	Last         Price       `json:"last"`
	PrevClose    Price       `json:"prevClose"`
	Open         Price       `json:"open"`
	High         Price       `json:"high"`
	Low          Price       `json:"low"`
	Change       Price       `json:"change"`
	ChangePct    float64     `json:"changePct"`
	Volume       int64       `json:"volume"`
	Turnover     Money       `json:"turnover"`
	Vwap         Price       `json:"vwap"`
	LimitUp      Price       `json:"limitUp"`
	LimitDown    Price       `json:"limitDown"`
	Bids         []Level     `json:"bids"`
	Asks         []Level     `json:"asks"`
	MinuteBars   []Bar       `json:"minuteBars"`
	DailyBars    []Bar       `json:"dailyBars"`
	RecentTrades []TapeTrade `json:"recentTrades"`
}

type Position struct {
	Symbol      string  `json:"symbol"`
	Quantity    int64   `json:"quantity"`
	Sellable    int64   `json:"sellable"`
	Frozen      int64   `json:"frozen"`
	TodayBought int64   `json:"todayBought"`
	CostBasis   Money   `json:"costBasis"`
	AverageCost Price   `json:"averageCost"`
	MarketValue Money   `json:"marketValue"`
	Pnl         Money   `json:"pnl"`
	PnlPct      float64 `json:"pnlPct"`
}

type Account struct {
	InitialCash   Money      `json:"initialCash"`
	Cash          Money      `json:"cash"`
	AvailableCash Money      `json:"availableCash"`
	FrozenCash    Money      `json:"frozenCash"`
	MarketValue   Money      `json:"marketValue"`
	Equity        Money      `json:"equity"`
	TotalPnl      Money      `json:"totalPnl"`
	TotalPnlPct   float64    `json:"totalPnlPct"`
	RealizedPnl   Money      `json:"realizedPnl"`
	FeesPaid      Money      `json:"feesPaid"`
	Positions     []Position `json:"positions"`
}

type Order struct {
	ID           string      `json:"id"`
	Symbol       string      `json:"symbol"`
	Side         Side        `json:"side"`
	Price        Price       `json:"price"`
	Quantity     int64       `json:"quantity"`
	Filled       int64       `json:"filled"`
	Remaining    int64       `json:"remaining"`
	Status       OrderStatus `json:"status"`
	CreatedAt    int64       `json:"createdAt"`
	AvgFillPrice Price       `json:"avgFillPrice"`
	Fee          Money       `json:"fee"`
}

type PlayerTrade struct {
	ID       string `json:"id"`
	OrderID  string `json:"orderId"`
	Symbol   string `json:"symbol"`
	Side     Side   `json:"side"`
	Time     int64  `json:"time"`
	Price    Price  `json:"price"`
	Quantity int64  `json:"quantity"`
	Amount   Money  `json:"amount"`
	Fee      Money  `json:"fee"`
}

type ExternalEventInfo struct {
	Category string `json:"category"`
	Severity string `json:"severity"`
}

type NewsItem struct {
	ID       string             `json:"id"`
	Time     int64              `json:"time"`
	Headline string             `json:"headline"`
	Body     string             `json:"body"`
	Scope    string             `json:"scope"`
	Symbols  []string           `json:"symbols"`
	Impact   string             `json:"impact"`
	Kind     string             `json:"kind,omitempty"`
	ReportID string             `json:"reportId,omitempty"`
	Event    *ExternalEventInfo `json:"event,omitempty"`
}

type MarketClock struct {
	DayIndex   int64       `json:"dayIndex"`
	Date       string      `json:"date"`
	Time       string      `json:"time"`
	Timestamp  int64       `json:"timestamp"`
	Phase      MarketPhase `json:"phase"`
	PhaseLabel string      `json:"phaseLabel"`
}

type MarketIndex struct {
	Name      string  `json:"name"`
	Value     float64 `json:"value"`
	ChangePct float64 `json:"changePct"`
	Advancing int64   `json:"advancing"`
	Declining int64   `json:"declining"`
	Unchanged int64   `json:"unchanged"`
	Volume    int64   `json:"volume"`
	Turnover  Money   `json:"turnover"`
}

type MarketSnapshot struct {
	Version   int64                 `json:"version"`
	Seed      string                `json:"seed"`
	Clock     MarketClock           `json:"clock"`
	Quotes    []Quote               `json:"quotes"`
	Account   Account               `json:"account"`
	Companies []CompanyFundamentals `json:"companies"`
	Review    InvestmentReview      `json:"review"`
	Orders    []Order               `json:"orders"`
	Trades    []PlayerTrade         `json:"trades"`
	News      []NewsItem            `json:"news"`
	Index     MarketIndex           `json:"index"`
}

type OrderInput struct {
	Symbol   string `json:"symbol"`
	Side     Side   `json:"side"`
	Price    Price  `json:"price"`
	Quantity int64  `json:"quantity"`
}

type CommandResult struct {
	OK    bool      `json:"ok"`
	Order *Order    `json:"order,omitempty"`
	Error string    `json:"error,omitempty"`
	Code  ErrorCode `json:"code,omitempty"`
}

type FeeBreakdown struct {
	Commission Money `json:"commission"`
	Transfer   Money `json:"transfer"`
	Stamp      Money `json:"stamp"`
	Total      Money `json:"total"`
}

type OrderPreview struct {
	Amount          Money        `json:"amount"`
	Fees            FeeBreakdown `json:"fees"`
	CashRequired    Money        `json:"cashRequired"`
	MaxBuyQuantity  int64        `json:"maxBuyQuantity"`
	MaxSellQuantity int64        `json:"maxSellQuantity"`
}

type FinancialReport struct {
	ID                   string   `json:"id"`
	Period               int64    `json:"period"`
	Label                string   `json:"label"`
	PublishedAt          int64    `json:"publishedAt"`
	Synthetic            bool     `json:"synthetic"`
	Revenue              Money    `json:"revenue"`
	OperatingCosts       Money    `json:"operatingCosts"`
	Depreciation         Money    `json:"depreciation"`
	InterestExpense      Money    `json:"interestExpense"`
	TaxExpense           Money    `json:"taxExpense"`
	NetProfit            Money    `json:"netProfit"`
	OperatingCashFlow    Money    `json:"operatingCashFlow"`
	Capex                Money    `json:"capex"`
	WorkingCapitalChange Money    `json:"workingCapitalChange"`
	Cash                 Money    `json:"cash"`
	FixedAssets          Money    `json:"fixedAssets"`
	WorkingCapital       Money    `json:"workingCapital"`
	Assets               Money    `json:"assets"`
	Liabilities          Money    `json:"liabilities"`
	Equity               Money    `json:"equity"`
	Eps                  float64  `json:"eps"`
	Bps                  float64  `json:"bps"`
	RevenueGrowthPct     *float64 `json:"revenueGrowthPct"`
	ProfitGrowthPct      *float64 `json:"profitGrowthPct"`
	ExpectedRevenue      Money    `json:"expectedRevenue"`
	ExpectedNetProfit    Money    `json:"expectedNetProfit"`
	RevenueSurprisePct   float64  `json:"revenueSurprisePct"`
	ProfitSurprisePct    float64  `json:"profitSurprisePct"`
}

type ReportSchedule struct {
	Period            int64  `json:"period"`
	Label             string `json:"label"`
	DayIndex          int64  `json:"dayIndex"`
	Date              string `json:"date"`
	PublishedAt       int64  `json:"publishedAt"`
	ExpectedRevenue   Money  `json:"expectedRevenue"`
	ExpectedNetProfit Money  `json:"expectedNetProfit"`
}

type CompanyFundamentalsProfile struct {
	Name        string `json:"name"`
	Sector      string `json:"sector"`
	Description string `json:"description"`
	Business    string `json:"business"`
}

type CompanyFundamentalsValuation struct {
	MarketCap    Money    `json:"marketCap"`
	Pe           *float64 `json:"pe"`
	Pb           *float64 `json:"pb"`
	Eps          float64  `json:"eps"`
	Bps          float64  `json:"bps"`
	TtmNetProfit Money    `json:"ttmNetProfit"`
	RoePct       *float64 `json:"roePct"`
	DebtRatioPct float64  `json:"debtRatioPct"`
}

type CompanyFundamentals struct {
	Symbol           string                       `json:"symbol"`
	Shares           int64                        `json:"shares"`
	Profile          CompanyFundamentalsProfile   `json:"profile"`
	Reports          []FinancialReport            `json:"reports"`
	NextReport       ReportSchedule               `json:"nextReport"`
	Valuation        CompanyFundamentalsValuation `json:"valuation"`
	PeerSymbols      []string                     `json:"peerSymbols"`
	CycleTradingDays int64                        `json:"cycleTradingDays"`
}

type EquityPoint struct {
	Time        int64   `json:"time"`
	DayIndex    int64   `json:"dayIndex"`
	Equity      Money   `json:"equity"`
	Cash        Money   `json:"cash"`
	MarketValue Money   `json:"marketValue"`
	PositionPct float64 `json:"positionPct"`
	IndexValue  float64 `json:"indexValue"`
}

type DailyReview struct {
	DayIndex            int64    `json:"dayIndex"`
	Date                string   `json:"date"`
	Status              string   `json:"status"`
	Partial             bool     `json:"partial"`
	CoverageStartAt     int64    `json:"coverageStartAt"`
	StartAt             int64    `json:"startAt"`
	EndAt               int64    `json:"endAt"`
	StartEquity         Money    `json:"startEquity"`
	EndEquity           Money    `json:"endEquity"`
	NetPnl              Money    `json:"netPnl"`
	ReturnPct           *float64 `json:"returnPct"`
	BenchmarkReturnPct  float64  `json:"benchmarkReturnPct"`
	ExcessReturnPct     *float64 `json:"excessReturnPct"`
	BuyFillCount        int64    `json:"buyFillCount"`
	SellFillCount       int64    `json:"sellFillCount"`
	BuyAmount           Money    `json:"buyAmount"`
	SellAmount          Money    `json:"sellAmount"`
	Fees                Money    `json:"fees"`
	RealizedPnl         Money    `json:"realizedPnl"`
	UnrealizedPnlChange Money    `json:"unrealizedPnlChange"`
	GrossPnl            Money    `json:"grossPnl"`
	MaxDrawdownPct      float64  `json:"maxDrawdownPct"`
}

type InvestmentReview struct {
	Points          []EquityPoint `json:"points"`
	Days            []DailyReview `json:"days"`
	CurrentDay      DailyReview   `json:"currentDay"`
	CoverageStartAt int64         `json:"coverageStartAt"`
	RetentionDays   int64         `json:"retentionDays"`
	Sampling        string        `json:"sampling"`
	Compacted       bool          `json:"compacted"`
}

type NormalizedEquityPoint struct {
	EquityPoint
	ReturnPct          *float64 `json:"returnPct"`
	BenchmarkReturnPct float64  `json:"benchmarkReturnPct"`
	ExcessReturnPct    *float64 `json:"excessReturnPct"`
}

type ReviewPeriodSummary struct {
	Status              string   `json:"status"`
	Partial             bool     `json:"partial"`
	CoverageStartAt     int64    `json:"coverageStartAt"`
	StartAt             int64    `json:"startAt"`
	EndAt               int64    `json:"endAt"`
	StartEquity         Money    `json:"startEquity"`
	EndEquity           Money    `json:"endEquity"`
	NetPnl              Money    `json:"netPnl"`
	ReturnPct           *float64 `json:"returnPct"`
	BenchmarkReturnPct  float64  `json:"benchmarkReturnPct"`
	ExcessReturnPct     *float64 `json:"excessReturnPct"`
	BuyFillCount        int64    `json:"buyFillCount"`
	SellFillCount       int64    `json:"sellFillCount"`
	BuyAmount           Money    `json:"buyAmount"`
	SellAmount          Money    `json:"sellAmount"`
	Fees                Money    `json:"fees"`
	RealizedPnl         Money    `json:"realizedPnl"`
	UnrealizedPnlChange Money    `json:"unrealizedPnlChange"`
	GrossPnl            Money    `json:"grossPnl"`
	MaxDrawdownPct      float64  `json:"maxDrawdownPct"`
	StartDate           string   `json:"startDate"`
	EndDate             string   `json:"endDate"`
	DayCount            int64    `json:"dayCount"`
}

type Options struct {
	// EventSeed is only for deterministic Go tests/offline fixtures; production leaves it empty.
	EventSeed     string
	EventMeanDays int64
	DisableEvents bool
	Seed          string
	HistoryDays   *int
}
type ReviewPeriod struct {
	Kind     string
	Days     int
	DayIndex int64
}
type ReviewSelection struct {
	Points  []NormalizedEquityPoint `json:"points"`
	Summary ReviewPeriodSummary     `json:"summary"`
}
