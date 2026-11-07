import { z } from 'zod';
import type { State } from './internal';
import { businessDate, growthPct, periodLabel, reportTime, surprisePct, expectedReport } from './fundamentals';
const signed=z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const amount=signed.nonnegative(),positive=amount.min(1),finite=z.number().finite();
const report=z.object({
 id:z.string().max(80),period:positive,label:z.string().max(80),publishedAt:amount,synthetic:z.boolean(),
 revenue:positive,operatingCosts:amount,depreciation:amount,interestExpense:amount,taxExpense:amount,
 netProfit:signed,operatingCashFlow:signed,capex:amount,workingCapitalChange:signed,
 cash:amount,fixedAssets:amount,workingCapital:amount,assets:positive,liabilities:amount,equity:signed,
 eps:finite,bps:finite,revenueGrowthPct:finite.nullable(),profitGrowthPct:finite.nullable(),
 expectedRevenue:positive,expectedNetProfit:signed,revenueSurprisePct:finite,profitSurprisePct:finite,
});
const pending=z.object({period:positive,label:z.string().max(80),dayIndex:amount,date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),publishedAt:amount,expectedRevenue:positive,expectedNetProfit:signed});
export const companiesSchema=z.array(z.object({symbol:z.string().max(20),shares:positive,rng:amount.max(4294967295),trend:finite.min(-.08).max(.10),costRatio:finite.min(.45).max(1.12),reports:z.array(report).min(4).max(24),pending})).length(12);
/** Validation supplements the original v1 exchange ledger validation; never replaces it. */
export function validateCompanies(s:State):void {
 const fail=()=>{throw new Error('存档公司财报、预期或发布日期校验失败');};
 const now=Date.parse(`${s.date}T00:00:00+08:00`)+s.seconds*1000,seen=new Set<string>();
 for(const c of s.companies){
  if(seen.has(c.symbol)||!s.stocks.some(q=>q.symbol===c.symbol)||c.shares!==s.totalShares[c.symbol])fail();seen.add(c.symbol);
  const next=c.pending,latest=c.reports[0],days=next.dayIndex-s.dayIndex;
  if(days<0||days>5||businessDate(s.date,days)!==next.date||next.publishedAt!==reportTime(next.date)||next.publishedAt<=now||next.period!==latest.period+1||next.label!==periodLabel(next.period))fail();
  const lastDate=new Date(latest.publishedAt+8*3600000).toISOString().slice(0,10);
  if(next.date!==businessDate(lastDate,5))fail();
  const expected=expectedReport(c,next.dayIndex,next.date);
  if(next.expectedRevenue!==expected.expectedRevenue||next.expectedNetProfit!==expected.expectedNetProfit)fail();
  for(let i=0;i<c.reports.length;i++){
   const r=c.reports[i],prev=c.reports[i+1];
   if(r.id!==`${c.symbol}-R${r.period}`||r.label!==periodLabel(r.period)||r.publishedAt>now||r.synthetic!==(r.period<=4))fail();
   const date=new Date(r.publishedAt+8*3600000).toISOString().slice(0,10);
   if(reportTime(date)!==r.publishedAt||[0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))fail();
   if(r.assets!==r.liabilities+r.equity||r.assets!==r.cash+r.fixedAssets+r.workingCapital||r.netProfit!==r.revenue-r.operatingCosts-r.depreciation-r.interestExpense-r.taxExpense||r.operatingCashFlow!==r.netProfit+r.depreciation-r.workingCapitalChange)fail();
   if(r.eps!==r.netProfit/c.shares||r.bps!==r.equity/c.shares||r.taxExpense!==Math.max(0,Math.round((r.revenue-r.operatingCosts-r.depreciation-r.interestExpense)*.25)))fail();
   if(r.revenueSurprisePct!==surprisePct(r.revenue,r.expectedRevenue,r.expectedRevenue)||r.profitSurprisePct!==surprisePct(r.netProfit,r.expectedNetProfit,r.expectedRevenue))fail();
   if(r.period===1&&(r.revenueGrowthPct!==null||r.profitGrowthPct!==null))fail();
   if(prev){
    if(c.reports[i+2]||prev.period===1){
     const forecast=expectedReport({...c,reports:c.reports.slice(i+1)},0,date);
     if(r.expectedRevenue!==forecast.expectedRevenue||r.expectedNetProfit!==forecast.expectedNetProfit)fail();
    }
    const priorDate=new Date(prev.publishedAt+8*3600000).toISOString().slice(0,10);
    if(r.period!==prev.period+1||date!==businessDate(priorDate,5)||r.cash!==prev.cash+r.operatingCashFlow-r.capex||r.fixedAssets!==prev.fixedAssets+r.capex-r.depreciation||r.workingCapital!==prev.workingCapital+r.workingCapitalChange||r.equity!==prev.equity+r.netProfit||r.liabilities!==prev.liabilities)fail();
    if(r.revenueGrowthPct!==growthPct(r.revenue,prev.revenue)||r.profitGrowthPct!==growthPct(r.netProfit,prev.netProfit))fail();
   }
  }
 }
 for(const item of s.news)if(item.kind==='earnings'){
  const c=s.companies.find(c=>item.symbols.length===1&&c.symbol===item.symbols[0]);
  const r=c?.reports.find(r=>r.id===item.reportId);
  if(!r||item.scope!=='company'||item.time!==r.publishedAt||item.time>now||r.synthetic)fail();
  if(r&&item.impact!==(r.profitSurprisePct>.5?'positive':r.profitSurprisePct<-.5?'negative':'neutral'))fail();
 }
 const reportNews=s.news.filter(n=>n.kind==='earnings').map(n=>n.reportId);
 if(new Set(reportNews).size!==reportNews.length)fail();
}
