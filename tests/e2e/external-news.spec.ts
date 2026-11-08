import { expect, test } from '@playwright/test';
import { createMarket } from '../../src/engine';

test('外部事件在账户区展开，交易控件仍可用', async ({ page }) => {
  const snapshot = createMarket({ seed: 'external-ui', historyDays: 0 }).getSnapshot();
  snapshot.news = [{ id: 'event-ui', time: snapshot.clock.timestamp, headline: '供应链受到冲击', body: '物流中断。', scope: 'sector', symbols: [snapshot.quotes[0].symbol], impact: 'negative', kind: 'external', event: { category: 'supply-chain', severity: 'major' } }];
  const user = { id: 'ui-user', username: 'trader', role: 'user', banned: false, createdAt: '' };
  const market = { revision: 1, running: false, speed: 1, savedAt: '' };
  const envelope = { userId: user.id, market, snapshot };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user, csrfToken: 'token', registrationOpen: true, market } });
    if (path === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(envelope)}\n\n` });
    if (path === '/api/snapshot') return route.fulfill({ headers: { 'X-User-Id': user.id }, json: envelope });
    if (path === '/api/orders/preview') return route.fulfill({ headers: { 'X-User-Id': user.id }, json: { amount: 0, fees: { commission: 0, transfer: 0, stamp: 0, total: 0 }, cashRequired: 0, maxBuyQuantity: 0, maxSellQuantity: 0 } });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /市场快讯/ }).click();
  const event = page.getByRole('button', { name: /外部事件.*供应链受到冲击/ });
  await event.click();
  const detail = page.getByLabel('外部事件详情');
  await expect(detail).toContainText('物流中断');
  await expect(detail).toContainText('范围：行业');
  await expect(detail).toContainText('类别：供应链');
  await expect(detail).toContainText('级别：重大');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('委托价格')).toBeEnabled();
  await detail.getByRole('button', { name: '收起' }).click();
  await expect(detail).toHaveCount(0);
});
