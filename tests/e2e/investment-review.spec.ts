import { expect, test, type Locator, type Page } from '@playwright/test';
import { createMarket, type MarketEngine } from '../../src/engine';
import { money, pct } from '../../src/lib/format';
import { createSave, serializeSave, STORAGE_KEY } from '../../src/lib/persistence';

// Use actual engine saves through the normal restore path. Restored sessions are
// paused, so a one-point baseline cannot race the application's market timer.
async function restoreMarket(page: Page, market: MarketEngine, legacy = false) {
  const snapshot = market.getSnapshot();
  const engine = market.exportState();
  if (legacy) {
    engine.schemaVersion = 2;
    delete (engine.data as { review?: unknown }).review;
  }
  const text = serializeSave(createSave(engine, {
    selectedSymbol: snapshot.quotes[0].symbol,
    chartMode: 'intraday', watchlist: [], speed: 1,
  }));
  await page.addInitScript(({ key, save }) => {
    if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, save);
  }, { key: STORAGE_KEY, save: text });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '委托交易' })).toBeVisible();
  return snapshot;
}

async function openReview(page: Page) {
  await page.getByRole('button', { name: /^投资复盘/ }).click();
  const review = page.getByRole('region', { name: '投资复盘', exact: true });
  await expect(review).toBeVisible();
  return review;
}

function metric(review: Locator, label: string) {
  return review.locator('.ir-metrics > div').filter({ hasText: label }).locator('dd');
}

test('真实起点、图表切换与返回后保留委托草稿和F10状态', async ({ page }) => {
  const market = createMarket({ seed: 'review-browser-baseline', historyDays: 0 });
  await restoreMarket(page, market);
  const order = page.getByRole('region', { name: '委托交易' });
  await order.getByLabel('委托价格').fill('12.34');
  await order.getByLabel('委托数量').fill('300');
  await order.getByRole('button', { name: '卖出', exact: true }).click();
  await page.getByRole('button', { name: '公司资料 F10', exact: true }).click();
  const company = page.getByRole('region', { name: /F10公司资料/ });
  await company.getByRole('tab', { name: '财务数据', exact: true }).click();

  const review = await openReview(page);
  const retainedOrder = page.getByRole('region', { name: '委托交易', includeHidden: true });
  await expect(retainedOrder).toHaveCount(1);
  await expect(retainedOrder).toBeHidden();
  await expect(review).toContainText('1 个真实采样点');
  await expect(review).toContainText('已记录真实起点 · 继续运行后显示走势');
  await expect(metric(review, '期初资产 / 元')).toHaveText('5,000.00');
  await expect(metric(review, '实际手续费 / 元')).toHaveText('0.00');
  await expect(metric(review, '账户收益率')).toHaveText('0.00%');
  for (const mode of ['账户 / 基准收益', '仓位', '资产与资金']) {
    const button = review.getByRole('button', { name: mode, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  await review.getByRole('button', { name: '返回账户', exact: true }).click();
  await expect(review).toBeHidden();
  await expect(order).toBeVisible();
  await expect(order.getByLabel('委托价格')).toHaveValue('12.34');
  await expect(order.getByLabel('委托数量')).toHaveValue('300');
  await expect(order.getByRole('button', { name: '卖出下单', exact: true })).toBeVisible();
  await expect(company.getByRole('tab', { name: '财务数据', exact: true })).toHaveAttribute('aria-selected', 'true');

  await openReview(page);
  await page.keyboard.press('Escape');
  await expect(review).toBeHidden();
  await expect(company.getByRole('tab', { name: '财务数据', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(order.getByLabel('委托价格')).toHaveValue('12.34');
  await expect(order.getByLabel('委托数量')).toHaveValue('300');

  await openReview(page);
  await page.keyboard.press('F6');
  await expect(review).toBeHidden();
  const quotes = page.getByRole('complementary', { name: '市场行情' });
  await expect(quotes).toBeVisible();
  await expect(quotes.getByRole('button', { name: /^我的自选/ })).toHaveClass(/active/);
  await expect(quotes).toContainText('暂无自选股');

  await openReview(page);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '自选股', exact: true }).click();
  await expect(review).toBeHidden();
  await expect(quotes).toBeVisible();
  await expect(quotes.getByRole('button', { name: /^我的自选/ })).toHaveClass(/active/);
});

test('跨日选择日报与真实记录区间，收盘日不重复', async ({ page }) => {
  const market = createMarket({ seed: 'review-browser-days', historyDays: 0 });
  market.step(5);
  market.nextDay();
  market.step(4);
  const snapshot = await restoreMarket(page, market);
  const review = await openReview(page);
  const dates = review.getByRole('combobox', { name: '选择复盘交易日' });
  await expect(dates.locator('option')).toHaveCount(2);
  await expect(review.locator('.ir-table tbody tr')).toHaveCount(2);
  await expect(dates).toHaveValue(String(snapshot.review.currentDay.dayIndex));
  await expect(review.locator('.ir-day-status')).toContainText('进行中');

  const closed = snapshot.review.days[0];
  await dates.selectOption(String(closed.dayIndex));
  await expect(review.locator('.ir-day-status')).toContainText(`${closed.date}`);
  await expect(review.locator('.ir-day-status')).toContainText('已收盘');
  await expect(metric(review, '账户收益率')).toHaveText(pct(closed.returnPct!));
  await review.getByRole('button', { name: '最近5日', exact: true }).click();
  await expect(review.locator('.ir-period-summary')).toContainText('2 个记录日');
  await expect(review.locator('.ir-chart')).toHaveAttribute('aria-label', `资产与资金走势，${snapshot.review.points.length}个真实采样点`);
  await review.getByRole('button', { name: '最近20日', exact: true }).click();
  await expect(review.getByRole('button', { name: '最近20日', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await review.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(review.locator('.ir-period-summary')).toContainText('2 个记录日');
  await review.getByRole('button', { name: '当日', exact: true }).click();
  await review.getByRole('button', { name: '所选交易日', exact: true }).click();
  await expect(dates).toHaveValue(String(snapshot.review.currentDay.dayIndex));
  await expect(review.locator('.ir-period-summary')).toContainText('1 个记录日');
  await expect(metric(review, '实际手续费 / 元')).toHaveText('0.00');
});

test('实际成交费用与成交笔数来自真实账户，刷新后保持记录', async ({ page }) => {
  const market = createMarket({ seed: 'review-browser-fees', historyDays: 0 });
  const quote = market.getSnapshot().quotes[0];
  const result = market.placeOrder({ symbol: quote.symbol, side: 'buy', price: quote.asks[0].price, quantity: 100 });
  expect(result.ok).toBe(true);
  const snapshot = await restoreMarket(page, market);
  expect(snapshot.trades.length).toBeGreaterThan(0);
  expect(snapshot.account.feesPaid).toBeGreaterThan(0);
  let review = await openReview(page);
  await expect(metric(review, '实际手续费 / 元')).toHaveText(money(snapshot.account.feesPaid));
  await expect(metric(review, '买入成交')).toHaveText(`${snapshot.trades.filter(trade => trade.side === 'buy').length} 笔`);
  await expect(metric(review, '卖出成交')).toHaveText('0 笔');
  await expect(metric(review, '净收益 / 元')).toHaveText(`${snapshot.review.currentDay.netPnl > 0 ? '+' : ''}${money(snapshot.review.currentDay.netPnl)}`);
  await page.reload();
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
  review = await openReview(page);
  await expect(metric(review, '实际手续费 / 元')).toHaveText(money(snapshot.account.feesPaid));
  await expect(metric(review, '买入成交')).toHaveText(`${snapshot.trades.filter(trade => trade.side === 'buy').length} 笔`);
});

test('旧档从恢复时开始采集，390宽度局部滚动且不补造历史', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const market = createMarket({ seed: 'review-browser-migration', historyDays: 0 });
  market.nextDay();
  market.step(5);
  const snapshot = await restoreMarket(page, market, true);
  const review = await openReview(page);
  await expect(review).toContainText('1 个真实采样点');
  await expect(review).toContainText('非完整日');
  await expect(review).toContainText('启用前的交易与资产走势不补造');
  await expect(review.getByRole('combobox', { name: '选择复盘交易日' }).locator('option')).toHaveCount(1);
  await expect(review.locator('.ir-table tbody tr')).toHaveCount(1);
  await expect(metric(review, '期初资产 / 元')).toHaveText(money(snapshot.account.equity));
  await expect(metric(review, '净收益 / 元')).toHaveText('0.00');
  await expect(metric(review, '实际手续费 / 元')).toHaveText('0.00');
  await expect(review.locator('.ir-coverage')).toContainText(snapshot.clock.date);
  await expect(page.locator('.market-clock')).toContainText(snapshot.clock.time);
  const layout = await review.evaluate(element => {
    const table = element.querySelector('.ir-table-scroll')!;
    const content = element.querySelector('.ir-content')!;
    return {
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      panelOverflow: element.scrollWidth > element.clientWidth,
      tableScrollable: table.scrollWidth > table.clientWidth,
      contentScrollable: content.scrollHeight > content.clientHeight,
    };
  });
  expect(layout).toEqual({ pageOverflow: false, panelOverflow: false, tableScrollable: true, contentScrollable: true });
  await review.getByRole('button', { name: '返回账户', exact: true }).click();
  await expect(page.getByRole('region', { name: '委托交易' })).toBeVisible();
});
