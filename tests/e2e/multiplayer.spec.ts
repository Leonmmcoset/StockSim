import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

// This suite is opt-in and uses scripts/e2e-server.mjs's disposable database.
// Native Go HTTP integration checks cover persistence, races and idempotency.
let admin: APIRequestContext;
let csrf = '';
const adminName = 'browser_admin';
const adminPassword = 'browser-verification-password';
async function command(path: string, body: unknown) {
  const response = await admin.post(`/api${path}`, { data: body, headers: { 'X-CSRF-Token': csrf } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function asAdmin(context: BrowserContext, page: Page) {
  await context.addCookies((await admin.storageState()).cookies);
  await page.goto('/');
  await expect(page.getByRole('region', { name: '委托交易' })).toBeVisible();
}
async function signUp(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('browser-player-password');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await expect(page.getByRole('region', { name: '委托交易' })).toBeVisible();
}

test.beforeAll(async ({ playwright }) => {
  admin = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5175' });
  csrf = (await (await admin.get('/api/session')).json()).csrfToken;
  const registered = await admin.post('/api/register', { data: { username: adminName, password: adminPassword }, headers: { 'X-CSRF-Token': csrf } });
  expect(registered.ok()).toBeTruthy();
  const session = await registered.json();
  csrf = session.csrfToken;
  expect(session.user.role).toBe('admin');
  await command('/admin/market', { action: 'pause' });
});
test.afterAll(async () => { await admin?.dispose(); });
test.beforeEach(async () => { await command('/admin/market', { action: 'pause' }); });

test('注册普通玩家，共享报价、隔离账户，买入与T+1结转后可刷新恢复', async ({ page }) => {
  await signUp(page, 'browser_trader');
  await expect(page.locator('.account-overview')).toContainText('5,000.00');
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);
  const visible = await (await page.request.get('/api/snapshot')).json();
  const shared = await (await admin.get('/api/snapshot')).json();
  expect(visible.snapshot.quotes).toEqual(shared.snapshot.quotes);
  const panel = page.getByRole('region', { name: '委托交易' });
  await page.locator('.orderbook button[title^="以卖1价"]').click();
  await panel.getByLabel('委托数量').fill('100');
  await panel.getByRole('button', { name: '买入下单', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('委托已提交');
  await expect(page.locator('.account-content')).toContainText('100 /');
  expect((await (await admin.get('/api/snapshot')).json()).snapshot.account.positions).toEqual([]);
  await panel.getByRole('button', { name: '卖出', exact: true }).click();
  await expect(panel.locator('.order-availability')).toContainText('0 股');
  await command('/admin/market', { action: 'nextDay' });
  await expect(panel.locator('.order-availability')).toContainText('100 股');
  await page.reload();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '卖出', exact: true }).click();
  await expect(panel.locator('.order-availability')).toContainText('100 股');
});

test('F10、服务端复盘、委托草稿与窄屏内部滚动', async ({ context, page }) => {
  await asAdmin(context, page);
  await page.getByLabel('委托价格', { exact: true }).fill('12.34');
  await page.getByLabel('委托数量', { exact: true }).fill('300');
  await page.getByRole('button', { name: '公司资料 F10', exact: true }).click();
  const company = page.getByRole('region', { name: /F10公司资料/ });
  await company.getByRole('tab', { name: '财务数据', exact: true }).click();
  const reviewRequest = page.waitForResponse(response => response.url().includes('/api/review?') && response.status() === 200);
  await page.getByRole('button', { name: /^投资复盘/ }).click();
  await reviewRequest;
  const review = page.getByRole('region', { name: '投资复盘', exact: true });
  await expect(review.locator('.ir-chart')).toBeVisible();
  await review.getByRole('button', { name: '账户 / 基准收益', exact: true }).click();
  await review.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(review.locator('.ir-period-summary')).toContainText('账户');
  await page.setViewportSize({ width: 390, height: 844 });
  const geometry = await review.evaluate(element => ({
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    panelOverflow: element.scrollWidth > element.clientWidth,
    tableScrollable: element.querySelector('.ir-table-scroll')!.scrollWidth > element.querySelector('.ir-table-scroll')!.clientWidth,
  }));
  expect(geometry).toEqual({ pageOverflow: false, panelOverflow: false, tableScrollable: true });
  await review.getByRole('button', { name: '返回账户', exact: true }).click();
  await expect(page.getByLabel('委托价格', { exact: true })).toHaveValue('12.34');
  await expect(page.getByLabel('委托数量', { exact: true })).toHaveValue('300');
  await expect(company.getByRole('tab', { name: '财务数据', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('管理员注册开关和禁用撤销会话，普通用户不可越权', async ({ browser, context, page }) => {
  await asAdmin(context, page);
  const playerContext = await browser.newContext();
  const playerPage = await playerContext.newPage();
  try {
    await signUp(playerPage, 'browser_managed');
    expect((await playerPage.request.get('/api/admin/users')).status()).toBe(403);
    expect((await playerPage.request.get('/api/admin/backup')).status()).toBe(403);
    await page.getByRole('button', { name: '设置与存档', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '服务器管理', exact: true }).click();
    const row = dialog.getByRole('row').filter({ hasText: 'browser_managed' });
    await row.getByRole('button', { name: '禁用', exact: true }).click();
    await expect(row).toContainText('已禁用');
    await expect(playerPage.getByLabel('用户名', { exact: true })).toBeVisible();
    await expect(playerPage.getByRole('region', { name: '委托交易' })).toHaveCount(0);
    await row.getByRole('button', { name: '解除禁用', exact: true }).click();
    await playerPage.getByLabel('用户名', { exact: true }).fill('browser_managed');
    await playerPage.getByLabel('密码', { exact: true }).fill('browser-player-password');
    await playerPage.getByRole('button', { name: '登录', exact: true }).click();
    await expect(playerPage.getByRole('region', { name: '委托交易' })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭注册', exact: true }).click();
    await expect(dialog).toContainText('注册当前关闭');
    await dialog.getByRole('button', { name: '开放注册', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载整服备份', exact: true }).click();
    expect(await (await downloadPromise).path()).toBeTruthy();
  } finally { await playerContext.close(); }
});
