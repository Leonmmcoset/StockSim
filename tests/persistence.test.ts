import { describe, expect, it } from 'vitest';
import { createSave, serializeSave, parseSave, loadLocalSave, writeLocalSave, STORAGE_KEY } from '../src/lib/persistence';

const engine = { schemaVersion: 1 as const, data: { cash: 500000, orders: [] } };
const prefs = { selectedSymbol: '600001', chartMode: 'intraday' as const, watchlist: ['600001', '600002'], speed: 4 };

describe('persistence', () => {
  it('round trips a save and preserves data in local storage', () => {
    const save = createSave(engine, prefs);
    expect(Date.parse(save.savedAt)).not.toBeNaN();
    expect(parseSave(serializeSave(save))).toEqual(save);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(loadLocalSave(storage)).toBeNull();
    writeLocalSave(save, storage);
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadLocalSave(storage)).toEqual(save);
  });
  it('rejects unsupported versions and malformed envelope', () => {
    const save = createSave(engine, prefs);
    for (const bad of [{ ...save, version: 2 }, { ...save, engine: { schemaVersion: 3, data: {} } }, { ...save, engine: { schemaVersion: 1 } }]) {
      expect(() => parseSave(JSON.stringify(bad))).toThrow();
    }
    expect(() => parseSave('{')).toThrow();
  });
  it('round trips both engine schema versions and preserves legacy preferences', () => {
    for (const schemaVersion of [1, 2]) {
      const original = {
        format: 'stock-sim', version: 1, savedAt: '2025-01-01T00:00:00.000Z',
        engine: { schemaVersion, data: { cash: 500000, orders: [] } },
        preferences: { selectedSymbol: '600002', chartMode: 'daily', watchlist: ['600002'], speed: 16 },
      };
      const parsed = parseSave(JSON.stringify(original));
      expect(parsed).toEqual(original);
      expect(parseSave(serializeSave(parsed))).toEqual(original);
    }
  });
  it('rejects oversized input, duplicate symbols and invalid speed', () => {
    expect(() => parseSave(' '.repeat(12 * 1024 * 1024 + 1))).toThrow();
    expect(() => createSave(engine, { ...prefs, speed: Infinity })).toThrow();
    expect(() => createSave(engine, { ...prefs, speed: 2 })).toThrow();
    expect(() => createSave(engine, { ...prefs, watchlist: ['600001', '600001'] })).toThrow();
  });
  it('rejects prototype pollution keys and non-finite engine values', () => {
    const save = createSave(engine, prefs);
    const polluted = JSON.stringify(save).replace('"cash":500000', '"__proto__":{"polluted":true},"cash":500000');
    expect(() => parseSave(polluted)).toThrow();
    expect(() => createSave({ schemaVersion: 1, data: { cash: NaN } }, prefs)).toThrow();
  });
  it('reports storage read and write failures in Chinese', () => {
    expect(() => loadLocalSave({ getItem: () => { throw new Error('denied'); } })).toThrow(/读取/);
    expect(() => writeLocalSave(createSave(engine, prefs), { setItem: () => { throw new Error('quota'); } })).toThrow(/保存/);
  });
});
