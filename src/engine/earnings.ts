import type { State, Stock } from './internal';
import type { FinancialReport } from './types';
import { releaseReport } from './fundamentals';
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
/** Announcement updates valuation beliefs and sentiment, never quotes or executions.
 * Inventory, existing orders, heterogeneous signals and subsequent matching determine prices.
 */
export function applyEarningsSignal(stock:Stock,report:FinancialReport):void {
  const surprise=clamp(report.profitSurprisePct/100,-.8,.8);
  const salesSurprise=clamp(report.revenueSurprisePct/100,-.3,.3);
  stock.fundamental*=Math.exp(.055*surprise+.025*salesSurprise);
  stock.sentiment=clamp(stock.sentiment+.018*surprise+.006*salesSurprise,-.035,.035);
}
export function releaseDueEarnings(s:State):void {
  const now=Date.parse(`${s.date}T00:00:00+08:00`)+s.seconds*1000;
  for(const c of s.companies){
    if(c.pending.publishedAt>now)continue;
    const q=s.stocks.find(q=>q.symbol===c.symbol)!,report=releaseReport(c);
    applyEarningsSignal(q,report);
    const sign=report.profitSurprisePct>.5?'positive':report.profitSurprisePct<-.5?'negative':'neutral';
    const money=(n:number)=>(n/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
    s.news.unshift({id:`N${++s.seq}`,time:report.publishedAt,kind:'earnings',reportId:report.id,scope:'company',symbols:[c.symbol],impact:sign,
      headline:`${q.name} ${report.label}：${sign==='positive'?'盈利超预期':sign==='negative'?'盈利不及预期':'盈利符合预期'}`,
      body:`营业收入${money(report.revenue)}元（此前预期${money(report.expectedRevenue)}元）；净利润${money(report.netProfit)}元（此前预期${money(report.expectedNetProfit)}元），盈利预期差${report.profitSurprisePct>=0?'+':''}${report.profitSurprisePct.toFixed(2)}%；经营现金流${money(report.operatingCashFlow)}元。每5交易日约一模拟季度；预期差以预期净利绝对值与预期营收1%中的较大值为分母。公告影响交易者判断，成交方向取决于订单撮合。`});
  }
  if(s.news.length>100)s.news.length=100;
}
