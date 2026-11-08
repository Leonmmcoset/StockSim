// Playwright's webServer: only a temporary database, never server/data.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'stocksim-browser-tests-'));
const child = spawn('go', ['run', './cmd/stocksim'], { cwd: join(root, 'server'), stdio: 'inherit', env: {
  ...process.env, STOCKSIM_ADDR: '127.0.0.1:5175', STOCKSIM_DB: join(directory, 'state.db'),
  STOCKSIM_STATIC_DIR: join(root, 'dist'), STOCKSIM_SEED: 'browser-multiplayer-tests',
} });
let closing = false;
async function cleanup(signal = 'SIGTERM') {
  if (closing) return;
  closing = true;
  child.kill(signal);
}
process.on('SIGINT', () => void cleanup('SIGINT'));
process.on('SIGTERM', () => void cleanup());
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', async code => { await rm(directory, { recursive: true, force: true }); process.exitCode = code ?? 0; });
