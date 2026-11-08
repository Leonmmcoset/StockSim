import { beforeEach, expect, test, vi } from 'vitest';
import { useGameStore } from '../src/store/game';

const user = { id: 'u', username: 'alice', role: 'user', banned: false, createdAt: '' };
const market = (revision: number) => ({ revision, running: true, speed: 1, savedAt: '' });
const envelope = (revision: number) => ({ userId: 'u', market: market(revision), snapshot: { quotes: [], marker: revision } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...((value && typeof value === 'object' && 'userId' in value) ? { 'X-User-Id': String(value.userId) } : {}) } });

beforeEach(() => {
  vi.restoreAllMocks();
  useGameStore.setState({ user: null, snapshot: null, market: null, csrfToken: '', connection: 'offline', uncertainOrder: null });
});

test('older snapshots cannot overwrite a newer revision', () => {
  useGameStore.setState({ user });
  useGameStore.getState().acceptSnapshot(envelope(4) as never);
  useGameStore.getState().acceptSnapshot(envelope(2) as never);
  expect(useGameStore.getState().market?.revision).toBe(4);
});

test('uncertain order retry retains the original idempotency key and body', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    requests.push(init);
    if (requests.length === 1) throw new TypeError('network');
    return json({ ...envelope(2), result: { ok: true } });
  }));
  useGameStore.setState({ user, csrfToken: 'token', connection: 'online' });
  const input = { symbol: '600000', side: 'buy' as const, price: 100, quantity: 100 };
  await useGameStore.getState().submitOrder(input);
  await useGameStore.getState().retryOrder();
  expect(requests).toHaveLength(2);
  expect(requests[0].body).toBe(requests[1].body);
  expect((requests[0].headers as Record<string, string>)['Idempotency-Key']).toBe((requests[1].headers as Record<string, string>)['Idempotency-Key']);
});

test('unauthorized responses remove private snapshot and user', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'expired' }, 401)));
  useGameStore.setState({ user, csrfToken: 'token', connection: 'online', snapshot: envelope(1).snapshot as never });
  await useGameStore.getState().refreshSnapshot();
  expect(useGameStore.getState().snapshot).toBeNull();
  expect(useGameStore.getState().user).toBeNull();
});

test('logout clears private data immediately and ignores a late snapshot', async () => {
  let resolveSnapshot!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/snapshot') return new Promise<Response>(resolve => { resolveSnapshot = resolve; });
    if (url === '/api/logout') return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json({ user: null, csrfToken: 'anon', registrationOpen: true, market: market(1) }));
  }));
  useGameStore.setState({ user, csrfToken: 'token', connection: 'online', snapshot: envelope(1).snapshot as never });
  const pending = useGameStore.getState().refreshSnapshot();
  const loggingOut = useGameStore.getState().logout();
  expect(useGameStore.getState().snapshot).toBeNull();
  resolveSnapshot(json(envelope(9)));
  await pending;
  await loggingOut;
  expect(useGameStore.getState().snapshot).toBeNull();
  expect(useGameStore.getState().user).toBeNull();
});

test('late login cannot restore a session after logout', async () => {
  let resolveLogin!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/login') return new Promise<Response>(resolve => { resolveLogin = resolve; });
    if (url === '/api/logout') return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json({ user: null, csrfToken: 'anon', registrationOpen: true, market: market(1) }));
  }));
  useGameStore.setState({ csrfToken: 'anon' });
  const login = useGameStore.getState().authenticate('login', 'alice', 'password');
  await useGameStore.getState().logout();
  resolveLogin(json({ user, csrfToken: 'old', registrationOpen: true, market: market(2) }));
  await login;
  expect(useGameStore.getState().user).toBeNull();
  expect(useGameStore.getState().snapshot).toBeNull();
});

test('old administrator 401 cannot clear a newer login', async () => {
  let resolveAdmin!: (response: Response) => void;
  const newer = { ...user, id: 'new', username: 'bob' };
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/admin/users') return new Promise<Response>(resolve => { resolveAdmin = resolve; });
    if (url === '/api/login') return Promise.resolve(json({ user: newer, csrfToken: 'new', registrationOpen: true, market: market(2) }));
    if (url === '/api/snapshot') return Promise.resolve(json({ ...envelope(2), userId: 'new' }));
    return Promise.resolve(json({ user: null, csrfToken: 'anon', registrationOpen: true, market: market(1) }));
  }));
  useGameStore.setState({ user: { ...user, role: 'admin' }, csrfToken: 'old', connection: 'online' });
  const oldRequest = useGameStore.getState().adminUsers().catch(() => null);
  await useGameStore.getState().authenticate('login', 'bob', 'password');
  resolveAdmin(json({ error: 'expired' }, 401));
  await oldRequest;
  expect(useGameStore.getState().user?.id).toBe('new');
});

test('an intentionally empty watchlist stays empty after market updates', () => {
  const q = { symbol: '600000' };
  useGameStore.setState({ user, ready: false, snapshot: null, market: null, watchlist: [] });
  useGameStore.getState().acceptSnapshot({ userId: 'u', market: market(1), snapshot: { quotes: [q] } } as never);
  useGameStore.getState().toggleWatchlist(q.symbol);
  useGameStore.getState().acceptSnapshot({ userId: 'u', market: market(2), snapshot: { quotes: [q] } } as never);
  expect(useGameStore.getState().watchlist).toEqual([]);
});

test('orders generate distinct secure idempotency keys without randomUUID', async () => {
  const keys: string[] = [];
  const realCrypto = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    keys.push((init.headers as Record<string, string>)['Idempotency-Key']);
    return json({ ...envelope(2), result: { ok: true } });
  }));
  useGameStore.setState({ user, csrfToken: 'token', connection: 'online', uncertainOrder: null });
  const input = { symbol: '600000', side: 'buy' as const, price: 100, quantity: 100 };
  await useGameStore.getState().submitOrder(input);
  await useGameStore.getState().submitOrder(input);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[0]).not.toEqual(keys[1]);
});

test('a late refresh cannot undo a reconnected SSE snapshot', async () => {
  let stream!: { emit: (data: unknown) => void; onerror: (() => void) | null; close: () => void };
  class FakeSource {
    onerror: (() => void) | null = null; onopen = null; callback: ((event: MessageEvent) => void) | null = null;
    constructor() { stream = this; }
    addEventListener(_name: string, callback: (event: MessageEvent) => void) { this.callback = callback; }
    emit(data: unknown) { this.callback?.({ data: JSON.stringify(data) } as MessageEvent); }
    close() {}
  }
  let resolveRefresh!: (response: Response) => void; let count = 0;
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/session') return Promise.resolve(json({ user, csrfToken: 'token', registrationOpen: true, market: market(1) }));
    if (url === '/api/snapshot' && ++count === 1) return Promise.resolve(json(envelope(1)));
    return new Promise<Response>(resolve => { resolveRefresh = resolve; });
  }));
  useGameStore.setState({ user: null, initializing: false, market: null, snapshot: null });
  await useGameStore.getState().initialize();
  stream.onerror?.();
  stream.emit(envelope(3));
  expect(useGameStore.getState().connection).toBe('online');
  resolveRefresh(json(envelope(2)));
  await vi.waitFor(() => expect(useGameStore.getState().market?.revision).toBe(3));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(useGameStore.getState().connection).toBe('online');
});

test('a snapshot belonging to a new cookie identity clears old data and reloads session', async () => {
  const bob = { ...user, id: 'bob', username: 'bob' };
  const bobSnapshot = { ...envelope(3), userId: bob.id };
  let resolveOld!: (response: Response) => void; let count = 0;
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/snapshot' && ++count === 1) return new Promise<Response>(resolve => { resolveOld = resolve; });
    if (url === '/api/session') return Promise.resolve(json({ user: bob, csrfToken: 'bob-token', registrationOpen: true, market: market(3) }));
    return Promise.resolve(json(bobSnapshot));
  }));
  useGameStore.setState({ user, csrfToken: 'alice-token', connection: 'online', initializing: false, market: market(1), snapshot: envelope(1).snapshot as never, selectedSymbol: 'alice-draft', watchlist: ['secret'] });
  const pending = useGameStore.getState().refreshSnapshot();
  resolveOld(json(bobSnapshot));
  await pending;
  expect(useGameStore.getState().snapshot).toBeNull();
  await vi.waitFor(() => expect(useGameStore.getState().user?.id).toBe('bob'));
  expect(useGameStore.getState().csrfToken).toBe('bob-token');
  expect(useGameStore.getState().watchlist).not.toContain('secret');
});

test('a command response for another cookie identity never exposes its account', async () => {
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/orders') return Promise.resolve(json({ ...envelope(4), userId: 'bob', result: { ok: true } }));
    return new Promise<Response>(() => {});
  }));
  useGameStore.setState({ user, csrfToken: 'alice', connection: 'online', market: market(1), snapshot: envelope(1).snapshot as never, initializing: false, uncertainOrder: null, commandPending: false });
  const result = await useGameStore.getState().submitOrder({ symbol: '600000', side: 'buy', price: 100, quantity: 100 });
  expect(result.ok).toBe(false);
  expect(useGameStore.getState().user).toBeNull();
  expect(useGameStore.getState().snapshot).toBeNull();
  expect(useGameStore.getState().connection).not.toBe('online');
});

test('admin response for a different cookie identity is rejected before showing users', async () => {
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/admin/users') return Promise.resolve(new Response(JSON.stringify({ users: [{ username: 'bob-secret' }], registrationOpen: true }), { status: 200, headers: { 'X-User-Id': 'bob', 'Content-Type': 'application/json' } }));
    return new Promise<Response>(() => {});
  }));
  useGameStore.setState({ user: { ...user, role: 'admin' }, csrfToken: 'alice', connection: 'online', initializing: false, snapshot: envelope(1).snapshot as never });
  await expect(useGameStore.getState().adminUsers()).rejects.toThrow();
  expect(useGameStore.getState().snapshot).toBeNull();
  expect(useGameStore.getState().user).toBeNull();
});

test('preview response with another identity is rejected before exposing estimates', async () => {
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/orders/preview') return Promise.resolve(new Response(JSON.stringify({ maxBuyQuantity: 9999 }), { status: 200, headers: { 'X-User-Id': 'bob', 'Content-Type': 'application/json' } }));
    return new Promise<Response>(() => {});
  }));
  useGameStore.setState({ user, csrfToken: 'alice', connection: 'online', initializing: false, snapshot: envelope(1).snapshot as never });
  await expect(useGameStore.getState().previewOrder({ symbol: '600000', side: 'buy', price: 100, quantity: 100 })).rejects.toThrow();
  expect(useGameStore.getState().user).toBeNull();
  expect(useGameStore.getState().snapshot).toBeNull();
});

test('authenticated orders bind the expected account before reaching the server', async () => {
  let headers: Record<string, string> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return json({ ...envelope(2), result: { ok: true } });
  }));
  useGameStore.setState({ user, csrfToken: 'token', connection: 'online', uncertainOrder: null, commandPending: false });
  await useGameStore.getState().submitOrder({ symbol: '600000', side: 'buy', price: 100, quantity: 100 });
  expect(headers['X-Expected-User-Id']).toBe('u');
});

test('a late failed refresh cannot undo a reconnected SSE snapshot', async () => {
  let stream!: { emit: (data: unknown) => void; onerror: (() => void) | null; close: () => void };
  class FakeSource {
    onerror: (() => void) | null = null; onopen = null; callback: ((event: MessageEvent) => void) | null = null;
    constructor() { stream = this; }
    addEventListener(_name: string, callback: (event: MessageEvent) => void) { this.callback = callback; }
    emit(data: unknown) { this.callback?.({ data: JSON.stringify(data) } as MessageEvent); }
    close() {}
  }
  let rejectRefresh!: (error: Error) => void; let count = 0;
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/session') return Promise.resolve(json({ user, csrfToken: 'token', registrationOpen: true, market: market(1) }));
    if (url === '/api/snapshot' && ++count === 1) return Promise.resolve(json(envelope(1)));
    return new Promise<Response>((_resolve, reject) => { rejectRefresh = reject; });
  }));
  useGameStore.setState({ user: null, initializing: false, market: null, snapshot: null });
  await useGameStore.getState().initialize();
  stream.onerror?.();
  stream.emit(envelope(3));
  expect(useGameStore.getState().connection).toBe('online');
  rejectRefresh(new Error('timeout'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(useGameStore.getState().connection).toBe('online');
});
