import { createElement } from 'react';
import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMarket } from '../src/engine';
import { AccountPanel } from '../src/components/AccountPanel';

test('market news identifies an external event without displaying unpublished model data', () => {
  const snapshot = createMarket({ seed: 'external-ui', historyDays: 0 }).getSnapshot();
  snapshot.news = [{ id: 'event-1', time: snapshot.clock.timestamp, headline: '供应链受到冲击', body: '物流中断。', scope: 'sector', symbols: [snapshot.quotes[0].symbol], impact: 'negative', kind: 'external', event: { category: 'supply-chain', severity: 'major' } }];
  const html = renderToStaticMarkup(createElement(AccountPanel, { snapshot, activeTab: 'news', onTabChange: () => {}, onSelect: () => {}, onTradePosition: () => {}, onCancel: async () => ({ ok: true }), disabled: false }));
  expect(html).toContain('外部事件');
  expect(html).toContain('供应链受到冲击');
  expect(html).not.toContain('半衰期');
});
