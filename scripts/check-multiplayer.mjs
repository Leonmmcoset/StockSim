// End-to-end HTTP checks against the actual compiled Go server, in a disposable DB.
// No browser or production account is created by this script.
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
const directory = await mkdtemp(join(tmpdir(), 'stocksim-http-check-'));
const listener = createServer();
await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
const port = listener.address().port;
await new Promise(done => listener.close(done));
const base = `http://127.0.0.1:${port}`;
let server;
let serverLog = '';

async function start() {
  serverLog = '';
  server = spawn(join(root, 'bin', 'stocksim'), [], { cwd: root, env: {
    ...process.env, STOCKSIM_ADDR: `127.0.0.1:${port}`, STOCKSIM_DB: join(directory, 'state.db'),
    STOCKSIM_STATIC_DIR: join(root, 'dist'), STOCKSIM_SEED: 'multiplayer-http-verification',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  server.on('error', error => { serverLog += error.message; });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${serverLog}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* startup */ }
    await delay(50);
  }
  throw new Error(`Server did not become ready: ${serverLog}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  const timeout = setTimeout(() => server.kill('SIGKILL'), 10000);
  await exited;
  clearTimeout(timeout);
}
async function rejectSecondOwner() {
  const duplicate = spawn(join(root, 'bin', 'stocksim'), [], { cwd: root, env: {
    ...process.env, STOCKSIM_ADDR: '127.0.0.1:0', STOCKSIM_DB: join(directory, 'state.db'),
    STOCKSIM_STATIC_DIR: join(root, 'dist'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', timedOut = false;
  duplicate.stdout.on('data', chunk => { log += chunk; });
  duplicate.stderr.on('data', chunk => { log += chunk; });
  const exited = once(duplicate, 'exit');
  const timeout = setTimeout(() => { timedOut = true; duplicate.kill('SIGTERM'); }, 9000);
  const [code] = await exited;
  clearTimeout(timeout);
  assert.equal(timedOut, false, 'a duplicate server must fail to start');
  assert.notEqual(code, 0);
  assert.match(log, /同一数据库只能运行一个服务/, 'failure must specifically report database ownership');
}
class Client {
  cookie = ''; csrf = ''; userId = '';
  async send(path, body, key, headers = {}) {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: this.cookie, ...(this.userId ? { 'X-Expected-User-Id': this.userId } : {}), ...(body === undefined ? {} : {
        Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf,
      }), ...(key ? { 'Idempotency-Key': key } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.at(-1).split(';')[0];
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (data?.csrfToken) this.csrf = data.csrfToken;
    if (data && 'user' in data) this.userId = data.user?.id ?? '';
    if (body !== undefined) await delay(125);
    return { status: response.status, data };
  }
  async ok(path, body, key) {
    const reply = await this.send(path, body, key);
    assert.ok(reply.status >= 200 && reply.status < 300, `${path}: ${JSON.stringify(reply)}`);
    return reply.data;
  }
  async snapshot() { return (await this.ok('/snapshot')).snapshot; }
  async event() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${base}/api/events`, { headers: { Cookie: this.cookie }, signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'SSE ended before initial snapshot');
        text += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, end); text = text.slice(end + 2);
          if (/event:\s*snapshot/.test(block)) {
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            return JSON.parse(data);
          }
        }
      }
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
try {
  await start();
  assert.equal((await fetch(base)).status, 200, 'production frontend is served');
  const admin = new Client(), player = new Client(), visitor = new Client();
  await Promise.all([admin.ok('/session'), player.ok('/session'), visitor.ok('/session')]);
  const first = await admin.ok('/register', { username: 'check_admin', password: 'verification-password-123' });
  assert.equal(first.user.role, 'admin'); assert.equal(first.market.speed, 1);
  await admin.ok('/admin/market', { action: 'pause' });
  const second = await player.ok('/register', { username: 'check_player', password: 'verification-password-456' });
  assert.equal(second.user.role, 'user');
  let a = await admin.snapshot(), b = await player.snapshot();
  assert.deepEqual(a.quotes, b.quotes); assert.deepEqual(a.companies, b.companies);
  assert.equal(a.account.cash, 500000); assert.equal(b.account.cash, 500000);
  assert.deepEqual(a.review.points, []); assert.deepEqual(b.orders, []);
  assert.equal((await player.send('/admin/users')).status, 403);
  assert.equal((await player.send('/admin/market', { action: 'resume' })).status, 403);
  assert.equal((await player.send('/admin/backup')).status, 403);
  assert.equal((await visitor.send('/snapshot')).status, 401);
  const wrongIdentity = await player.send('/orders', {}, randomUUID(), { 'X-Expected-User-Id': first.user.id });
  assert.equal(wrongIdentity.status, 401, 'a stale browser identity is rejected before execution');
  assert.equal((await player.snapshot()).account.cash, 500000);
  await rejectSecondOwner();
  assert.deepEqual(await admin.snapshot(), a, 'a rejected second process must not alter the first market');
  assert.equal((await player.send('/orders', {}, randomUUID(), { Origin: 'https://invalid.example' })).status, 403);
  console.log('PASS registration, first-admin, shared quotes, private accounts, authorization and exclusive database ownership');

  const quote = a.quotes[0];
  assert.ok(quote.asks.length, 'startup order book has a real ask');
  const buy = { symbol: quote.symbol, side: 'buy', price: quote.asks[0].price, quantity: 100 };
  const buyKey = randomUUID();
  const bought = await admin.ok('/orders', buy, buyKey);
  assert.equal(bought.result.ok, true); assert.equal(bought.result.order.status, 'filled');
  assert.equal(bought.snapshot.account.positions[0].sellable, 0);
  const replay = await admin.ok('/orders', buy, buyKey);
  assert.deepEqual(replay, bought, 'same idempotency key replays the exact committed result');
  assert.equal((await admin.send('/orders', { ...buy, quantity: 200 }, buyKey)).status, 409);
  assert.equal((await admin.snapshot()).trades.length, bought.snapshot.trades.length);
  assert.equal((await player.snapshot()).trades.length, 0);
  const privateCancel = await player.ok(`/orders/${bought.result.order.id}/cancel`, {}, randomUUID());
  assert.equal(privateCancel.result.ok, false); assert.equal(privateCancel.result.order, undefined);
  await admin.ok('/admin/market', { action: 'nextDay' });
  a = await admin.snapshot();
  assert.equal(a.account.positions[0].sellable, 100, 'T+1 is settled globally');
  const current = a.quotes.find(item => item.symbol === quote.symbol);
  assert.ok(current.bids[0].price < current.last && current.asks[0].price > current.last, 'inside spread is free for direct player matching');
  const sold = await admin.ok('/orders', { symbol: quote.symbol, side: 'sell', price: current.last, quantity: 100 }, randomUUID());
  assert.equal(sold.result.ok, true); assert.equal(sold.result.order.status, 'open');
  const matched = await player.ok('/orders', { symbol: quote.symbol, side: 'buy', price: current.last, quantity: 100 }, randomUUID());
  assert.equal(matched.result.ok, true); assert.equal(matched.result.order.status, 'filled');
  a = await admin.snapshot(); b = await player.snapshot();
  assert.equal(a.account.positions.length, 0); assert.equal(b.account.positions[0].quantity, 100);
  assert.equal(a.trades[0].price, b.trades[0].price); assert.equal(a.trades[0].side, 'sell'); assert.equal(b.trades[0].side, 'buy');
  assert.notEqual(a.trades[0].orderId, b.trades[0].orderId);
  assert.equal(b.orders.length, 1); assert.ok(a.orders.every(order => order.id !== b.orders[0].id));
  const [eventA, eventB] = await Promise.all([admin.event(), player.event()]);
  assert.equal(eventA.userId, first.user.id); assert.equal(eventB.userId, second.user.id);
  assert.deepEqual(eventA.snapshot.quotes, eventB.snapshot.quotes);
  assert.equal(eventA.snapshot.account.positions.length, 0); assert.equal(eventB.snapshot.account.positions[0].quantity, 100);
  const review = await admin.ok(`/review?range=day&dayIndex=${a.clock.dayIndex}`);
  assert.ok(review.points.length); assert.equal(review.summary.netPnl, review.summary.realizedPnl + review.summary.unrealizedPnlChange);
  console.log('PASS idempotency, T+1, real player-to-player fills, private SSE and Go review');

  await admin.ok('/admin/settings', { registrationOpen: false });
  assert.equal((await visitor.send('/register', { username: 'not_allowed', password: 'verification-password-789' })).status, 403);
  await admin.ok('/admin/settings', { registrationOpen: true });
  await admin.ok(`/admin/users/${second.user.id}/ban`, { banned: true });
  assert.equal((await player.send('/snapshot')).status, 401);
  await admin.ok(`/admin/users/${second.user.id}/ban`, { banned: false });
  assert.equal((await player.send('/snapshot')).status, 401, 'unban does not resurrect revoked sessions');
  await player.ok('/session');
  await player.ok('/login', { username: 'check_player', password: 'verification-password-456' });
  assert.equal((await admin.send(`/admin/users/${first.user.id}/ban`, { banned: true })).status, 409);
  const savedA = await admin.snapshot(), savedB = await player.snapshot();
  await stop(); await start();
  assert.deepEqual(await admin.snapshot(), savedA); assert.deepEqual(await player.snapshot(), savedB);
  console.log('PASS registration switch, bans, session revocation and full server restart persistence');

  const day = savedA.clock.dayIndex;
  await admin.ok('/admin/market', { action: 'speed', speed: 64 });
  await admin.ok('/admin/market', { action: 'resume' });
  let sawLunch = false, sawClosed = false, moved = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const snapshot = await admin.snapshot();
    sawLunch ||= snapshot.clock.phase === 'lunch'; sawClosed ||= snapshot.clock.phase === 'closed';
    if (snapshot.clock.dayIndex > day) { moved = true; break; }
    await delay(500);
  }
  await admin.ok('/admin/market', { action: 'pause' });
  assert.equal(moved, true, 'server automatically opens the next game day');
  assert.equal(sawLunch, true); assert.equal(sawClosed, true);
  const paused = (await admin.snapshot()).clock;
  await delay(1500);
  assert.deepEqual((await admin.snapshot()).clock, paused, 'manual pause stops automatic progression');
  console.log('PASS unattended lunch/close auto-advance and deliberate pause');
  console.log('All real-server checks passed. Temporary accounts and DB were isolated from production.');
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
