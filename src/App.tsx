import { useEffect, useState } from 'react';
import { Activity, BarChart3, CandlestickChart, ChevronRight, CircleHelp, Database, Gauge, Pause, Play, Radio, Save, Settings2, SkipForward, Star } from 'lucide-react';
import { startGameLoop, useGameStore } from './store/game';
import { QuotesTable } from './components/QuotesTable';
import { OrderBook, OrderPanel, type PriceSelection } from './components/OrderPanel';
import { AccountPanel } from './components/AccountPanel';
import MarketChart from './components/MarketChart';
import SettingsDialog from './components/SettingsDialog';
import { compactNumber, direction, pct, price, volume } from './lib/format';
import type { Side } from './engine/types';

export default function App() {
  const game = useGameStore();
  const [watchOnly, setWatchOnly] = useState(false);
  const [accountTab, setAccountTab] = useState<'positions' | 'orders' | 'trades' | 'news'>('positions');
  const [priceSelection, setPriceSelection] = useState<PriceSelection | null>(null);
  useEffect(() => { setPriceSelection(null); }, [game.sessionRevision]);
  useEffect(() => { game.initialize(); return startGameLoop(); }, [game.initialize]);
  useEffect(() => {
    if (!game.notice) return;
    const timeout = window.setTimeout(game.clearNotice, 6500);
    return () => window.clearTimeout(timeout);
  }, [game.notice?.id]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || game.settingsOpen) return;
      if (event.key === 'F5') { event.preventDefault(); game.setChartMode(game.chartMode === 'daily' ? 'intraday' : 'daily'); }
      if (event.key === 'F6') { event.preventDefault(); setWatchOnly(value => !value); }
      if (event.key === 'F12') { event.preventDefault(); document.getElementById('order-price')?.focus(); }
      if (event.code === 'Space') { event.preventDefault(); game.toggleRunning(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [game.chartMode, game.settingsOpen]);
  const snapshot = game.snapshot;
  const quote = snapshot?.quotes.find(q => q.symbol === game.selectedSymbol) ?? snapshot?.quotes[0];
  const selectStock = (symbol: string) => { setPriceSelection(null); game.selectStock(symbol); };
  const selectPrice = (value: number) => { if (quote) setPriceSelection({ symbol: quote.symbol, sessionRevision: game.sessionRevision, price: value, key: Date.now() }); };
  const selectPosition = (symbol: string, side: Side) => { const selected = snapshot?.quotes.find(q => q.symbol === symbol); game.selectStock(symbol); if (selected) setPriceSelection({ symbol, sessionRevision: game.sessionRevision, price: selected.bids[0]?.price ?? selected.last, side, key: Date.now() }); document.getElementById('order-price')?.focus(); };
  if (!snapshot || !quote) return <div className="terminal loading-terminal"><div className="loading-brand"><span className="brand-mark">海</span><span>股海证券 <small>STOCKSIM TERMINAL</small></span></div><div className="loading-state"><Activity size={20} /><p>{game.initError || '正在建立模拟市场与历史行情…'}</p><span>原创虚构市场 · 初始资金 ¥5,000.00</span>{game.initError && <button onClick={() => game.setSettingsOpen(true)}>打开设置与存档</button>}</div><SettingsDialog /></div>;
  const { clock, index, account } = snapshot;
  const changed = quote.change;
  const metrics = [
    { label: '今开', value: price(quote.open), color: direction(quote.open - quote.prevClose) },
    { label: '最高', value: price(quote.high), color: direction(quote.high - quote.prevClose) },
    { label: '最低', value: price(quote.low), color: direction(quote.low - quote.prevClose) },
    { label: '成交量', value: `${volume(quote.volume)} 手`, color: 'yellow' },
    { label: '成交额', value: compactNumber(quote.turnover / 100), color: 'cyan' },
  ];
  return <div className="terminal">
    <header className="terminal-header">
      <div className="topbar"><div className="brand"><span className="brand-mark">海</span><div><div className="brand-name">股海证券</div><div className="brand-en">STOCKSIM TERMINAL</div></div></div><nav className="main-nav" aria-label="主导航"><button className="active" onClick={() => { setWatchOnly(false); setAccountTab('positions'); }}>行情交易</button><button onClick={() => { setWatchOnly(true); }}>自选股</button><button onClick={() => setAccountTab('news')}>资讯中心</button><button onClick={() => setAccountTab('trades')}>交割查询</button></nav><div className="topbar-right"><span className="simulation-label">模拟市场</span><span className="muted mono" style={{ fontSize: 10 }}>账户 8888 0001</span><button className="icon-button" onClick={() => game.setSettingsOpen(true)} aria-label="设置与存档" title="设置、交易规则与存档"><Settings2 size={15} /></button></div></div>
      <div className="toolbar"><div className="toolbar-links"><button className={`toolbar-button ${!watchOnly ? 'active' : ''}`} onClick={() => setWatchOnly(false)}><BarChart3 size={12} />沪深 A 股</button><button className={`toolbar-button ${watchOnly ? 'active' : ''}`} onClick={() => setWatchOnly(true)}><Star size={12} />自选 F6</button><div className="toolbar-divider" /><button className="toolbar-button" onClick={() => setAccountTab('orders')}><Database size={12} />委托查询</button><button className="toolbar-button" onClick={() => game.setSettingsOpen(true, 'rules')}><CircleHelp size={12} />交易规则</button></div><div className="clock-control"><span className="market-clock"><span className="clock-date">{clock.date}　</span>{clock.time}</span><span className="market-phase"><span className="live-dot" />{clock.phaseLabel}</span>{clock.phase === 'lunch' ? <button className="play-button" onClick={game.skipLunch}><SkipForward size={11} />午后开盘</button> : <button className="play-button" disabled={clock.phase === 'closed'} onClick={game.toggleRunning} title="空格键暂停或继续">{game.running ? <Pause size={11} /> : <Play size={11} />}{game.running ? '暂停' : '继续'}</button>}<div className="speed-selector" aria-label="模拟速度">{[1, 4, 16, 64].map(speed => <button key={speed} className={game.speed === speed ? 'active' : ''} onClick={() => game.setSpeed(speed)} title={`${speed} 倍模拟速度`}>{speed}×</button>)}</div><button className="next-day-button" onClick={game.nextDay} title="先模拟完当前交易日，再进入下一交易日。剩余委托可能成交。">下一交易日<ChevronRight size={12} /></button></div></div>
    </header>
    <div className="index-strip"><div className="index-item"><span className="index-name">{index.name}</span><strong className={`index-value ${direction(index.changePct)}`}>{index.value.toFixed(2)}</strong><span className={`index-change ${direction(index.changePct)}`}>{pct(index.changePct)}</span></div><div className="index-item"><span className="index-name">成交额</span><span className="index-value yellow">{compactNumber(index.turnover / 100)}</span><span className="index-change muted">元</span></div><div className="index-item"><span className="index-name">模拟交易日</span><span className="index-value" style={{ color: '#c5cbd6' }}>{String(clock.dayIndex + 1).padStart(2, '0')}</span><span className="index-change muted">DAY</span></div><div className="market-breadth"><span>涨 <span className="up mono">{index.advancing}</span></span><div className="breadth-bar"><i style={{ width: `${index.advancing / Math.max(1, snapshot.quotes.length) * 100}%` }} /></div><span>跌 <span className="down mono">{index.declining}</span></span><span>平 <span className="mono">{index.unchanged}</span></span><Activity size={13} /></div></div>
    <main className="workspace"><QuotesTable quotes={snapshot.quotes} selectedSymbol={quote.symbol} watchlist={game.watchlist} onSelect={selectStock} onToggleWatchlist={game.toggleWatchlist} watchOnly={watchOnly} onWatchOnlyChange={setWatchOnly} />
      <section className="chart-pane" aria-label="个股走势"><div className="stock-summary"><div className="stock-primary"><div className="stock-identity"><span className="stock-title">{quote.name}</span><span className="stock-id">{quote.symbol}</span><span className="stock-sector">{quote.sector}</span></div><button className={`star-button ${game.watchlist.includes(quote.symbol) ? 'on' : ''}`} title="加入 / 移除自选" aria-label="切换当前股票自选" onClick={() => game.toggleWatchlist(quote.symbol)}><Star size={13} fill={game.watchlist.includes(quote.symbol) ? 'currentColor' : 'none'} /></button><div className={`stock-price-group ${direction(changed)}`}><span className="stock-last">{price(quote.last)}</span><span className="stock-change">{changed > 0 ? '+' : ''}{price(changed)}　{pct(quote.changePct)}</span></div></div><div className="stock-metrics">{metrics.map(metric => <div className="stock-metric" key={metric.label}><label>{metric.label}</label><span className={metric.color}>{metric.value}</span></div>)}</div></div>
      <div className="chart-toolbar"><button className={`chart-period ${game.chartMode === 'intraday' ? 'active' : ''}`} onClick={() => game.setChartMode('intraday')}>分时</button><button className={`chart-period ${game.chartMode === 'daily' ? 'active' : ''}`} onClick={() => game.setChartMode('daily')}>日 K</button><div className="toolbar-divider" /><span className="muted" style={{ fontSize: 10 }}>F5 切换</span><div className="chart-tool-label"><CandlestickChart size={11} /><span>{game.chartMode === 'daily' ? 'MA 5 / 10 / 20' : '价格 / 均价'}</span><span>│</span><Gauge size={11} /><span>滚轮缩放</span></div></div>
      <div className="chart-host"><MarketChart quote={quote} mode={game.chartMode} /></div><div className="chart-caption"><span>沪市主板 · 人民币</span><span>红涨绿跌</span><span className="caption-right">原创虚构行情 · 非真实证券价格</span></div></section>
      <aside className="trade-pane" aria-label="盘口与交易"><div className="section-heading"><div className="section-heading-left"><Radio size={12} /><span>盘口 · 快速交易</span></div><small>LEVEL 1</small></div><OrderBook quote={quote} onPrice={selectPrice} /><OrderPanel key={`${game.sessionRevision}:${quote.symbol}`} sessionRevision={game.sessionRevision} quote={quote} account={account} selection={priceSelection} revision={clock.timestamp} onSubmit={game.submitOrder} onPreview={game.previewOrder} /><div className="tape-heading"><span>逐笔成交</span><span>单位：手</span></div><table className="tape-table"><thead><tr><th>时间</th><th>成交价</th><th>现量</th><th>性质</th></tr></thead><tbody>{quote.recentTrades.slice(0, 5).map(trade => <tr key={trade.id}><td>{new Date(trade.time).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</td><td className={direction(trade.price - quote.prevClose)}>{price(trade.price)}</td><td className="yellow">{volume(trade.quantity)}</td><td className={trade.side === 'buy' ? 'up' : 'down'}>{trade.side === 'buy' ? 'B' : 'S'}</td></tr>)}</tbody></table></aside>
    </main>
    <AccountPanel snapshot={snapshot} onSelect={selectStock} onTradePosition={selectPosition} onCancel={game.cancelOrder} activeTab={accountTab} onTabChange={setAccountTab} />
    <footer className="statusbar"><span className="status-left"><span className="live-dot" />本地模拟引擎已连接</span><span>{game.running ? `${game.speed}× 行情推演中` : '行情已暂停'}</span><span className="status-message">{game.notice?.text ?? `${clock.phaseLabel} · 沪市主板普通股 · T+1`}</span><span className="status-spacer" /><span className="status-hint"><kbd>Space</kbd>暂停 <kbd>F5</kbd>图表 <kbd>F12</kbd>交易</span><span className="save-state"><Save size={10} />{game.saveError ? '存档失败' : game.lastSaved ? '已自动存档' : '等待存档'}</span></footer>
    <SettingsDialog />{game.notice && <div className={`toast ${game.notice.tone === 'error' ? 'error' : ''}`} role="status" onClick={game.clearNotice}>{game.notice.text}</div>}
  </div>;
}
