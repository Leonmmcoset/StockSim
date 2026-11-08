import { useEffect, useState } from 'react';
import { Activity, BarChart3, CandlestickChart, ChevronRight, CircleHelp, Database, Gauge, Pause, Play, Radio, Save, Settings2, SkipForward, Star } from 'lucide-react';
import { startGameLoop, useGameStore } from './store/game';
import { QuotesTable } from './components/QuotesTable';
import { OrderBook, OrderPanel, type PriceSelection } from './components/OrderPanel';
import { AccountPanel } from './components/AccountPanel';
import MarketChart from './components/MarketChart';
import CompanyFundamentals from './components/CompanyFundamentals';
import InvestmentReview from './components/InvestmentReview';
import SettingsDialog from './components/SettingsDialog';
import { compactNumber, direction, pct, price, volume } from './lib/format';
import type { Side } from './engine/types';
import AuthPanel from './components/AuthPanel';

export default function App() {
  const game = useGameStore();
  const [watchOnly, setWatchOnly] = useState(false);
  const [showCompany, setShowCompany] = useState(false);
  const [companyOpenRevision, setCompanyOpenRevision] = useState(0);
  const [selectedReportId, setSelectedReportId] = useState<string | undefined>();
  const [accountTab, setAccountTab] = useState<'positions' | 'orders' | 'trades' | 'news' | 'review'>('positions');
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
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || document.querySelector('[role=dialog][data-state=open]')) return;
      if (event.key === 'Escape') { if (accountTab === 'review') setAccountTab('positions'); else setShowCompany(false); }
      if (event.key === 'F10') { event.preventDefault(); setAccountTab(tab => tab === 'review' ? 'positions' : tab); setShowCompany(value => !value); setSelectedReportId(undefined); }
      if (event.key === 'F5') { event.preventDefault(); setAccountTab(tab => tab === 'review' ? 'positions' : tab); setShowCompany(false); game.setChartMode(game.chartMode === 'daily' ? 'intraday' : 'daily'); }
      if (event.key === 'F6') { event.preventDefault(); setAccountTab(tab => tab === 'review' ? 'positions' : tab); setWatchOnly(value => !value); }
      if (event.key === '/' && accountTab === 'review') { event.preventDefault(); setAccountTab('positions'); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[aria-label="搜索股票"]')?.focus()); }
      if (event.key === 'F12') { event.preventDefault(); setAccountTab(tab => tab === 'review' ? 'positions' : tab); requestAnimationFrame(() => document.getElementById('order-price')?.focus()); }

    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [game.chartMode, game.settingsOpen, accountTab]);
  const snapshot = game.snapshot;
  const quote = snapshot?.quotes.find(q => q.symbol === game.selectedSymbol) ?? snapshot?.quotes[0];
  const company = snapshot?.companies?.find(item => item.symbol === quote?.symbol);
  const selectStock = (symbol: string) => { setPriceSelection(null); game.selectStock(symbol); };
  const showQuotes = (onlyWatchlist: boolean) => { setWatchOnly(onlyWatchlist); setAccountTab(tab => tab === 'review' ? 'positions' : tab); };
  const openCompany = (symbol: string, reportId?: string) => { selectStock(symbol); setAccountTab(tab => tab === 'review' ? 'positions' : tab); setSelectedReportId(reportId); setCompanyOpenRevision(value => value + 1); setShowCompany(true); };
  const selectPrice = (value: number) => { if (quote) setPriceSelection({ symbol: quote.symbol, sessionRevision: game.sessionRevision, price: value, key: Date.now() }); };
  const selectPosition = (symbol: string, side: Side) => { const selected = snapshot?.quotes.find(q => q.symbol === symbol); game.selectStock(symbol); if (selected) setPriceSelection({ symbol, sessionRevision: game.sessionRevision, price: selected.bids[0]?.price ?? selected.last, side, key: Date.now() }); document.getElementById('order-price')?.focus(); };
  if (!game.user || !snapshot || !quote) return <AuthPanel />;
  const { clock, index, account } = snapshot;
  const changed = quote.change;
  const metrics = [
    { label: '今开', value: price(quote.open), color: direction(quote.open - quote.prevClose) },
    { label: '最高', value: price(quote.high), color: direction(quote.high - quote.prevClose) },
    { label: '最低', value: price(quote.low), color: direction(quote.low - quote.prevClose) },
    { label: '成交量', value: `${volume(quote.volume)} 手`, color: 'yellow' },
    { label: '成交额', value: compactNumber(quote.turnover / 100), color: 'cyan' },
  ];
  return <div className={`terminal ${accountTab === 'review' ? 'review-active' : ''}`}>
    <header className="terminal-header">
      <div className="topbar"><div className="brand"><span className="brand-mark">海</span><div><div className="brand-name">股海证券</div><div className="brand-en">STOCKSIM TERMINAL</div></div></div><nav className="main-nav" aria-label="主导航"><button className="active" onClick={() => { setWatchOnly(false); setAccountTab('positions'); }}>行情交易</button><button onClick={() => showQuotes(true)}>自选股</button><button onClick={() => setAccountTab('news')}>资讯中心</button><button onClick={() => setAccountTab('trades')}>交割查询</button></nav><div className="topbar-right"><span className="simulation-label">模拟市场</span><span className="muted mono" style={{ fontSize: 10 }}>账户 {game.user.username} · {game.user.role === 'admin' ? '管理员' : '玩家'}</span><button onClick={() => void game.logout()}>退出</button><button className="icon-button" onClick={() => game.setSettingsOpen(true)} aria-label="设置与存档" title="设置、交易规则与存档"><Settings2 size={15} /></button></div></div>
      <div className="toolbar"><div className="toolbar-links"><button className={`toolbar-button ${!watchOnly ? 'active' : ''}`} onClick={() => showQuotes(false)}><BarChart3 size={12} />沪深 A 股</button><button className={`toolbar-button ${watchOnly ? 'active' : ''}`} onClick={() => showQuotes(true)}><Star size={12} />自选 F6</button><div className="toolbar-divider" /><button className="toolbar-button" onClick={() => setAccountTab('orders')}><Database size={12} />委托查询</button><button className="toolbar-button" onClick={() => game.setSettingsOpen(true, 'rules')}><CircleHelp size={12} />交易规则</button></div><div className="clock-control"><span className="market-clock"><span className="clock-date">{clock.date}　</span>{clock.time}</span><span className="market-phase"><span className="live-dot" />{clock.phaseLabel}</span>{game.user.role === 'admin' ? <div className="admin-controls"><button disabled={game.marketPending || game.connection !== 'online'} className="play-button" onClick={() => void game.marketAction(game.market?.running ? 'pause' : 'resume')}>{game.market?.running ? <Pause size={11}/> : <Play size={11}/>} {game.market?.running ? '暂停' : '继续'}</button><div className="speed-selector" aria-label="模拟速度">{[1,4,16,64].map(speed => <button disabled={game.marketPending || game.connection !== 'online'} key={speed} className={game.market?.speed === speed ? 'active' : ''} onClick={() => void game.marketAction('speed', speed)}>{speed}×</button>)}</div><button disabled={game.marketPending || game.connection !== 'online'} className="next-day-button" onClick={() => void game.marketAction('skipLunch')}><SkipForward size={11}/>跳过午休</button><button disabled={game.marketPending || game.connection !== 'online'} className="next-day-button" onClick={() => void game.marketAction('nextDay')}>下一交易日<ChevronRight size={12}/></button></div> : <span>{game.market?.running ? '运行中' : '已暂停'} · {game.market?.speed}×</span>}</div></div>
    </header>
    <div className="index-strip"><div className="index-item"><span className="index-name">{index.name}</span><strong className={`index-value ${direction(index.changePct)}`}>{index.value.toFixed(2)}</strong><span className={`index-change ${direction(index.changePct)}`}>{pct(index.changePct)}</span></div><div className="index-item"><span className="index-name">成交额</span><span className="index-value yellow">{compactNumber(index.turnover / 100)}</span><span className="index-change muted">元</span></div><div className="index-item"><span className="index-name">模拟交易日</span><span className="index-value" style={{ color: '#c5cbd6' }}>{String(clock.dayIndex + 1).padStart(2, '0')}</span><span className="index-change muted">DAY</span></div><div className="market-breadth"><span>涨 <span className="up mono">{index.advancing}</span></span><div className="breadth-bar"><i style={{ width: `${index.advancing / Math.max(1, snapshot.quotes.length) * 100}%` }} /></div><span>跌 <span className="down mono">{index.declining}</span></span><span>平 <span className="mono">{index.unchanged}</span></span><Activity size={13} /></div></div>
    <main className={`workspace ${accountTab === 'review' ? 'workspace-review-hidden' : ''}`}><QuotesTable quotes={snapshot.quotes} selectedSymbol={quote.symbol} watchlist={game.watchlist} onSelect={selectStock} onToggleWatchlist={game.toggleWatchlist} watchOnly={watchOnly} onWatchOnlyChange={setWatchOnly} />
      <section className="chart-pane" aria-label="个股走势"><div className="stock-summary"><div className="stock-primary"><div className="stock-identity"><span className="stock-title">{quote.name}</span><span className="stock-id">{quote.symbol}</span><span className="stock-sector">{quote.sector}</span></div><button className={`star-button ${game.watchlist.includes(quote.symbol) ? 'on' : ''}`} title="加入 / 移除自选" aria-label="切换当前股票自选" onClick={() => game.toggleWatchlist(quote.symbol)}><Star size={13} fill={game.watchlist.includes(quote.symbol) ? 'currentColor' : 'none'} /></button><div className={`stock-price-group ${direction(changed)}`}><span className="stock-last">{price(quote.last)}</span><span className="stock-change">{changed > 0 ? '+' : ''}{price(changed)}　{pct(quote.changePct)}</span></div></div><div className="stock-metrics">{metrics.map(metric => <div className="stock-metric" key={metric.label}><label>{metric.label}</label><span className={metric.color}>{metric.value}</span></div>)}</div></div>
      <div className="chart-toolbar"><button className={`chart-period ${!showCompany && game.chartMode === 'intraday' ? 'active' : ''}`} onClick={() => { setShowCompany(false); game.setChartMode('intraday'); }}>分时</button><button className={`chart-period ${!showCompany && game.chartMode === 'daily' ? 'active' : ''}`} onClick={() => { setShowCompany(false); game.setChartMode('daily'); }}>日 K</button><button className={`chart-period ${showCompany ? 'active' : ''}`} aria-pressed={showCompany} onClick={() => { setSelectedReportId(undefined); setShowCompany(value => !value); }}>公司资料 F10</button><div className="toolbar-divider" /><span className="muted" style={{ fontSize: 10 }}>{showCompany ? 'F10 返回图表' : 'F5 切换'}</span><div className="chart-tool-label"><CandlestickChart size={11} /><span>{game.chartMode === 'daily' ? 'MA 5 / 10 / 20' : '价格 / 均价'}</span><span>│</span><Gauge size={11} /><span>滚轮缩放</span></div></div>
      <div className={`chart-host ${showCompany ? 'company-host' : ''}`}>{showCompany && company ? <CompanyFundamentals key={`${game.sessionRevision}:${companyOpenRevision}`} company={company} companies={snapshot.companies} quote={quote} clock={clock} onSelect={selectStock} onClose={() => setShowCompany(false)} initialTab={selectedReportId ? 'reports' : 'overview'} reportId={selectedReportId} /> : <MarketChart quote={quote} mode={game.chartMode} />}</div><div className="chart-caption"><span>沪市主板 · 人民币</span><span>红涨绿跌</span><span className="caption-right">原创虚构行情 · 非真实证券价格</span></div></section>
      <aside className="trade-pane" aria-label="盘口与交易"><div className="section-heading"><div className="section-heading-left"><Radio size={12} /><span>盘口 · 快速交易</span></div><small>LEVEL 1</small></div><OrderBook quote={quote} onPrice={selectPrice} /><OrderPanel key={`${game.sessionRevision}:${quote.symbol}`} sessionRevision={game.sessionRevision} quote={quote} account={account} selection={priceSelection} revision={clock.timestamp} onSubmit={game.submitOrder} onPreview={game.previewOrder} disabled={game.connection !== 'online' || game.commandPending || !!game.uncertainOrder} /><div className="tape-heading"><span>逐笔成交</span><span>单位：手</span></div><table className="tape-table"><thead><tr><th>时间</th><th>成交价</th><th>现量</th><th>性质</th></tr></thead><tbody>{quote.recentTrades.slice(0, 5).map(trade => <tr key={trade.id}><td>{new Date(trade.time).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</td><td className={direction(trade.price - quote.prevClose)}>{price(trade.price)}</td><td className="yellow">{volume(trade.quantity)}</td><td className={trade.side === 'buy' ? 'up' : 'down'}>{trade.side === 'buy' ? 'B' : 'S'}</td></tr>)}</tbody></table></aside>
    </main>
    {accountTab === 'review' && <main className="review-workspace"><InvestmentReview key={game.sessionRevision} review={snapshot.review} onClose={() => setAccountTab('positions')} /></main>}
    <AccountPanel snapshot={snapshot} onSelect={selectStock} onTradePosition={selectPosition} onCancel={game.cancelOrder} disabled={game.connection !== 'online' || game.commandPending || !!game.uncertainOrder} activeTab={accountTab} onTabChange={setAccountTab} onOpenCompany={openCompany} />
    <footer className="statusbar"><span className="status-left"><span className="live-dot" />{game.connection === 'online' ? '服务器已连接' : '连接中断 · 行情可能过期'}</span><span>{game.market?.running ? `${game.market.speed}× 行情推演中` : '行情已暂停'}</span><span className="status-message">{game.notice?.text ?? `${clock.phaseLabel} · 沪市主板普通股 · T+1`}</span><span className="status-spacer" /><span className="status-hint"><kbd>F5</kbd>图表 <kbd>F10</kbd>资料 <kbd>F12</kbd>交易</span><span className="save-state"><Save size={10} />{game.market?.savedAt ? '服务器已存档' : '等待服务器存档'}</span></footer>
    {game.uncertainOrder && <button className="toast error" onClick={() => void game.retryOrder()} disabled={game.commandPending || game.connection !== 'online'}>请求结果未知 · 使用原请求重试</button>}<SettingsDialog />{game.notice && <div className={`toast ${game.notice.tone === 'error' ? 'error' : ''}`} role="status" onClick={game.clearNotice}>{game.notice.text}</div>}
  </div>;
}
