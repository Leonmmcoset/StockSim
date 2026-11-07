import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronUp, Info, Minus, Plus, ShieldCheck } from 'lucide-react';
import type { Account, CommandResult, OrderInput, OrderPreview, Quote, Side } from '../engine/types';
import { direction, money, price, volume } from '../lib/format';

export interface PriceSelection { symbol: string; sessionRevision: number; price: number; side?: Side; key: number }
interface OrderPanelProps {
  quote: Quote;
  account: Account;
  selection: PriceSelection | null;
  sessionRevision: number;
  revision: number;
  onSubmit: (input: OrderInput) => CommandResult;
  onPreview: (input: OrderInput) => OrderPreview;
}

export function OrderPanel({ quote, account, selection, sessionRevision, revision, onSubmit, onPreview }: OrderPanelProps) {
  const [side, setSide] = useState<Side>('buy');
  const [priceText, setPriceText] = useState(price(quote.last));
  const [quantityText, setQuantityText] = useState('100');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setPriceText(price(quote.last)); setFeedback(null); }, [quote.symbol]);
  useEffect(() => { if (selection?.symbol === quote.symbol && selection.sessionRevision === sessionRevision) { setPriceText(price(selection.price)); if (selection.side) setSide(selection.side); setFeedback(null); } }, [selection, quote.symbol, sessionRevision]);
  const orderPrice = Math.round(Number(priceText) * 100);
  const quantity = Number(quantityText);
  const input: OrderInput = { symbol: quote.symbol, side, price: Number.isFinite(orderPrice) ? orderPrice : 0, quantity: Number.isFinite(quantity) ? quantity : 0 };
  const preview = useMemo(() => onPreview(input), [quote.symbol, side, orderPrice, quantity, revision, account, onPreview]);
  const maxQuantity = side === 'buy' ? preview.maxBuyQuantity : preview.maxSellQuantity;
  const adjustPrice = (delta: number) => setPriceText(price(Math.max(1, (Number.isFinite(orderPrice) ? orderPrice : quote.last) + delta)));
  const adjustQuantity = (delta: number) => setQuantityText(String(Math.max(0, (Number.isFinite(quantity) ? quantity : 0) + delta)));
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const result = onSubmit(input);
    setFeedback({ ok: result.ok, text: result.ok ? `委托已提交 · ${result.order?.id ?? ''}${result.order?.status === 'filled' ? ' · 已成交' : ''}` : result.error || '委托未成功，请检查价格和数量' });
  };
  return <section className="order-panel" aria-label="委托交易">
    <div className="order-tabs"><button className={side === 'buy' ? 'buy-active' : ''} onClick={() => { setSide('buy'); setFeedback(null); }}><ArrowDownLeft size={12} /> 买入</button><button className={side === 'sell' ? 'sell-active' : ''} onClick={() => { setSide('sell'); setFeedback(null); }}><ArrowUpRight size={12} /> 卖出</button></div>
    <form className="order-form" onSubmit={handleSubmit}>
      <div className="order-stock"><span>{quote.name}</span><span className="order-stock-code">{quote.symbol}</span><span className="limit-tag">限价委托</span></div>
      <div className="order-field"><label htmlFor="order-price">委托价格</label><div className="stepper-input"><button type="button" onClick={() => adjustPrice(-1)} aria-label="价格减少一分"><Minus size={11} /></button><input id="order-price" type="number" min="0.01" step="0.01" value={priceText} onChange={e => setPriceText(e.target.value)} /><button type="button" onClick={() => adjustPrice(1)} aria-label="价格增加一分"><Plus size={11} /></button></div></div>
      <div className="order-field"><label htmlFor="order-quantity">委托数量</label><div className="stepper-input"><button type="button" onClick={() => adjustQuantity(-100)} aria-label="数量减少一手"><Minus size={11} /></button><input id="order-quantity" type="number" min="0" step="100" value={quantityText} onChange={e => setQuantityText(e.target.value)} /><button type="button" onClick={() => adjustQuantity(100)} aria-label="数量增加一手"><Plus size={11} /></button></div></div>
      <div className="quantity-shortcuts">{[.25, .5, 1].map(ratio => <button key={ratio} type="button" onClick={() => setQuantityText(String(Math.floor(maxQuantity * ratio / 100) * 100))}>{ratio === 1 ? '全仓' : ratio === .5 ? '1/2' : '1/4'}</button>)}</div>
      <div className="order-availability"><span>{side === 'buy' ? '可用资金' : '可卖数量'} <strong>{side === 'buy' ? money(account.availableCash) : `${maxQuantity} 股`}</strong></span><span>{side === 'buy' ? `可买 ${maxQuantity} 股` : 'T+1 可卖'}</span></div>
      <div className="order-estimate"><span>委托金额 <span className="mono">{money(preview.amount)}</span></span><span title={`佣金 ${money(preview.fees.commission)} · 过户费 ${money(preview.fees.transfer)} · 印花税 ${money(preview.fees.stamp)}`}>预计费用 <span className="mono">{money(preview.fees.total)}</span></span></div>
      <button type="submit" className={`order-submit ${side === 'sell' ? 'sell-submit' : ''}`}>{side === 'buy' ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{side === 'buy' ? '买入下单' : '卖出下单'}</button>
      {feedback && <div role="status" className={`order-feedback ${feedback.ok ? '' : 'error'}`}>{feedback.text}</div>}
      <div className="order-note"><Info size={10} /><span>100 股起买 · 当日买入次日可卖<br />涨停 {price(quote.limitUp)} / 跌停 {price(quote.limitDown)} · 含交易费用</span></div>
    </form>
  </section>;
}

export function OrderBook({ quote, onPrice }: { quote: Quote; onPrice: (value: number) => void }) {
  const maxDepth = Math.max(1, ...quote.bids.map(l => l.quantity), ...quote.asks.map(l => l.quantity));
  return <div className="orderbook"><div className="book-header"><span>五档盘口</span><span>价格 / 元</span><span>委托量 / 手</span></div>
    {[4, 3, 2, 1, 0].map(index => { const level = quote.asks[index]; return <button key={`ask-${index}`} className="book-row sell" disabled={!level} onClick={() => level && onPrice(level.price)} title={level ? `以卖${index + 1}价 ${price(level.price)} 填入委托` : '暂无委托'}><i className="book-depth" style={{ width: `${(level?.quantity ?? 0) / maxDepth * 80}%` }} /><label>卖{['一', '二', '三', '四', '五'][index]}</label><span className={level ? direction(level.price - quote.prevClose) : 'muted'}>{level ? price(level.price) : '—'}</span><span className="book-volume">{level ? volume(level.quantity) : '—'}</span></button>; })}
    <div className="book-middle"><span>最新 <strong className={direction(quote.change)}>{price(quote.last)}</strong></span><span>均价 <span className="yellow mono">{price(quote.vwap)}</span></span></div>
    {[0, 1, 2, 3, 4].map(index => { const level = quote.bids[index]; return <button key={`bid-${index}`} className="book-row buy" disabled={!level} onClick={() => level && onPrice(level.price)} title={level ? `以买${index + 1}价 ${price(level.price)} 填入委托` : '暂无委托'}><i className="book-depth" style={{ width: `${(level?.quantity ?? 0) / maxDepth * 80}%` }} /><label>买{['一', '二', '三', '四', '五'][index]}</label><span className={level ? direction(level.price - quote.prevClose) : 'muted'}>{level ? price(level.price) : '—'}</span><span className="book-volume">{level ? volume(level.quantity) : '—'}</span></button>; })}
    <div className="book-footer"><span>点击盘口价 → 填入委托</span><ShieldCheck size={11} /></div>
  </div>;
}
