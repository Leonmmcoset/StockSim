import { useState } from 'react';
import { BellRing, ChartNoAxesCombined, ClipboardList, FileClock, ListOrdered, Wallet, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import type { CommandResult, MarketSnapshot, NewsItem, Side } from '../engine/types';
import { direction, money, pct, price } from '../lib/format';

type Tab = 'positions' | 'orders' | 'trades' | 'news' | 'review';
interface AccountPanelProps {
  snapshot: MarketSnapshot;
  onSelect: (symbol: string) => void;
  onTradePosition: (symbol: string, side: Side) => void;
  onCancel: (id: string) => Promise<CommandResult>;
  disabled: boolean;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onOpenCompany?: (symbol: string, reportId?: string) => void;
}
const statuses = { open: '已报', partial: '部分成交', filled: '已成交', cancelled: '已撤单', expired: '已过期' };
const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
const fullDateTime = (timestamp: number) => new Date(timestamp).toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
const dateTime = (timestamp: number) => fullDateTime(timestamp).slice(5);

export function AccountPanel({ snapshot, onSelect, onTradePosition, onCancel, disabled, activeTab, onTabChange, onOpenCompany }: AccountPanelProps) {
  const { account, quotes, orders, trades, news, clock } = snapshot;
  const [openedNews, setOpenedNews] = useState<NewsItem | null>(null);
  const [openedExternalId, setOpenedExternalId] = useState<string | null>(null);
  const categories = { policy: '政策', disaster: '灾害', 'supply-chain': '供应链', technology: '技术' } as const;
  const scopes = { market: '全市场', sector: '行业', company: '公司' } as const;
  const findQuote = (symbol: string) => quotes.find(q => q.symbol === symbol);
  const todayOrders = orders.filter(order => new Date(order.createdAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) === clock.date);
  const openOrders = todayOrders.filter(o => o.status === 'open' || o.status === 'partial');
  const tabs = [
    { key: 'positions' as const, label: '资金持仓', icon: Wallet, count: account.positions.length },
    { key: 'orders' as const, label: '当日委托', icon: ClipboardList, count: openOrders.length },
    { key: 'trades' as const, label: '成交记录', icon: FileClock, count: trades.length },
    { key: 'news' as const, label: '市场快讯', icon: BellRing, count: news.length },
    { key: 'review' as const, label: '投资复盘', icon: ChartNoAxesCombined, count: snapshot.review.days.length },
  ];
  return <section className={`account-panel ${activeTab === 'review' ? 'review-open' : ''}`} aria-label="账户与交易记录">
    <div className="account-tabs-row"><div className="account-tabs">{tabs.map(tab => <button key={tab.key} className={activeTab === tab.key ? 'active' : ''} onClick={() => onTabChange(tab.key)}><tab.icon size={12} />{tab.label}<span className="tab-count">{tab.count}</span></button>)}</div><div className="account-actions"><span className="live-dot" />模拟账户 · 人民币</div></div>
    <div className="account-overview">
      <div className="asset-item"><label>总资产 / 元</label><strong>{money(account.equity)}</strong></div>
      <div className="asset-item"><label>可用资金</label><strong>{money(account.availableCash)}</strong></div>
      <div className="asset-item"><label>股票市值</label><strong>{money(account.marketValue)}</strong></div>
      <div className="asset-item"><label>累计盈亏</label><strong className={direction(account.totalPnl)}>{account.totalPnl > 0 ? '+' : ''}{money(account.totalPnl)}</strong></div>
      <div className="asset-item"><label>收益率</label><strong className={direction(account.totalPnlPct)}>{pct(account.totalPnlPct)}</strong></div>
      <div className="asset-item small"><label>冻结资金</label><strong>{money(account.frozenCash)}</strong></div>
      <div className="initial-capital"><Wallet size={12} />初始资金 <span className="mono">¥{money(account.initialCash)}</span></div>
    </div>
    <div className="account-content" hidden={activeTab === 'review'}>
      {activeTab === 'positions' && (account.positions.length ? <table className="account-table"><thead><tr><th>证券代码</th><th>证券名称</th><th>持仓 / 可卖</th><th>成本价</th><th>现价</th><th>最新市值</th><th>浮动盈亏</th><th>盈亏比例</th><th>操作</th></tr></thead><tbody>{account.positions.map(position => <tr key={position.symbol} onClick={() => onSelect(position.symbol)}><td className="code-cell">{position.symbol}</td><td className="name-cell">{findQuote(position.symbol)?.name}</td><td>{position.quantity} / <span className={position.sellable ? 'yellow' : 'muted'}>{position.sellable}</span></td><td>{price(position.averageCost)}</td><td className={direction(findQuote(position.symbol)?.change ?? 0)}>{price(findQuote(position.symbol)?.last ?? 0)}</td><td>{money(position.marketValue)}</td><td className={direction(position.pnl)}>{position.pnl > 0 ? '+' : ''}{money(position.pnl)}</td><td className={direction(position.pnlPct)}>{pct(position.pnlPct)}</td><td><button className="text-action" onClick={e => { e.stopPropagation(); onTradePosition(position.symbol, 'sell'); }} title={position.sellable ? '卖出该持仓' : '当日买入股份次日可卖'}>卖出</button></td></tr>)}</tbody></table> : <EmptyState icon="wallet" title="暂无持仓，等待你的第一笔交易" detail="选择左侧证券，在右侧买入下单 · 当日买入的股票，下一交易日可卖" />)}
      {activeTab === 'orders' && (todayOrders.length ? <table className="account-table"><thead><tr><th>委托时间</th><th>证券代码</th><th>证券名称</th><th>方向</th><th>委托价格</th><th>委托数量</th><th>已成 / 未成</th><th>状态</th><th>操作</th></tr></thead><tbody>{todayOrders.map(order => <tr key={order.id} onClick={() => onSelect(order.symbol)}><td>{time(order.createdAt)}</td><td className="code-cell">{order.symbol}</td><td className="name-cell">{findQuote(order.symbol)?.name}</td><td className={order.side === 'buy' ? 'up' : 'down'}>{order.side === 'buy' ? '买入' : '卖出'}</td><td>{price(order.price)}</td><td>{order.quantity}</td><td>{order.filled} / {order.remaining}</td><td className="order-state">{statuses[order.status]}</td><td>{['open', 'partial'].includes(order.status) ? <button disabled={disabled} className="text-action" onClick={e => { e.stopPropagation(); void onCancel(order.id); }}>撤单</button> : <span className="muted">—</span>}</td></tr>)}</tbody></table> : <EmptyState title="今日暂无委托" detail="提交的买卖委托将显示在这里，可撤回尚未成交的部分" />)}
      {activeTab === 'trades' && (trades.length ? <table className="account-table"><thead><tr><th>成交时间</th><th>证券代码</th><th>证券名称</th><th>方向</th><th>成交价格</th><th>成交数量</th><th>成交金额</th><th>交易费用</th><th>委托编号</th></tr></thead><tbody>{trades.map(trade => <tr key={trade.id} onClick={() => onSelect(trade.symbol)}><td>{dateTime(trade.time)}</td><td className="code-cell">{trade.symbol}</td><td className="name-cell">{findQuote(trade.symbol)?.name}</td><td className={trade.side === 'buy' ? 'up' : 'down'}>{trade.side === 'buy' ? '买入' : '卖出'}</td><td>{price(trade.price)}</td><td>{trade.quantity}</td><td>{money(trade.amount)}</td><td>{money(trade.fee)}</td><td className="muted">{trade.orderId}</td></tr>)}</tbody></table> : <EmptyState title="暂无成交记录" detail="委托撮合成交后，将在这里记录成交价格、数量与费用" />)}
      {activeTab === 'news' && (news.length ? <div className="news-list">{news.map(item => item.kind === 'external' ? <div key={item.id} className="external-news-item">
        <button className="news-item" aria-expanded={openedExternalId === item.id} onClick={() => setOpenedExternalId(openedExternalId === item.id ? null : item.id)}><span className="news-time">{dateTime(item.time)}</span><span className="news-tag external-news-tag">外部事件</span><span className="news-title">{item.headline}</span><span className="news-symbol">{scopes[item.scope]}</span></button>
        {openedExternalId === item.id && <div className="external-news-detail" aria-label="外部事件详情"><div><strong>外部事件</strong><span>发生于 {fullDateTime(item.time)}（游戏时间）</span><span>范围：{scopes[item.scope]}</span>{item.event && <><span>类别：{categories[item.event.category]}</span><span>级别：{item.event.severity === 'extreme' ? '极端' : '重大'}</span></>}<button onClick={() => setOpenedExternalId(null)}>收起</button></div><p>{item.body}</p>{item.symbols.length > 0 && <div className="external-news-symbols"><span>相关证券：</span>{item.symbols.map(symbol => <button key={symbol} onClick={() => onSelect(symbol)}>{findQuote(symbol)?.name ?? symbol}</button>)}</div>}</div>}
      </div> : <button key={item.id} className="news-item" onClick={() => { setOpenedNews(item); if (item.symbols[0]) onSelect(item.symbols[0]); }}><span className="news-time">{dateTime(item.time)}</span><span className={`news-tag ${item.impact === 'positive' ? 'up' : item.impact === 'negative' ? 'down' : ''}`}>{item.kind === 'earnings' ? '财报公告' : item.scope === 'market' ? '市场动态' : item.scope === 'sector' ? '行业消息' : '公司公告'}</span><span className="news-title">{item.headline}</span><span className="news-symbol">{item.symbols.length === 1 ? findQuote(item.symbols[0])?.name : item.symbols.length ? `${item.symbols.length} 只相关证券` : '全市场'}</span></button>)}</div> : <EmptyState title="等待市场消息" detail="新闻将在模拟市场演化时陆续发布，并影响相关行业和公司的走势" />)}
    </div>
    <Dialog.Root open={!!openedNews} onOpenChange={open => !open && setOpenedNews(null)}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content news-dialog"><Dialog.Title>{openedNews?.headline}</Dialog.Title><Dialog.Description className="muted">模拟市场快讯 · {openedNews && dateTime(openedNews.time)} · 所有公司与新闻均为虚构</Dialog.Description><p>{openedNews?.body}</p>{openedNews?.kind === 'earnings' && openedNews.symbols[0] && onOpenCompany && <button onClick={() => { onOpenCompany(openedNews.symbols[0], openedNews.reportId); setOpenedNews(null); }}>查看财报 F10</button>}{openedNews?.symbols.map(symbol => <button key={symbol} onClick={() => { onSelect(symbol); setOpenedNews(null); }}>查看 {findQuote(symbol)?.name ?? symbol}</button>)}<Dialog.Close className="dialog-close" aria-label="关闭新闻"><X size={15} /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}

function EmptyState({ icon, title, detail }: { icon?: 'wallet'; title: string; detail: string }) {
  return <div className="empty-state"><div className="empty-state-icon">{icon === 'wallet' ? <Wallet size={16} /> : <ListOrdered size={16} />}</div><div><strong>{title}</strong><p>{detail}</p></div></div>;
}
