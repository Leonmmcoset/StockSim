import { describe, expect, it } from 'vitest';
import { createMarket, importMarket } from '../src/engine';
import type { State } from '../src/engine/internal';

const make=()=>createMarket({seed:'fundamentals-tests',historyDays:0});
describe('company fundamentals and earnings',()=>{
 it('provides twelve coherent public companies and four past simulated reports without hidden state',()=>{
  const snapshot=make().getSnapshot();
  expect(snapshot.companies).toHaveLength(12);
  for(const c of snapshot.companies){
   expect(c.reports).toHaveLength(4);
   expect(c.profile.business.length).toBeGreaterThan(5);
   for(const r of c.reports){
    expect(r.assets).toBe(r.liabilities+r.equity);
    expect(r.assets).toBe(r.cash+r.fixedAssets+r.workingCapital);
    expect(r.netProfit).toBe(r.revenue-r.operatingCosts-r.depreciation-r.interestExpense-r.taxExpense);
    expect(r.operatingCashFlow).toBe(r.netProfit+r.depreciation-r.workingCapitalChange);
    expect(r.publishedAt).toBeLessThanOrEqual(snapshot.clock.timestamp);
    expect(r.eps).toBe(r.netProfit/c.shares);
   }
   expect(c.nextReport.publishedAt).toBeGreaterThan(snapshot.clock.timestamp);
   expect(c.nextReport.dayIndex).toBeLessThanOrEqual(4);
   expect(c.valuation.marketCap).toBe(snapshot.quotes.find(q=>q.symbol===c.symbol)!.last*c.shares);
   expect(c).not.toHaveProperty('rng');expect(c).not.toHaveProperty('fundamental');expect(c.nextReport).not.toHaveProperty('actual');
  }
 });
});
it('publishes at 10:00 exactly once, keeps prior forecasts, and rolls the balance sheet forward',()=>{
 const m=make(),before=m.getSnapshot(),forecast=before.companies[0].nextReport,previous=before.companies[0].reports[0];
 m.step(49);expect(m.getSnapshot().clock.time).toBe('09:59:30');
 expect(m.getSnapshot().companies[0].reports[0].period).toBe(4);
 expect(m.getSnapshot().news.some(n=>n.kind==='earnings')).toBe(false);
 m.step();const s=m.getSnapshot(),c=s.companies[0],r=c.reports[0];
 expect(s.clock.time).toBe('10:00:00');expect(r.period).toBe(5);expect(r.publishedAt).toBe(s.clock.timestamp);
 expect(r.expectedRevenue).toBe(forecast.expectedRevenue);expect(r.expectedNetProfit).toBe(forecast.expectedNetProfit);
 expect(r.cash).toBe(previous.cash+r.operatingCashFlow-r.capex);
 expect(r.equity).toBe(previous.equity+r.netProfit);
 expect(c.nextReport.dayIndex).toBe(forecast.dayIndex+5);
 expect(s.news.filter(n=>n.reportId===r.id)).toHaveLength(1);
 m.step(2);expect(m.getSnapshot().news.filter(n=>n.reportId===r.id)).toHaveLength(1);
});
it('restores pending reports deterministically with tick batching',()=>{
 const a=make();a.step(49);const b=importMarket(a.exportState());
 a.step(31);for(let n=0;n<31;n++)b.step();
 expect(b.exportState()).toEqual(a.exportState());
 expect(b.getSnapshot()).toEqual(a.getSnapshot());
});
it('migrates v1 after validation without altering exchange balances, orders or its RNG',()=>{
 const m=make();const q=m.getSnapshot().quotes[0];
 m.placeOrder({symbol:q.symbol,side:'buy',price:q.asks[0].price,quantity:100});
 m.placeOrder({symbol:q.symbol,side:'buy',price:q.limitDown,quantity:100});
 const raw=structuredClone(m.exportState().data) as State;const {companies:discarded,...legacy}=raw;void discarded;
 const restored=importMarket({schemaVersion:1,data:legacy}),migrated=restored.exportState();
 expect(migrated.schemaVersion).toBe(2);
 const {companies,...rest}=migrated.data as State;expect(rest).toEqual(legacy);expect(companies).toHaveLength(12);
 expect(restored.getSnapshot().account).toEqual(m.getSnapshot().account);
 const corrupt=structuredClone(legacy);corrupt.wallets[0].cash++;
 expect(()=>importMarket({schemaVersion:1,data:corrupt})).toThrow();
});
it('rejects corrupt reports, duplicate periods and forward-dated disclosures in schema 2',()=>{
 const save=make().exportState();expect(save.schemaVersion).toBe(2);
 for(const corrupt of [
  (s:State)=>{s.companies[0].reports[0].netProfit++;},
  (s:State)=>{s.companies[0].reports[0].assets++;},
  (s:State)=>{s.companies[0].reports[0].publishedAt+=1e12;},
  (s:State)=>{s.companies[0].reports[0].period--;},
  (s:State)=>{s.companies[0].pending.expectedNetProfit++;},
 ]){const broken=structuredClone(save);corrupt(broken.data as State);expect(()=>importMarket(broken)).toThrow();}
});
it('uses null PE for losses and null QoQ growth for non-positive bases',()=>{
 const s=make().getSnapshot(),loss=s.companies.find(c=>c.valuation.ttmNetProfit<=0)!;
 expect(loss).toBeDefined();expect(loss.valuation.pe).toBeNull();
 expect(loss.reports.filter(r=>r.period>1).every(r=>r.profitGrowthPct===null)).toBe(true);
 for(const c of s.companies){
  expect(c.valuation.ttmNetProfit).toBe(c.reports.slice(0,4).reduce((n,r)=>n+r.netProfit,0));
  expect(c.valuation.pb).toBe(c.valuation.marketCap/c.reports[0].equity);
 }
});
it('can report rising profits that disappoint the previously public consensus',()=>{
 const m=createMarket({historyDays:0});m.step(50);const r=m.getSnapshot().companies[0].reports[0];
 expect(r.synthetic).toBe(false);expect(r.profitGrowthPct).toBeGreaterThan(0);expect(r.profitSurprisePct).toBeLessThan(0);
});
it('rejects rewritten historical consensus and contradictory announcement impact',()=>{
 const m=make();m.step(50);const save=m.exportState();
 const altered=structuredClone(save),state=altered.data as State,r=state.companies[0].reports[0];
 r.expectedNetProfit+=1000;r.profitSurprisePct=(r.netProfit-r.expectedNetProfit)/Math.max(Math.abs(r.expectedNetProfit),r.expectedRevenue*.01)*100;
 expect(()=>importMarket(altered)).toThrow();
 const changed=structuredClone(save);const news=(changed.data as State).news.find(n=>n.kind==='earnings')!;
 news.impact=news.impact==='positive'?'negative':'positive';expect(()=>importMarket(changed)).toThrow();
});
it('changes beliefs in the direction of surprise without changing the last trade or cash',async()=>{
 const {applyEarningsSignal,releaseDueEarnings}=await import('../src/engine/earnings');
 const m=make(),s=structuredClone(m.exportState().data) as State,q=s.stocks[0],r=s.companies[0].reports[0];
 const up=structuredClone(q),down=structuredClone(q);
 applyEarningsSignal(up,{...r,profitSurprisePct:20,revenueSurprisePct:0});
 applyEarningsSignal(down,{...r,profitSurprisePct:-20,revenueSurprisePct:0});
 expect(up.fundamental).toBeGreaterThan(q.fundamental);expect(down.fundamental).toBeLessThan(q.fundamental);
 expect(up.sentiment).toBeGreaterThan(q.sentiment);expect(down.sentiment).toBeLessThan(q.sentiment);
 expect(up.last).toBe(q.last);expect(down.last).toBe(q.last);
 const wallets=structuredClone(s.wallets),orders=structuredClone(s.orders),prices=s.stocks.map(q=>q.last),rng=s.rng;
 s.seconds=36000;releaseDueEarnings(s);
 expect(s.wallets).toEqual(wallets);expect(s.orders).toEqual(orders);expect(s.stocks.map(q=>q.last)).toEqual(prices);expect(s.rng).toBe(rng);
 expect(s.news.filter(n=>n.kind==='earnings')).toHaveLength(3);
});
it('publishes each company on its staggered five-trading-day schedule and restores across periods',()=>{
 const m=make();
 for(let day=0;day<6;day++){
  if(day)m.nextDay();m.step(day?60:50);
  const s=m.getSnapshot();
  for(const c of s.companies){
   expect(c.reports.every(r=>r.publishedAt<=s.clock.timestamp)).toBe(true);
   expect(c.nextReport.publishedAt).toBeGreaterThan(s.clock.timestamp);
  }
  expect(importMarket(m.exportState()).getSnapshot()).toEqual(s);
 }
 const s=m.getSnapshot();expect(s.companies[0].reports[0].period).toBe(6);
 expect(s.companies.every(c=>c.reports[0].period>=5)).toBe(true);
},15000);
it('migrates a late-day v1 save with future deadlines and no backdated new announcement',()=>{
 const m=make();m.step(1000);const raw=structuredClone(m.exportState().data) as State;
 const {companies:discarded,...legacy}=raw;void discarded;
 // A genuine old v1 has no earnings news, even when migrated after the new release hour.
 legacy.news=legacy.news.filter(n=>!n.kind);
 const restored=importMarket({schemaVersion:1,data:legacy}),s=restored.getSnapshot();
 expect(s.companies.every(c=>c.nextReport.publishedAt>s.clock.timestamp)).toBe(true);
 expect(s.news.some(n=>n.kind==='earnings')).toBe(false);
 expect((restored.exportState().data as State).rng).toBe(legacy.rng);
});
it('describes a loss-making report as net profit below consensus without calling it earnings',()=>{
 const m=make();for(let day=0;day<4;day++)m.nextDay();m.step(60);
 const s=m.getSnapshot(),r=s.companies.find(c=>c.symbol==='600502')!.reports[0];
 expect(r.period).toBe(5);expect(r.netProfit).toBeLessThan(0);expect(r.netProfit).toBeLessThan(r.expectedNetProfit);
 const announcement=s.news.find(n=>n.reportId===r.id)!;
 expect(announcement.impact).toBe('negative');
 expect(announcement.headline).toBe(`瑞宁生物 ${r.label}：净利润不及预期`);
},15000);
