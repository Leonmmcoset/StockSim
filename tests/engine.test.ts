import { describe, expect, it } from 'vitest';
import { createMarket, importMarket } from '../src/engine';

const make = () => createMarket({ seed: 'engine-tests', historyDays: 0 });

describe('market and accounting', () => {
  it('starts with 5000 yuan, twelve stocks and real two-sided liquidity', () => {
    const s = make().getSnapshot();
    expect(s.account.cash).toBe(500000);
    expect(s.account.equity).toBe(500000);
    expect(s.quotes).toHaveLength(12);
    expect(s.quotes.every(q => q.bids.length > 0 && q.asks.length > 0)).toBe(true);
    expect(s.quotes.every(q => q.bids[0].price < q.asks[0].price)).toBe(true);
  });
  it('produces exactly the same path with batch and individual steps', () => {
    const a = make(), b = make();
    a.step(20); for (let i = 0; i < 20; i++) b.step();
    expect(a.exportState()).toEqual(b.exportState());
    expect(a.getSnapshot().quotes.some(q => q.volume > 0)).toBe(true);
  });
  it('fills an executable limit order and locks its purchased shares until tomorrow', () => {
    const m = make(); const q = m.getSnapshot().quotes.find(q => q.asks[0]?.price < 1500)!;
    const r = m.placeOrder({ symbol: q.symbol, side: 'buy', price: q.asks[0].price, quantity: 100 });
    expect(r.ok).toBe(true); expect(r.order?.filled).toBe(100);
    const p = m.getSnapshot().account.positions[0];
    expect(p.quantity).toBe(100); expect(p.sellable).toBe(0); expect(p.todayBought).toBe(100);
    expect(m.placeOrder({symbol:q.symbol,side:'sell',price:q.bids[0].price,quantity:100}).ok).toBe(false);
    expect(m.getSnapshot().account.cash).toBe(500000 - 100 * r.order!.avgFillPrice - r.order!.fee);
    m.nextDay(); expect(m.getSnapshot().account.positions[0].sellable).toBe(100);
    const nq = m.getSnapshot().quotes.find(x => x.symbol === q.symbol)!;
    const sold = m.placeOrder({symbol:q.symbol,side:'sell',price:nq.bids[0].price,quantity:100});
    expect(sold.ok).toBe(true); expect(sold.order?.filled).toBe(100);
    expect(m.getSnapshot().account.positions).toHaveLength(0);
    expect(sold.order!.fee).toBeGreaterThan(500);
  });
  it('freezes pending buy funds, refunds cancel once and charges no unfilled commission', () => {
    const m = make(); const q = m.getSnapshot().quotes[0];
    const r = m.placeOrder({symbol:q.symbol,side:'buy',price:q.limitDown,quantity:100});
    expect(r.ok).toBe(true); expect(r.order?.filled).toBe(0);
    const a=m.getSnapshot().account; expect(a.frozenCash).toBeGreaterThan(0);
    expect(a.cash).toBe(a.availableCash+a.frozenCash);
    expect(m.cancelOrder(r.order!.id).ok).toBe(true);
    expect(m.cancelOrder(r.order!.id).ok).toBe(false);
    expect(m.getSnapshot().account.cash).toBe(500000);
    expect(m.getSnapshot().account.frozenCash).toBe(0);
  });
  it('rejects illegal lots, insufficient funds, price limit and price cage', () => {
    const m=make(); const q=m.getSnapshot().quotes[0];
    expect(m.placeOrder({symbol:q.symbol,side:'buy',price:q.last,quantity:99}).code).toBe('INVALID_QUANTITY');
    expect(m.placeOrder({symbol:q.symbol,side:'buy',price:q.last,quantity:1000000}).code).toBe('INSUFFICIENT_CASH');
    expect(m.placeOrder({symbol:q.symbol,side:'buy',price:q.limitUp+1,quantity:100}).code).toBe('OUTSIDE_LIMIT');
    expect(m.placeOrder({symbol:q.symbol,side:'buy',price:q.limitUp,quantity:100}).code).toBe('PRICE_CAGE');
  });
  it('restores all hidden state and rejects corrupt saves without affecting the original', () => {
    const m=make(); m.step(13); const restored=importMarket(m.exportState());
    m.step(17); restored.step(17); expect(restored.exportState()).toEqual(m.exportState());
    expect(() => importMarket({schemaVersion:1,data:{}})).toThrow();
    expect(() => importMarket({schemaVersion:99,data:{}})).toThrow();
  });
  it('provides sixty background days and integer, bounded candles', () => {
    const s=createMarket({seed:'history'}).getSnapshot();
    for(const q of s.quotes){
      expect(q.dailyBars.length).toBeGreaterThanOrEqual(61);
      expect(q.dailyBars.every(b=>Number.isInteger(b.close)&&b.high>=b.low&&b.volume>=0)).toBe(true);
      expect(q.last).toBeGreaterThanOrEqual(q.limitDown);expect(q.last).toBeLessThanOrEqual(q.limitUp);
    }
  });
  it('halts at lunch, skips to afternoon, closes and expires pending orders', () => {
    const m=make(); const q=m.getSnapshot().quotes[0];
    const r=m.placeOrder({symbol:q.symbol,side:'buy',price:q.limitDown,quantity:100});
    m.step(1000); expect(m.getSnapshot().clock.phase).toBe('lunch');
    const noon=m.exportState();m.step(10);expect(m.exportState()).toEqual(noon);
    m.skipLunch();expect(m.getSnapshot().clock.time).toBe('13:00:00');
    m.step(1000);expect(m.getSnapshot().clock.phase).toBe('closed');
    expect(m.getSnapshot().orders.find(o=>o.id===r.order!.id)?.status).toBe('expired');
    expect(m.getSnapshot().account.frozenCash).toBe(0);
  });
});

describe('market liquidity quality',()=>{
  it('maintains two-sided natural liquidity in at least 95% of ordinary snapshots',()=>{
    const m=createMarket({seed:'liquidity-quality',historyDays:0});let missing=0,total=0;
    for(let i=0;i<40;i++){m.step(10);m.skipLunch();for(const q of m.getSnapshot().quotes){total++;if(!q.bids.length||!q.asks.length)missing++;}}
    expect(missing/total).toBeLessThan(.05);
  });
});
it('reports index percentage from its own fixed-weight previous close',()=>{
 const m=createMarket({seed:'index-check'});m.step(100);const s=m.getSnapshot();
 const raw=m.exportState().data as import('../src/engine/internal').State;
 const previous=raw.stocks.reduce((n,q)=>n+q.prevClose/q.base,0)/12*1000;
 expect(s.index.changePct).toBeCloseTo((s.index.value/previous-1)*100,10);
});
