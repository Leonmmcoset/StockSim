export type Money = number;
export type Price = number;
export type Side = 'buy' | 'sell';
export type MarketPhase = 'continuous' | 'lunch' | 'closing-auction' | 'closed';
export type OrderStatus = 'open' | 'partial' | 'filled' | 'cancelled' | 'expired';

export interface Level { price: Price; quantity: number }
export interface Bar {
  time: number;
  open: Price; high: Price; low: Price; close: Price;
  volume: number; turnover: Money;
}
export interface TapeTrade {
  id: string; symbol: string; time: number;
  price: Price; quantity: number; side: Side;
}
export interface Quote {
  symbol: string; name: string; sector: string;
  last: Price; prevClose: Price; open: Price; high: Price; low: Price;
  change: Price; changePct: number;
  volume: number; turnover: Money; vwap: Price;
  limitUp: Price; limitDown: Price;
  bids: Level[]; asks: Level[]; // 各最多五档，最优在下标0；缺档不伪造
  minuteBars: Bar[]; // 当日一分钟bar，尾项可为未完成bar
  dailyBars: Bar[];  // 含当前交易日的未完成bar；最多251项（250个历史交易日加当日）
  recentTrades: TapeTrade[]; // 最新在前，最多30项
}
export interface Position {
  symbol: string; quantity: number;
  sellable: number; // 此刻可新下卖单的数量，已扣除frozen
  frozen: number; todayBought: number;
  costBasis: Money; // 剩余持仓精确成本，包含分摊买入费用
  averageCost: Price; // costBasis / quantity四舍五入，仅用于显示
  marketValue: Money; pnl: Money; pnlPct: number;
}
export interface Account {
  initialCash: Money; cash: Money; availableCash: Money; frozenCash: Money;
  marketValue: Money; equity: Money;
  totalPnl: Money; totalPnlPct: number; realizedPnl: Money; feesPaid: Money;
  positions: Position[]; // 仅quantity>0，按symbol排序
}
export interface Order {
  id: string; symbol: string; side: Side; price: Price;
  quantity: number; filled: number; remaining: number;
  status: OrderStatus; createdAt: number;
  avgFillPrice: Price; fee: Money;
}
export interface PlayerTrade {
  id: string; orderId: string; symbol: string; side: Side;
  time: number; price: Price; quantity: number;
  amount: Money; fee: Money; // 本次成交计提的费用增量
}
export interface NewsItem {
  id: string; time: number; headline: string; body: string;
  scope: 'market' | 'sector' | 'company'; symbols: string[];
  impact: 'positive' | 'negative' | 'neutral';
  kind?: 'earnings'; reportId?: string;
}
export interface MarketClock {
  dayIndex: number; date: string; time: string; timestamp: number;
  phase: MarketPhase; phaseLabel: string;
}
export interface MarketIndex {
  name: string; value: number; changePct: number;
  advancing: number; declining: number; unchanged: number;
  volume: number; turnover: Money;
}
export interface MarketSnapshot {
  version: 1; seed: string; clock: MarketClock;
  quotes: Quote[]; account: Account;
  companies: CompanyFundamentals[];
  review: InvestmentReview;
  orders: Order[]; // 玩家全部保留订单，最新在前；可按date/status筛选
  trades: PlayerTrade[]; // 玩家成交，最新在前
  news: NewsItem[]; // 最新在前，最多100项
  index: MarketIndex;
}
export interface OrderInput {
  symbol: string; side: Side; price: Price; quantity: number;
}
export type ErrorCode =
  | 'UNKNOWN_SYMBOL' | 'INVALID_PRICE' | 'INVALID_QUANTITY'
  | 'OUTSIDE_LIMIT' | 'PRICE_CAGE' | 'MARKET_CLOSED'
  | 'INSUFFICIENT_CASH' | 'INSUFFICIENT_SHARES'
  | 'ORDER_NOT_FOUND' | 'ORDER_NOT_OPEN' | 'CANCEL_RESTRICTED';
export interface CommandResult { ok: boolean; order?: Order; error?: string; code?: ErrorCode }
export interface FeeBreakdown {
  commission: Money; transfer: Money; stamp: Money; total: Money;
}
export interface OrderPreview {
  amount: Money; fees: FeeBreakdown; cashRequired: Money;
  maxBuyQuantity: number; maxSellQuantity: number;
}
export interface MarketOptions {
  seed?: string | number;
  startingCash?: Money; // 默认500000
  historyDays?: number; // 默认60；0可用于测试/诊断
}
export interface MarketEngine {
  step(ticks?: number): void;
  placeOrder(input: OrderInput): CommandResult;
  cancelOrder(orderId: string): CommandResult;
  previewOrder(input: OrderInput): OrderPreview;
  skipLunch(): void;
  nextDay(): void;
  getSnapshot(): MarketSnapshot;
  exportState(): MarketSave; // 带schemaVersion的可JSON序列化对象
}
export interface MarketSave { schemaVersion: 1 | 2 | 3; data: unknown }

/** All total amounts are integer fen; EPS/BPS are fen per share (not rounded).
 * All *Pct are percentage points. Growth is QoQ and null if prior base <= 0.
 * Surprise = (actual - expected) / max(abs(expected), expectedRevenue * .01) * 100.
 */
export interface FinancialReport {
  id: string; period: number; label: string; publishedAt: number; synthetic: boolean;
  revenue: Money; operatingCosts: Money; depreciation: Money; interestExpense: Money; taxExpense: Money;
  netProfit: Money; operatingCashFlow: Money; capex: Money; workingCapitalChange: Money;
  cash: Money; fixedAssets: Money; workingCapital: Money;
  assets: Money; liabilities: Money; equity: Money;
  eps: number; bps: number;
  revenueGrowthPct: number | null; profitGrowthPct: number | null;
  expectedRevenue: Money; expectedNetProfit: Money;
  revenueSurprisePct: number; profitSurprisePct: number;
}
export interface ReportSchedule {
  period: number; label: string; dayIndex: number; date: string; publishedAt: number;
  expectedRevenue: Money; expectedNetProfit: Money;
}
export interface CompanyFundamentals {
  symbol: string; shares: number;
  profile: { name: string; sector: string; description: string; business: string };
  reports: FinancialReport[]; // newest first, up to 24 published simulated quarters
  nextReport: ReportSchedule; // public forecast; contains no future actual results
  valuation: {
    marketCap: Money; pe: number | null; pb: number | null;
    eps: number; bps: number; // latest quarter EPS; latest balance-sheet BPS, fen/share
    ttmNetProfit: Money; roePct: number | null; debtRatioPct: number;
  };
  peerSymbols: string[];
  cycleTradingDays: 5;
}

/** Real account observations only; all amounts are integer fen, *Pct percentage points. */
export interface EquityPoint {
  time: number; dayIndex: number; equity: Money; cash: Money; marketValue: Money;
  positionPct: number; indexValue: number;
}
export interface NormalizedEquityPoint extends EquityPoint {
  returnPct: number | null; benchmarkReturnPct: number; excessReturnPct: number | null;
}
export interface DailyReview {
  dayIndex: number; date: string; status: 'in-progress' | 'closed';
  partial: boolean; coverageStartAt: number; startAt: number; endAt: number;
  startEquity: Money; endEquity: Money; netPnl: Money; returnPct: number | null;
  benchmarkReturnPct: number; excessReturnPct: number | null;
  buyFillCount: number; sellFillCount: number; buyAmount: Money; sellAmount: Money;
  fees: Money; realizedPnl: Money; unrealizedPnlChange: Money; grossPnl: Money;
  maxDrawdownPct: number;
}
export interface InvestmentReview {
  points: EquityPoint[]; days: DailyReview[]; currentDay: DailyReview;
  coverageStartAt: number; retentionDays: 30; sampling: '30s-and-fills';
  /** Extremely busy days may be compacted, preserving observed equity drawdown extrema. */
  compacted: boolean;
}
export interface ReviewPeriodSummary extends Omit<DailyReview, 'dayIndex' | 'date'> {
  startDate: string; endDate: string; dayCount: number;
}
