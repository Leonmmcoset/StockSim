// Standalone diagnostic, excluded from the quick Vitest suite.
// Bundle with esbuild (see docs/market-model.md), then run with Node.
import { createMarket, importMarket } from '../src/engine';
const daily:number[]=[],minute:number[]=[],spreads:number[]=[],dayVectors:number[][]=[];let missing=0,samples=0,limits=0,zeros=0,bars=0,restores=0;
const mean=(x:number[])=>x.reduce((a,b)=>a+b,0)/x.length;
const sd=(x:number[])=>{const m=mean(x);return Math.sqrt(mean(x.map(v=>(v-m)**2)))};
const corr=(a:number[],b:number[])=>{const ma=mean(a),mb=mean(b),va=sd(a),vb=sd(b);return mean(a.map((v,i)=>(v-ma)*(b[i]-mb)))/(va*vb)};
const acf=(x:number[],lag:number,abs=false)=>{const y=abs?x.map(Math.abs):x;return corr(y.slice(lag),y.slice(0,-lag))};
const stats:{acf1:number;absacf1:number;absacf5:number;volvol:number}[]=[];const started=performance.now();
for(let seed=0;seed<10;seed++){
 const m=createMarket({seed:`pilot-${seed}`,historyDays:0});const byStock=Array.from({length:12},()=>[] as number[]);
 for(let day=0;day<20;day++){
  for(let j=0;j<8;j++){
   m.step(60);m.skipLunch();
   const snap=m.getSnapshot();
   if(snap.clock.phase==='closed')continue;
   for(const q of snap.quotes){samples++;if(!q.bids.length||!q.asks.length)missing++;else spreads.push(q.asks[0].price-q.bids[0].price);}
  }
  m.step(1000);m.skipLunch();m.step(1000);
  const s=m.getSnapshot();const vector:number[]=[];
  s.quotes.forEach((q,i)=>{
   const r=Math.log(q.last/q.prevClose);daily.push(r);byStock[i].push(r);vector.push(r);if(q.last===q.limitUp||q.last===q.limitDown)limits++;
   const rs=q.minuteBars.slice(1).map((b,i)=>Math.log(b.close/q.minuteBars[i].close));minute.push(...rs);stats.push({acf1:acf(rs,1),absacf1:acf(rs,1,true),absacf5:acf(rs,5,true),volvol:corr(rs.map(Math.abs),q.minuteBars.slice(1).map(b=>b.volume))});
   for(const b of q.minuteBars){bars++;if(!b.volume)zeros++;}
  });
  dayVectors.push(vector);if(day===19){importMarket(m.exportState());restores++;}m.nextDay();
 }
 console.log('completed seed',seed,'elapsed seconds',((performance.now()-started)/1000).toFixed(1));
}
spreads.sort((a,b)=>a-b);const pairs:{same:boolean;r:number}[]=[];for(let i=0;i<12;i++)for(let j=i+1;j<12;j++)pairs.push({same:Math.floor(i/2)===Math.floor(j/2),r:corr(dayVectors.map(v=>v[i]),dayVectors.map(v=>v[j]))});
const minuteMean=mean(minute),minuteSd=sd(minute);
const result={seeds:10,daysPerSeed:20,stockDays:daily.length,wallSeconds:(performance.now()-started)/1000,dailyVolPct:sd(daily)*100,meanDailyPct:mean(daily)*100,minuteKurtosis:mean(minute.map(v=>((v-minuteMean)/minuteSd)**4)),minuteACF1:mean(stats.map(s=>s.acf1).filter(Number.isFinite)),absMinuteACF1:mean(stats.map(s=>s.absacf1).filter(Number.isFinite)),absMinuteACF5:mean(stats.map(s=>s.absacf5).filter(Number.isFinite)),volumeAbsReturnCorr:mean(stats.map(s=>s.volvol).filter(Number.isFinite)),sameSectorCorr:mean(pairs.filter(p=>p.same).map(p=>p.r)),otherSectorCorr:mean(pairs.filter(p=>!p.same).map(p=>p.r)),limitCloseRate:limits/daily.length,missingBookRate:missing/samples,medianSpreadCents:spreads[Math.floor(spreads.length*.5)],p95SpreadCents:spreads[Math.floor(spreads.length*.95)],zeroMinuteRate:zeros/bars,validatedRestores:restores};
console.log(JSON.stringify(result,null,2));
