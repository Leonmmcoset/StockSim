import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { ArrowLeft, ListOrdered } from 'lucide-react';
import { useGameStore } from '../store/game';
import type { LeaderboardSort, PerformanceDay } from '../lib/api';
import { money, pct } from '../lib/format';
import './InvestmentReview.css';
import './PlayerStats.css';

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

const dateTime = (time: number) => time ? new Date(time).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const percent = (value: number | null | undefined, sign = true) => value == null ? '—' : pct(value, sign);
const dayText = (day: PerformanceDay | null) => day ? `${day.date} · ${percent(day.returnPct)} · ${money(day.netPnl)} 元` : '暂无完整已收盘日';

function AssetCurve({ points }: { points: { time: number; equity: number }[] }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const instance = echarts.init(host.current, null, { renderer: 'canvas' }); chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize()); observer.observe(host.current);
    return () => { observer.disconnect(); instance.dispose(); chart.current = null; };
  }, []);
  useEffect(() => {
    chart.current?.setOption({ animation: false, backgroundColor: '#030405', grid: { left: 75, right: 18, top: 22, bottom: 35 },
      tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, backgroundColor: '#101722', borderColor: '#44516a', textStyle: { color: '#d5dce6' }, formatter: (params: unknown) => { const items = params as { value: [number, number] }[]; const point = items[0]?.value; return point ? `${dateTime(point[0])}\n总资产 ${money(point[1])} 元` : ''; } },
      xAxis: { type: 'time', axisLabel: { color: '#7a8da7', hideOverlap: true }, axisLine: { lineStyle: { color: '#344056' } }, splitLine: { show: false } },
      yAxis: { type: 'value', scale: true, name: '元', nameTextStyle: { color: '#7a8da7' }, axisLabel: { color: '#7a8da7', formatter: (value: number) => money(value) }, splitLine: { lineStyle: { color: '#1e293a', type: 'dashed' } } },
      series: [{ type: 'line', name: '总资产', data: points.map(point => [point.time, point.equity]), showSymbol: points.length === 1, smooth: false, lineStyle: { color: '#e8d878', width: 1.5 }, itemStyle: { color: '#e8d878' } }],
    }, { notMerge: true });
  }, [points]);
  return <div className="ir-curve"><div className="ir-chart" ref={host} role="img" aria-label={`个人资产曲线，共 ${points.length} 个观察点`} />{points.length < 2 && <div className="ir-chart-empty">{points.length ? '已记录真实起点 · 继续运行后显示走势' : '暂无资产采样点'}</div>}</div>;
}

export default function PlayerStats({ onClose }: { onClose: () => void }) {
  const { playerProfile: profile, leaderboard, playerStatsPending: pending, playerStatsError: error, uncertainVisibility: uncertain, connection, refreshPlayerProfile, refreshLeaderboard, setLeaderboardVisibility, retryLeaderboardVisibility, clearLeaderboard } = useGameStore();
  const [tab, setTab] = useState<'personal' | 'leaderboard'>('personal');
  const [sort, setSort] = useState<LeaderboardSort>('totalReturnPct');
  useEffect(() => {
    if (connection !== 'online' || pending || uncertain) { clearLeaderboard(); return; }
    const controller = new AbortController(); let busy = false;
    const refresh = async () => { if (busy) return; busy = true; try { await refreshPlayerProfile(controller.signal); if (tab === 'leaderboard' && !controller.signal.aborted) await refreshLeaderboard(sort, controller.signal); } finally { busy = false; } };
    void refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { controller.abort(); window.clearInterval(timer); clearLeaderboard(); };
  }, [connection, tab, sort, pending, uncertain, refreshPlayerProfile, refreshLeaderboard, clearLeaderboard]);
  const perf = profile?.performance;
  const points = perf?.points ?? [];
  return <section className="investment-review player-stats" aria-label="玩家战绩">
    <div className="ir-heading"><div><ListOrdered size={13}/><strong>玩家战绩</strong><small>PLAYER PERFORMANCE</small></div><button className="ir-close" onClick={onClose}><ArrowLeft size={12}/>返回账户</button></div>
    <div className="ir-content">
      <div className="ps-tabs"><button className={tab === 'personal' ? 'active' : ''} aria-pressed={tab === 'personal'} onClick={() => setTab('personal')}>个人战绩</button><button className={tab === 'leaderboard' ? 'active' : ''} aria-pressed={tab === 'leaderboard'} onClick={() => setTab('leaderboard')}>玩家排行榜</button><span>在线时每 5 秒刷新</span></div>
      <div className="ps-privacy"><div><strong>排行榜公开状态：{connection !== 'online' ? '未知' : pending ? '正在确认' : uncertain || !profile ? '未知' : profile.leaderboardOptIn ? '已上榜' : '未上榜'}</strong><p>开启后公开用户名、入场时间、累计及近 5 日收益率和观察回撤；不公开持仓与委托。可随时取消。</p></div><button disabled={pending || connection !== 'online' || (!profile && !uncertain)} onClick={() => uncertain ? void retryLeaderboardVisibility() : void setLeaderboardVisibility(!profile!.leaderboardOptIn)}>{uncertain ? '使用原请求确认' : profile?.leaderboardOptIn ? '取消公开' : '同意公开并上榜'}</button></div>
      {error && <p className="ps-message" role="alert">{error}</p>}
      {connection !== 'online' && <p className="ps-message">连接中断，等待服务器重新连接。</p>}
      {tab === 'personal' ? perf && <>
        <div className="ir-coverage"><span>游戏入场时间 <b>{dateTime(perf.joinedAt)}</b></span><span>最佳 / 最差仅统计完整已收盘日 · 已排除 {perf.excludedPartialDayCount} 个不完整日</span></div>
        <dl className="ir-metrics">
          {[['累计收益率', percent(perf.totalReturnPct)], ['累计盈亏 / 元', money(perf.totalPnl)], ['近 5 日收益率', percent(perf.recent5.returnPct)], ['观察最大回撤', percent(perf.drawdown.maxDrawdownPct, false)], ['成交分笔', `${perf.fillCount} 笔`], ['累计费用 / 元', money(perf.feesPaid)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <p className="ir-note">成交分笔：买入 {perf.buyFillCount} 笔、卖出 {perf.sellFillCount} 笔，按撮合成交记录计数，不是委托数。<br/>近 5 日覆盖 {perf.recent5.coveredDays} 日（{dateTime(perf.recent5.startAt)} 至 {dateTime(perf.recent5.endAt)}）{perf.recent5.complete ? ' · 周期完整' : ' · 周期未完整，不参与近 5 日排名'}；观察回撤基于最多 {perf.drawdown.retentionDays} 个交易日留存采样点（{dateTime(perf.drawdown.startAt)} 至 {dateTime(perf.drawdown.endAt)}），可能遗漏采样间波动。{perf.drawdown.compacted ? ' 高频数据已压缩。' : ''}</p>
        <section className="ir-section"><div className="ir-section-heading"><h3>个人资产曲线</h3><small>{points.length} 个观察点 · 元</small></div><AssetCurve points={points} /></section>
        <div className="ps-days"><div><label>最佳交易日</label><strong>{dayText(perf.bestDay)}</strong></div><div><label>最差交易日</label><strong>{dayText(perf.worstDay)}</strong></div></div>
      </> : <>
        <div className="ir-section-heading"><h3>排行榜</h3><div className="ir-buttons">{([['totalReturnPct', '累计收益'], ['recent5ReturnPct', '近 5 日收益'], ['maxDrawdownPct', '观察回撤']] as const).map(([id, label]) => <button key={id} className={sort === id ? 'active' : ''} aria-pressed={sort === id} onClick={() => setSort(id)}>{label}</button>)}</div></div>
        <p className="ir-note">近 5 日周期未完整者不参与该项排名；观察回撤基于最多 30 个交易日的留存采样点。</p>
        {connection === 'online' && leaderboard ? <div className="ir-table-scroll"><table className="ir-table"><thead><tr><th>名次 / 玩家</th><th>入场时间</th><th>累计收益率</th><th>近 5 日收益率</th><th>观察最大回撤</th></tr></thead><tbody>{leaderboard.entries.map((entry, index) => <tr key={`${entry.username}:${index}`}><td>{entry.rank ?? '—'}　{entry.username}</td><td>{dateTime(entry.joinedAt)}</td><td>{percent(entry.totalReturnPct)}</td><td>{percent(entry.recent5.returnPct)}<small>覆盖 {entry.recent5.coveredDays} 日{!entry.recent5.complete && ' · 周期未完整'}</small></td><td>{percent(entry.drawdown.maxDrawdownPct, false)}<small>{dateTime(entry.drawdown.startAt)} 至 {dateTime(entry.drawdown.endAt)}</small></td></tr>)}</tbody></table>{leaderboard.entries.length === 0 && <div className="ps-empty">暂无玩家公开战绩</div>}</div> : <div className="ps-empty">{connection === 'online' ? '正在获取排行榜…' : '连接恢复后显示排行榜'}</div>}
      </>}
      {tab === 'personal' && !perf && <div className="ps-empty">{connection === 'online' ? '正在获取个人战绩…' : '连接恢复后获取个人战绩'}</div>}
    </div>
  </section>;
}
