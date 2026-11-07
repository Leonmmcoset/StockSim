# 引擎公开契约（实现前冻结稿）

本文件由市场算法负责人维护。实现入口为 `src/engine/index.ts`，类型在该入口统一导出。UI 不直接读写内部订单簿、代理账户或随机状态。

## 单位和推进

- `Money` / `Price`：整数人民币分；`quantity` / `volume`：股；`turnover`：分；百分比字段 `changePct` 的 `1` 表示 `1%`。
- `time`：Unix 毫秒；日期按中国标准时间显示。`date` 为 `YYYY-MM-DD`，`clock.time` 为 `HH:mm:ss`。
- 一个核心 tick 为 30 模拟秒；`step(n)` 必须等价于 n 次 `step(1)`。UI 1× 每现实秒调用 `step(1)`；加速只改变批量次数。
- 午休和收盘时 `step` 不推进，避免无人值守跨越下一天。午休可调用 `skipLunch()`；`nextDay()` 会先模拟当天剩余交易（现有委托可能成交），再清理当日委托、解锁 T+1 并进入下一工作日 09:30。
- 默认进入 `2026-11-09 09:35:00`；首日 09:30–09:35 已生成的成交不涉及玩家账户。只排除周六、周日，未应用法定节假日历。

## TypeScript 公共类型

```ts
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
  companies: CompanyFundamentals[]; // 已公开公司资料、报表、预期、估值；完整类型见src/engine/types.ts
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
export interface MarketSave { schemaVersion: 1 | 2; data: unknown }
export function createMarket(options?: MarketOptions): MarketEngine;
export function importMarket(state: unknown): MarketEngine;
export const DEFAULT_SEED: string;
```

`importMarket` 校验失败抛出带中文说明的 `Error`，不会修改原引擎；UI 仅在成功返回后替换实例。`previewOrder` 不改变状态、无 RNG 消耗；输入暂时非法（表单编辑中）时按安全的零值预览，最终是否合法由 `placeOrder` 判定。卖单预览 `cashRequired=0`。

`getSnapshot()` 返回隔离的可序列化展示数据；UI 视为只读。`equity=cash+marketValue`，`cash=availableCash+frozenCash`，`totalPnl=equity-initialCash`。持仓成本按成交数量比例分摊，最后一次清仓带走剩余尾差。盈亏展示不能用四舍五入后的 `averageCost` 反推。

错误消息直接用于 toast。集合竞价仍接受限价单但延迟撮合、拒绝撤单；午休和收盘拒绝新的委托。初版没有对外市价单，NPC 的主动单同样是可成交限价单。股票代码和名称由 `snapshot.quotes` 获取，不在 UI 重复硬编码。

## UI 调用示例

```ts
const market = createMarket({ seed: 'stock-sim-2026' });
const result = market.placeOrder({ symbol: '600101', side: 'buy', price: 850, quantity: 100 });
if (!result.ok) showToast(result.error);
const snapshot = market.getSnapshot();
localStorage.setItem('stock-sim-v1', JSON.stringify(market.exportState()));
// 导入时先创建candidate，成功后替换当前实例。
const candidate = importMarket(JSON.parse(importedText));
```

UI 每现实秒更新1–4次快照即可；Canvas动画不必重算市场。自动存档建议每5–10秒及下单/撤单/换日后执行，避免每个30秒tick序列化完整状态。
