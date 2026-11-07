import { z } from 'zod';
import type { State } from './internal';
import { REVIEW_MAX_DAYS, REVIEW_MAX_POINTS_PER_DAY, REVIEW_MAX_TOTAL_POINTS, reviewIndex, reviewTime } from './review';
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signed = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const point = z.tuple([integer, integer, integer, integer, z.number().positive().finite(), signed, integer, integer, integer, integer, integer]);
export const reviewSchema = z.object({
  coverageStartAt: integer,
  days: z.array(z.object({dayIndex: integer, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), partial: z.boolean(), closed: z.boolean(), compacted: z.boolean(), points: z.array(point).min(1).max(REVIEW_MAX_POINTS_PER_DAY)}).strict()).min(1).max(REVIEW_MAX_DAYS),
}).strict();
export function validateReview(s: State): void {
  const r = s.review!, now = reviewTime(s), fail = (): never => { throw new Error('投资复盘记录、金额或时间校验失败'); };
  const current = r.days.at(-1)!;
  if (r.days.reduce((n, d) => n + d.points.length, 0) > REVIEW_MAX_TOTAL_POINTS) fail();
  if (current.dayIndex !== s.dayIndex || current.date !== s.date || current.closed !== (s.seconds === 54000) || current.points.at(-1)![0] !== now || r.coverageStartAt > r.days[0].points[0][0]) fail();
  let previous: typeof current | undefined;
  for (const day of r.days) {
    const start = Date.parse(`${day.date}T00:00:00+08:00`), first = day.points[0], last = day.points.at(-1)!;
    if (!Number.isFinite(start) || new Date(start + 8 * 3600000).toISOString().slice(0, 10) !== day.date || [0, 6].includes(new Date(start + 8 * 3600000).getUTCDay()) || day.dayIndex > s.dayIndex || first[0] < r.coverageStartAt || day.partial !== (first[0] !== start + 34200000)) fail();
    if (day.closed && last[0] !== start + 54000000) fail();
    if (day !== current && !day.closed) fail();
    if (previous) {
      let next = Date.parse(`${previous.date}T12:00:00Z`);
      do { next += 86400000; } while ([0, 6].includes(new Date(next).getUTCDay()));
      if (day.date !== new Date(next).toISOString().slice(0, 10) || day.dayIndex !== previous.dayIndex + 1 || day.partial) fail();
      const before = previous.points.at(-1)!;
      if (first.slice(1).some((v, i) => v !== before[i + 1])) fail();
    }
    for (let i = 0; i < day.points.length; i++) {
      const p = day.points[i], seconds = (p[0] - start) / 1000;
      if (p[0] > now || seconds % 30 || !((seconds >= 34200 && seconds <= 41400) || (seconds >= 46800 && seconds <= 54000)) || p[1] !== p[2] + p[3] || p[7] + p[8] > s.seq) fail();
      const basis = s.initialCash + p[5] - p[2];
      if (!Number.isSafeInteger(basis) || basis < 0 || (basis === 0) !== (p[3] === 0) || p[2] !== s.initialCash + p[10] - p[9] - p[6]) fail();
      if (i > 0) {
        const a = day.points[i - 1];
        if (p[0] < a[0] || p.every((v, j) => v === a[j]) || [6, 7, 8, 9, 10].some(j => p[j] < a[j])) fail();
        if (p[2] - a[2] !== p[10] - a[10] - (p[9] - a[9]) - (p[6] - a[6])) fail();
        if ((p[7] === a[7]) !== (p[9] === a[9]) || (p[8] === a[8]) !== (p[10] === a[10])) fail();
        if (p[8] === a[8] && p[5] !== a[5]) fail();
        if (p[7] === a[7] && p[8] === a[8] && p[6] !== a[6]) fail();
      }
    }
    previous = day;
  }
  const last = current.points.at(-1)!, w = s.wallets[0];
  const marketValue = s.stocks.reduce((n, q) => n + (w.positions[q.symbol]?.quantity ?? 0) * q.last, 0);
  const amounts = [0, 0], counts = [0, 0];
  for (const id of s.playerOrderIds) { const o = s.orders[id]; amounts[o.side === 'buy' ? 0 : 1] += o.notional; }
  for (const t of s.trades) counts[t.side === 'buy' ? 0 : 1]++;
  if (last[1] !== w.cash + marketValue || last[2] !== w.cash || last[3] !== marketValue || last[4] !== reviewIndex(s) || last[5] !== s.realizedPnl || last[6] !== s.playerFees || last[9] !== amounts[0] || last[10] !== amounts[1]) fail();
  if (s.trades.length < 5000 ? last[7] !== counts[0] || last[8] !== counts[1] : last[7] < counts[0] || last[8] < counts[1]) fail();
}
