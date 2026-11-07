import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChartNoAxesCombined } from 'lucide-react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import type { DailyReview, InvestmentReview as ReviewData, NormalizedEquityPoint } from '../engine/types';
import { selectReviewPeriod } from '../engine/review';
import { compactNumber, direction, money, pct } from '../lib/format';
import './InvestmentReview.css';

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export interface InvestmentReviewProps {
  review: ReviewData;
  onClose: () => void;
}

type ChartMode = 'assets' | 'returns' | 'position';
type CurveRange = 'day' | '5' | '20' | 'all';
const chartModes: { id: ChartMode; label: string }[] = [
  { id: 'assets', label: '资产与资金' },
  { id: 'returns', label: '账户 / 基准收益' },
  { id: 'position', label: '仓位' },
];
const curveRanges: { id: CurveRange; label: string }[] = [
  { id: 'day', label: '所选交易日' },
  { id: '5', label: '最近5日' },
  { id: '20', label: '最近20日' },
  { id: 'all', label: '全部记录' },
];
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const amountFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTime = (time: number) => `${dateFormat.format(time)} ${timeFormat.format(time)}`;
const signedMoney = (value: number) => `${value > 0 ? '+' : ''}${money(value)}`;
const nullablePct = (value: number | null) => value === null ? '—' : pct(value);
const dayStatus = (day: DailyReview) => `${day.status === 'closed' ? '已收盘' : '进行中'}${day.partial ? ' · 非完整日' : ''}`;

interface TooltipEntry { seriesName: string; dataIndex: number; value: [number, number | null] }

function ReviewCurve({ points, mode }: { points: NormalizedEquityPoint[]; mode: ChartMode }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const instance = echarts.init(host.current, null, { renderer: 'canvas' });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(host.current);
    return () => { observer.disconnect(); instance.dispose(); chart.current = null; };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    const definitions = mode === 'assets'
      ? [{ name: '总资产', color: '#e8d878', value: (point: NormalizedEquityPoint) => point.equity / 100 }, { name: '现金', color: '#78a8d4', value: (point: NormalizedEquityPoint) => point.cash / 100 }, { name: '股票市值', color: '#b78cd1', value: (point: NormalizedEquityPoint) => point.marketValue / 100 }]
      : mode === 'returns'
        ? [{ name: '账户收益', color: '#e8d878', value: (point: NormalizedEquityPoint) => point.returnPct }, { name: '股海指数', color: '#78a8d4', value: (point: NormalizedEquityPoint) => point.benchmarkReturnPct }]
        : [{ name: '仓位', color: '#e8d878', value: (point: NormalizedEquityPoint) => point.positionPct }];
    const multipleDays = points.length > 1 && dateFormat.format(points[0].time) !== dateFormat.format(points[points.length - 1].time);
    const option: EChartsOption = {
      animation: false, backgroundColor: '#030405',
      textStyle: { fontFamily: 'Consolas, Microsoft YaHei, monospace', fontSize: 11 },
      grid: { left: 67, right: 15, top: 23, bottom: multipleDays ? 42 : 29 },
      tooltip: {
        trigger: 'axis', renderMode: 'richText', confine: true,
        backgroundColor: '#101722', borderColor: '#44516a', borderWidth: 1,
        textStyle: { color: '#d5dce6', fontSize: 11 }, axisPointer: { type: 'line', lineStyle: { color: '#637089', type: 'dashed' } },
        formatter(params: unknown) {
          const entries = (Array.isArray(params) ? params : [params]) as TooltipEntry[];
          const point = points[entries[0]?.dataIndex];
          if (!point) return '';
          return [dateTime(point.time), ...entries.map(entry => `${entry.seriesName}  ${entry.value[1] === null ? '—' : mode === 'assets' ? `${amountFormat.format(entry.value[1])} 元` : pct(entry.value[1], mode === 'returns')}`)].join('\n');
        },
      },
      xAxis: {
        type: 'time', min: points[0]?.time, max: points[points.length - 1]?.time,
        axisLine: { lineStyle: { color: '#344056' } }, axisTick: { show: false }, splitNumber: 4,
        axisLabel: { color: '#7a8da7', fontSize: 10, hideOverlap: true, formatter: (value: number) => `${multipleDays ? `${dateFormat.format(value).slice(5)}\n` : ''}${timeFormat.format(value).slice(0, 5)}` },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', scale: mode !== 'position', min: mode === 'position' ? 0 : undefined, max: mode === 'position' ? 100 : undefined,
        name: mode === 'assets' ? '元' : '%', nameTextStyle: { color: '#7a8da7', fontSize: 10 }, splitNumber: 3,
        axisLabel: { color: '#7a8da7', fontSize: 10, formatter: (value: number) => mode === 'assets' ? compactNumber(value) : `${value.toFixed(1)}%` },
        splitLine: { lineStyle: { color: '#1e293a', type: 'dashed' } },
      },
      series: definitions.map(definition => ({
        type: 'line', name: definition.name, data: points.map(point => [point.time, definition.value(point)]),
        showSymbol: points.length === 1, symbolSize: 5, smooth: false, connectNulls: false,
        lineStyle: { color: definition.color, width: 1.5 }, itemStyle: { color: definition.color },
        emphasis: { disabled: true },
      })),
    };
    chart.current.setOption(option, { notMerge: true });
  }, [points, mode]);

  const legend = mode === 'assets' ? [['总资产', '#e8d878'], ['现金', '#78a8d4'], ['股票市值', '#b78cd1']] : mode === 'returns' ? [['账户收益', '#e8d878'], ['股海指数', '#78a8d4']] : [['仓位', '#e8d878']];
  return <div className="ir-curve">
    <div className="ir-legend">{legend.map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}<small>{points.length} 个真实采样点</small></div>
    <div className="ir-chart" ref={host} role="img" aria-label={`${chartModes.find(item => item.id === mode)?.label}走势，${points.length}个真实采样点`} />
    {points.length < 2 && <div className="ir-chart-empty">{points.length ? '已记录真实起点 · 继续运行后显示走势' : '所选区间暂无采集记录'}</div>}
  </div>;
}

function DayMetrics({ day }: { day: DailyReview }) {
  const metrics: { label: string; value: string; color?: number | null; detail?: string }[] = [
    { label: '净收益 / 元', value: signedMoney(day.netPnl), color: day.netPnl },
    { label: '账户收益率', value: nullablePct(day.returnPct), color: day.returnPct },
    { label: '同期股海指数', value: pct(day.benchmarkReturnPct), color: day.benchmarkReturnPct },
    { label: '超额收益', value: nullablePct(day.excessReturnPct), color: day.excessReturnPct },
    { label: '最大回撤', value: pct(day.maxDrawdownPct, false), detail: '基于采集点' },
    { label: '实际手续费 / 元', value: money(day.fees), detail: '已计入净收益' },
    { label: '已实现盈亏 / 元', value: signedMoney(day.realizedPnl), color: day.realizedPnl },
    { label: '浮盈变动 / 元', value: signedMoney(day.unrealizedPnlChange), color: day.unrealizedPnlChange },
    { label: '期初资产 / 元', value: money(day.startEquity) },
    { label: '期末资产 / 元', value: money(day.endEquity), detail: day.status === 'in-progress' ? '当前采集值' : '收盘采集值' },
    { label: '买入成交', value: `${day.buyFillCount} 笔`, detail: `${money(day.buyAmount)} 元` },
    { label: '卖出成交', value: `${day.sellFillCount} 笔`, detail: `${money(day.sellAmount)} 元` },
  ];
  return <dl className="ir-metrics">{metrics.map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd className={metric.color == null ? '' : direction(metric.color)}>{metric.value}</dd>{metric.detail && <small>{metric.detail}</small>}</div>)}</dl>;
}

export default function InvestmentReview({ review, onClose }: InvestmentReviewProps) {
  const [selectedDayIndex, setSelectedDayIndex] = useState<number | null>(null);
  const [mode, setMode] = useState<ChartMode>('assets');
  const [range, setRange] = useState<CurveRange>('day');
  const days = useMemo(() => [...review.days.filter(day => day.dayIndex !== review.currentDay.dayIndex), review.currentDay], [review.days, review.currentDay]);
  const selectedDay = days.find(day => day.dayIndex === selectedDayIndex) ?? review.currentDay;
  const period = useMemo(() => selectReviewPeriod(review, range === 'day' ? { dayIndex: selectedDay.dayIndex } : range === 'all' ? 'all' : Number(range)), [review, selectedDay.dayIndex, range]);
  const { points, summary } = period;
  const completedDays = days.filter(day => day.status === 'closed').length;

  return <section className="investment-review" aria-label="投资复盘">
    <div className="ir-heading"><div><ChartNoAxesCombined size={13} /><strong>投资复盘</strong><small>PORTFOLIO REVIEW</small></div><button className="ir-close" onClick={onClose}><ArrowLeft size={12} />返回账户</button></div>
    <div className="ir-content">
      <div className="ir-coverage"><span>采集起点 <b>{dateTime(review.coverageStartAt)}</b></span><span>保留最近 {review.retentionDays} 个交易日 · 已收盘 {completedDays} 日</span></div>
      <section className="ir-section" aria-label="每日复盘">
        <div className="ir-section-heading"><h3>每日复盘</h3><div className="ir-day-controls"><button className={selectedDay.dayIndex === review.currentDay.dayIndex ? 'active' : ''} aria-pressed={selectedDay.dayIndex === review.currentDay.dayIndex} onClick={() => setSelectedDayIndex(null)}>当日</button><label>交易日<select aria-label="选择复盘交易日" value={selectedDay.dayIndex} onChange={event => setSelectedDayIndex(Number(event.target.value))}>{[...days].reverse().map(day => <option key={day.dayIndex} value={day.dayIndex}>{day.date} · {dayStatus(day)}</option>)}</select></label></div></div>
        <div className="ir-day-status"><strong>{selectedDay.date}</strong><span className={selectedDay.status === 'closed' ? 'ir-status-closed' : 'ir-status-live'}>{dayStatus(selectedDay)}</span><small>{dateTime(selectedDay.startAt)} — {timeFormat.format(selectedDay.endAt)}（北京时间）</small></div>
        {selectedDay.partial && <p className="ir-partial">本日从 {timeFormat.format(selectedDay.coverageStartAt)} 开始采集，仅统计已记录时段；启用前的交易与资产走势不补造。</p>}
        <DayMetrics day={selectedDay} />
        <p className="ir-note">日收益以本日采集起点资产为基准；净收益已扣实际成交手续费。已实现盈亏与浮盈变动按引擎日结口径记录。进行中数值随市场更新，收盘后生成日结。</p>
      </section>
      <section className="ir-section" aria-label="账户历史走势">
        <div className="ir-section-heading"><h3>账户走势</h3><div className="ir-buttons" aria-label="走势记录区间">{curveRanges.map(item => <button key={item.id} className={range === item.id ? 'active' : ''} aria-pressed={range === item.id} onClick={() => setRange(item.id)}>{item.label}</button>)}</div></div>
        <div className="ir-curve-controls"><div className="ir-buttons" aria-label="走势指标">{chartModes.map(item => <button key={item.id} className={mode === item.id ? 'active' : ''} aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>{item.label}</button>)}</div><span>{points.length ? `${dateTime(points[0].time)} — ${dateTime(points[points.length - 1].time)}` : '暂无区间数据'}</span></div>
        <div className="ir-period-summary" aria-label="所选区间收益"><span>区间净收益 <b className={direction(summary.netPnl)}>{signedMoney(summary.netPnl)} 元</b></span><span>账户 <b className={summary.returnPct === null ? '' : direction(summary.returnPct)}>{nullablePct(summary.returnPct)}</b></span><span>基准 <b className={direction(summary.benchmarkReturnPct)}>{pct(summary.benchmarkReturnPct)}</b></span><span>超额 <b className={summary.excessReturnPct === null ? '' : direction(summary.excessReturnPct)}>{nullablePct(summary.excessReturnPct)}</b></span><small>{summary.dayCount} 个记录日{summary.partial ? ' · 含非完整日' : ''}</small></div>
        <ReviewCurve points={points} mode={mode} />
        <p className="ir-note">{mode === 'returns' ? '账户与股海指数均以所选区间首个采集点归零；账户起点资产为零时收益率显示“—”。' : mode === 'assets' ? '现金包含冻结资金，股票市值按当时公开成交价计价。' : '仓位显示股票市值占总资产的比例。'} 横轴为北京时间，保留午休与隔夜间隔；连线仅连接真实采样点，不表示期间发生交易。</p>
      </section>
      <section className="ir-section" aria-label="最近日结记录">
        <div className="ir-section-heading"><h3>最近记录</h3><small>点击日期查看日报 · 金额单位：元</small></div>
        <div className="ir-table-scroll" tabIndex={0} aria-label="日结记录，可左右滚动"><table className="ir-table"><thead><tr><th>交易日 / 状态</th><th>净收益</th><th>账户收益</th><th>股海指数</th><th>超额收益</th><th>最大回撤</th><th>手续费</th><th>买 / 卖成交</th></tr></thead><tbody>{[...days].reverse().map(day => <tr key={day.dayIndex} className={day.dayIndex === selectedDay.dayIndex ? 'selected' : ''}><td><button onClick={() => setSelectedDayIndex(day.dayIndex)} aria-label={`查看${day.date}复盘`}>{day.date}<span>{dayStatus(day)}</span></button></td><td className={direction(day.netPnl)}>{signedMoney(day.netPnl)}</td><td className={day.returnPct === null ? '' : direction(day.returnPct)}>{nullablePct(day.returnPct)}</td><td className={direction(day.benchmarkReturnPct)}>{pct(day.benchmarkReturnPct)}</td><td className={day.excessReturnPct === null ? '' : direction(day.excessReturnPct)}>{nullablePct(day.excessReturnPct)}</td><td>{pct(day.maxDrawdownPct, false)}</td><td>{money(day.fees)}</td><td>{day.buyFillCount} / {day.sellFillCount}</td></tr>)}</tbody></table></div>
        <p className="ir-note">仅展示采集后留存的真实记录。资产每 30 秒及成交时采样；最大回撤基于采集点，可能遗漏采样间的瞬时波动。{review.compacted && ' 高频成交记录已压缩展示，保留真实观察点与已观察到的回撤极值。'}</p>
      </section>
    </div>
  </section>;
}
