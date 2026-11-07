import type { Account, Bar, CommandResult, ErrorCode, Level, MarketEngine, MarketOptions, MarketSave, MarketSnapshot, Order, OrderInput, OrderPreview, Side } from './types';
import type { InternalOrder, State, Stock, Wallet } from './internal';
import { DEFAULT_SEED, UNIVERSE } from './data';
import { hashSeed, normal, random } from './random';
import { fees, holding, settleSide, updateReserve } from './ledger';
import { clearingPrice } from './book';

const OPEN=9*3600+30*60,NOON=11*3600+30*60,AFTERNOON=13*3600,AUCTION=14*3600+57*60,CLOSE=15*3600;
const clamp=(v:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,v));
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
const timestamp=(date:string,seconds:number)=>Date.parse(`${date}T00:00:00+08:00`)+seconds*1000;
function shiftDate(date:string,direction=1):string {
  let ms=Date.parse(`${date}T12:00:00Z`);do{ms+=direction*86400000;}while([0,6].includes(new Date(ms).getUTCDay()));
  return new Date(ms).toISOString().slice(0,10);
}
function phase(s:State):'continuous'|'lunch'|'closing-auction'|'closed' {
  if(s.seconds>=CLOSE)return 'closed';if(s.seconds>=NOON&&s.seconds<AFTERNOON)return 'lunch';
  return s.seconds>=AUCTION?'closing-auction':'continuous';
}
function publicOrder(o:InternalOrder):Order {
  const {id,symbol,side,price,quantity,filled,remaining,status,createdAt,avgFillPrice,fee}=o;
  return {id,symbol,side,price,quantity,filled,remaining,status,createdAt,avgFillPrice,fee};
}
function newWallet(kind:Wallet['kind'],cash:number,bias=0):Wallet{return {kind,cash,bias,frozenCash:0,positions:{}};}
function limits(stock:Stock):void{stock.limitUp=Math.round(stock.prevClose*1.1);stock.limitDown=Math.max(1,Math.round(stock.prevClose*.9));}
function emptyBar(time:number,price:number):Bar{return {time,open:price,high:price,low:price,close:price,volume:0,turnover:0};}

export class Market implements MarketEngine {
  private s:State;
  constructor(options:MarketOptions={},restored?:State){
    if(restored){this.s=restored;return;}
    const seed=String(options.seed??DEFAULT_SEED),initialCash=options.startingCash??500000;
    if(!Number.isSafeInteger(initialCash)||initialCash<0||initialCash>1e12)throw new Error('初始资金必须是有效的整数分');
    this.s={seed,rng:hashSeed(seed),seq:0,tick:0,date:'2026-11-09',seconds:OPEN,dayIndex:0,initialCash,feePool:0,realizedPnl:0,playerFees:0,
      wallets:[newWallet('player',initialCash)],stocks:[],orders:{},playerOrderIds:[],trades:[],news:[],macro:0,sectorFactors:{},totalCash:initialCash,totalShares:{}};
    const s=this.s;
    for(const u of UNIVERSE){
      s.sectorFactors[u.sector]=0;
      const stock:Stock={symbol:u.symbol,name:u.name,sector:u.sector,base:u.price,beta:u.beta,fundamental:u.price,sentiment:0,ema:u.price,variance:1e-7,
        last:u.price,prevClose:u.price,open:u.price,high:u.price,low:u.price,volume:0,turnover:0,limitUp:0,limitDown:0,
        bids:[],asks:[],agents:[],minuteBars:[],dailyBars:[],tape:[]};
      s.stocks.push(stock);limits(stock);
    }
    this.history(Math.floor(clamp(options.historyDays??60,0,250)));
    for(const stock of s.stocks){
      for(let i=0;i<48;i++){
        const kind=i<16?'liquidity':i<28?'fundamental':i<40?'trend':'noise';
        const quantity=100000,cash=quantity*stock.last;
        const w=newWallet(kind,cash,normal(s)*.15);w.positions[stock.symbol]={quantity,todayBought:0,frozen:0,costBasis:cash};
        stock.agents.push(s.wallets.length);s.wallets.push(w);s.totalCash+=cash;
      }
      s.totalShares[stock.symbol]=4800000;
      this.newDailyBar(stock);this.seedLiquidity(stock);
    }
    this.s.news.push({id:'welcome',time:timestamp(s.date,OPEN),headline:'股海模拟市场开市',body:'12家虚构公司已进入竞价交易。初始资金5000元，买入100股起，T+1可卖；背景历史为合成行情。',scope:'market',symbols:[],impact:'neutral'});
    this.step(10);
    // The player enters after the five-minute opening warm-up with no trades.
  }
  /** Fast, explicitly synthetic background history, not a trade replay. */
  private history(days:number):void {
    const s=this.s;let date=s.date;for(let i=0;i<days;i++)date=shiftDate(date,-1);
    let volatility=.013;
    for(let day=0;day<days;day++){
      volatility=clamp(.91*volatility+.09*(.009+Math.abs(normal(s))*.012),.008,.035);
      const market=normal(s)*volatility*.42;
      const sectors:Record<string,number>={};for(const stock of s.stocks)sectors[stock.sector]??=normal(s)*volatility*.45;
      for(const q of s.stocks){
        const prev=q.last,ret=clamp(market*q.beta+sectors[q.sector]+normal(s)*volatility*.62,-.095,.095);
        const close=Math.max(50,Math.round(prev*Math.exp(ret))),lo=Math.round(prev*.9),hi=Math.round(prev*1.1);
        const open=clamp(Math.round(prev*Math.exp(normal(s)*.003)),lo,hi);
        const high=clamp(Math.round(Math.max(open,close)*(1+Math.abs(normal(s))*.007)),lo,hi);
        const low=clamp(Math.round(Math.min(open,close)*(1-Math.abs(normal(s))*.007)),lo,hi);
        const volume=Math.round((1500+random(s)*3500)*(1+Math.abs(ret)*25))*100;
        q.dailyBars.push({time:timestamp(date,OPEN),open,high,low,close:clamp(close,lo,hi),volume,turnover:volume*Math.round((open+high+low+close)/4)});
        q.last=clamp(close,lo,hi);
      }
      date=shiftDate(date);
    }
    for(const q of s.stocks){q.prevClose=q.last;q.open=q.last;q.high=q.last;q.low=q.last;q.fundamental=q.last;q.ema=q.last;limits(q);}
  }
  private newDailyBar(stock:Stock):void {
    stock.dailyBars.push(emptyBar(timestamp(this.s.date,OPEN),stock.last));
    if(stock.dailyBars.length>251)stock.dailyBars.shift();
  }
  private seedLiquidity(stock:Stock):void {
    for(let i=0;i<8;i++){
      const distance=1+i*Math.max(1,Math.round(stock.last*.0007));
      this.submit(stock,stock.agents[i], 'buy',clamp(stock.last-distance,stock.limitDown,stock.limitUp),1500+(i%3)*500,60+i);
      this.submit(stock,stock.agents[8+i],'sell',clamp(stock.last+distance,stock.limitDown,stock.limitUp),1500+(i%3)*500,60+i);
    }
  }
  private active(o:InternalOrder):boolean{return o.status==='open'||o.status==='partial';}
  private book(stock:Stock,side:Side):InternalOrder[]{return (side==='buy'?stock.bids:stock.asks).map(id=>this.s.orders[id]).filter(o=>o&&this.active(o));}
  private sort(stock:Stock,side:Side):void {
    const ids=side==='buy'?stock.bids:stock.asks,s=this.s;
    ids.sort((a,b)=>(side==='buy'?s.orders[b].price-s.orders[a].price:s.orders[a].price-s.orders[b].price)||s.orders[a].seq-s.orders[b].seq);
  }
  private remove(stock:Stock,o:InternalOrder):void {
    const ids=o.side==='buy'?stock.bids:stock.asks,index=ids.indexOf(o.id);if(index>=0)ids.splice(index,1);
    if(o.owner!==0)delete this.s.orders[o.id];
  }
  private cancelInternal(stock:Stock,o:InternalOrder,status:'cancelled'|'expired'):void {
    if(!this.active(o))return;
    const w=this.s.wallets[o.owner];
    if(o.side==='buy'){w.frozenCash-=o.reserve;o.reserve=0;}
    else holding(w,o.symbol).frozen-=o.remaining;
    o.status=status;this.remove(stock,o);
  }
  private cage(stock:Stock,side:Side):number {
    const opposite=this.book(stock,side==='buy'?'sell':'buy')[0],same=this.book(stock,side)[0];
    const base=opposite?.price??same?.price??(stock.volume?stock.last:stock.prevClose);
    return side==='buy'?Math.round(Math.max(base*1.02,base+10)):Math.round(Math.min(base*.98,base-10));
  }
  private submit(stock:Stock,owner:number,side:Side,price:number,quantity:number,lifetime=20):InternalOrder|null {
    const s=this.s,w=s.wallets[owner],h=holding(w,stock.symbol);
    price=Math.round(clamp(price,stock.limitDown,stock.limitUp));
    if(phase(s)==='continuous')price=side==='buy'?Math.min(price,this.cage(stock,side)):Math.max(price,this.cage(stock,side));
    if(side==='buy'&&owner!==0){
      const available=w.cash-w.frozenCash;
      quantity=Math.min(quantity,Math.max(0,Math.floor((available-501)/(price*100*(1.00026)))*100));
    }else if(side==='sell')quantity=Math.min(quantity,h.quantity-h.todayBought-h.frozen);
    if(owner!==0||side==='buy')quantity=Math.floor(quantity/100)*100;if(quantity<=0)return null;
    const seq=++s.seq,id=`O${seq}`;
    const o:InternalOrder={id,seq,owner,symbol:stock.symbol,side,price,quantity,filled:0,remaining:quantity,status:'open',createdAt:timestamp(s.date,s.seconds),avgFillPrice:0,fee:0,notional:0,reserve:0,expires:owner===0?Number.MAX_SAFE_INTEGER:s.tick+lifetime};
    s.orders[id]=o;if(owner===0)s.playerOrderIds.push(id);
    if(side==='buy')updateReserve(s,o);else h.frozen+=quantity;
    if(phase(s)==='continuous')this.match(stock,o);
    if(o.remaining>0){(side==='buy'?stock.bids:stock.asks).push(id);this.sort(stock,side);}else if(owner!==0)delete s.orders[id];
    return o;
  }
  private match(stock:Stock,incoming:InternalOrder):void {
    const ids=incoming.side==='buy'?stock.asks:stock.bids;
    while(incoming.remaining>0&&ids.length){
      const resting=this.s.orders[ids[0]];
      if(incoming.side==='buy'?resting.price>incoming.price:resting.price<incoming.price)break;
      if(resting.owner===incoming.owner){this.cancelInternal(stock,resting,'cancelled');continue;}
      this.fill(stock,incoming,resting,resting.price,Math.min(incoming.remaining,resting.remaining),incoming.side);
      if(!resting.remaining)this.remove(stock,resting);
    }
  }
  private fill(stock:Stock,a:InternalOrder,b:InternalOrder,price:number,quantity:number,side:Side):void {
    const s=this.s,time=timestamp(s.date,s.seconds),id=`T${++s.seq}`;
    for(const o of [a,b]){
      const fee=settleSide(s,o,price,quantity);
      if(o.owner===0)s.trades.unshift({id:`${id}-${o.id}`,orderId:o.id,symbol:stock.symbol,side:o.side,time,price,quantity,amount:price*quantity,fee});
    }
    if(!stock.volume){stock.open=price;stock.high=price;stock.low=price;}
    stock.last=price;stock.high=Math.max(stock.high,price);stock.low=Math.min(stock.low,price);stock.volume+=quantity;stock.turnover+=price*quantity;
    stock.tape.unshift({id,symbol:stock.symbol,time,price,quantity,side});if(stock.tape.length>100)stock.tape.length=100;
    const minute=Math.floor(time/60000)*60000;
    let bar=stock.minuteBars.at(-1);
    if(!bar||bar.time!==minute){bar=emptyBar(minute,price);stock.minuteBars.push(bar);}
    if(bar.volume===0)bar.open=price;
    bar.high=bar.volume?Math.max(bar.high,price):price;bar.low=bar.volume?Math.min(bar.low,price):price;bar.close=price;bar.volume+=quantity;bar.turnover+=price*quantity;
    const daily=stock.dailyBars.at(-1)!;Object.assign(daily,{open:stock.open,high:stock.high,low:stock.low,close:price,volume:stock.volume,turnover:stock.turnover});
    if(s.trades.length>5000)s.trades.length=5000;
  }
  private agentAction(stock:Stock,owner:number):void {
    const s=this.s,w=s.wallets[owner],h=holding(w,stock.symbol),p=stock.last;
    // Only replace this agent's stale orders. Other agents and player queue positions survive.
    if(phase(s)==='continuous')for(const o of [...this.book(stock,'buy'),...this.book(stock,'sell')])if(o.owner===owner)this.cancelInternal(stock,o,'cancelled');
    const inv=h.quantity*p/Math.max(1,w.cash+h.quantity*p),risk=Math.sqrt(stock.variance),fund=Math.log(stock.fundamental/p),trend=clamp(Math.log(p/stock.ema),-.015,.015);
    if(w.kind==='liquidity'){
      const shift=clamp((stock.fundamental*Math.exp(stock.sentiment)-p)*.12-(inv-.5)*p*.008,-p*.003,p*.003);
      const center=p+shift,spread=Math.max(1,Math.round(p*(.0005+risk*.5)));
      const size=(4+Math.floor(random(s)*12))*100;
      this.submit(stock,owner,'buy',Math.round(center-spread),size,10+Math.floor(random(s)*12));
      this.submit(stock,owner,'sell',Math.round(center+spread),size,10+Math.floor(random(s)*12));
      return;
    }
    const wf=w.kind==='fundamental'?.24:.035,wt=w.kind==='trend'?.85:.05;
    const signal=wf*fund+wt*trend+stock.sentiment*(w.kind==='noise'?.5:1)+normal(s)*(.0012+risk)+w.bias*.001;
    const buyProb=clamp(.5+signal*55-(inv-.5)*.55,.06,.94),side:Side=random(s)<buyProb?'buy':'sell';
    const conviction=Math.abs(signal),aggressive=random(s)<clamp(.38+conviction*50,.3,.85);
    const opposite=this.book(stock,side==='buy'?'sell':'buy')[0];
    let price:number;
    if(aggressive&&opposite){
      const cross=opposite.price+(side==='buy'?1:-1)*Math.floor(random(s)*Math.max(2,p*.0015));
      // An aggressive order still has a reservation value: a thin book must
      // not make an uninformed trader accept an arbitrarily distant quote.
      const reservation=Math.round(p*Math.exp(clamp(signal,-.012,.012))+(side==='buy'?1:-1)*Math.max(2,p*.0015));
      price=side==='buy'?Math.min(cross,reservation):Math.max(cross,reservation);
    }
    else price=Math.round(p*Math.exp(clamp(signal,-.007,.007))+(side==='buy'?-1:1)*(1+Math.floor(random(s)*4)));
    const size=(2+Math.floor(random(s)*12+Math.min(10,conviction*500)))*100;
    this.submit(stock,owner,side,price,size,4+Math.floor(random(s)*18));
  }
  private emitNews():void {
    const s=this.s,scopeRoll=random(s),scope=scopeRoll<.18?'market':scopeRoll<.48?'sector':'company';
    const source=s.stocks[Math.floor(random(s)*s.stocks.length)],positive=random(s)>.48;
    const magnitude=(.006+random(s)*.016)*(positive?1:-1),targets=scope==='market'?s.stocks:scope==='sector'?s.stocks.filter(q=>q.sector===source.sector):[source];
    for(const q of targets){q.fundamental*=Math.exp(magnitude*.55);q.sentiment+=magnitude*.28;}
    const label=scope==='market'?'市场':scope==='sector'?source.sector:source.name;
    const titles=positive?['需求改善预期升温','新订单增长超出预期','投资信心回升']:['成本压力增加','需求预期下修','短期不确定性上升'];
    s.news.unshift({id:`N${++s.seq}`,time:timestamp(s.date,s.seconds),headline:`${label}：${titles[Math.floor(random(s)*titles.length)]}`,body:`模拟快讯：${label}${positive?'经营预期出现积极变化':'面临新的经营压力'}。不同交易者正在重新评估估值和仓位，短期价格仍取决于买卖力量。`,scope,symbols:targets.map(q=>q.symbol),impact:positive?'positive':'negative'});
    if(s.news.length>100)s.news.length=100;
  }
  step(ticks=1):void {
    if(!Number.isInteger(ticks)||ticks<0||ticks>10000)throw new Error('推进步数必须为0至10000的整数');
    const s=this.s;
    for(let i=0;i<ticks;i++){
      if(phase(s)==='lunch'||phase(s)==='closed')break;
      s.tick++;
      const marketShock=normal(s)*.00018;
      s.macro=.992*s.macro+marketShock;
      for(const sector of Object.keys(s.sectorFactors))s.sectorFactors[sector]=.985*s.sectorFactors[sector]+normal(s)*.00018;
      if(random(s)<.009)this.emitNews();
      for(const q of s.stocks){
        const before=q.last;
        q.fundamental*=Math.exp(marketShock*q.beta+normal(s)*.00021);
        q.sentiment=clamp(.986*q.sentiment+.014*(s.macro*q.beta+s.sectorFactors[q.sector])+normal(s)*.00012,-.035,.035);
        if(phase(s)==='continuous')for(const o of [...this.book(q,'buy'),...this.book(q,'sell')])if(o.owner!==0&&o.expires<=s.tick)this.cancelInternal(q,o,'expired');
        // Three inventory-sensitive liquidity providers and five heterogeneous traders.
        for(let j=0;j<3;j++)this.agentAction(q,q.agents[Math.floor(random(s)*16)]);
        for(let j=0;j<5;j++)this.agentAction(q,q.agents[16+Math.floor(random(s)*32)]);
        const ret=Math.log(q.last/before);q.variance=.97*q.variance+.03*ret*ret;q.ema=.97*q.ema+.03*q.last;
        if(phase(s)==='continuous'){
          const time=Math.floor(timestamp(s.date,s.seconds)/60000)*60000;
          if(q.minuteBars.at(-1)?.time!==time)q.minuteBars.push(emptyBar(time,q.last));
        }
      }
      s.seconds+=30;
      if(s.seconds===CLOSE)this.closeDay();
    }
  }
  private closeDay():void {
    const s=this.s;
    for(const q of s.stocks){
      const all=[...this.book(q,'buy'),...this.book(q,'sell')],p=clearingPrice(all);
      if(p!==null){
        while(q.bids.length&&q.asks.length){
          const b=s.orders[q.bids[0]],a=s.orders[q.asks[0]];
          if(b.price<p||a.price>p)break;
          if(b.owner===a.owner){this.cancelInternal(q,b.seq>a.seq?b:a,'cancelled');continue;}
          this.fill(q,b,a,p,Math.min(b.remaining,a.remaining),'buy');
          if(!b.remaining)this.remove(q,b);if(!a.remaining)this.remove(q,a);
        }
      }else if(q.volume){
        const last=q.tape[0],recent=q.tape.filter(t=>t.time>=last.time-60000);
        q.last=Math.round(recent.reduce((n,t)=>n+t.price*t.quantity,0)/recent.reduce((n,t)=>n+t.quantity,0));
        q.dailyBars.at(-1)!.close=q.last;
      }
      for(const o of [...this.book(q,'buy'),...this.book(q,'sell')])this.cancelInternal(q,o,'expired');
    }
  }
  skipLunch():void {if(phase(this.s)==='lunch')this.s.seconds=AFTERNOON;}
  nextDay():void {
    const s=this.s;
    this.step(1000);this.skipLunch();this.step(1000);
    s.date=shiftDate(s.date);s.dayIndex++;s.seconds=OPEN;
    for(const w of s.wallets)for(const h of Object.values(w.positions))h.todayBought=0;
    const macro=normal(s)*.004;
    for(const q of s.stocks){
      q.prevClose=q.last;q.open=q.last;q.high=q.last;q.low=q.last;q.volume=0;q.turnover=0;q.minuteBars=[];q.tape=[];limits(q);
      q.fundamental*=Math.exp(macro*q.beta+normal(s)*.004);q.sentiment*=.65;this.newDailyBar(q);this.seedLiquidity(q);
    }
    s.news.unshift({id:`N${++s.seq}`,time:timestamp(s.date,OPEN),headline:`${s.date} 新交易日开市`,body:'昨日买入持仓已转为可卖，未成交的昨日委托已失效。',scope:'market',symbols:[],impact:'neutral'});
    if(s.news.length>100)s.news.length=100;
  }
  private error(code:ErrorCode,error:string):CommandResult{return {ok:false,code,error};}
  placeOrder(input:OrderInput):CommandResult {
    const s=this.s,q=s.stocks.find(q=>q.symbol===input.symbol);
    if(!q)return this.error('UNKNOWN_SYMBOL','证券代码不存在');
    if(input.side!=='buy'&&input.side!=='sell')return this.error('INVALID_QUANTITY','委托方向无效');
    if(!Number.isSafeInteger(input.price)||input.price<=0)return this.error('INVALID_PRICE','委托价格必须精确到0.01元');
    if(!Number.isSafeInteger(input.quantity)||input.quantity<=0||input.quantity>1000000)return this.error('INVALID_QUANTITY','委托数量须为1至100万股的整数');
    const h=s.wallets[0].positions[q.symbol]??{quantity:0,todayBought:0,frozen:0,costBasis:0},sellable=h.quantity-h.todayBought-h.frozen;
    if(input.quantity%100!==0&&(input.side==='buy'||input.quantity!==sellable))return this.error('INVALID_QUANTITY','买入须为100股整数倍；零股需一次卖出');
    if(phase(s)==='lunch'||phase(s)==='closed')return this.error('MARKET_CLOSED','当前为休市时段，请等待开市');
    if(input.price<q.limitDown||input.price>q.limitUp)return this.error('OUTSIDE_LIMIT','委托价格超出当日涨跌停范围');
    if(phase(s)==='continuous'&&(input.side==='buy'?input.price>this.cage(q,'buy'):input.price<this.cage(q,'sell')))return this.error('PRICE_CAGE','委托价格超出连续竞价有效申报范围（2%或10个最小价位）');
    if(input.side==='buy'&&input.price*input.quantity+fees(input.price*input.quantity,'buy').total>s.wallets[0].cash-s.wallets[0].frozenCash)return this.error('INSUFFICIENT_CASH','可用资金不足，请预留手续费');
    if(input.side==='sell'&&input.quantity>sellable)return this.error('INSUFFICIENT_SHARES','可卖数量不足（当日买入需下一交易日卖出）');
    const o=this.submit(q,0,input.side,input.price,input.quantity);
    if(!o)return this.error(input.side==='buy'?'INSUFFICIENT_CASH':'INSUFFICIENT_SHARES','委托余额不足');
    return {ok:true,order:publicOrder(o)};
  }
  cancelOrder(id:string):CommandResult {
    const o=this.s.orders[id];if(!o||o.owner!==0)return this.error('ORDER_NOT_FOUND','未找到委托');
    if(!this.active(o))return this.error('ORDER_NOT_OPEN','该委托已成交、撤销或失效');
    if(phase(this.s)==='closing-auction')return this.error('CANCEL_RESTRICTED','收盘集合竞价14:57至15:00不可撤单');
    const q=this.s.stocks.find(q=>q.symbol===o.symbol)!;this.cancelInternal(q,o,'cancelled');return {ok:true,order:publicOrder(o)};
  }
  previewOrder(input:OrderInput):OrderPreview {
    const w=this.s.wallets[0],p=Number.isSafeInteger(input.price)&&input.price>0?input.price:0,qty=Number.isSafeInteger(input.quantity)&&input.quantity>0?input.quantity:0;
    const amount=p*qty,f=fees(amount,input.side),h=w.positions[input.symbol];
    let max=p?Math.max(0,Math.floor((w.cash-w.frozenCash-500)/(p*100))*100):0;
    while(max>0&&max*p+fees(max*p,'buy').total>w.cash-w.frozenCash)max-=100;
    return {amount,fees:f,cashRequired:input.side==='buy'?amount+f.total:0,maxBuyQuantity:max,maxSellQuantity:h?h.quantity-h.todayBought-h.frozen:0};
  }
  private levels(q:Stock,side:Side):Level[]{
    const levels:Level[]=[];for(const o of this.book(q,side)){
      const last=levels.at(-1);if(last?.price===o.price)last.quantity+=o.remaining;
      else{if(levels.length===5)break;levels.push({price:o.price,quantity:o.remaining});}
    }return levels;
  }
  private account():Account {
    const s=this.s,w=s.wallets[0];
    const positions=Object.entries(w.positions).filter(([,h])=>h.quantity>0).sort(([a],[b])=>a.localeCompare(b)).map(([symbol,h])=>{
      const price=s.stocks.find(q=>q.symbol===symbol)!.last,marketValue=price*h.quantity,pnl=marketValue-h.costBasis;
      return {symbol,quantity:h.quantity,sellable:h.quantity-h.todayBought-h.frozen,frozen:h.frozen,todayBought:h.todayBought,costBasis:h.costBasis,averageCost:Math.round(h.costBasis/h.quantity),marketValue,pnl,pnlPct:h.costBasis?pnl/h.costBasis*100:0};
    });
    const marketValue=positions.reduce((sum,p)=>sum+p.marketValue,0),equity=w.cash+marketValue;
    return {initialCash:s.initialCash,cash:w.cash,availableCash:w.cash-w.frozenCash,frozenCash:w.frozenCash,marketValue,equity,totalPnl:equity-s.initialCash,totalPnlPct:s.initialCash?(equity/s.initialCash-1)*100:0,realizedPnl:s.realizedPnl,feesPaid:s.playerFees,positions};
  }
  getSnapshot():MarketSnapshot {
    const s=this.s,ph=phase(s),hours=Math.floor(s.seconds/3600),minutes=Math.floor(s.seconds%3600/60),secs=s.seconds%60;
    const labels={continuous:'连续竞价',lunch:'午间休市','closing-auction':'收盘集合竞价',closed:'已收盘'};
    const quotes=s.stocks.map(q=>({symbol:q.symbol,name:q.name,sector:q.sector,last:q.last,prevClose:q.prevClose,open:q.open,high:q.high,low:q.low,change:q.last-q.prevClose,changePct:(q.last/q.prevClose-1)*100,
      volume:q.volume,turnover:q.turnover,vwap:q.volume?Math.round(q.turnover/q.volume):q.last,limitUp:q.limitUp,limitDown:q.limitDown,bids:this.levels(q,'buy'),asks:this.levels(q,'sell'),minuteBars:q.minuteBars,dailyBars:q.dailyBars,recentTrades:q.tape.slice(0,30)}));
    return clone({version:1,seed:s.seed,clock:{dayIndex:s.dayIndex,date:s.date,time:`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}`,timestamp:timestamp(s.date,s.seconds),phase:ph,phaseLabel:labels[ph]},
      quotes,account:this.account(),orders:s.playerOrderIds.map(id=>publicOrder(s.orders[id])).reverse(),trades:s.trades,news:s.news,
      index:{name:'股海综合',value:s.stocks.reduce((a,q)=>a+q.last/q.base,0)/12*1000,changePct:(s.stocks.reduce((a,q)=>a+q.last/q.base,0)/s.stocks.reduce((a,q)=>a+q.prevClose/q.base,0)-1)*100,advancing:quotes.filter(q=>q.change>0).length,declining:quotes.filter(q=>q.change<0).length,unchanged:quotes.filter(q=>q.change===0).length,volume:quotes.reduce((a,q)=>a+q.volume,0),turnover:quotes.reduce((a,q)=>a+q.turnover,0)}});
  }
  exportState():MarketSave {return {schemaVersion:1,data:clone(this.s)};}
}
