import { beforeEach, expect, test, vi } from 'vitest';
import { useGameStore } from '../src/store/game';

const user = { id: 'u', username: 'alice', role: 'user' as const, banned: false, createdAt: '' };
const profile = (revision: number, leaderboardOptIn = false) => ({ userId: 'u', revision, username: 'alice', createdAt: '', leaderboardOptIn, performance: {} });
const board = (revision: number, entries: unknown[] = []) => ({ userId: 'u', revision, sortBy: 'totalReturnPct', entries });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'X-User-Id': 'u' } });
beforeEach(() => {
  vi.restoreAllMocks();
  useGameStore.setState({ user, csrfToken: 'token', connection: 'online', playerProfile: null, leaderboard: null, playerStatsPending: false, uncertainVisibility: null, playerStatsRevision: 0 } as never);
});

test('visibility change invalidates an older in-flight leaderboard', async () => {
  let resolveBoard!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('/api/leaderboard') ? new Promise<Response>(resolve => { resolveBoard = resolve; }) : Promise.resolve(json(profile(2, false)))));
  const old = useGameStore.getState().refreshLeaderboard('totalReturnPct');
  await useGameStore.getState().setLeaderboardVisibility(false);
  resolveBoard(json(board(1, [{ username: 'alice' }])));
  await old;
  expect(useGameStore.getState().leaderboard).toBeNull();
});

test('an older profile cannot replace a newer profile', async () => {
  let resolveFirst!: (response: Response) => void;
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(() => ++n === 1 ? new Promise<Response>(resolve => { resolveFirst = resolve; }) : Promise.resolve(json(profile(2, true)))));
  const first = useGameStore.getState().refreshPlayerProfile();
  await useGameStore.getState().refreshPlayerProfile();
  resolveFirst(json(profile(1)));
  await first;
  expect(useGameStore.getState().playerProfile?.leaderboardOptIn).toBe(true);
});

test('leaderboard refresh is blocked while visibility is changing', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn((url: string) => url === '/api/profile/visibility' ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(json(board(1, [{ username: 'alice' }]))));
  vi.stubGlobal('fetch', fetcher);
  const change = useGameStore.getState().setLeaderboardVisibility(false);
  await useGameStore.getState().refreshLeaderboard('totalReturnPct');
  expect(useGameStore.getState().leaderboard).toBeNull();
  finish(json(profile(2, false)));
  await change;
});

test('failed visibility update leaves state unknown when recheck also fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
  useGameStore.setState({ playerProfile: profile(1, true) as never });
  await useGameStore.getState().setLeaderboardVisibility(false);
  expect(useGameStore.getState().playerProfile).toBeNull();
  expect(useGameStore.getState().playerStatsError).toBeTruthy();
});

test('switching account clears the prior account performance immediately', async () => {
  let finishSnapshot!: (response: Response) => void;
  const bob = { ...user, id: 'b', username: 'bob' };
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/login' ? Promise.resolve(json({ user: bob, csrfToken: 'new', registrationOpen: true, market: { revision: 1, running: true, speed: 1, savedAt: '' } })) : new Promise<Response>(resolve => { finishSnapshot = resolve; })));
  useGameStore.setState({ playerProfile: profile(1, true) as never, leaderboard: board(1) as never });
  const login = useGameStore.getState().authenticate('login', 'bob', 'pw');
  await vi.waitFor(() => expect(useGameStore.getState().user?.id).toBe('b'));
  expect(useGameStore.getState().playerProfile).toBeNull();
  expect(useGameStore.getState().leaderboard).toBeNull();
  finishSnapshot(new Response(JSON.stringify({ userId: 'b', market: { revision: 1 }, snapshot: { quotes: [] } }), { headers: { 'X-User-Id': 'b' } }));
  await login;
});

test('session initialization with a different cookie identity clears old performance', async () => {
  const bob = { ...user, id: 'b', username: 'bob' };
  let finishSnapshot!: (response: Response) => void;
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/session' ? Promise.resolve(json({ user: bob, csrfToken: 'new', registrationOpen: true, market: { revision: 1 } })) : new Promise<Response>(resolve => { finishSnapshot = resolve; })));
  useGameStore.setState({ initializing: false, playerProfile: profile(1, true) as never, leaderboard: board(1) as never });
  const initializing = useGameStore.getState().initialize();
  await vi.waitFor(() => expect(useGameStore.getState().user?.id).toBe('b'));
  expect(useGameStore.getState().playerProfile).toBeNull();
  expect(useGameStore.getState().leaderboard).toBeNull();
  finishSnapshot(new Response(JSON.stringify({ userId: 'b', market: { revision: 1 }, snapshot: { quotes: [] } }), { headers: { 'X-User-Id': 'b' } }));
  await initializing;
});

test('a leaderboard older than the latest confirmed profile cannot restore a revoked entry', async () => {
  useGameStore.setState({ playerProfile: profile(10, false) as never });
  vi.stubGlobal('fetch', vi.fn(async () => json(board(9, [{ username: 'alice' }]))));
  await useGameStore.getState().refreshLeaderboard('totalReturnPct');
  expect(useGameStore.getState().leaderboard).toBeNull();
});

test('a timed out visibility update stays unknown and retries the identical request', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/profile/visibility') { requests.push(init); if (requests.length === 1) throw new TypeError('timeout'); return json(profile(3, true)); }
    return json(profile(1, false));
  }));
  await useGameStore.getState().setLeaderboardVisibility(true);
  expect(useGameStore.getState().uncertainVisibility?.value).toBe(true);
  await useGameStore.getState().refreshPlayerProfile();
  await useGameStore.getState().refreshLeaderboard('totalReturnPct');
  expect(useGameStore.getState().playerProfile).toBeNull();
  expect(useGameStore.getState().uncertainVisibility?.value).toBe(true);
  await useGameStore.getState().setLeaderboardVisibility(false);
  expect(requests).toHaveLength(1);
  await useGameStore.getState().retryLeaderboardVisibility();
  expect(requests).toHaveLength(2);
  expect(requests[1].body).toBe(requests[0].body);
  expect((requests[1].headers as Record<string, string>)['Idempotency-Key']).toBe((requests[0].headers as Record<string, string>)['Idempotency-Key']);
  expect(useGameStore.getState().uncertainVisibility).toBeNull();
});

test('a successful visibility response arriving offline stays unknown for retry', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const change = useGameStore.getState().setLeaderboardVisibility(true);
  useGameStore.setState({ connection: 'reconnecting' });
  finish(json(profile(4, true)));
  await change;
  expect(useGameStore.getState().uncertainVisibility?.value).toBe(true);
  expect(useGameStore.getState().playerProfile).toBeNull();
});

test('a profile older than the previous confirmed revision cannot return after visibility update', async () => {
  useGameStore.setState({ playerProfile: profile(10, true) as never, playerStatsRevision: 10 } as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/profile/visibility' ? profile(11, false) : profile(9, true))));
  await useGameStore.getState().setLeaderboardVisibility(false);
  await useGameStore.getState().refreshPlayerProfile();
  expect(useGameStore.getState().playerProfile).toBeNull();
});

test('a response crossing an offline and reconnect cycle still requires original-request confirmation', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const change = useGameStore.getState().setLeaderboardVisibility(true);
  useGameStore.setState({ connection: 'reconnecting' });
  useGameStore.setState({ connection: 'online' });
  finish(json(profile(4, true)));
  await change;
  expect(useGameStore.getState().uncertainVisibility?.value).toBe(true);
});

test('a later sort request cannot be overwritten by an older sort response', async () => {
  let finishOld!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('totalReturnPct') ? new Promise<Response>(resolve => { finishOld = resolve; }) : Promise.resolve(json({ ...board(4), sortBy: 'recent5ReturnPct' }))));
  const old = useGameStore.getState().refreshLeaderboard('totalReturnPct');
  await useGameStore.getState().refreshLeaderboard('recent5ReturnPct');
  finishOld(json(board(5)));
  await old;
  expect(useGameStore.getState().leaderboard?.sortBy).toBe('recent5ReturnPct');
});

test('a pending visibility request survives same-tab initialization for the same user', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/profile/visibility') throw new TypeError('timeout');
    if (url === '/api/session') return json({ user, csrfToken: 'token', registrationOpen: true, market: { revision: 1 } });
    return json({ userId: 'u', snapshot: { quotes: [] }, market: { revision: 1 } });
  }));
  await useGameStore.getState().setLeaderboardVisibility(true);
  const operation = useGameStore.getState().uncertainVisibility;
  useGameStore.setState({ uncertainVisibility: null, user: null, initializing: false });
  await useGameStore.getState().initialize();
  expect(useGameStore.getState().uncertainVisibility).toEqual(operation);
});

test('pending visibility receipt is never restored for a different identity', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal('EventSource', undefined);
  const bob = { ...user, id: 'b', username: 'bob' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/profile/visibility') throw new TypeError('timeout');
    if (url === '/api/session') return json({ user: bob, csrfToken: 'token', registrationOpen: true, market: { revision: 1 } });
    return new Response(JSON.stringify({ userId: 'b', snapshot: { quotes: [] }, market: { revision: 1 } }), { headers: { 'X-User-Id': 'b' } });
  }));
  await useGameStore.getState().setLeaderboardVisibility(true);
  useGameStore.setState({ uncertainVisibility: null, user: null, initializing: false });
  await useGameStore.getState().initialize();
  expect(useGameStore.getState().uncertainVisibility).toBeNull();
});

test('unavailable session storage does not erase an unresolved request in memory', async () => {
  vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('disabled'); }, removeItem: () => { throw new Error('disabled'); } });
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/profile/visibility') throw new TypeError('timeout');
    if (url === '/api/session') return json({ user, csrfToken: 'token', registrationOpen: true, market: { revision: 1 } });
    return json({ userId: 'u', snapshot: { quotes: [] }, market: { revision: 1 } });
  }));
  await useGameStore.getState().setLeaderboardVisibility(true);
  const operation = useGameStore.getState().uncertainVisibility;
  useGameStore.setState({ initializing: false });
  await useGameStore.getState().initialize();
  expect(useGameStore.getState().uncertainVisibility).toEqual(operation);
});

test('rate limits and forbidden retry responses preserve the original unresolved receipt', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url !== '/api/profile/visibility') return json(profile(1, false));
    requests.push(init);
    if (requests.length === 1) throw new TypeError('timeout');
    if (requests.length < 4) return new Response(JSON.stringify({ error: 'try later' }), { status: requests.length === 2 ? 429 : 403 });
    return json(profile(3, true));
  }));
  await useGameStore.getState().setLeaderboardVisibility(true);
  const original = useGameStore.getState().uncertainVisibility;
  const receipt = [...storage.values()][0];
  for (let i = 0; i < 2; i++) {
    await useGameStore.getState().retryLeaderboardVisibility();
    await useGameStore.getState().refreshPlayerProfile();
    expect(useGameStore.getState().uncertainVisibility).toEqual(original);
    expect([...storage.values()][0]).toBe(receipt);
    expect(useGameStore.getState().playerProfile).toBeNull();
  }
  await useGameStore.getState().retryLeaderboardVisibility();
  expect(useGameStore.getState().uncertainVisibility).toBeNull();
  expect(storage.size).toBe(0);
  expect(requests.map(request => (request.headers as Record<string, string>)['Idempotency-Key'])).toEqual(Array(4).fill(original?.key));
});
