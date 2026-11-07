import { expect, test } from '@playwright/test';

// Every test uses a fresh browser context and the ordinary terminal controls.
test('行情、选股、图表与暂停控制', async ({ page }) => {
  await page.goto('/');
  const quotes = page.getByRole('complementary', { name: '市场行情' });
  await expect(quotes.getByRole('row')).toHaveCount(13);
  await expect(page.getByRole('region', { name: '委托交易' })).toContainText('5,000.00');

  const rows = quotes.locator('tbody tr');
  const symbol = (await rows.nth(1).locator('.stock-code').innerText()).match(/6\d{5}/)?.[0];
  expect(symbol).toBeTruthy();
  await rows.nth(1).click();
  await expect(page.getByRole('region', { name: '委托交易' })).toContainText(symbol!);
  await expect(page.getByRole('region', { name: '个股走势' })).toContainText(symbol!);
  await page.getByRole('button', { name: '日 K', exact: true }).click();
  await expect(page.locator('.market-chart')).toHaveAttribute('aria-label', /日K线图/);
  await page.getByRole('button', { name: '分时', exact: true }).click();
  await expect(page.locator('.market-chart')).toHaveAttribute('aria-label', /分时图/);
  await page.getByRole('button', { name: /暂停/ }).click();
  await expect(page.getByRole('button', { name: /继续/ })).toBeVisible();
});

test('买入、T+1 可卖与刷新恢复', async ({ page }) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: '委托交易' });
  await expect(panel).toContainText('5,000.00');
  await page.getByRole('button', { name: /暂停/ }).click();
  await page.locator('.orderbook button[title^="以卖1价"]').click();
  await panel.getByLabel('委托数量').fill('100');
  await panel.getByRole('button', { name: '买入下单' }).click();
  await expect(panel.getByRole('status')).toContainText('委托已提交');
  await expect(page.getByRole('region', { name: '账户与交易记录' }).locator('tbody tr')).toContainText('100 / 0');
  await panel.getByRole('button', { name: '卖出', exact: true }).click();
  await expect(panel.locator('.order-availability')).toContainText('0 股');
  await page.getByRole('button', { name: /下一交易日/ }).click();
  await expect(panel.locator('.order-availability')).toContainText('100 股');
  await page.reload();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '卖出', exact: true }).click();
  await expect(panel.locator('.order-availability')).toContainText('100 股');
});

test('导出、导入与损坏存档保护', async ({ page }) => {
  await page.goto('/');
  const quotes = page.getByRole('complementary', { name: '市场行情' });
  await expect(quotes.locator('tbody tr')).toHaveCount(12);
  await page.getByRole('button', { name: /暂停/ }).click();
  const rows = quotes.locator('tbody tr');
  const savedSymbol = (await rows.nth(1).locator('.stock-code').innerText()).match(/6\d{5}/)?.[0];
  expect(savedSymbol).toBeTruthy();
  await rows.nth(1).click();
  await page.getByRole('button', { name: '设置与存档' }).click();
  const dialog = page.getByRole('dialog', { name: '交易终端设置' });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出存档' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  await dialog.getByRole('button', { name: '返回终端' }).click();
  await rows.nth(2).click();
  await rows.nth(1).click();
  const panel = page.getByRole('region', { name: '委托交易' });
  await panel.getByRole('button', { name: '卖出', exact: true }).click();
  await panel.getByLabel('委托数量').fill('300');
  await page.getByRole('button', { name: '设置与存档' }).click();
  await dialog.getByLabel('导入存档文件').setInputFiles(path!);
  await expect(page.locator('.toast')).toContainText('存档导入成功');
  await dialog.getByRole('button', { name: '返回终端' }).click();
  await expect(panel).toContainText(savedSymbol!);
  await expect(panel.getByLabel('委托数量')).toHaveValue('100');
  await expect(panel.getByRole('button', { name: '买入下单' })).toBeVisible();
  await page.getByRole('button', { name: '设置与存档' }).click();
  await dialog.getByLabel('导入存档文件').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(dialog.getByRole('alert')).toContainText('JSON');
  await dialog.getByRole('button', { name: '返回终端' }).click();
  await expect(page.getByRole('region', { name: '委托交易' })).toContainText(savedSymbol!);
});
