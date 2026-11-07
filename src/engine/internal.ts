import type { Bar, NewsItem, Order, PlayerTrade, TapeTrade } from './types';
export interface Holding { quantity:number; todayBought:number; frozen:number; costBasis:number }
export interface Wallet { cash:number; frozenCash:number; positions:Record<string,Holding>; kind:'player'|'fundamental'|'trend'|'noise'|'liquidity'; bias:number }
export interface InternalOrder extends Order { owner:number; seq:number; notional:number; reserve:number; expires:number }
export interface Stock {
 symbol:string; name:string; sector:string; beta:number; base:number; fundamental:number; sentiment:number; ema:number; variance:number;
 last:number;prevClose:number;open:number;high:number;low:number;volume:number;turnover:number;limitUp:number;limitDown:number;
 bids:string[];asks:string[];agents:number[];minuteBars:Bar[];dailyBars:Bar[];tape:TapeTrade[];
}
export interface State {
 seed:string;rng:number;seq:number;tick:number;date:string;seconds:number;dayIndex:number;
 initialCash:number;feePool:number;realizedPnl:number;playerFees:number;
 wallets:Wallet[];stocks:Stock[];orders:Record<string,InternalOrder>;playerOrderIds:string[];
 trades:PlayerTrade[];news:NewsItem[];macro:number;sectorFactors:Record<string,number>;
 totalCash:number;totalShares:Record<string,number>;
}
