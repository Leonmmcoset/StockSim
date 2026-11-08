import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1,
  expect: { timeout: 20_000 },
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5175', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run build && node scripts/e2e-server.mjs', url: 'http://127.0.0.1:5175/api/health', reuseExistingServer: false, timeout: 180_000 },
});
