export interface BookEntry { id: string; side: 'buy' | 'sell'; price: number; remaining: number; seq: number }
export function sortBook<T extends BookEntry>(orders: T[], side: 'buy'|'sell'): T[] {
  return [...orders].sort((a,b)=>(side==='buy'?b.price-a.price:a.price-b.price)||a.seq-b.seq);
}
/** SSE call auction: maximum volume, all strictly better prices filled,
 * at least one equal-price side filled, minimum imbalance, then midpoint. */
export function clearingPrice(orders: BookEntry[]): number | null {
  const bids=orders.filter(o=>o.side==='buy'&&o.remaining>0), asks=orders.filter(o=>o.side==='sell'&&o.remaining>0);
  if(!bids.length||!asks.length)return null;
  const lo=Math.min(...asks.map(o=>o.price)),hi=Math.max(...bids.map(o=>o.price));
  let max=0, imbalance=Infinity, first=0,last=0;
  // All prices in an interval between adjacent submitted prices have identical
  // demand/supply. Its endpoints suffice to preserve the midpoint tie-break.
  const levels=[...new Set(orders.map(o=>o.price))].sort((a,b)=>a-b);
  const candidates=new Set<number>(levels);
  for(let i=1;i<levels.length;i++)if(levels[i]-levels[i-1]>1){candidates.add(levels[i-1]+1);candidates.add(levels[i]-1);}
  for(const p of [...candidates].sort((a,b)=>a-b)){
    if(p<lo||p>hi)continue;
    let b=0,s=0,strictB=0,strictS=0;
    for(const o of bids)if(o.price>=p){b+=o.remaining;if(o.price>p)strictB+=o.remaining;}
    for(const o of asks)if(o.price<=p){s+=o.remaining;if(o.price<p)strictS+=o.remaining;}
    const v=Math.min(b,s),gap=Math.abs(b-s);
    if(!v||strictB>v||strictS>v)continue;
    if(v>max||(v===max&&gap<imbalance)){max=v;imbalance=gap;first=p;last=p;}
    else if(v===max&&gap===imbalance)last=p;
  }
  return max?Math.round((first+last)/2):null;
}
