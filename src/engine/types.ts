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
  dailyBars: Bar[];  // 含当前交易日的未完成bar；最多250项
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
export interface MarketSave { schemaVersion: 1; data: unknown }
