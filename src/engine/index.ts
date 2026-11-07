export type * from './types';
export { DEFAULT_SEED } from './data';
import type { MarketEngine, MarketOptions } from './types';
import { Market } from './market';
import { validateSave } from './save';
export function createMarket(options?: MarketOptions): MarketEngine { return new Market(options); }
export function importMarket(state: unknown): MarketEngine { return new Market({}, validateSave(state)); }

export { normalizeEquityCurve, selectReviewPeriod } from './review';
