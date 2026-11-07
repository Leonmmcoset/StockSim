const decimal = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

/** All prices and money entering the UI are integer fen. */
export function money(valueFen: number, decimals = 2): string {
  if (!Number.isFinite(valueFen)) return '—';
  return decimals === 2 ? decimal.format(valueFen / 100) : (valueFen / 100).toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function price(valueFen: number): string {
  return Number.isFinite(valueFen) ? (valueFen / 100).toFixed(2) : '—';
}

/** Percentage points, e.g. 1.2 represents +1.20%. */
export function pct(value: number, sign = true): string {
  if (!Number.isFinite(value)) return '—';
  return `${sign && value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return integer.format(value);
}

export function volume(quantityShares: number): string {
  return compactNumber(quantityShares / 100);
}

export function direction(value: number): 'up' | 'down' | 'flat' {
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}
