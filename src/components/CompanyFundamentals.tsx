import { useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Building2, FileText } from 'lucide-react';
import type { CompanyFundamentals as CompanyData, FinancialReport, MarketClock, Quote } from '../engine/types';
import { compactNumber, direction, money, pct, price } from '../lib/format';
import './CompanyFundamentals.css';

export interface CompanyFundamentalsProps {
  company: CompanyData;
  companies: CompanyData[];
  quote: Quote;
  clock: MarketClock;
  onSelect: (symbol: string) => void;
  onClose: () => void;
  initialTab?: CompanyFundamentalsTab;
  reportId?: string;
}

export type CompanyFundamentalsTab = 'overview' | 'financials' | 'reports' | 'peers';
type Tab = CompanyFundamentalsTab;
type TrendMetric = 'revenue' | 'netProfit' | 'operatingCashFlow';
const tabs: { id: Tab; label: string }[] = [
  { id: 'overview', label: '公司概况' },
  { id: 'financials', label: '财务数据' },
  { id: 'reports', label: '财报公告' },
  { id: 'peers', label: '同行比较' },
];
const trendMetrics: { id: TrendMetric; label: string }[] = [
  { id: 'revenue', label: '营业收入' },
  { id: 'netProfit', label: '归母净利润' },
  { id: 'operatingCashFlow', label: '经营现金流' },
];
const numberFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatAmount = (value: number) => `${compactNumber(value / 100)}元`;
const formatWan = (value: number) => numberFormat.format(value / 1e6);
const formatMultiple = (value: number | null) => value === null ? '—' : `${value.toFixed(2)}倍`;
const formatPct = (value: number | null, sign = false) => value === null ? '—' : pct(value, sign);
const reportDate = (timestamp: number) => new Date(timestamp).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).replaceAll('/', '-');
const reportTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });

function FinancialTrend({ reports }: { reports: FinancialReport[] }) {
  const [metric, setMetric] = useState<TrendMetric>('revenue');
  const data = reports.slice(0, 8).reverse();
  const values = data.map(report => report[metric]);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const left = 70;
  const right = 526;
  const top = 17;
  const bottom = 112;
  const x = (index: number) => data.length === 1 ? (left + right) / 2 : left + index * (right - left) / (data.length - 1);
  const y = (value: number) => bottom - (value - min) / range * (bottom - top);
  const label = trendMetrics.find(item => item.id === metric)?.label;
  return <section className="f10-section" aria-label="已公开财务趋势">
    <h3>公开财务趋势 <small>最近 {data.length} 期 · 单季值</small></h3>
    <div className="f10-trend-controls" aria-label="趋势指标">{trendMetrics.map(item => <button key={item.id} className={metric === item.id ? 'active' : ''} aria-pressed={metric === item.id} onClick={() => setMetric(item.id)}>{item.label}</button>)}</div>
    {data.length ? <div className="f10-trend"><svg viewBox="0 0 552 141" role="img" aria-label={`${label}最近${data.length}期趋势，单位人民币元`}>
      {[0, 0.5, 1].map(ratio => { const value = min + range * ratio; return <g key={ratio}><line x1={left} x2={right} y1={y(value)} y2={y(value)} /><text x={left - 8} y={y(value) + 3} textAnchor="end">{compactNumber(value / 100)}</text></g>; })}
      <polyline className="f10-trend-line" points={data.map((report, index) => `${x(index)},${y(report[metric])}`).join(' ')} />
      {data.map((report, index) => <g key={report.id}><circle cx={x(index)} cy={y(report[metric])} r={3}><title>{report.label} {label}：{formatAmount(report[metric])}</title></circle><text x={x(index)} y={131} textAnchor="middle">第{report.period}期</text></g>)}
    </svg></div> : <div className="f10-empty">暂无已公开财务报告</div>}
    <p className="f10-note">各点对应已发布的模拟单季报告；鼠标悬停圆点可查看金额。初始合成背景期在财务表和公告中标记。</p>
  </section>;
}

function ValuationNotes() {
  return <p className="f10-note">PE＝当前总市值 / 最近四期归母净利润（TTM）；利润非正时显示“—”。PB＝总市值 / 最新净资产，净资产非正时显示“—”。EPS 为最新单季每股收益，BPS 为最新每股净资产。ROE＝最近四期归母净利润 / 最新净资产，采用期末净资产的简化口径；负债率＝最新总负债 / 总资产。以上估值随成交价更新，财务数据仅在公告发布后更新。</p>;
}

function ReportArticle({ report, company }: { report: FinancialReport; company: CompanyData }) {
  return <article className="f10-report-article" aria-label={`${report.label}财报正文`}>
    <h3>{company.profile.name} {report.label}业绩公告</h3>
    <div className="f10-report-meta"><span>发布 {reportDate(report.publishedAt)} {reportTime(report.publishedAt)}</span><span>{report.synthetic ? '合成背景财报' : '模拟市场公开财报'}</span><span>单季数据</span></div>
    <p className="f10-report-body">{company.profile.name}本期实现营业收入 {formatAmount(report.revenue)}，归属于母公司股东的净利润 {formatAmount(report.netProfit)}。经营活动产生的现金流量净额为 {formatAmount(report.operatingCashFlow)}。期末总资产 {formatAmount(report.assets)}，总负债 {formatAmount(report.liabilities)}，净资产 {formatAmount(report.equity)}。</p>
    <div className="f10-report-numbers">
      <div><label>营收环比</label><span className={report.revenueGrowthPct === null ? '' : direction(report.revenueGrowthPct)}>{formatPct(report.revenueGrowthPct, true)}</span></div>
      <div><label>净利环比</label><span className={report.profitGrowthPct === null ? '' : direction(report.profitGrowthPct)}>{formatPct(report.profitGrowthPct, true)}</span></div>
      <div><label>本期 EPS</label><span>{money(report.eps, 4)}元</span></div>
      <div><label>期末 BPS</label><span>{money(report.bps, 4)}元</span></div>
      <div><label>资本开支</label><span>{formatAmount(report.capex)}</span></div>
      <div><label>期末现金</label><span>{formatAmount(report.cash)}</span></div>
    </div>
    {report.synthetic ? <div className="f10-report-surprise"><strong>初始合成背景期</strong><br />本期用于建立公司的初始财务历史；预期差不作为游戏内已发生的公告事件展示。</div> : <><div className="f10-report-surprise"><strong>公告前公开预期</strong><br />营业收入 {formatAmount(report.expectedRevenue)}，本次预期差 <span className={direction(report.revenueSurprisePct)}>{pct(report.revenueSurprisePct)}</span>；归母净利润 {formatAmount(report.expectedNetProfit)}，本次预期差 <span className={direction(report.profitSurprisePct)}>{pct(report.profitSurprisePct)}</span>。</div>
    <p className="f10-note">预期差用于对照公告前的公开预期，正值为超过预期、负值为低于预期。营收按预期营收作分母；净利按 max（预期净利绝对值，预期营收 × 1%）作分母。市场交易仍由订单撮合决定。</p></>}
  </article>;
}

export default function CompanyFundamentals({ company, companies, quote, clock, onSelect, onClose, initialTab, reportId }: CompanyFundamentalsProps) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? 'overview');
  const [selectedReportId, setSelectedReportId] = useState<string | null>(reportId ?? null);
  useEffect(() => { if (initialTab) setActiveTab(initialTab); }, [initialTab]);
  useEffect(() => { setSelectedReportId(reportId ?? null); }, [reportId]);
  // Consume only the public snapshot, with a timestamp guard for disclosure-time rendering.
  const reports = company.reports.filter(report => report.publishedAt <= clock.timestamp);
  const recentReports = reports.slice(0, 8);
  const selectedReport = reports.find(report => report.id === selectedReportId) ?? reports[0];
  const latest = reports[0];
  const { valuation, nextReport, profile } = company;
  const daysToReport = Math.max(0, nextReport.dayIndex - clock.dayIndex);
  const peers = companies.filter(candidate => candidate.profile.sector === profile.sector);
  const handleTabKeys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveTab(tabs[nextIndex].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  };
  const tableRows: { label: string; value: (report: FinancialReport) => string; color?: (report: FinancialReport) => string }[] = [
    { label: '营业收入（万元）', value: report => formatWan(report.revenue) },
    { label: '营收环比', value: report => formatPct(report.revenueGrowthPct, true), color: report => report.revenueGrowthPct === null ? '' : direction(report.revenueGrowthPct) },
    { label: '归母净利（万元）', value: report => formatWan(report.netProfit), color: report => direction(report.netProfit) },
    { label: '净利环比', value: report => formatPct(report.profitGrowthPct, true), color: report => report.profitGrowthPct === null ? '' : direction(report.profitGrowthPct) },
    { label: '经营现金流（万元）', value: report => formatWan(report.operatingCashFlow) },
    { label: '总资产（万元）', value: report => formatWan(report.assets) },
    { label: '总负债（万元）', value: report => formatWan(report.liabilities) },
    { label: '净资产（万元）', value: report => formatWan(report.equity) },
    { label: 'EPS（元/股）', value: report => money(report.eps, 4) },
    { label: 'BPS（元/股）', value: report => money(report.bps, 4) },
    { label: '营收预期差', value: report => report.synthetic ? '— *' : pct(report.revenueSurprisePct), color: report => report.synthetic ? '' : direction(report.revenueSurprisePct) },
    { label: '净利预期差', value: report => report.synthetic ? '— *' : pct(report.profitSurprisePct), color: report => report.synthetic ? '' : direction(report.profitSurprisePct) },
  ];
  return <section className="company-fundamentals" aria-label={`${profile.name} F10公司资料`}>
    <div className="f10-heading"><div className="f10-heading-title"><Building2 size={13} /><span>公司资料 · F10</span><small>PUBLIC DISCLOSURES</small></div><button className="f10-close" onClick={onClose} title="返回行情图表（F10 / Esc）"><ArrowLeft size={12} />返回图表</button></div>
    <div className="f10-tabs" role="tablist" aria-label="公司资料分类">{tabs.map((tab, index) => <button key={tab.id} id={`f10-tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id} aria-controls={`f10-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)} onKeyDown={event => handleTabKeys(event, index)}>{tab.label}</button>)}</div>
    <div className="f10-content" role="tabpanel" id={`f10-panel-${activeTab}`} aria-labelledby={`f10-tab-${activeTab}`}>
      <div className="f10-summary-line"><strong>{profile.name} <span className="mono">{company.symbol}</span></strong><span>{profile.sector} · 截至 {clock.date} {clock.time}</span></div>
      {activeTab === 'overview' && <>
        <div className="f10-grid"><div><section className="f10-section"><h3>公司简介</h3><p className="f10-description">{profile.description}</p></section><section className="f10-section"><h3>主营业务</h3><p>{profile.business}</p><p className="f10-note">所属行业：{profile.sector}　总股本：{compactNumber(company.shares)}股。全部公司及其财务数据均为原创虚构模拟。</p></section></div>
          <section className="f10-section"><h3>估值与财务指标 <small>{latest?.label ?? '暂无报告'}</small></h3><dl className="f10-facts">
            <div><dt>PE（TTM）</dt><dd>{formatMultiple(valuation.pe)}</dd></div><div><dt>PB</dt><dd>{formatMultiple(valuation.pb)}</dd></div>
            <div><dt>EPS（元/股）</dt><dd>{money(valuation.eps, 4)}</dd></div><div><dt>BPS（元/股）</dt><dd>{money(valuation.bps, 4)}</dd></div>
            <div><dt>ROE（简化TTM）</dt><dd>{formatPct(valuation.roePct)}</dd></div><div><dt>资产负债率</dt><dd>{pct(valuation.debtRatioPct, false)}</dd></div>
            <div><dt>总市值</dt><dd>{formatAmount(valuation.marketCap)}</dd></div><div><dt>最新成交价</dt><dd className={direction(quote.change)}>{price(quote.last)}元</dd></div>
            <div className="f10-data-period"><dt>财务发布日期</dt><dd>{latest ? `${reportDate(latest.publishedAt)}${latest.synthetic ? ' · 合成背景期' : ''}` : '暂无公开报告'}</dd></div>
          </dl></section></div>
        <FinancialTrend reports={reports} /><ValuationNotes />
      </>}
      {activeTab === 'financials' && <>
        <section className="f10-section"><h3>已公开财务数据 <small>最近 {recentReports.length} 期 · 最新在左</small></h3>{recentReports.length ? <div className="f10-table-scroll" tabIndex={0} aria-label="财务数据，可左右滚动"><table className="f10-table"><thead><tr><th>项目 / 报告期</th>{recentReports.map(report => <th key={report.id}><span className="f10-period-head">{report.label}{report.synthetic ? ' *' : ''}</span><span className="f10-release-date">{reportDate(report.publishedAt)}</span></th>)}</tr></thead><tbody>{tableRows.map(row => <tr key={row.label}><td>{row.label}</td>{recentReports.map(report => <td key={report.id} className={row.color?.(report)}>{row.value(report)}</td>)}</tr>)}</tbody></table></div> : <div className="f10-empty">暂无已公开财务报告</div>}<p className="f10-note">* 初始合成背景财报，其预期差不作为游戏内公告事件展示。损益和现金流均为单季值；资产、负债和净资产为期末值。增长为相对上一期的环比，上一期基数 ≤ 0 时显示“—”；不代表同比。金额按表中单位显示。</p></section>
        <FinancialTrend reports={reports} /><ValuationNotes />
      </>}
      {activeTab === 'reports' && <>
        <div className="f10-next-report"><FileText size={13} className="yellow" /><span>下次 {nextReport.label}</span><strong>{nextReport.date} {reportTime(nextReport.publishedAt)}</strong><strong>{daysToReport === 0 ? '本交易日发布' : `距今 ${daysToReport} 个交易日`}</strong><small>模拟季度：每 {company.cycleTradingDays} 个交易日一期</small></div>
        <p className="f10-note" style={{ marginBottom: 12 }}>下期公开预期：营收 {formatAmount(nextReport.expectedRevenue)}，归母净利润 {formatAmount(nextReport.expectedNetProfit)}。实际业绩于上述时间公开。</p>
        {selectedReport ? <div className="f10-report-layout"><nav className="f10-report-list" aria-label="选择已发布报告">{reports.map(report => <button key={report.id} className={selectedReport.id === report.id ? 'active' : ''} aria-pressed={selectedReport.id === report.id} onClick={() => setSelectedReportId(report.id)}>{report.label}业绩公告<span>{reportDate(report.publishedAt)}{report.synthetic ? ' · 背景期' : ''}</span></button>)}</nav><ReportArticle report={selectedReport} company={company} /></div> : <div className="f10-empty">暂无已发布公告</div>}
        <p className="f10-footnote">游戏将季度经营和披露压缩为交易日节奏，倒计时按模拟交易日计算；这与真实上市公司的自然季度、法定披露期限不同。初始背景财报为合成数据，后续报告由同一公司经营模型逐期生成。</p>
      </>}
      {activeTab === 'peers' && <>
        <section className="f10-section"><h3>{profile.sector} · 同行比较 <small>同一公开指标口径</small></h3><div className="f10-table-scroll" tabIndex={0} aria-label="同行比较，可左右滚动"><table className="f10-table f10-peer-table"><thead><tr><th>公司</th><th>总市值</th><th>PE / TTM</th><th>PB</th><th>EPS / 元</th><th>ROE / TTM</th><th>负债率</th><th>操作</th></tr></thead><tbody>{peers.map(peer => <tr key={peer.symbol} className={peer.symbol === company.symbol ? 'selected' : ''}><td><span className="f10-peer-name">{peer.profile.name}</span><span className="f10-peer-code">{peer.symbol}</span></td><td>{formatAmount(peer.valuation.marketCap)}</td><td>{formatMultiple(peer.valuation.pe)}</td><td>{formatMultiple(peer.valuation.pb)}</td><td>{money(peer.valuation.eps, 4)}</td><td>{formatPct(peer.valuation.roePct)}</td><td>{pct(peer.valuation.debtRatioPct, false)}</td><td><button className="f10-select-peer" disabled={peer.symbol === company.symbol} onClick={() => onSelect(peer.symbol)} aria-label={`查看${peer.profile.name}公司资料`}>{peer.symbol === company.symbol ? '当前' : '查看公司'}</button></td></tr>)}</tbody></table></div><p className="f10-note">仅列出同属“{profile.sector}”的公司。选择同行会同步切换行情与交易标的，并保留 F10 界面。</p></section><ValuationNotes />
      </>}
    </div>
  </section>;
}
