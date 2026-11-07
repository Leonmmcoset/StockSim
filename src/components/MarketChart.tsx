import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CandlestickChart, LineChart } from 'echarts/charts';
import { AxisPointerComponent, DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import type { Bar, Quote } from '../engine';
import { price, volume } from '../lib/format';
import './MarketChart.css';

echarts.use([LineChart, BarChart, CandlestickChart, GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, AxisPointerComponent, CanvasRenderer]);

const UP = '#ff4545', DOWN = '#00d878', GRID = '#2b2025';
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
function movingAverage(bars: Bar[], window: number): Array<number | '-'> {
  let sum = 0;
  return bars.map((bar, i) => {
    sum += bar.close;
    if (i >= window) sum -= bars[i - window].close;
    return i < window - 1 ? '-' : +(sum / window / 100).toFixed(3);
  });
}
const sessionTimes = [
  ...Array.from({ length: 120 }, (_, i) => `${String(9 + Math.floor((30 + i) / 60)).padStart(2, '0')}:${String((30 + i) % 60).padStart(2, '0')}`),
  ...Array.from({ length: 121 }, (_, i) => `${String(13 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`),
];
interface TooltipEntry { seriesName: string; axisValue?: string; value: unknown; dataIndex: number }

export default function MarketChart({ quote, mode }: { quote: Quote; mode: 'intraday' | 'daily' }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const zoom = useRef({ start: 10, end: 100 });
  const identity = useRef('');
  const daily = mode === 'daily';
  const averages = useMemo(() => [5, 10, 20].map(w => movingAverage(quote.dailyBars, w)), [quote.dailyBars]);

  useEffect(() => {
    if (!host.current) return;
    const instance = echarts.init(host.current, null, { renderer: 'canvas' });
    chart.current = instance;
    instance.on('datazoom', () => {
      const option = instance.getOption() as { dataZoom?: Array<{ start?: number; end?: number }> };
      const value = option.dataZoom?.[0];
      if (value) zoom.current = { start: value.start ?? 10, end: value.end ?? 100 };
    });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(host.current);
    return () => { observer.disconnect(); instance.dispose(); chart.current = null; };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    const key = `${quote.symbol}-${mode}`;
    if (identity.current !== key) { zoom.current = { start: 10, end: 100 }; identity.current = key; }
    const bars = quote.dailyBars;
    const intraday = new Map(quote.minuteBars.map(bar => [clockFormat.format(bar.time), bar]));
    const x = daily ? bars.map(bar => dayFormat.format(bar.time)) : sessionTimes;
    let amount = 0, count = 0;
    const average = sessionTimes.map(time => {
      const bar = intraday.get(time);
      if (!bar) return '-';
      amount += bar.turnover; count += bar.volume;
      return count ? +(amount / count / 100).toFixed(3) : bar.close / 100;
    });
    const range = Math.max(quote.high - quote.prevClose, quote.prevClose - quote.low, quote.prevClose * 0.006) * 1.12;
    const min = Math.max(1, Math.floor(quote.prevClose - range)) / 100;
    const max = Math.ceil(quote.prevClose + range) / 100;
    const dataColor = (bar: Bar) => bar.close >= bar.open ? UP : DOWN;
    const commonAxis = {
      type: 'category' as const, data: x, boundaryGap: daily,
      axisLine: { lineStyle: { color: '#44434b' } }, axisTick: { show: false },
      axisLabel: { color: '#9395a0', fontFamily: 'Consolas, monospace', fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: GRID, type: 'dashed' as const } },
    };
    const option: EChartsOption = {
      animation: false, backgroundColor: '#030405',
      textStyle: { fontFamily: 'Consolas, Microsoft YaHei, sans-serif', fontSize: 11 },
      grid: [{ left: 57, right: 52, top: 36, bottom: '29%' }, { left: 57, right: 52, top: '76%', bottom: daily ? 45 : 30 }],
      axisPointer: { link: [{ xAxisIndex: [0, 1] }], label: { backgroundColor: '#343947', color: '#fff' }, lineStyle: { color: '#81838e', type: 'dashed' } },
      tooltip: {
        trigger: 'axis', renderMode: 'richText', confine: true,
        backgroundColor: '#11141d', borderColor: '#50505e', borderWidth: 1,
        textStyle: { color: '#dedfe3', fontSize: 11 }, axisPointer: { type: 'cross' },
        formatter(params: unknown) {
          const entries = (Array.isArray(params) ? params : [params]) as TooltipEntry[];
          const first = entries[0];
          if (!first) return '';
          if (daily) {
            const bar = bars[first.dataIndex];
            if (!bar) return '';
            return `${first.axisValue}\n开 ${price(bar.open)}   高 ${price(bar.high)}\n收 ${price(bar.close)}   低 ${price(bar.low)}\n成交 ${volume(bar.volume)} 手`;
          }
          const bar = intraday.get(String(first.axisValue));
          if (!bar) return String(first.axisValue ?? '');
          return `${first.axisValue}\n价格 ${price(bar.close)}\n涨幅 ${((bar.close / quote.prevClose - 1) * 100).toFixed(2)}%\n成交 ${volume(bar.volume)} 手`;
        },
      },
      xAxis: [
        { ...commonAxis, axisLabel: { ...commonAxis.axisLabel, show: false }, axisPointer: { label: { show: true } } },
        { ...commonAxis, gridIndex: 1, splitLine: { show: false },
          axisLabel: { ...commonAxis.axisLabel, interval: daily ? 'auto' : 0,
            formatter: daily ? (v: string) => v.slice(5) : (v: string) => ({ '09:30': '09:30', '10:30': '10:30', '13:00': '11:30/13:00', '14:00': '14:00', '15:00': '15:00' })[v] ?? '',
          },
        },
      ],
      yAxis: [
        {
          type: 'value', scale: true, position: 'left', splitNumber: 4,
          ...(daily ? {} : { min, max, interval: (max - min) / 4 }),
          axisLabel: { color: daily ? '#b0b2bb' : (value?: string | number) => Number(value) * 100 > quote.prevClose ? UP : Number(value) * 100 < quote.prevClose ? DOWN : '#b4b4be', formatter: (value: number) => value.toFixed(2), fontSize: 10, fontFamily: 'Consolas, monospace' },
          splitLine: { show: true, lineStyle: { color: GRID, type: 'dashed' } },
          axisPointer: { label: { precision: 2 } },
        },
        { type: 'value', gridIndex: 1, splitNumber: 2, axisLabel: { color: '#898b96', fontSize: 9, formatter: (value: number) => value >= 1e4 ? `${(value / 1e4).toFixed(1)}万` : `${value}` }, splitLine: { lineStyle: { color: '#201d22' } } },
        ...(daily ? [] : [{
          type: 'value' as const, position: 'right' as const,
          min: (min * 100 / quote.prevClose - 1) * 100, max: (max * 100 / quote.prevClose - 1) * 100,
          interval: (max - min) * 10000 / quote.prevClose / 4,
          axisLabel: { color: (value?: string | number) => Number(value) > 0 ? UP : Number(value) < 0 ? DOWN : '#aaa', formatter: (value: number) => `${value.toFixed(2)}%`, fontSize: 10 },
          splitLine: { show: false },
        }]),
      ],
      dataZoom: daily ? [
        { type: 'inside', xAxisIndex: [0, 1], ...zoom.current },
        { type: 'slider', xAxisIndex: [0, 1], ...zoom.current, bottom: 8, height: 13, borderColor: '#30303a', backgroundColor: '#101219', fillerColor: '#34455b55', handleSize: '130%', handleStyle: { color: '#6f7b8e' }, textStyle: { color: '#888', fontSize: 9 }, showDetail: false, brushSelect: false, dataBackground: { lineStyle: { color: '#6a6470' }, areaStyle: { color: '#1d2635' } } },
      ] : [],
      series: daily ? [
        { name: '日K', type: 'candlestick', data: bars.map(b => [b.open / 100, b.close / 100, b.low / 100, b.high / 100]), barMaxWidth: 10, itemStyle: { color: '#030405', color0: DOWN, borderColor: UP, borderColor0: DOWN },
          markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: '#54515d', type: 'dashed' }, data: [{ yAxis: quote.last / 100 }] },
        },
        ...averages.map((data, i) => ({ name: `MA${[5, 10, 20][i]}`, type: 'line' as const, data, showSymbol: false, lineStyle: { width: 1, color: ['#dcdde3', '#f2d85f', '#d37bdb'][i] }, emphasis: { disabled: true } })),
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 10, data: bars.map(bar => ({ value: bar.volume / 100, itemStyle: { color: dataColor(bar) } })) },
      ] : [
        { name: '价格', type: 'line', data: sessionTimes.map(time => { const bar = intraday.get(time); return bar ? bar.close / 100 : '-'; }), showSymbol: false, connectNulls: false, lineStyle: { color: '#e2e5ee', width: 1.25 },
          markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: '#6b5c68', type: 'dashed' }, data: [{ yAxis: quote.prevClose / 100 }] },
        },
        { name: '均价', type: 'line', data: average, showSymbol: false, lineStyle: { color: '#e9ce4e', width: 1.1 } },
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 5, data: sessionTimes.map(time => { const bar = intraday.get(time); return bar ? { value: bar.volume / 100, itemStyle: { color: dataColor(bar) } } : '-'; }) },
      ],
    };
    chart.current.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [quote, mode, daily, averages]);

  const latestMA = averages.map(values => values[values.length - 1]);
  return <div className="market-chart" aria-label={`${quote.name}${daily ? '日K线' : '分时'}图`}>
    <div className="chart-legend">
      <span>{daily ? '日线' : '分时走势'}</span>
      {daily ? <>{[5, 10, 20].map((w, i) => <span key={w} style={{ color: ['#dcdde3', '#f2d85f', '#d37bdb'][i] }}>MA{w}: {typeof latestMA[i] === 'number' ? latestMA[i].toFixed(2) : '—'}</span>)}</> : <><span className="legend-white">价格 {price(quote.last)}</span><span className="legend-yellow">均价 {price(quote.vwap)}</span><span className="legend-muted">昨收 {price(quote.prevClose)}</span></>}
    </div>
    <div ref={host} className="chart-canvas" />
    <div className="chart-volume-label">VOL（手）<span>{volume(quote.volume)}</span></div>
    <div className="chart-watermark">股海证券 <small>模拟行情</small></div>
  </div>;
}
