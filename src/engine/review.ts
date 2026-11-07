import type { State } from './internal';
import type { DailyReview, EquityPoint, InvestmentReview, NormalizedEquityPoint, ReviewPeriodSummary } from './types';

// Compact persistence: no public-snapshot clones, RNG calls, or order-book operations.
// [time, equity, cash, marketValue, index, realized, fees, buy fills, sell fills, buy amount, sell amount]
export type ReviewObservation = [number, number, number, number, number, number, number, number, number, number, number];
export interface ReviewDayState { dayIndex: number; date: string; partial: boolean; closed: boolean; compacted: boolean; points: ReviewObservation[] }
export interface ReviewState { coverageStartAt: number; days: ReviewDayState[] }
export const REVIEW_MAX_DAYS = 30;
export const REVIEW_MAX_POINTS_PER_DAY = 1024;
export const REVIEW_MAX_TOTAL_POINTS = 15000;
export const reviewTime = (s: State): number => Date.parse(`${s.date}T00:00:00+08:00`) + s.seconds * 1000;
export const reviewIndex = (s: State): number => s.stocks.reduce((n, q) => n + q.last / q.base, 0) / 12 * 1000;
const pct = (end: number, start: number): number | null => start > 0 ? (end / start - 1) * 100 : null;
function observation(s: State, counters: readonly number[]): ReviewObservation {
  const cash = s.wallets[0].cash;
  const marketValue = s.stocks.reduce((n, q) => n + (s.wallets[0].positions[q.symbol]?.quantity ?? 0) * q.last, 0);
  return [reviewTime(s), cash + marketValue, cash, marketValue, reviewIndex(s), s.realizedPnl, s.playerFees, counters[0], counters[1], counters[2], counters[3]];
}
export function initializeReview(s: State): void {
  const totals = [0, 0, 0, 0];
  for (const t of s.trades) totals[t.side === 'buy' ? 0 : 1]++;
  for (const id of s.playerOrderIds) { const o = s.orders[id]; totals[o.side === 'buy' ? 2 : 3] += o.notional; }
  const point = observation(s, totals);
  s.review = { coverageStartAt: point[0], days: [{ dayIndex: s.dayIndex, date: s.date, partial: s.seconds !== 34200, closed: s.seconds === 54000, compacted: false, points: [point] }] };
}
export function openReviewDay(s: State): void {
  const r = s.review;if (!r) return;
  const previous = r.days.at(-1)!.points.at(-1)!;
  r.days.push({ dayIndex: s.dayIndex, date: s.date, partial: false, closed: false, compacted: false, points: [observation(s, previous.slice(7))] });
  if (r.days.length > REVIEW_MAX_DAYS) r.days.shift();
}
function drawdown(points: readonly { equity: number }[]): number {
  let peak = 0, worst = 0;
  for (const p of points) { peak = Math.max(peak, p.equity); if (peak > 0) worst = Math.max(worst, (peak - p.equity) / peak * 100); }
  return worst;
}
/** Keep both ends, equity/index extremes and the observed drawdown's peak/trough.
 * Other observations are thinned deterministically only on exceptionally busy days.
 * These anchors preserve the exact observed drawdown, including future extensions.
 */
function compact(day: ReviewDayState, forced = false): void {
  if (!forced && day.points.length <= REVIEW_MAX_POINTS_PER_DAY) return;
  const p = day.points, keep = new Set([0, p.length - 1]);
  let peak = 0, worst = -1, peakAt = 0, troughAt = 0;
  let low = 0, high = 0, indexLow = 0, indexHigh = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i][1] > p[peak][1]) peak = i;
    const dd = p[peak][1] ? (p[peak][1] - p[i][1]) / p[peak][1] : 0;
    if (dd > worst) { worst = dd; peakAt = peak; troughAt = i; }
    if (p[i][1] < p[low][1]) low = i;if (p[i][1] > p[high][1]) high = i;
    if (p[i][4] < p[indexLow][4]) indexLow = i;if (p[i][4] > p[indexHigh][4]) indexHigh = i;
    if (i % 2 === 0) keep.add(i);
  }
  for (const i of [peakAt, troughAt, low, high, indexLow, indexHigh]) keep.add(i);
  day.points = p.filter((_, i) => keep.has(i));day.compacted = true;
}
export function recordReview(s: State, fill?: { side: 'buy' | 'sell'; amount: number }, close = false): void {
  const day = s.review?.days.at(-1);if (!day) return;
  const last = day.points.at(-1)!, counters = last.slice(7);
  if (fill) { counters[fill.side === 'buy' ? 0 : 1]++; counters[fill.side === 'buy' ? 2 : 3] += fill.amount; }
  const point = observation(s, counters);
  if (!point.every((v, i) => v === last[i])) day.points.push(point);
  if (close) day.closed = true;
  compact(day);
  const days = s.review!.days;
  let total = days.reduce((n, d) => n + d.points.length, 0);
  while (total > REVIEW_MAX_TOTAL_POINTS) {
    const largest = days.reduce((a, b) => a.points.length >= b.points.length ? a : b);
    const before = largest.points.length;compact(largest, true);total -= before - largest.points.length;
  }
}
function publicPoint(p: ReviewObservation, dayIndex: number): EquityPoint {
  return { time: p[0], dayIndex, equity: p[1], cash: p[2], marketValue: p[3], positionPct: p[1] ? p[3] / p[1] * 100 : 0, indexValue: p[4] };
}
function daily(day: ReviewDayState): DailyReview {
  const a = day.points[0], b = day.points.at(-1)!, netPnl = b[1] - a[1], realizedPnl = b[5] - a[5], fees = b[6] - a[6];
  const returnPct = pct(b[1], a[1]), benchmarkReturnPct = pct(b[4], a[4])!;
  return { dayIndex: day.dayIndex, date: day.date, status: day.closed ? 'closed' : 'in-progress', partial: day.partial, coverageStartAt: a[0], startAt: a[0], endAt: b[0], startEquity: a[1], endEquity: b[1],
    netPnl, returnPct, benchmarkReturnPct, excessReturnPct: returnPct === null ? null : returnPct - benchmarkReturnPct,
    buyFillCount: b[7] - a[7], sellFillCount: b[8] - a[8], buyAmount: b[9] - a[9], sellAmount: b[10] - a[10], fees, realizedPnl, unrealizedPnlChange: netPnl - realizedPnl, grossPnl: netPnl + fees,
    maxDrawdownPct: drawdown(day.points.map(p => ({ equity: p[1] }))) };
}
export function publicReview(s: State): InvestmentReview {
  const r = s.review!, summaries = r.days.map(daily);
  return { points: r.days.flatMap(d => d.points.map(p => publicPoint(p, d.dayIndex))), days: summaries.filter(d => d.status === 'closed'), currentDay: summaries.at(-1)!,
    coverageStartAt: r.coverageStartAt, retentionDays: 30, sampling: '30s-and-fills', compacted: r.days.some(d => d.compacted) };
}
export function normalizeEquityCurve(points: readonly EquityPoint[]): NormalizedEquityPoint[] {
  if (!points.length) return [];
  const baseline = points[0];
  return points.map(p => { const returnPct = pct(p.equity, baseline.equity), benchmarkReturnPct = pct(p.indexValue, baseline.indexValue)!;
    return { ...p, returnPct, benchmarkReturnPct, excessReturnPct: returnPct === null ? null : returnPct - benchmarkReturnPct }; });
}
export function selectReviewPeriod(review: InvestmentReview, period: 'all' | number | { dayIndex: number }): { points: NormalizedEquityPoint[]; summary: ReviewPeriodSummary } {
  const allDays = [...review.days.filter(d => d.dayIndex !== review.currentDay.dayIndex), review.currentDay];
  const selected = typeof period === 'object' ? allDays.filter(d => d.dayIndex === period.dayIndex) : typeof period === 'number' ? allDays.slice(-Math.max(1, Math.floor(period))) : allDays;
  if (!selected.length) throw new Error('所选交易日没有真实资产记录');
  const first = selected[0], last = selected.at(-1)!, ids = new Set(selected.map(d => d.dayIndex));
  const points = normalizeEquityCurve(review.points.filter(p => ids.has(p.dayIndex))), end = points.at(-1)!;
  const sum = (key: 'buyFillCount' | 'sellFillCount' | 'buyAmount' | 'sellAmount' | 'fees' | 'realizedPnl') => selected.reduce((n, d) => n + d[key], 0);
  const netPnl = end.equity - points[0].equity, realizedPnl = sum('realizedPnl'), fees = sum('fees');
  return { points, summary: { startDate: first.date, endDate: last.date, dayCount: selected.length, status: last.status, partial: selected.some(d => d.partial), coverageStartAt: first.coverageStartAt,
    startAt: points[0].time, endAt: end.time, startEquity: points[0].equity, endEquity: end.equity, netPnl, returnPct: end.returnPct, benchmarkReturnPct: end.benchmarkReturnPct, excessReturnPct: end.excessReturnPct,
    buyFillCount: sum('buyFillCount'), sellFillCount: sum('sellFillCount'), buyAmount: sum('buyAmount'), sellAmount: sum('sellAmount'), fees, realizedPnl, unrealizedPnlChange: netPnl - realizedPnl, grossPnl: netPnl + fees, maxDrawdownPct: drawdown(points) } };
}
