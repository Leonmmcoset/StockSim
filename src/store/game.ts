import { create } from 'zustand';
import type { CommandResult, MarketSnapshot, OrderInput, OrderPreview } from '../engine/types';
import { ApiError, ApiIdentityError, request, preview, type AdminUsers, type CommandResponse, type MarketMeta, type SessionResponse, type SnapshotResponse, type User, type PlayerProfile, type LeaderboardResponse, type LeaderboardSort } from '../lib/api';

export type ChartMode = 'intraday' | 'daily';
export interface Notice { id: number; text: string; tone: 'success' | 'error' | 'info' }
type PendingOrder = { path: string; body: unknown; key: string };
interface GameStore {
 snapshot: MarketSnapshot | null; user: User | null; market: MarketMeta | null; csrfToken: string; registrationOpen: boolean;
 connection: 'connecting' | 'online' | 'offline' | 'reconnecting'; initError: string | null; initializing: boolean; ready: boolean; sessionRevision: number;
 selectedSymbol: string; chartMode: ChartMode; watchlist: string[]; notice: Notice | null; settingsOpen: boolean; settingsTab: 'save'|'rules'|'model'|'admin';
 uncertainOrder: PendingOrder | null; commandPending: boolean; marketPending: boolean;
 playerProfile: PlayerProfile | null; leaderboard: LeaderboardResponse | null; playerStatsPending: boolean; playerStatsError: string | null; uncertainVisibility: { key: string; value: boolean } | null; playerStatsRevision: number;
 refreshPlayerProfile(signal?: AbortSignal): Promise<void>; refreshLeaderboard(sort: LeaderboardSort, signal?: AbortSignal): Promise<void>; setLeaderboardVisibility(value: boolean): Promise<void>; retryLeaderboardVisibility(): Promise<void>; clearLeaderboard(): void;
 initialize(): Promise<void>; authenticate(mode: 'login'|'register', username: string, password: string): Promise<void>; logout(): Promise<void>; refreshSnapshot(): Promise<void>; acceptSnapshot(data: SnapshotResponse): boolean; verifyIdentity(userId: string): boolean;
 selectStock(symbol: string): void; setChartMode(mode: ChartMode): void; toggleWatchlist(symbol: string): void;
 submitOrder(input: OrderInput): Promise<CommandResult>; cancelOrder(id: string): Promise<CommandResult>; retryOrder(): Promise<CommandResult>; previewOrder(input: OrderInput, signal?: AbortSignal): Promise<OrderPreview>;
 marketAction(action: 'pause'|'resume'|'speed'|'skipLunch'|'nextDay', speed?: number): Promise<void>;
 adminBackup(): Promise<Blob>; adminUsers(): Promise<AdminUsers>; setBan(id: string, banned: boolean): Promise<AdminUsers>; setRegistration(registrationOpen: boolean): Promise<AdminUsers>;
 clearNotice(): void; setSettingsOpen(open: boolean, tab?: 'save'|'rules'|'model'|'admin'): void; setSettingsTab(tab: 'save'|'rules'|'model'|'admin'): void;
}
let events: EventSource | null = null;
let authController: AbortController | null = null;
let epoch = 0;
let streamSequence = 0;
let disconnectSequence = 0;
let profileSequence = 0;
let leaderboardSequence = 0;
let seq = 0;
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const makeNotice = (text: string, tone: Notice['tone'] = 'info'): Notice => ({ id: ++seq, text, tone });
function closeEvents() { events?.close(); events = null; }
const visibilityReceiptKey = 'stocksim.visibility.pending.v1';
function saveVisibilityReceipt(userId: string, operation: { key: string; value: boolean }) {
 try { sessionStorage.setItem(visibilityReceiptKey, JSON.stringify({ userId, ...operation })); } catch { /* Memory still protects this session when storage is unavailable. */ }
}
function clearVisibilityReceipt() { try { sessionStorage.removeItem(visibilityReceiptKey); } catch { /* Storage may be unavailable. */ } }
function restoreVisibilityReceipt(userId: string): { key: string; value: boolean } | null {
 try {
  const raw = sessionStorage.getItem(visibilityReceiptKey); if (!raw) return null;
  const receipt = JSON.parse(raw);
  if (receipt.userId !== userId || typeof receipt.key !== 'string' || !receipt.key || typeof receipt.value !== 'boolean') { clearVisibilityReceipt(); return null; }
  return { key: receipt.key, value: receipt.value };
 } catch { return null; }
}
function clearPrivate() { clearVisibilityReceipt(); ++epoch; ++profileSequence; ++leaderboardSequence; authController?.abort(); authController = null; closeEvents(); useGameStore.setState({ user: null, snapshot: null, market: null, playerProfile: null, leaderboard: null, playerStatsPending: false, playerStatsError: null, uncertainVisibility: null, playerStatsRevision: 0, csrfToken: '', connection: 'offline', ready: false, initializing: false, settingsOpen: false, settingsTab: 'save', notice: null, selectedSymbol: '', watchlist: [], chartMode: 'intraday', uncertainOrder: null, commandPending: false, marketPending: false, sessionRevision: useGameStore.getState().sessionRevision + 1 }); }
function authError(error: unknown) { if (error instanceof ApiIdentityError) { useGameStore.getState().verifyIdentity(error.actualUserId ?? ''); return true; } if (error instanceof ApiError && error.status === 401) { clearPrivate(); const generation = epoch; void useGameStore.getState().initialize().then(() => { if (generation === epoch) useGameStore.setState({ initError: '会话已失效，请重新登录' }); }); return true; } return false; }
function subscribe() {
 closeEvents();
 if (typeof EventSource === 'undefined') return;
 const generation = epoch;
 const source = new EventSource('/api/events'); events = source;
 source.addEventListener('snapshot', event => { if (generation !== epoch) return; try { if (useGameStore.getState().acceptSnapshot(JSON.parse((event as MessageEvent).data))) { streamSequence++; useGameStore.setState({ connection: 'online' }); } } catch { /* malformed data ignored */ } });
 source.onopen = () => { /* The first authoritative snapshot marks the connection online. */ };
 source.onerror = () => { if (generation === epoch) { useGameStore.setState({ connection: 'reconnecting' }); void useGameStore.getState().refreshSnapshot(); } };
}
const failResult = (error: unknown): CommandResult => ({ ok: false, error: message(error) });
function newIdempotencyKey(): string {
 const source = globalThis.crypto;
 if (!source?.getRandomValues) throw new Error('浏览器不支持安全随机数，无法提交委托');
 if (typeof source.randomUUID === 'function') return source.randomUUID();
 const bytes = source.getRandomValues(new Uint8Array(16));
 bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
 const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
 return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function startOrder(path: string, body: unknown): Promise<CommandResult> {
 try { return executeOrder({ path, body, key: newIdempotencyKey() }); }
 catch (error) { useGameStore.setState({ notice: makeNotice(message(error), 'error') }); return Promise.resolve(failResult(error)); }
}
async function executeOrder(order: PendingOrder): Promise<CommandResult> {
 const state = useGameStore.getState();
 if (state.commandPending) return { ok: false, error: '请求处理中' };
 if (state.connection !== 'online') return { ok: false, error: '连接未就绪' };
 const generation = epoch;
 useGameStore.setState({ commandPending: true });
 try {
  const data = await request<CommandResponse>(order.path, { body: order.body, csrf: state.csrfToken, key: order.key, expectedUserId: state.user?.id ?? '' });
  if (generation !== epoch) return { ok: false, error: '会话已更改' };
  if (!useGameStore.getState().acceptSnapshot(data)) return { ok: false, error: '会话已更改，请重试' };
  useGameStore.setState({ uncertainOrder: null, notice: makeNotice(data.result.ok ? '委托操作成功' : data.result.error ?? '委托失败', data.result.ok ? 'success' : 'error') });
  return data.result;
 } catch (error) {
  if (generation !== epoch) return failResult(error);
  if (!authError(error)) {
   const uncertain = !(error instanceof ApiError) || error.status >= 500;
   useGameStore.setState({ uncertainOrder: uncertain ? order : null, notice: makeNotice(uncertain ? '结果未知，请使用原请求重试或查看委托记录' : message(error), 'error') });
  }
  return failResult(error);
 } finally { if (generation === epoch) useGameStore.setState({ commandPending: false }); }
}
export const useGameStore = create<GameStore>((set, get) => ({
 snapshot: null, user: null, market: null, csrfToken: '', registrationOpen: true, connection: 'connecting', initError: null, initializing: false, ready: false, sessionRevision: 0,
 selectedSymbol: '', chartMode: 'intraday', watchlist: [], notice: null, settingsOpen: false, settingsTab: 'save', uncertainOrder: null, commandPending: false, marketPending: false, playerProfile: null, leaderboard: null, playerStatsPending: false, playerStatsError: null, uncertainVisibility: null, playerStatsRevision: 0,
 async refreshPlayerProfile(signal) {
  const state = get(); if (!state.user || state.connection !== 'online' || state.playerStatsPending || state.uncertainVisibility) return; const generation = epoch; const current = ++profileSequence;
  try { const data = await request<PlayerProfile>('/profile', { expectedUserId: state.user.id, signal }); if (generation !== epoch || current !== profileSequence || signal?.aborted || get().connection !== 'online') return; if (!get().verifyIdentity(data.userId)) return; if (data.revision < get().playerStatsRevision || (get().playerProfile && data.revision < get().playerProfile!.revision) || (get().leaderboard && data.revision < get().leaderboard!.revision)) return; set({ playerProfile: data, playerStatsRevision: data.revision, leaderboard: get().leaderboard && get().leaderboard!.revision < data.revision ? null : get().leaderboard, playerStatsError: null }); }
  catch (error) { if (generation !== epoch || current !== profileSequence || signal?.aborted) return; if (!authError(error)) set({ playerStatsError: message(error) }); }
 },
 async refreshLeaderboard(sort, signal) {
  const state = get(); if (!state.user || state.connection !== 'online' || state.playerStatsPending || state.uncertainVisibility) return; const generation = epoch; const current = ++leaderboardSequence;
  try { const data = await request<LeaderboardResponse>(`/leaderboard?sortBy=${sort}`, { expectedUserId: state.user.id, signal }); if (generation !== epoch || current !== leaderboardSequence || signal?.aborted || get().connection !== 'online') return; if (!get().verifyIdentity(data.userId)) return; if (data.revision < get().playerStatsRevision || data.sortBy !== sort || (get().leaderboard && data.revision < get().leaderboard!.revision) || (get().playerProfile && data.revision < get().playerProfile!.revision)) return; set({ leaderboard: data, playerStatsRevision: data.revision, playerStatsError: null }); }
  catch (error) { if (generation !== epoch || current !== leaderboardSequence || signal?.aborted) return; if (!authError(error)) set({ leaderboard: null, playerStatsError: message(error) }); }
 },
 async setLeaderboardVisibility(value) {
  const state = get(); if (!state.user || state.connection !== 'online' || state.playerStatsPending || state.uncertainVisibility) return;
  let key: string; try { key = newIdempotencyKey(); } catch (error) { set({ playerStatsError: message(error) }); return; }
  const operation = { key, value }; saveVisibilityReceipt(state.user.id, operation); set({ uncertainVisibility: operation }); await get().retryLeaderboardVisibility();
 },
 async retryLeaderboardVisibility() {
  const state = get(); const operation = state.uncertainVisibility;
  if (!state.user || state.connection !== 'online' || state.playerStatsPending || !operation) return;
  const generation = epoch; const connectionGeneration = disconnectSequence; ++profileSequence; ++leaderboardSequence;
  set({ playerStatsPending: true, playerProfile: null, leaderboard: null, playerStatsError: null });
  try {
   const data = await request<PlayerProfile>('/profile/visibility', { body: { leaderboardOptIn: operation.value }, key: operation.key, csrf: state.csrfToken, expectedUserId: state.user.id });
   if (generation !== epoch) return;
   if (!get().verifyIdentity(data.userId)) return;
   if (get().connection !== 'online' || connectionGeneration !== disconnectSequence) { set({ playerStatsError: '公开状态未确认，连接恢复后使用原请求确认' }); return; }
   clearVisibilityReceipt(); set({ uncertainVisibility: null, playerStatsRevision: Math.max(get().playerStatsRevision, data.revision) });
  } catch (error) {
   if (generation !== epoch) return;
   if (!authError(error)) {
    set({ uncertainVisibility: operation, playerStatsError: `${message(error)} · 公开状态仍待确认，请使用原请求确认` });
   }
  } finally { if (generation === epoch) set({ playerStatsPending: false }); }
 },
 clearLeaderboard() { ++leaderboardSequence; set({ leaderboard: null }); },
 async initialize() { if (get().initializing) return; set({ initializing: true, connection: 'connecting', initError: null }); const generation = epoch; try { const data = await request<SessionResponse>('/session'); if (generation !== epoch) return; if (get().user && get().user?.id !== data.user?.id) { clearPrivate(); set({ ...data, initializing: false, connection: data.user ? 'connecting' : 'offline' }); const nextGeneration = epoch; if (data.user) { await get().refreshSnapshot(); if (get().user && nextGeneration === epoch) subscribe(); } return; } set({ ...data, ...(data.user ? { uncertainVisibility: (get().user?.id === data.user.id ? get().uncertainVisibility : null) ?? restoreVisibilityReceipt(data.user.id) } : {}), initializing: false, connection: data.user ? 'connecting' : 'offline' }); if (data.user) { await get().refreshSnapshot(); if (get().user && generation === epoch) subscribe(); } } catch (error) { if (generation === epoch) set({ initializing: false, connection: 'offline', initError: message(error) }); } },
 async authenticate(mode, username, password) { const generation = ++epoch; authController?.abort(); const controller = new AbortController(); authController = controller; closeEvents(); set({ initError: null, initializing: false }); try { const data = await request<SessionResponse>(`/${mode}`, { body: { username, password }, csrf: get().csrfToken, signal: controller.signal }); if (generation !== epoch) return; set({ ...data, sessionRevision: get().sessionRevision + 1, playerProfile: null, leaderboard: null, playerStatsPending: false, playerStatsError: null, uncertainVisibility: data.user ? ((get().user?.id === data.user.id ? get().uncertainVisibility : null) ?? restoreVisibilityReceipt(data.user.id)) : null, playerStatsRevision: 0, connection: 'connecting', snapshot: null, ready: false, selectedSymbol: '', watchlist: [], chartMode: 'intraday', settingsOpen: false, notice: null }); await get().refreshSnapshot(); if (get().user && generation === epoch) subscribe(); } catch (error) { if (generation === epoch) { set({ initError: message(error) }); throw error; } } finally { if (authController === controller) authController = null; } },
 async logout() { const csrf = get().csrfToken; clearPrivate(); const generation = epoch; try { await request<void>('/logout', { body: {}, csrf }); if (generation === epoch) void get().initialize(); } catch (error) { if (generation !== epoch) return; if (error instanceof ApiError && error.status === 401) void get().initialize(); else set({ initError: '退出请求未确认，服务器会话可能仍有效；请重试连接后退出' }); } },
 async refreshSnapshot() { const generation = epoch; const observedStreamSequence = streamSequence; try { const data = await request<SnapshotResponse>('/snapshot', { expectedUserId: get().user?.id ?? '' }); if (generation !== epoch) return; if (!get().acceptSnapshot(data)) return; if (streamSequence === observedStreamSequence) set({ connection: events && get().connection !== 'online' ? 'reconnecting' : 'online', initError: null }); } catch (error) { if (generation !== epoch) return; if (!authError(error) && streamSequence === observedStreamSequence) set({ connection: 'reconnecting', initError: message(error) }); } },
 verifyIdentity(userId) { if (get().user?.id === userId && !!userId) return true; clearPrivate(); void get().initialize(); return false; },
 acceptSnapshot(data) { if (!get().verifyIdentity(data.userId)) return false; if (get().market && data.market.revision < get().market!.revision) return true; const symbols = data.snapshot.quotes; set({ snapshot: data.snapshot, market: data.market, ready: true, selectedSymbol: symbols.some(q => q.symbol === get().selectedSymbol) ? get().selectedSymbol : symbols[0]?.symbol ?? '', watchlist: get().ready ? get().watchlist : symbols.slice(0, 6).map(q => q.symbol) }); return true; },
 selectStock(selectedSymbol) { set({ selectedSymbol }); }, setChartMode(chartMode) { set({ chartMode }); }, toggleWatchlist(symbol) { const list = get().watchlist; set({ watchlist: list.includes(symbol) ? list.filter(s => s !== symbol) : [...list, symbol] }); },
 submitOrder(input) { if (get().uncertainOrder) return Promise.resolve({ ok: false, error: '请先处理结果未知的请求' }); return startOrder('/orders', input); },
 cancelOrder(id) { if (get().uncertainOrder) return Promise.resolve({ ok: false, error: '请先处理结果未知的请求' }); return startOrder(`/orders/${encodeURIComponent(id)}/cancel`, {}); },
 retryOrder() { const order = get().uncertainOrder; return order ? executeOrder(order) : Promise.resolve({ ok: false, error: '没有待重试请求' }); },
 previewOrder(input, signal) { const generation = epoch; return preview(input, get().csrfToken, get().user?.id ?? '', signal).catch(error => { if (generation === epoch) authError(error); throw error; }); },
 async marketAction(action, speed) { if (get().marketPending || get().connection !== 'online') return; const generation = epoch; set({ marketPending: true }); try { const data = await request<SnapshotResponse>('/admin/market', { body: { action, ...(speed !== undefined ? { speed } : {}) }, csrf: get().csrfToken, expectedUserId: get().user?.id ?? '' }); if (generation === epoch) get().acceptSnapshot(data); } catch (error) { if (generation === epoch && !authError(error)) set({ notice: makeNotice(message(error), 'error') }); } finally { if (generation === epoch) set({ marketPending: false }); } },
 adminBackup() { const generation = epoch; return request<Blob>('/admin/backup', { expectedUserId: get().user?.id ?? '', responseType: 'blob' }).then(value => { if (generation !== epoch) throw new Error('会话已更改'); return value; }).catch(error => { if (generation === epoch) authError(error); throw error; }); },
 adminUsers() { const generation = epoch; return request<AdminUsers>('/admin/users', { expectedUserId: get().user?.id ?? '' }).then(value => { if (generation !== epoch) throw new Error('会话已更改'); return value; }).catch(error => { if (generation === epoch) authError(error); throw error; }); },
 setBan(id, banned) { const generation = epoch; return request<AdminUsers>(`/admin/users/${encodeURIComponent(id)}/ban`, { body: { banned }, csrf: get().csrfToken, expectedUserId: get().user?.id ?? '' }).then(value => { if (generation !== epoch) throw new Error('会话已更改'); return value; }).catch(error => { if (generation === epoch) authError(error); throw error; }); },
 setRegistration(registrationOpen) { const generation = epoch; return request<AdminUsers>('/admin/settings', { body: { registrationOpen }, csrf: get().csrfToken, expectedUserId: get().user?.id ?? '' }).then(value => { if (generation !== epoch) throw new Error('会话已更改'); return value; }).catch(error => { if (generation === epoch) authError(error); throw error; }); },
 clearNotice() { set({ notice: null }); }, setSettingsOpen(settingsOpen, tab) { set({ settingsOpen, ...(settingsOpen ? { settingsTab: tab ?? 'save' } : {}) }); }, setSettingsTab(settingsTab) { set({ settingsTab }); },
}));
useGameStore.subscribe((state, previous) => { if (previous.connection === 'online' && state.connection !== 'online') ++disconnectSequence; });
export function startGameLoop() { return () => closeEvents(); }
