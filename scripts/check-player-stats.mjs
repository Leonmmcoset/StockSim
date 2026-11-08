// Native-process verification with two players and a disposable SQLite database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'stocksim-stats-check-'));
const listener = createServer();
await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
const port = listener.address().port;
await new Promise(done => listener.close(done));
const base = `http://127.0.0.1:${port}`;
let server, log = '';
async function start() {
  log = '';
  server = spawn(join(root, 'bin/stocksim'), [], { cwd: root, env: {
    ...process.env, STOCKSIM_ADDR: `127.0.0.1:${port}`, STOCKSIM_DB: join(directory, 'state.db'),
    STOCKSIM_STATIC_DIR: join(root, 'dist'), STOCKSIM_SEED: 'player-stats-integration',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  server.on('error', error => { log += error.message; });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await delay(50);
  }
  throw new Error(`Server did not start: ${log}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const ended = once(server, 'exit');
  server.kill('SIGTERM');
  const timeout = setTimeout(() => server.kill('SIGKILL'), 10000);
  await ended;
  clearTimeout(timeout);
}
class Client {
  cookie = ''; csrf = ''; userId = '';
  async send(path, body, headers = {}) {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: this.cookie, ...(this.userId ? { 'X-Expected-User-Id': this.userId } : {}),
        ...(body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }),
        ...(path === '/profile/visibility' ? { 'Idempotency-Key': randomUUID() } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.at(-1).split(';')[0];
    const data = await response.json();
    if (data.csrfToken) this.csrf = data.csrfToken;
    if ('user' in data) this.userId = data.user?.id ?? '';
    if (body !== undefined) await delay(125);
    return { status: response.status, identity: response.headers.get('X-User-Id'), data };
  }
  async ok(path, body, headers) {
    const response = await this.send(path, body, headers);
    assert.ok(response.status >= 200 && response.status < 300, `${path}: ${JSON.stringify(response.data)}`);
    if ('userId' in response.data) {
      assert.equal(response.identity, this.userId);
      assert.equal(response.data.userId, this.userId);
    }
    return response.data;
  }
}
const sortedKeys = value => Object.keys(value).sort();
function publicOnly(entry) {
  assert.deepEqual(sortedKeys(entry), ['drawdown', 'joinedAt', 'rank', 'recent5', 'totalReturnPct', 'username']);
  assert.deepEqual(sortedKeys(entry.recent5), ['complete', 'coveredDays', 'endAt', 'requestedStartAt', 'requestedStartDayIndex', 'returnPct', 'startAt']);
  assert.deepEqual(sortedKeys(entry.drawdown), ['compacted', 'endAt', 'maxDrawdownPct', 'retentionDays', 'startAt']);
  assert.equal(entry.drawdown.retentionDays, 30);
}
try {
  await start();
  const admin = new Client(), player = new Client(), visitor = new Client();
  await Promise.all([admin.ok('/session'), player.ok('/session'), visitor.ok('/session')]);
  await admin.ok('/register', { username: 'stats_admin', password: 'stats-verification-admin' });
  await admin.ok('/admin/market', { action: 'pause' });
  await player.ok('/register', { username: 'stats_player', password: 'stats-verification-player' });
  for (const client of [admin, player]) {
    const profile = await client.ok('/profile');
    assert.equal(profile.leaderboardOptIn, false);
    assert.equal(profile.performance.equity, 500000);
    assert.equal(profile.performance.fillCount, 0);
    assert.equal(profile.performance.bestDay, null);
    assert.equal(profile.performance.recent5.complete, false);
    assert.deepEqual((await client.ok('/leaderboard')).entries, []);
  }
  assert.equal((await visitor.send('/profile')).status, 401);
  assert.equal((await visitor.send('/leaderboard')).status, 401);
  assert.equal((await player.send('/profile/visibility', { leaderboardOptIn: true }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await player.send('/profile/visibility', { leaderboardOptIn: true }, { 'X-Expected-User-Id': admin.userId })).status, 401);
  assert.equal((await player.send('/profile/visibility', { leaderboardOptIn: true }, { 'Idempotency-Key': '' })).status, 400);
  for (const invalid of [{}, { leaderboardOptIn: null }, { leaderboardOptIn: true, userId: admin.userId }]) {
    assert.equal((await player.send('/profile/visibility', invalid)).status, 400);
  }
  assert.equal((await player.ok('/profile')).leaderboardOptIn, false);
  console.log('PASS private defaults, identity boundaries, CSRF and strict visibility input');

  const snapshot = (await admin.ok('/snapshot')).snapshot;
  const quote = snapshot.quotes[0];
  const filled = await admin.ok('/orders', { symbol: quote.symbol, side: 'buy', price: quote.asks[0].price, quantity: 100 }, { 'Idempotency-Key': randomUUID() });
  assert.equal(filled.result.ok, true);
  assert.equal(filled.result.order.status, 'filled');
  const owned = await admin.ok('/profile');
  assert.equal(owned.performance.fillCount, filled.snapshot.trades.length);
  assert.equal(owned.performance.buyFillCount, owned.performance.fillCount);
  assert.equal(owned.performance.sellFillCount, 0);
  assert.equal(owned.performance.feesPaid, filled.snapshot.account.feesPaid);
  assert.equal(owned.performance.equity, filled.snapshot.account.equity);
  assert.equal((await player.ok(`/profile?userId=${admin.userId}`)).performance.fillCount, 0);
  assert.deepEqual((await player.ok('/leaderboard')).entries, []);
  console.log('PASS actual fills and private profile statistics');

  const originalKey = randomUUID();
  const enabled = await admin.ok('/profile/visibility', { leaderboardOptIn: true }, { 'Idempotency-Key': originalKey });
  assert.equal(enabled.leaderboardOptIn, true);
  assert.ok(enabled.revision > owned.revision);
  assert.equal((await admin.ok('/profile/visibility', { leaderboardOptIn: true }, { 'Idempotency-Key': originalKey })).revision, enabled.revision);
  assert.equal((await admin.send('/profile/visibility', { leaderboardOptIn: false }, { 'Idempotency-Key': originalKey })).status, 409);
  assert.equal((await admin.ok('/profile/visibility', { leaderboardOptIn: true })).revision, enabled.revision);
  await player.ok('/profile/visibility', { leaderboardOptIn: true });
  let board = await player.ok('/leaderboard?sortBy=totalReturnPct');
  assert.equal(board.entries.length, 2);
  board.entries.forEach(publicOnly);
  assert.equal(board.entries[0].username, 'stats_player');
  for (const sort of ['recent5ReturnPct', 'maxDrawdownPct']) {
    board = await admin.ok(`/leaderboard?sortBy=${sort}`);
    board.entries.forEach(publicOnly);
    if (sort === 'recent5ReturnPct') assert.ok(board.entries.every(entry => entry.rank === null));
  }
  assert.equal((await player.send('/leaderboard?sortBy=invalid')).status, 400);
  await player.ok('/profile/visibility', { leaderboardOptIn: false });
  assert.deepEqual((await admin.ok('/leaderboard')).entries.map(entry => entry.username), ['stats_admin']);
  const before = await admin.ok('/profile');
  const backup = await admin.ok('/admin/backup');
  assert.equal(backup.schemaVersion, 2);
  assert.ok(backup.playerPreferences.some(item => item.userId === admin.userId && item.leaderboardOptIn));
  await stop(); await start();
  assert.deepEqual(await admin.ok('/profile'), before);
  assert.equal((await player.ok('/profile')).leaderboardOptIn, false);
  await player.ok('/profile/visibility', { leaderboardOptIn: true });
  await admin.ok(`/admin/users/${player.userId}/ban`, { banned: true });
  assert.deepEqual((await admin.ok('/leaderboard')).entries.map(entry => entry.username), ['stats_admin']);
  assert.equal((await player.send('/profile')).status, 401);
  await admin.ok('/profile/visibility', { leaderboardOptIn: false });
  assert.equal((await admin.ok('/profile/visibility', { leaderboardOptIn: true }, { 'Idempotency-Key': originalKey })).leaderboardOptIn, false, 'a delayed original opt-in cannot undo a later opt-out');
  assert.deepEqual((await admin.ok('/leaderboard')).entries, []);
  console.log('PASS explicit consent, public field allowlists, sorting, opt-out, backup, restart, bans and delayed-request idempotency');
  console.log('All player-stat checks passed against an isolated native Go server.');
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
