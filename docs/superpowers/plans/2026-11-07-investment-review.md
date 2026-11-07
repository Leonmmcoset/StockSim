# Investment Review Implementation Plan

**Goal:** Add truthful account history and daily performance summaries while keeping the terminal and existing games.

**Spec:** `docs/superpowers/specs/2026-11-07-investment-review-design.md`

**Architecture:** Astra owns sampling, metrics, selected-range calculations, lifecycle hooks and schema 3 migration. Sol builds a read-only chart/statistics component. Terra updates the strict outer save envelope, then reviews migration and accounting. Root integrates the terminal tab, verifies behavior and controls Git commits.

## Tasks

- [x] **Engine review history and metrics — Astra:** `src/engine/{types,internal,review,review-save,market,save,index}.ts` as needed, `tests/engine-review.test.ts`, `docs/investment-review-model.md`. Write failing tests, freeze public data/helpers, implement bounded genuine sampling, day closure, range normalization and validation. Verify ledger/market invariance and restore determinism; commit the completed engine feature.
- [x] **Save envelope — Terra:** `src/lib/persistence.ts`, `tests/persistence.test.ts`. Confirm schema 3 roundtrip fails first, accept only 1/2/3 while preserving safety and old settings, reject 4. Run targeted tests and commit.
- [x] **Review interface — Sol:** `src/components/InvestmentReview.tsx/.css`. Use only public review data and Astra helpers for metrics; show partial coverage, correct dates, three chart modes, daily/range choices and local scrolling. Verify TypeScript, then root browser checks and commit.
- [x] **Terminal integration — root:** extend AccountPanel tab and App rendering without unmounting existing trading workspace. Add review close behavior, scoped layout, new E2E specification and instructions. Verify draft preservation, chart resize and F10 coexistence.
- [x] **Independent verification:** review formulas/time/version migration; run all tests and production build; validate genuine legacy fixtures and corrupt review rejection; inspect desktop/mobile in CUA; record proof, screenshots and storage bounds; commit checked result and sync repository.

## Review focus

- Net PnL must not deduct fees twice or sum daily realized PnL with ending unrealized PnL.
- Compare index changes from the exact same start instant as account returns.
- Legacy partial days and history retention must not pretend to cover missing observations.
- Multiple fills at one clock time, close auction and repeated next-day operations must remain ordered and deterministic.
- Reopening review must preserve order entry; invalid saves must be rejected before replacement.

## Ledger

- Base main `fc62a2a`; working branch `codex/investment-review`, existing checkout reused.
- True pre-change schema 2 save with position, pending order and published earnings saved under ignored `test-results/legacy-review-v2-*`; original v1 fixture retained.
- User authorized the proposed asset-curve and daily-review stage. Replay of trade markers and full event timeline remains later work.

## Verification outcome

- 56 unit tests and production build pass; 8 Playwright specifications discovered, browser suite not executed.
- Actual CUA production checks covered truthful baseline, real v1/v2 imports, schema3 roundtrip, corrupt-save preservation, fees, cross-day returns, order/F10 state, keyboard navigation and desktop/mobile sizing.
- Independent review identified Esc/F6 navigation defects; both fixed and rechecked. Engine migration/accounting review found no outstanding P1/P2.
- Detailed evidence and storage limits: `docs/investment-review-verification.md`, `docs/investment-review-audit.md`, `docs/investment-review-model.md`.
