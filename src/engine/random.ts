/** Serializable Mulberry32. A separate normal draw is deliberately not cached. */
export function hashSeed(seed:string):number {
  let h=2166136261;for(let i=0;i<seed.length;i++)h=Math.imul(h^seed.charCodeAt(i),16777619);
  return h>>>0;
}
export function random(state:{rng:number}):number {
  state.rng=(state.rng+0x6D2B79F5)>>>0;let t=state.rng;
  t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);
  return ((t^(t>>>14))>>>0)/4294967296;
}
export function normal(state:{rng:number}):number {
  return Math.sqrt(-2*Math.log(Math.max(1e-12,random(state))))*Math.cos(2*Math.PI*random(state));
}
