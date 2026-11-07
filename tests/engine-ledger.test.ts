import {expect,it} from 'vitest';
import {createMarket,importMarket} from '../src/engine';
import type {State,InternalOrder} from '../src/engine/internal';
import {fees} from '../src/engine/ledger';

/** A small valid exchange fixture: two resting asks, same accounts and
 * conservation totals as a seeded market. No mocked matching or ledger. */
function fixture(){
  const base=createMarket({seed:'ledger-fixture',historyDays:0});
  const saved=base.exportState(),s=saved.data as State,q=s.stocks[0];
  for(const id of [...q.bids,...q.asks]){
    const o=s.orders[id],w=s.wallets[o.owner];
    if(o.side==='buy')w.frozenCash-=o.reserve;else w.positions[q.symbol].frozen-=o.remaining;
    delete s.orders[id];
  }
  q.bids=[];q.asks=[];
  for(let i=0;i<2;i++){
    const owner=q.agents[8+i],seq=++s.seq,id=`O${seq}`,price=q.last+1;
    const o:InternalOrder={id,seq,owner,symbol:q.symbol,side:'sell',price,quantity:100,filled:0,remaining:100,status:'open',createdAt:Date.parse(s.date+'T09:35:00+08:00'),avgFillPrice:0,fee:0,notional:0,reserve:0,expires:s.tick+100};
    s.orders[id]=o;q.asks.push(id);s.wallets[owner].positions[q.symbol].frozen+=100;
  }
  return {market:importMarket(saved),symbol:q.symbol,price:q.last+1,first:q.asks[0],second:q.asks[1]};
}
it('aggregates partial-fill commission once and releases the unfilled fee reserve on cancel',()=>{
 const {market:m,symbol,price}=fixture();
 const r=m.placeOrder({symbol,side:'buy',price,quantity:300});
 expect(r.ok).toBe(true);expect(r.order?.filled).toBe(200);expect(r.order?.remaining).toBe(100);expect(r.order?.status).toBe('partial');
 const s=m.getSnapshot();expect(s.trades).toHaveLength(2);
 expect(s.trades.reduce((sum,t)=>sum+t.fee,0)).toBe(fees(price*200,'buy').total);
 expect(s.account.frozenCash).toBe(price*100+fees(price*300,'buy').total-fees(price*200,'buy').total);
 expect(m.cancelOrder(r.order!.id).ok).toBe(true);
 expect(m.getSnapshot().account.cash).toBe(500000-price*200-fees(price*200,'buy').total);
 expect(m.getSnapshot().account.frozenCash).toBe(0);
 expect(()=>importMarket(m.exportState())).not.toThrow();
});
it('honors equal-price FIFO by consuming the earlier resting order first',()=>{
 const {market:m,symbol,price,first,second}=fixture();
 const r=m.placeOrder({symbol,side:'buy',price,quantity:100});expect(r.order?.filled).toBe(100);
 const s=m.exportState().data as State;expect(s.orders[first]).toBeUndefined();expect(s.orders[second].remaining).toBe(100);
});
it('preserves money and stock across trades, cancel, settlement and reload',()=>{
 const {market:m,symbol,price}=fixture();m.placeOrder({symbol,side:'buy',price,quantity:300});m.nextDay();
 expect(()=>importMarket(m.exportState())).not.toThrow();
 const s=m.exportState().data as State;
 expect(s.wallets.reduce((a,w)=>a+w.cash,0)+s.feePool).toBe(s.totalCash);
 expect(s.wallets.reduce((a,w)=>a+(w.positions[symbol]?.quantity??0),0)).toBe(s.totalShares[symbol]);
});
it('does not change state when rejecting an order',()=>{
 const m=createMarket({seed:'reject',historyDays:0});const before=m.exportState(),q=m.getSnapshot().quotes[0];
 expect(m.placeOrder({symbol:q.symbol,side:'buy',price:q.last,quantity:1000000}).ok).toBe(false);
 expect(m.exportState()).toEqual(before);
});
it('rejects a save with forged but superficially balanced frozen cash',()=>{
 const {market:m,symbol,price}=fixture();m.placeOrder({symbol,side:'buy',price:price-5,quantity:100});
 const bad=m.exportState(),s=bad.data as State,o=s.orders[s.playerOrderIds[0]];
 o.reserve+=1;s.wallets[0].frozenCash+=1;
 expect(()=>importMarket(bad)).toThrow();
});
it('rejects active sell reservations whose owner position is missing even when total shares balance',()=>{
 const {market:m,symbol,price}=fixture();m.placeOrder({symbol,side:'buy',price,quantity:100});m.nextDay();
 const q=m.getSnapshot().quotes.find(q=>q.symbol===symbol)!;
 const sell=m.placeOrder({symbol,side:'sell',price:q.limitUp,quantity:100});expect(sell.ok).toBe(true);expect(sell.order?.filled).toBe(0);
 const bad=m.exportState(),s=bad.data as State,h=s.wallets[0].positions[symbol],recipient=s.wallets[s.stocks[0].agents[0]].positions[symbol];
 recipient.quantity+=h.quantity;recipient.costBasis+=h.costBasis;delete s.wallets[0].positions[symbol];
 expect(()=>importMarket(bad)).toThrow();
});
