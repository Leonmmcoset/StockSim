import { z } from 'zod';
import type { State } from './internal';
import { UNIVERSE } from './data';
import { fees } from './ledger';
const int=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),price=int.min(1),str=z.string().max(300),finite=z.number().finite();
const side=z.enum(['buy','sell']);
const bar=z.object({time:int,open:price,high:price,low:price,close:price,volume:int,turnover:int});
const position=z.object({quantity:int,todayBought:int,frozen:int,costBasis:int});
const wallet=z.object({cash:int,frozenCash:int,positions:z.record(z.string(),position),kind:z.enum(['player','fundamental','trend','noise','liquidity']),bias:finite});
const order=z.object({id:str,symbol:str,side,price,quantity:int.min(1).max(1000000),filled:int,remaining:int,status:z.enum(['open','partial','filled','cancelled','expired']),createdAt:int,avgFillPrice:int,fee:int,owner:int,seq:int,notional:int,reserve:int,expires:int});
const tape=z.object({id:str,symbol:str,time:int,price,quantity:int.min(1),side});
const stock=z.object({symbol:str,name:str,sector:str,beta:finite,base:price,fundamental:z.number().positive().finite(),sentiment:finite,ema:z.number().positive().finite(),variance:z.number().nonnegative().finite(),last:price,prevClose:price,open:price,high:price,low:price,volume:int,turnover:int,limitUp:price,limitDown:price,bids:z.array(str).max(5000),asks:z.array(str).max(5000),agents:z.array(int).length(48),minuteBars:z.array(bar).max(242),dailyBars:z.array(bar).min(1).max(251),tape:z.array(tape).max(100)});
const stateSchema=z.object({seed:z.string().max(300),rng:int.max(4294967295),seq:int,tick:int,date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),seconds:int.min(34200).max(54000),dayIndex:int,initialCash:int,feePool:int,realizedPnl:z.number().int(),playerFees:int,wallets:z.array(wallet).length(577),stocks:z.array(stock).length(12),orders:z.record(z.string(),order),playerOrderIds:z.array(str).max(20000),trades:z.array(z.object({id:str,orderId:str,symbol:str,side,time:int,price,quantity:int,amount:int,fee:int})).max(5000),news:z.array(z.object({id:str,time:int,headline:str,body:z.string().max(2000),scope:z.enum(['market','sector','company']),symbols:z.array(str).max(12),impact:z.enum(['positive','negative','neutral'])})).max(100),macro:finite,sectorFactors:z.record(z.string(),finite),totalCash:int,totalShares:z.record(z.string(),int)});
export function validateSave(input:unknown):State {
  let text:string;try{text=JSON.stringify(input);}catch{throw new Error('存档格式错误：无法读取JSON');}
  if(!text||text.length>12_000_000)throw new Error('存档为空或超过12MB大小限制');
  const parsed=z.object({schemaVersion:z.literal(1),data:stateSchema}).safeParse(input);
  if(!parsed.success)throw new Error('存档格式或版本不兼容，原进度未被修改');
  const s=parsed.data.data as State;
  const fail=()=>{throw new Error('存档资金、持仓、订单或时间校验失败');};
  if(!Number.isFinite(Date.parse(s.date+'T00:00:00Z'))||new Date(s.date+'T00:00:00Z').toISOString().slice(0,10)!==s.date||s.seconds%30||s.wallets[0].kind!=='player')fail();
  const dayStart=Date.parse(s.date+'T00:00:00+08:00'),now=dayStart+s.seconds*1000;
  const universe=new Set(UNIVERSE.map(q=>q.symbol as string)),bookIds=new Set<string>(),playerIds=new Set(s.playerOrderIds);
  if(playerIds.size!==s.playerOrderIds.length)fail();
  const reserveCash=s.wallets.map(()=>0),reserveShares=s.wallets.map(()=>({} as Record<string,number>));
  for(const q of s.stocks){
    if(!universe.delete(q.symbol)||q.limitUp!==Math.round(q.prevClose*1.1)||q.limitDown!==Math.max(1,Math.round(q.prevClose*.9))||q.last<q.limitDown||q.last>q.limitUp||q.high<q.low)fail();
    if(!Object.hasOwn(s.sectorFactors,q.sector))fail();
    const current=q.dailyBars.at(-1)!;
    if(current.time!==dayStart+34200000||current.open!==q.open||current.high!==q.high||current.low!==q.low||current.close!==q.last||current.volume!==q.volume||current.turnover!==q.turnover)fail();
    let previousTime=-1;
    for(const b of q.dailyBars){if(b.time<=previousTime||b.time>current.time)fail();previousTime=b.time;}
    previousTime=-1;let minuteVolume=0,minuteTurnover=0;
    for(const b of q.minuteBars){
      const seconds=(b.time-dayStart)/1000;
      const inSession=(seconds>=34200&&seconds<41400)||(seconds>=46800&&seconds<53820)||(seconds===54000&&s.seconds===54000);
      if(b.time<=previousTime||b.time>now||b.time%60000!==0||!inSession)fail();
      previousTime=b.time;minuteVolume+=b.volume;minuteTurnover+=b.turnover;
    }
    if(minuteVolume!==q.volume||minuteTurnover!==q.turnover||(q.volume>0&&q.tape.length===0))fail();
    for(const tr of q.tape)if(tr.symbol!==q.symbol||tr.time<dayStart+34200000||tr.time>now||tr.price<q.limitDown||tr.price>q.limitUp)fail();
    for(const owner of q.agents)if(!s.wallets[owner]||owner===0)fail();
    for(const [side,ids] of [['buy',q.bids],['sell',q.asks]] as const){
      let prev:State['orders'][string]|undefined;
      for(const id of ids){
        const o=s.orders[id];if(bookIds.has(id)||!o||o.symbol!==q.symbol||o.side!==side||o.price<q.limitDown||o.price>q.limitUp||!['open','partial'].includes(o.status))fail();bookIds.add(id);
        if(prev&&((side==='buy'?prev.price<o.price:prev.price>o.price)||(prev.price===o.price&&prev.seq>o.seq)))fail();prev=o;
      }
    }
    for(const b of [...q.minuteBars,...q.dailyBars])if(b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.low>b.high)fail();
  }
  for(const [id,o] of Object.entries(s.orders)){
    if(o.id!==id||!s.wallets[o.owner]||o.filled+o.remaining!==o.quantity||o.seq>s.seq||!s.stocks.some(q=>q.symbol===o.symbol)||o.fee>o.notional+500)fail();
    const active=['open','partial'].includes(o.status);
    if(o.fee!==fees(o.notional,o.side).total||o.avgFillPrice!==(o.filled?Math.round(o.notional/o.filled):0))fail();
    const expectedReserve=active&&o.side==='buy'?o.remaining*o.price+fees(o.notional+o.remaining*o.price,'buy').total-o.fee:0;
    if(o.reserve!==expectedReserve)fail();
    if(active!==bookIds.has(id)||(o.owner===0)!==playerIds.has(id)||(!active&&o.reserve!==0))fail();
    if(active){
      if(o.side==='buy')reserveCash[o.owner]+=o.reserve;
      else reserveShares[o.owner][o.symbol]=(reserveShares[o.owner][o.symbol]??0)+o.remaining;
    }
  }
  for(const id of playerIds)if(!s.orders[id]||s.orders[id].owner!==0)fail();
  const shares:Record<string,number>={};let cash=s.feePool;
  s.wallets.forEach((w,i)=>{
    if(w.frozenCash!==reserveCash[i]||w.cash<w.frozenCash)fail();cash+=w.cash;
    for(const [symbol,reserved] of Object.entries(reserveShares[i]))if(!w.positions[symbol]||w.positions[symbol].frozen!==reserved)fail();
    for(const [symbol,h] of Object.entries(w.positions)){
      if(!s.stocks.some(q=>q.symbol===symbol)||h.todayBought+h.frozen>h.quantity||h.frozen!==(reserveShares[i][symbol]??0)||(h.quantity===0&&h.costBasis!==0)||(h.quantity>0&&h.costBasis===0))fail();
      shares[symbol]=(shares[symbol]??0)+h.quantity;
    }
  });
  if(s.wallets[0].cash+Object.values(s.wallets[0].positions).reduce((n,h)=>n+h.costBasis,0)!==s.initialCash+s.realizedPnl)fail();
  if(s.playerOrderIds.reduce((n,id)=>n+s.orders[id].fee,0)!==s.playerFees)fail();
  if(cash!==s.totalCash)fail();for(const q of s.stocks)if(shares[q.symbol]!==s.totalShares[q.symbol])fail();
  return s;
}
