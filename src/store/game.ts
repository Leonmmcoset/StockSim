import { create } from 'zustand';
import { createMarket, DEFAULT_SEED, importMarket } from '../engine';
import type { CommandResult, MarketEngine, MarketSnapshot, OrderInput, OrderPreview } from '../engine';
import { createSave, loadLocalSave, parseSave, serializeSave, writeLocalSave } from '../lib/persistence';

export type ChartMode = 'intraday' | 'daily';
export interface Notice { id: number; text: string; tone: 'success' | 'error' | 'info' }

interface GameStore {
  snapshot: MarketSnapshot | null;
  ready: boolean;
  initializing: boolean;
  sessionRevision: number;
  initError: string | null;
  selectedSymbol: string;
  running: boolean;
  speed: number;
  chartMode: ChartMode;
  watchlist: string[];
  notice: Notice | null;
  lastSaved: string | null;
  saveError: string | null;
  settingsOpen: boolean;
  settingsTab: 'save' | 'rules' | 'model';
  initialize(): void;
  selectStock(symbol: string): void;
  toggleRunning(): void;
  setSpeed(speed: number): void;
  setChartMode(mode: ChartMode): void;
  toggleWatchlist(symbol: string): void;
  submitOrder(input: OrderInput): CommandResult;
  previewOrder(input: OrderInput): OrderPreview;
  cancelOrder(id: string): CommandResult;
  nextDay(): void;
  skipLunch(): void;
  advance(ticks?: number): void;
  save(): void;
  exportSave(): string;
  importSave(text: string): void;
  newGame(seed: string): void;
  clearNotice(): void;
  setSettingsOpen(open: boolean, tab?: 'save' | 'rules' | 'model'): void;
  setSettingsTab(tab: 'save' | 'rules' | 'model'): void;
}

let engine: MarketEngine | null = null;
let noticeSequence = 0;
const notice = (text: string, tone: Notice['tone'] = 'info'): Notice => ({ id: ++noticeSequence, text, tone });
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const emptyPreview: OrderPreview = { amount: 0, fees: { commission: 0, transfer: 0, stamp: 0, total: 0 }, cashRequired: 0, maxBuyQuantity: 0, maxSellQuantity: 0 };

export const useGameStore = create<GameStore>((set, get) => ({
  snapshot: null, ready: false, initializing: false, sessionRevision: 0, initError: null,
  selectedSymbol: '', running: true, speed: 1, chartMode: 'intraday', watchlist: [],
  notice: null, lastSaved: null, saveError: null, settingsOpen: false, settingsTab: 'save',

  initialize() {
    if (get().ready || get().initializing) return;
    set({ initializing: true, initError: null });
    // Let the terminal's loading screen paint before historical market warmup.
    window.setTimeout(() => {
      try {
        let loaded = null;
        let loadError: string | null = null;
        try { loaded = loadLocalSave(window.localStorage); }
        catch (error) { loadError = message(error); }
        if (loaded) {
          try {
            engine = importMarket(loaded.engine);
            const snapshot = engine.getSnapshot();
            const symbols = new Set(snapshot.quotes.map(q => q.symbol));
            set({ snapshot, ...loaded.preferences,
              selectedSymbol: symbols.has(loaded.preferences.selectedSymbol) ? loaded.preferences.selectedSymbol : snapshot.quotes[0].symbol,
              watchlist: loaded.preferences.watchlist.filter(s => symbols.has(s)),
              ready: true, initializing: false, sessionRevision: get().sessionRevision + 1, running: false, lastSaved: loaded.savedAt,
              notice: notice('已恢复本地存档，点击继续开始交易', 'info'),
            });
            return;
          } catch (error) {
            // Preserve the bad stored save. A deliberate new game is the only replacement path.
            set({ initializing: false, initError: `存档无法恢复：${message(error)}。可在设置中导入备份，或选择重新开局。`, settingsOpen: true, running: false });
            return;
          }
        }
        if (loadError) {
          set({ initializing: false, initError: loadError, settingsOpen: true, running: false });
          return;
        }
        engine = createMarket({ seed: DEFAULT_SEED, startingCash: 500000 });
        const snapshot = engine.getSnapshot();
        set({ snapshot, ready: true, initializing: false, sessionRevision: get().sessionRevision + 1,
          selectedSymbol: snapshot.quotes.find(q => q.last < 3000)?.symbol ?? snapshot.quotes[0].symbol,
          watchlist: snapshot.quotes.slice(0, 6).map(q => q.symbol),
        });
        get().save();
      } catch (error) {
        set({ initializing: false, initError: message(error), running: false });
      }
    }, 60);
  },
  selectStock(symbol) {
    if (!get().snapshot?.quotes.some(q => q.symbol === symbol)) return;
    set({ selectedSymbol: symbol });
  },
  toggleRunning() { if (get().ready) set({ running: !get().running }); },
  setSpeed(speed) { if ([1, 4, 16, 64].includes(speed)) set({ speed }); },
  setChartMode(chartMode) { set({ chartMode }); },
  toggleWatchlist(symbol) {
    const { watchlist, snapshot } = get();
    if (!snapshot?.quotes.some(q => q.symbol === symbol)) return;
    set({ watchlist: watchlist.includes(symbol) ? watchlist.filter(s => s !== symbol) : [...watchlist, symbol] });
    get().save();
  },
  submitOrder(input) {
    if (!engine) return { ok: false, error: '行情引擎尚未准备好' };
    const result = engine.placeOrder(input);
    set({ snapshot: engine.getSnapshot(), notice: notice(result.ok ? `委托已报：${input.side === 'buy' ? '买入' : '卖出'} ${input.symbol} ${input.quantity} 股` : result.error ?? '委托失败', result.ok ? 'success' : 'error') });
    if (result.ok) get().save();
    return result;
  },
  previewOrder(input) { return engine ? engine.previewOrder(input) : emptyPreview; },
  cancelOrder(id) {
    if (!engine) return { ok: false, error: '行情引擎尚未准备好' };
    const result = engine.cancelOrder(id);
    set({ snapshot: engine.getSnapshot(), notice: notice(result.ok ? '撤单成功，未成交部分已解冻' : result.error ?? '撤单失败', result.ok ? 'success' : 'error') });
    if (result.ok) get().save();
    return result;
  },
  advance(ticks) {
    if (!engine || !get().running) return;
    try {
      const beforeTrades = get().snapshot?.trades.length ?? 0;
      engine.step(ticks ?? get().speed);
      const snapshot = engine.getSnapshot();
      set({ snapshot, ...(snapshot.clock.phase === 'lunch' || snapshot.clock.phase === 'closed' ? { running: false } : {}) });
      if (snapshot.trades.length > beforeTrades) {
        const trade = snapshot.trades[0];
        const name = snapshot.quotes.find(q => q.symbol === trade.symbol)?.name ?? trade.symbol;
        set({ notice: notice(`${name} ${trade.side === 'buy' ? '买入' : '卖出'}成交 ${trade.quantity} 股`, 'success') });
        get().save();
      }
    } catch (error) { set({ running: false, notice: notice(message(error), 'error') }); }
  },
  nextDay() {
    if (!engine) return;
    try {
      engine.nextDay();
      set({ snapshot: engine.getSnapshot(), running: false, notice: notice('已进入下一交易日，昨日买入股份可卖', 'success') });
      get().save();
    } catch (error) { set({ notice: notice(message(error), 'error'), running: false }); }
  },
  skipLunch() {
    if (!engine) return;
    engine.skipLunch();
    set({ snapshot: engine.getSnapshot(), running: true });
    get().save();
  },
  save() {
    if (!engine || !get().ready) return;
    try {
      const state = get();
      const save = createSave(engine.exportState(), { selectedSymbol: state.selectedSymbol, chartMode: state.chartMode, watchlist: state.watchlist, speed: state.speed });
      writeLocalSave(save, window.localStorage);
      set({ lastSaved: save.savedAt, saveError: null });
    } catch (error) { set({ saveError: message(error) }); }
  },
  exportSave() {
    if (!engine) throw new Error('引擎未就绪，无法导出');
    const state = get();
    return serializeSave(createSave(engine.exportState(), { selectedSymbol: state.selectedSymbol, chartMode: state.chartMode, watchlist: state.watchlist, speed: state.speed }));
  },
  importSave(text) {
    const saved = parseSave(text);
    const candidate = importMarket(saved.engine);
    const snapshot = candidate.getSnapshot();
    const symbols = new Set(snapshot.quotes.map(q => q.symbol));
    engine = candidate;
    set({ snapshot, ...saved.preferences,
      selectedSymbol: symbols.has(saved.preferences.selectedSymbol) ? saved.preferences.selectedSymbol : snapshot.quotes[0].symbol,
      watchlist: saved.preferences.watchlist.filter(s => symbols.has(s)),
      running: false, ready: true, initializing: false, sessionRevision: get().sessionRevision + 1, initError: null, notice: notice('存档导入成功，市场已暂停', 'success'),
    });
    get().save();
  },
  newGame(seed) {
    const candidate = createMarket({ seed: seed.trim() || DEFAULT_SEED, startingCash: 500000 });
    const snapshot = candidate.getSnapshot();
    engine = candidate;
    set({ snapshot, selectedSymbol: snapshot.quotes.find(q => q.last < 3000)?.symbol ?? snapshot.quotes[0].symbol,
      watchlist: snapshot.quotes.slice(0, 6).map(q => q.symbol), running: false, speed: 1,
      ready: true, initializing: false, sessionRevision: get().sessionRevision + 1, initError: null, notice: notice('新开局已就绪，起始资金 ¥5,000.00', 'success'),
    });
    get().save();
  },
  clearNotice() { set({ notice: null }); },
  setSettingsOpen(settingsOpen, tab) { set({ settingsOpen, ...(settingsOpen ? { settingsTab: tab ?? 'save' } : {}) }); },
  setSettingsTab(settingsTab) { set({ settingsTab }); },
}));

/** Called once by the app; fixed batches, no catch-up after a background tab. */
export function startGameLoop(): () => void {
  const tick = window.setInterval(() => useGameStore.getState().advance(), 1000);
  const save = window.setInterval(() => useGameStore.getState().save(), 10000);
  const onHide = () => { if (document.visibilityState === 'hidden') useGameStore.getState().save(); };
  const onUnload = () => useGameStore.getState().save();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('beforeunload', onUnload);
  return () => {
    window.clearInterval(tick); window.clearInterval(save);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('beforeunload', onUnload);
  };
}
