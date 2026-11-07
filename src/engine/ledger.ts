import type { FeeBreakdown, Side } from './types';
import type { InternalOrder, State, Wallet, Holding } from './internal';
export function fees(amount:number,side:Side):FeeBreakdown {
  if(amount<=0)return {commission:0,transfer:0,stamp:0,total:0};
  const commission=Math.max(500,Math.round(amount*.00025));
  const transfer=Math.round(amount*.00001),stamp=side==='sell'?Math.round(amount*.0005):0;
  return {commission,transfer,stamp,total:commission+transfer+stamp};
}
export function holding(wallet:Wallet,symbol:string):Holding {
  return wallet.positions[symbol]??(wallet.positions[symbol]={quantity:0,todayBought:0,frozen:0,costBasis:0});
}
export function updateReserve(state:State,o:InternalOrder):void {
  const w=state.wallets[o.owner];
  if(o.side==='buy'){
    w.frozenCash-=o.reserve;
    o.reserve=o.remaining>0?o.remaining*o.price+fees(o.notional+o.remaining*o.price,'buy').total-o.fee:0;
    w.frozenCash+=o.reserve;
  }
}
export function settleSide(state:State,o:InternalOrder,price:number,quantity:number):number {
  const w=state.wallets[o.owner],h=holding(w,o.symbol),amount=price*quantity;
  const newFee=fees(o.notional+amount,o.side).total,deltaFee=newFee-o.fee;
  o.notional+=amount;o.fee=newFee;o.filled+=quantity;o.remaining-=quantity;
  o.avgFillPrice=Math.round(o.notional/o.filled);o.status=o.remaining?'partial':'filled';
  if(o.side==='buy'){
    w.cash-=amount+deltaFee;h.quantity+=quantity;h.todayBought+=quantity;h.costBasis+=amount+deltaFee;
    updateReserve(state,o);
  }else{
    const cost=quantity===h.quantity?h.costBasis:Math.floor(h.costBasis*quantity/h.quantity);
    h.quantity-=quantity;h.frozen-=quantity;h.costBasis-=cost;w.cash+=amount-deltaFee;
    if(o.owner===0)state.realizedPnl+=amount-deltaFee-cost;
  }
  state.feePool+=deltaFee;
  if(o.owner===0)state.playerFees+=deltaFee;
  return deltaFee;
}
