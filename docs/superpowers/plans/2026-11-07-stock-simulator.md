# StockSim Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. User approved direct execution and delegated implementation choices.

**Goal:** Build a playable HTML5 A-share simulation terminal with ¥5,000 starting capital.

**Architecture:** A deterministic TypeScript agent-based market owns all prices, orders and accounting. React renders immutable snapshots; a Zustand controller advances the engine and handles persistence. UI and engine are implemented independently against one shared contract.

**Tech Stack:** React, TypeScript, Vite, ECharts, Zustand, TanStack Table, Radix Dialog, Lucide, Zod, date-fns, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-stock-simulator-design.md`

## Global Constraints

- Initial balance ¥5,000; internal money and quote prices are integer fen.
- Fictional generated market, real main-board trading conventions, accelerated simulation clock.
- Traditional black terminal, red up / green down, yellow labels, dense tables.
- Only GPT-6 Astra writes market algorithms and ledger logic. Other agents use GPT-6.1 Sol/Terra.
- Current checkout and `codex/stock-simulator` branch; commit every finished feature.
- Browser local preview first; no real money or real market feed.

## Review Focus

- Partially filled orders: fees charged cumulatively, freezing/releasing money never creates money.
- Day rollover: T+1 release, unfinished orders expired, graph history preserved.
- Accelerated clock: batches preserve the exact seeded command/tick sequence.
- Imported/corrupt saves: rejected before replacing live market, auto-save failures visible.
- UI stale selection: stock switch updates chart/book/form, invalid orders never silently submit.

### Task 1: Toolchain and runnable shell

**Files:** `package.json`, `package-lock.json`, `index.html`, `vite.config.ts`, `tsconfig*.json`, `src/main.tsx`, `.gitignore`.

- [ ] Create React/Vite/TS setup and install purposeful libraries.
- [ ] Verify dependency installation, TypeScript and dev server HTTP response once UI exists.
- [ ] Commit `chore: set up HTML5 trading terminal toolchain`.

### Task 2: Market engine and exchange ledger (Astra)

**Files:** `src/engine/*`, `tests/engine*.test.ts`, `docs/market-model.md`, `docs/engine-contract.md`.

**Produces:** Engine contract declared in `src/engine/types.ts` and `src/engine/index.ts`; `createMarket`, fixed-tick stepping, next-day transition, limit orders, cancellations, snapshots and serializable state.

- [ ] Establish public contract before UI implementation relies on it.
- [ ] Write failing deterministic-seed, price-limit, order/fee/freezing and T+1 tests; run them.
- [ ] Implement seeded market, fundamentals/sector factors, heterogeneous participants, limit order book, news and chart history.
- [ ] Implement player order matching, positions and cumulative fees; preserve NPC resources.
- [ ] Verify seed/tick-batch/save determinism and accounting invariants with Vitest.
- [ ] Document official rules, research sources, assumptions and uncalibrated limitations.
- [ ] Commit independently useful engine and trading milestones after checks.

### Task 3: Terminal UI (Sol)

**Files:** `src/App.tsx`, `src/styles.css`, `src/components/{QuotesTable,OrderPanel,AccountPanel}.tsx`.

**Consumes:** `useGameStore`, engine types, `MarketChart` and `SettingsDialog` from integration work.

- [ ] Build dense black multi-pane terminal, menu, clock, index strip and status bar.
- [ ] Add stock selection/search/sort/watchlist and chart period controls.
- [ ] Implement real book levels, price selection, validated buy/sell form and quantity shortcuts.
- [ ] Implement account, orders/cancel, trades and news tabs with clear empty states.
- [ ] Add responsive pane switching and accessible keyboard controls.
- [ ] Verify main flows in browser and commit terminal, order and account features separately.

### Task 4: Charts, controller and saves (root)

**Files:** `src/components/{MarketChart,SettingsDialog}.tsx`, `src/store/game.ts`, `src/lib/{format,persistence}.ts`, `tests/persistence.test.ts`.

- [ ] Wire typed engine to Zustand, fixed ticks, pause/speed/next-day, user feedback and auto-save.
- [ ] Write failing save validation/roundtrip/corrupt-state tests before persistence implementation.
- [ ] Implement versioned export/import and safe local storage; new game confirms replacement.
- [ ] Implement ECharts intraday average/last/volume and candlestick/MA/volume with proper time axes, cursor and resize handling.
- [ ] Implement settings dialog with rules, source links, seed, save actions and confirmation.
- [ ] Verify relevant tests and build; commit each completed feature.

### Task 5: Independent review and browser verification (Terra)

**Files:** `tests/e2e/*`, `playwright.config.ts`, `README.md`, `docs/verification.md`.

- [ ] Review engine integration and terminal against spec; route algorithm fixes back to Astra.
- [ ] Test opening funds, selection, chart modes, pause/speed, buy, same-day sell rejection, cancel, next-day release, export/import and refresh restoration.
- [ ] Check 1440×900, 1920×1080 and narrow widths; inspect console and screenshots.
- [ ] Fix material defects, run `npm test` and `npm run build`, and record exact results and remaining simplifications.
- [ ] Add launch instructions and source guide, commit checked result and hand over local preview.

## Execution ledger

- 2026-11-07: User approved design and direct implementation; no further implementation approval gate.
- Design review by GPT-6.1 Terra: nothing important left.
- Algorithm assigned to GPT-6 Astra; terminal UI assigned to GPT-6.1 Sol; controller/chart/integration owned by root.
- Ruling: parallel work uses disjoint owned files with root-controlled staging/commits to avoid shared-index conflicts.
