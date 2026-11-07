import { z } from 'zod';
import type { MarketSave } from '../engine/types';

export interface UISettings {
  selectedSymbol: string;
  chartMode: 'intraday' | 'daily';
  watchlist: string[];
  speed: number;
}
export interface GameSave {
  format: 'stock-sim';
  version: 1;
  savedAt: string;
  engine: MarketSave;
  preferences: UISettings;
}

export const STORAGE_KEY = 'stock-sim.save.v1';
const MAX_BYTES = 12 * 1024 * 1024;
const symbol = z.string().regex(/^6\d{5}$/);
const settingsSchema = z.strictObject({
  selectedSymbol: symbol,
  chartMode: z.enum(['intraday', 'daily']),
  watchlist: z.array(symbol).max(12).refine((items) => new Set(items).size === items.length),
  speed: z.union([z.literal(1), z.literal(4), z.literal(16), z.literal(64)]),
});
const saveSchema = z.strictObject({
  format: z.literal('stock-sim'),
  version: z.literal(1),
  savedAt: z.iso.datetime(),
  engine: z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]), data: z.unknown() }),
  preferences: settingsSchema,
});

// Engine validation belongs to importMarket; this layer only permits safe JSON data.
function assertSafeJson(value: unknown): void {
  const stack: Array<{ value: unknown; exit?: boolean }> = [{ value }];
  const active = new Set<object>();
  while (stack.length) {
    const entry = stack.pop()!;
    const item = entry.value;
    if (entry.exit) { active.delete(item as object); continue; }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number' && Number.isFinite(item)) continue;
    if (typeof item !== 'object') throw new Error('存档包含无效数据');
    if (active.has(item)) throw new Error('存档包含循环引用');
    active.add(item);
    stack.push({ value: item, exit: true });
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new Error('存档包含无效对象');
    for (const [key, child] of Object.entries(item)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error('存档包含不安全字段');
      stack.push({ value: child });
    }
  }
}

function validate(value: unknown): GameSave {
  assertSafeJson(value);
  const result = saveSchema.safeParse(value);
  if (!result.success || !Object.hasOwn(result.data.engine, 'data')) throw new Error('存档格式或版本无效');
  return result.data as GameSave;
}
function checkSize(text: string): void {
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('存档超过大小限制');
}
export function createSave(engine: MarketSave, preferences: UISettings): GameSave {
  return validate({ format: 'stock-sim', version: 1, savedAt: new Date().toISOString(), engine, preferences });
}
export function serializeSave(save: GameSave): string {
  const text = JSON.stringify(validate(save));
  checkSize(text);
  return text;
}
export function parseSave(text: string): GameSave {
  checkSize(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('存档不是有效的 JSON'); }
  return validate(value);
}
export function loadLocalSave(storage: Pick<Storage, 'getItem'>): GameSave | null {
  let text: string | null;
  try { text = storage.getItem(STORAGE_KEY); } catch { throw new Error('读取本地存档失败'); }
  return text === null ? null : parseSave(text);
}
export function writeLocalSave(save: GameSave, storage: Pick<Storage, 'setItem'>): void {
  const text = serializeSave(save);
  try { storage.setItem(STORAGE_KEY, text); } catch { throw new Error('保存本地存档失败'); }
}
