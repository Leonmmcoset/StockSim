import { describe, expect, it } from 'vitest';
import { createMarket, importMarket } from '../src/engine';
import type { State } from '../src/engine/internal';

const make = () => createMarket({seed:'review-tests',historyDays:0});
describe('investment review accounting', () => {
 it('starts at the real entry account without inventing warmup history', () => {
  const m=make(),s=m.getSnapshot();
  expect(s.review).toBeDefined();
  expect(s.review.points).toHaveLength(1);
  expect(s.review.points[0]).toMatchObject({time:s.clock.timestamp,equity:500000,cash:500000,marketValue:0,indexValue:s.index.value,positionPct:0});
  expect(s.review.currentDay).toMatchObject({partial:true,status:'in-progress',netPnl:0,returnPct:0,benchmarkReturnPct:0,fees:0});
  m.step(4);const after=m.getSnapshot();
  expect(after.review.points).toHaveLength(5);
  expect(after.review.currentDay.netPnl).toBe(0);
  expect(after.review.currentDay.benchmarkReturnPct).toBe((after.index.value/s.index.value-1)*100);
 });
 it('records paid fees once and counts execution fills instead of submitted orders', () => {
  const m=make(),before=m.getSnapshot(),q=before.quotes[0];
  const order=m.placeOrder({symbol:q.symbol,side:'buy',price:q.asks[0].price,quantity:100});
  expect(order.ok).toBe(true);expect(order.order!.filled).toBe(100);
  const s=m.getSnapshot(),r=s.review.currentDay;
  expect(r.buyFillCount).toBe(s.trades.length);expect(r.buyAmount).toBe(s.trades.reduce((n,t)=>n+t.amount,0));
  expect(r.fees).toBe(s.account.feesPaid);expect(r.netPnl).toBe(s.account.equity-before.account.equity);
  expect(r.realizedPnl+r.unrealizedPnlChange).toBe(r.netPnl);expect(r.grossPnl).toBe(r.netPnl+r.fees);
  expect(r.maxDrawdownPct).toBeGreaterThan(0);
  const saved=m.exportState();m.getSnapshot();m.getSnapshot();expect(m.exportState()).toEqual(saved);
 });
 it('keeps reservations and cancellations out of equity and fees', () => {
  const m=make(),q=m.getSnapshot().quotes[0],before=m.getSnapshot().review;
  const order=m.placeOrder({symbol:q.symbol,side:'buy',price:q.limitDown,quantity:100});
  expect(order.ok).toBe(true);expect(order.order!.filled).toBe(0);
  expect(m.getSnapshot().account.frozenCash).toBeGreaterThan(0);
  expect(m.getSnapshot().review).toEqual(before);
  m.cancelOrder(order.order!.id);expect(m.getSnapshot().review).toEqual(before);
 });
 it('has read-only lunch snapshots and closes each day once', () => {
  const m=make();m.step(1000);const lunch=m.exportState();m.step(10);m.getSnapshot();expect(m.exportState()).toEqual(lunch);
  m.skipLunch();m.step(1000);const closed=m.getSnapshot();
  expect(closed.review.currentDay.status).toBe('closed');expect(closed.review.days).toHaveLength(1);
  const save=m.exportState();m.step(100);m.getSnapshot();expect(m.exportState()).toEqual(save);
  m.nextDay();const next=m.getSnapshot();expect(next.review.days).toHaveLength(1);
  expect(next.review.currentDay).toMatchObject({dayIndex:1,status:'in-progress',partial:false,netPnl:0,fees:0});
 });
 it('preserves exact review results under batching and save restore', () => {
  const a=make(),b=importMarket(a.exportState());a.step(50);for(let i=0;i<50;i++)b.step();
  expect(a.exportState()).toEqual(b.exportState());expect(a.getSnapshot().review).toEqual(b.getSnapshot().review);
 });
 it('starts legacy history only at import without altering market or ledger RNG', () => {
  const m=make();m.step(4);const raw=structuredClone(m.exportState().data) as State;
  const {review:ignored,...legacy}=raw;void ignored;
  const restored=importMarket({schemaVersion:2,data:legacy}),s=restored.getSnapshot();
  expect(s.review.points).toHaveLength(1);expect(s.review.coverageStartAt).toBe(s.clock.timestamp);
  expect(s.review.currentDay.partial).toBe(true);
  const {review:added,...rest}=restored.exportState().data as State;void added;
  expect(rest).toEqual(legacy);expect(restored.exportState().schemaVersion).toBe(3);
 });
});

// These checks catch wrong baselines, duplicated fee/cash movements, fabricated
// summary caches, and review code that accidentally changes market randomness.
import { normalizeEquityCurve, selectReviewPeriod } from '../src/engine';
import { Market } from '../src/engine/market';
import { fees } from '../src/engine/ledger';
import type { InternalOrder } from '../src/engine/internal';
import type { EquityPoint } from '../src/engine';
function splitFillFixture() {
 const saved=make().exportState(),s=saved.data as State,q=s.stocks[0];
 for(const id of [...q.bids,...q.asks]) {
  const o=s.orders[id],w=s.wallets[o.owner];if(o.side==='buy')w.frozenCash-=o.reserve;else w.positions[q.symbol].frozen-=o.remaining;delete s.orders[id];
 }
 q.bids=[];q.asks=[];
 for(let i=0;i<2;i++) {
  const seq=++s.seq,id=`O${seq}`,owner=q.agents[8+i],price=q.last+1;
  const o:InternalOrder={id,seq,owner,symbol:q.symbol,side:'sell',price,quantity:100,filled:0,remaining:100,status:'open',createdAt:s.review!.coverageStartAt,avgFillPrice:0,fee:0,notional:0,reserve:0,expires:s.tick+100};
  s.orders[id]=o;q.asks.push(id);s.wallets[owner].positions[q.symbol].frozen+=100;
 }
 return {m:importMarket(saved),symbol:q.symbol,price:q.last+1};
}
it('normalizes every selected interval to the simultaneous real account and index observation',()=>{
 const points:EquityPoint[]=[{time:1,dayIndex:0,equity:10000,cash:5000,marketValue:5000,positionPct:50,indexValue:2000},{time:2,dayIndex:0,equity:11000,cash:5000,marketValue:6000,positionPct:6000/11000*100,indexValue:2100}];
 const curve=normalizeEquityCurve(points);
 expect(curve[0]).toMatchObject({returnPct:0,benchmarkReturnPct:0,excessReturnPct:0});
 expect(curve[1].returnPct).toBeCloseTo(10);expect(curve[1].benchmarkReturnPct).toBeCloseTo(5);expect(curve[1].excessReturnPct).toBeCloseTo(5);
 expect(normalizeEquityCurve(points.slice(1))[0].returnPct).toBe(0);
 expect(normalizeEquityCurve([])).toEqual([]);
 const zero=createMarket({startingCash:0,historyDays:0}).getSnapshot();
 expect(zero.review.currentDay.returnPct).toBeNull();expect(zero.review.currentDay.excessReturnPct).toBeNull();
 expect(normalizeEquityCurve(zero.review.points)[0].returnPct).toBeNull();
});
it('charges only incremental partial-fill fees and preserves the full cash and unrealized reconciliation',()=>{
 const {m,symbol,price}=splitFillFixture();const result=m.placeOrder({symbol,side:'buy',price,quantity:300});
 expect(result.order?.filled).toBe(200);expect(m.getSnapshot().trades).toHaveLength(2);
 const s=m.getSnapshot(),r=s.review.currentDay;
 expect(r.buyFillCount).toBe(2);expect(r.buyAmount).toBe(price*200);expect(r.fees).toBe(fees(price*200,'buy').total);
 expect(r.netPnl).toBe(-r.fees);expect(r.grossPnl).toBe(0);expect(r.realizedPnl).toBe(0);expect(r.unrealizedPnlChange).toBe(-r.fees);
 expect(r.maxDrawdownPct).toBeCloseTo(r.fees/500000*100);
 m.cancelOrder(result.order!.id);expect(m.getSnapshot().review.currentDay).toEqual(r);
 expect(importMarket(m.exportState()).getSnapshot()).toEqual(m.getSnapshot());
});
it('reconciles multi-day realized profit and changes in unrealized profit, including sale fees',()=>{
 const {m,symbol,price}=splitFillFixture();m.placeOrder({symbol,side:'buy',price,quantity:200});m.nextDay();
 const start=m.getSnapshot(),q=start.quotes.find(q=>q.symbol===symbol)!;
 expect(m.placeOrder({symbol,side:'sell',price:q.bids[0].price,quantity:100}).ok).toBe(true);
 m.step(20);const s=m.getSnapshot(),d=s.review.currentDay;
 expect(d.realizedPnl).toBe(s.account.realizedPnl-start.account.realizedPnl);
 expect(d.unrealizedPnlChange).toBe(s.account.positions.reduce((n,p)=>n+p.pnl,0)-start.account.positions.reduce((n,p)=>n+p.pnl,0));
 expect(d.netPnl).toBe(d.realizedPnl+d.unrealizedPnlChange);
 expect(d.fees).toBe(s.account.feesPaid-start.account.feesPaid);
 const all=selectReviewPeriod(s.review,'all'),today=selectReviewPeriod(s.review,{dayIndex:1});
 expect(all.summary.netPnl).toBe(s.account.equity-500000);expect(all.summary.fees).toBe(s.account.feesPaid);
 expect(all.summary.realizedPnl+all.summary.unrealizedPnlChange).toBe(all.summary.netPnl);
 expect(all.summary.dayCount).toBe(2);expect(today.summary.netPnl).toBe(d.netPnl);
 expect(today.points[0].returnPct).toBe(0);expect(selectReviewPeriod(s.review,1)).toEqual(today);
 expect(importMarket(m.exportState()).getSnapshot()).toEqual(s);
});
it('rejects invalid observations and fabricated summaries rather than trusting a cache',()=>{
 const m=make();m.step(3);
 const corruptions:((s:State)=>void)[]=[
  s=>{s.review!.days[0].points[1][1]++;},
  s=>{const p=s.review!.days[0].points[0];p[1]++;p[3]++;},
  s=>{s.review!.days[0].points[0][5]=-500001;},
  s=>{s.review!.days[0].points[1][0]+=1e12;},
  s=>{s.review!.days[0].points[1][4]=NaN;},
  s=>{s.review!.days[0].points.reverse();},
  s=>{s.review!.days[0].points[0][6]++;},
  s=>{s.review!.days[0].points.at(-1)![4]++;},
  s=>{s.review!.days[0].closed=true;},
  s=>{Object.assign(s.review!,{summary:{netPnl:12345}});},
  s=>{Object.assign(s.review!.days[0],{netPnl:12345});},
 ];
 const before=m.exportState();
 for(const corrupt of corruptions){const saved=structuredClone(before);corrupt(saved.data as State);expect(()=>importMarket(saved)).toThrow();}
 expect(m.exportState()).toEqual(before);
});
it('preserves the market and company RNG, ledger, matching and prices with recording enabled',()=>{
 const enabled=make(),raw=structuredClone(enabled.exportState().data) as State;delete raw.review;
 const control=new Market({},raw);
 const commands=[()=>{enabled.step(4);control.step(4);},()=>{const q=enabled.getSnapshot().quotes[0];const order={symbol:q.symbol,side:'buy' as const,price:q.asks[0].price,quantity:100};expect(enabled.placeOrder(order)).toEqual(control.placeOrder(order));},()=>{enabled.nextDay();control.nextDay();},()=>{enabled.step(60);control.step(60);}];
 for(const command of commands){command();const {review,...state}=enabled.exportState().data as State;void review;expect(state).toEqual(control.exportState().data);}
});
it('imports schema 1 and already-closed schema 2 without inventing past days or settling twice',()=>{
 const m=make();m.step(1000);m.skipLunch();m.step(1000);const raw=m.exportState().data as State;
 const {review,companies,...legacy}=raw;void review;void companies;
 const v1={...legacy,news:legacy.news.filter(n=>n.kind!=='earnings')};
 const a=importMarket({schemaVersion:1,data:v1});
 expect(a.getSnapshot().review.points).toHaveLength(1);expect(a.getSnapshot().review.currentDay.netPnl).toBe(0);expect(a.getSnapshot().review.days).toHaveLength(1);
 const {review:added,companies:generated,...rest}=a.exportState().data as State;void added;void generated;expect(rest).toEqual(v1);
 const b=importMarket({schemaVersion:2,data:{...legacy,companies:raw.companies}});const save=b.exportState();b.step();expect(b.exportState()).toEqual(save);
 b.nextDay();expect(b.getSnapshot().review.days).toHaveLength(1);expect(b.getSnapshot().review.currentDay.dayIndex).toBe(1);
});
it('bounds retained real history through more than thirty trading days and fits ordinary local storage',()=>{
 const m=make();for(let i=0;i<31;i++)m.nextDay();
 const s=m.getSnapshot(),save=m.exportState(),days=(save.data as State).review!.days;
 expect(days).toHaveLength(30);expect(days[0].dayIndex).toBe(2);expect(days.every(d=>d.points.length<=1024)).toBe(true);
 expect(s.review.points.every(p=>p.time<=s.clock.timestamp)).toBe(true);
 expect(JSON.stringify(save).length).toBeLessThan(4_000_000);
 expect(importMarket(save).getSnapshot().review).toEqual(s.review);
},20000);

import { initializeReview, publicReview, recordReview } from '../src/engine/review';
it('bounds busy observation histories and preserves chronological drawdown anchors when compacting',()=>{
 // Controlled valuation observations exercise the production recorder directly;
 // the fixture is not loaded as an exchange save or used as simulated price evidence.
 const s=make().exportState().data as State,q=s.stocks[0];
 s.wallets[0].cash=0;s.wallets[0].positions={[q.symbol]:{quantity:100,todayBought:0,frozen:0,costBasis:200000}};
 q.last=2000;initializeReview(s);
 for(let i=1;i<2500;i++){q.last=i===3?2200:i===997?1800:2000+i%2;recordReview(s);}
 const review=publicReview(s);
 expect(review.compacted).toBe(true);expect(review.points.length).toBeLessThanOrEqual(1024);
 expect(review.currentDay.maxDrawdownPct).toBeCloseTo(400/2200*100);
 expect(review.points.some(p=>p.equity===220000)).toBe(true);expect(review.points.some(p=>p.equity===180000)).toBe(true);
 // A later, higher peak must not forget the earlier trough or change its order.
 q.last=2300;recordReview(s);q.last=1900;recordReview(s);
 expect(publicReview(s).currentDay.maxDrawdownPct).toBeCloseTo(400/2200*100);
 // Thirty busy days must remain bounded as a whole, not only per day.
 const day=structuredClone(s.review!.days[0]);
 s.review!.days=Array.from({length:30},(_,i)=>({...structuredClone(day),dayIndex:i}));
 recordReview(s);
 expect(s.review!.days.reduce((n,d)=>n+d.points.length,0)).toBeLessThanOrEqual(15000);
});
