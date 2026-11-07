import type { CompanyFundamentals, FinancialReport, ReportSchedule } from './types';
import type { State } from './internal';
import { UNIVERSE } from './data';
import { hashSeed, normal } from './random';

export interface CompanyState {
  symbol:string; shares:number; rng:number; trend:number; costRatio:number;
  reports:FinancialReport[]; pending:ReportSchedule;
}
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
export const REPORT_SECONDS=10*3600;
export function businessDate(date:string,days:number):string {
  let ms=Date.parse(`${date}T12:00:00Z`);
  for(let i=0;i<Math.abs(days);i++)do{ms+=Math.sign(days)*86400000;}while([0,6].includes(new Date(ms).getUTCDay()));
  return new Date(ms).toISOString().slice(0,10);
}
export const reportTime=(date:string)=>Date.parse(`${date}T10:00:00+08:00`);
export const periodLabel=(period:number)=>`第${period}期（模拟季报）`;
export const growthPct=(actual:number,base:number):number|null=>base>0?(actual/base-1)*100:null;
export const surprisePct=(actual:number,expected:number,revenue:number):number=>(actual-expected)/Math.max(Math.abs(expected),revenue*.01)*100;
const businesses=[
  '面向区域企业与居民提供存贷、结算和财富管理服务。',
  '提供证券经纪、资产管理与企业融资顾问服务。',
  '生产和销售包装食品、调味品与区域特色消费品。',
  '经营连锁零售、供应链采购及线上线下商贸服务。',
  '从事传统能源供应、储运及工业客户能源服务。',
  '经营发电设施与区域电力供应，推进低碳电源投资。',
  '研发企业软件、云平台及工业数字化解决方案。',
  '设计与制造电子元件、智能终端配套器件。',
  '研发生产常用药品，提供医药流通和健康产品服务。',
  '从事创新生物制品研发，处于投入较高的商业化阶段。',
  '生产工业装备，提供制造产线与设备维护服务。',
  '制造精密零件、自动化部件及工业配套产品。',
];
const margins=[.16,.13,.10,.055,.12,.09,.15,.08,.13,-.025,.08,.07];
/** Forecast uses only the last disclosed period. It never draws a future shock. */
export function expectedReport(c:CompanyState,dayIndex:number,date:string):ReportSchedule {
  const last=c.reports[0],previous=c.reports[1];
  const revenueTrend=previous?clamp(last.revenue/previous.revenue-1,-.04,.08):.02;
  const profitTrend=previous&&previous.netProfit>0?clamp(last.netProfit/previous.netProfit-1,-.10,.14):0;
  // The bank carries an optimistic public analyst consensus: rising profit can still disappoint.
  const optimism=c.symbol==='600101'?.12:.015;
  return {period:last.period+1,label:periodLabel(last.period+1),dayIndex,date,publishedAt:reportTime(date),
    expectedRevenue:Math.max(1,Math.round(last.revenue*(1+.5*revenueTrend+.015))),
    expectedNetProfit:Math.round(last.netProfit+Math.abs(last.netProfit)*(.5*profitTrend+optimism))};
}
/** A deliberately simplified operating company. No financing/dividends; all earnings retained.
 * Even bank/broker names use this common educational balance-sheet model, not industry GAAP.
 */
function operate(c:CompanyState,plan:ReportSchedule,synthetic:boolean,opening?:FinancialReport):FinancialReport {
  const prev=opening??c.reports[0];
  c.trend=clamp(.72*c.trend+.28*.018+normal(c)*.018,-.08,.10);
  const revenue=Math.max(c.shares,Math.round(prev.revenue*(1+clamp(c.trend+normal(c)*.022,-.16,.16))));
  const depreciation=Math.round(prev.fixedAssets*.015);
  const interestExpense=Math.round(prev.liabilities*.003);
  let operatingCosts=Math.max(0,Math.round(revenue*clamp(c.costRatio+normal(c)*.012,.45,1.12)));
  // Cash stress causes spending restraint; it never injects exchange-wallet cash or new financing.
  operatingCosts=Math.min(operatingCosts,Math.max(0,revenue-depreciation-interestExpense+Math.floor(prev.cash*.10)));
  const pretax=revenue-operatingCosts-depreciation-interestExpense;
  const taxExpense=Math.max(0,Math.round(pretax*.25));
  const netProfit=pretax-taxExpense;
  const targetWorkingCapital=Math.round(revenue*.16);
  const workingCapitalChange=clamp(targetWorkingCapital-prev.workingCapital,-prev.workingCapital,Math.max(0,Math.floor((prev.cash+netProfit+depreciation)*.15)));
  const operatingCashFlow=netProfit+depreciation-workingCapitalChange;
  const capex=Math.max(0,Math.min(Math.round(depreciation*1.2),Math.floor((prev.cash+operatingCashFlow)*.25)));
  const cash=prev.cash+operatingCashFlow-capex;
  const fixedAssets=prev.fixedAssets+capex-depreciation,workingCapital=prev.workingCapital+workingCapitalChange;
  const assets=cash+fixedAssets+workingCapital,liabilities=prev.liabilities,equity=assets-liabilities;
  return {id:`${c.symbol}-R${plan.period}`,period:plan.period,label:plan.label,publishedAt:plan.publishedAt,synthetic,
    revenue,operatingCosts,depreciation,interestExpense,taxExpense,netProfit,operatingCashFlow,capex,workingCapitalChange,
    cash,fixedAssets,workingCapital,assets,liabilities,equity,eps:netProfit/c.shares,bps:equity/c.shares,
    revenueGrowthPct:opening?null:growthPct(revenue,prev.revenue),profitGrowthPct:opening?null:growthPct(netProfit,prev.netProfit),
    expectedRevenue:plan.expectedRevenue,expectedNetProfit:plan.expectedNetProfit,
    revenueSurprisePct:surprisePct(revenue,plan.expectedRevenue,plan.expectedRevenue),profitSurprisePct:surprisePct(netProfit,plan.expectedNetProfit,plan.expectedRevenue)};
}
export function initializeCompanies(s:Pick<State,'seed'|'stocks'|'totalShares'|'date'|'dayIndex'|'seconds'>):CompanyState[] {
  return s.stocks.map((q,index)=>{
    const shares=s.totalShares[q.symbol],assets=q.last*shares,liabilities=Math.round(assets*.3);
    const revenue=Math.round(assets*.24),fixedAssets=Math.round(assets*.35),workingCapital=Math.round(revenue*.16);
    const c:CompanyState={symbol:q.symbol,shares,rng:hashSeed(`${s.seed}:company:${q.symbol}`),trend:.025,
      costRatio:1-margins[index]/(margins[index]>0?.75:1)-fixedAssets*.015/revenue-liabilities*.003/revenue,reports:[],pending:{} as ReportSchedule};
    const opening={revenue,cash:assets-fixedAssets-workingCapital,fixedAssets,workingCapital,liabilities,netProfit:Math.round(revenue*margins[index])} as FinancialReport;
    // First slot today 10:00 if still ahead, otherwise on the next business day.
    const offset=index%5+(s.seconds>=REPORT_SECONDS?1:0);
    for(let period=1;period<=4;period++){
      const date=businessDate(s.date,offset-(5-period)*5);
      const plan:ReportSchedule=period===1?{period,label:periodLabel(period),date,dayIndex:s.dayIndex+offset-20,publishedAt:reportTime(date),expectedRevenue:revenue,expectedNetProfit:opening.netProfit}:expectedReport(c,s.dayIndex+offset-(5-period)*5,date);
      c.reports.unshift(operate(c,plan,true,period===1?opening:undefined));
    }
    c.pending=expectedReport(c,s.dayIndex+offset,businessDate(s.date,offset));
    return c;
  });
}
/** Called only after the market clock reaches the disclosed timestamp. */
export function releaseReport(c:CompanyState):FinancialReport {
  const report=operate(c,c.pending,false);
  c.reports.unshift(report);if(c.reports.length>24)c.reports.length=24;
  c.pending=expectedReport(c,c.pending.dayIndex+5,businessDate(c.pending.date,5));
  return report;
}
export function publicCompanies(s:State):CompanyFundamentals[] {
  return s.companies.map(c=>{
    const q=s.stocks.find(q=>q.symbol===c.symbol)!,index=UNIVERSE.findIndex(u=>u.symbol===c.symbol),last=c.reports[0];
    const ttmNetProfit=c.reports.slice(0,4).reduce((n,r)=>n+r.netProfit,0),marketCap=q.last*c.shares;
    return {symbol:c.symbol,shares:c.shares,profile:{name:q.name,sector:q.sector,business:businesses[index],description:`${q.name}是股海模拟市场中的虚构${q.sector}公司。经营、财报和估值均为本地模拟；不对应现实发行人。`},
      reports:c.reports,nextReport:c.pending,cycleTradingDays:5,peerSymbols:s.stocks.filter(p=>p.sector===q.sector&&p.symbol!==q.symbol).map(p=>p.symbol),
      valuation:{marketCap,pe:ttmNetProfit>0?marketCap/ttmNetProfit:null,pb:last.equity>0?marketCap/last.equity:null,eps:last.eps,bps:last.bps,ttmNetProfit,roePct:last.equity>0?ttmNetProfit/last.equity*100:null,debtRatioPct:last.liabilities/last.assets*100}};
  });
}
