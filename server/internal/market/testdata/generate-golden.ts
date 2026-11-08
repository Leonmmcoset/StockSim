import {createMarket} from '../../../../src/engine/index.ts';
import {hashSeed,random} from '../../../../src/engine/random.ts';
import {writeFileSync} from 'node:fs';
const cases=[];
for(const [seed,historyDays] of [['stock-sim-2026',0],['中文🌊',0],['golden-history',60]] as const){
 const m=createMarket({seed,historyDays});
 for(const steps of [0,50,30]){
  m.step(steps); const s=m.getSnapshot();
  cases.push({seed,historyDays,elapsed:steps===0?0:steps===50?50:80,quotes:s.quotes.map(q=>({symbol:q.symbol,last:q.last,prevClose:q.prevClose,volume:q.volume,turnover:q.turnover,bids:q.bids,asks:q.asks})),reports:s.companies.map(c=>({symbol:c.symbol,period:c.reports[0].period,revenue:c.reports[0].revenue,netProfit:c.reports[0].netProfit}))});
 }
}
const rng=['stock-sim-2026','中文🌊'].map(seed=>{const hash=hashSeed(seed),state={rng:hash};return {seed,hash,values:Array.from({length:8},()=>random(state))}});
writeFileSync('server/internal/market/testdata/ts-golden.json',JSON.stringify({cases,rng},null,2)+'\n');
