# Fundamentals and Earnings Reports Implementation Plan

**Goal:** Give stock selection public business evidence through F10 company data and scheduled earnings news, without changing the terminal design or losing existing games.

**Spec:** `docs/superpowers/specs/2026-11-07-fundamentals-reports-design.md`

**Architecture:** Astra owns all engine business and report modeling, typed public snapshots, deterministic publication and v1 migration. The F10 component renders only those public fields. The controller integrates entry points and adapts the outer persistence envelope with no financial modeling in UI code.

## Global constraints

- Initial balance remains 500000 fen; public monetary metrics use integer fen except per-share display values that may be fractional fen.
- Preserve the black terminal. No work from the cancelled light App redesign is reused.
- Use Astra for algorithms and Sol/Terra for all other agents.
- Every company publishes every 5 trading days; fictional reporting periods are labeled clearly.
- Future actual reports and private model value stay out of snapshots.
- Existing cash, inventory, orders, clock and market RNG survive legacy migration.
- Each completed feature is verified and committed; workers use disjoint files and root controls Git staging.

## Tasks

- [x] **Engine company model and reports — Astra**: `src/engine/{types,internal,fundamentals,market,save,index}.ts`, relevant tests and `docs/fundamentals-model.md`. Freeze public contract, write failing accounting/publication/migration tests, implement independent company RNG and schedule, connect earnings surprise to agent inputs, strengthen v2 validation. Verify targeted and complete regression suites. Commit model and publication/compatibility milestones after checks.
- [x] **Outer save compatibility — Terra**: `src/lib/persistence.ts`, `tests/persistence.test.ts`. Write v1/v2 envelope and unsupported-version regression first, then accept engine 1|2 while retaining outer schema, size and safe-JSON protections. Run targeted tests and commit.
- [x] **F10 interface — Sol**: `src/components/CompanyFundamentals.tsx/.css`. Render profile, published statements, report announcements and peers; formatting uses engine units and derived values returned by engine. Scope styles to panel, allow local scrolling, avoid global layout changes. Verify TypeScript and browser paths, commit.
- [x] **Terminal integration — root**: `src/App.tsx` and small scoped layout updates. Add F10 button/key, preserve left/right panes and selection, link market announcements to F10. Update E2E specifications, README and tests guide. Verify build and real browser.
- [x] **Independent review and verification**: review report timing/no-forward-data, accounting identities, schema migration, persistence failure behavior and UI labels. Route any algorithm fixes back to Astra, rerun relevant checks, capture screenshots, commit checked result.

## Review focus

- Report money and per-share/ratio units must not be mixed in formatting.
- Missing/negative profit and invalid growth bases must be explained rather than rendered as misleading numbers.
- A report due at the current tick must publish exactly once; publication state must persist.
- Legacy migration must not spend RNG or recalculate trade ledger history.
- Malformed report values and dates must fail before replacing the current engine.

## Ledger

- Base `main` at `13a3293`; working branch `codex/fundamentals-reports`.
- User approved F10 + announcements and chose 5-trading-day compressed reports.
- Real pre-change v1 save with 100-share position preserved under ignored `test-results/` for migration verification.
- Work assigned to Astra (engine), Sol (F10), Terra (save envelope), root (terminal integration and validation).

- Complete: 42 tests and production build passed; real-browser F10, release timing, news-to-report links, loss valuation, legacy migration/refresh, corrupt report rejection and narrow layout verified.
- Fresh final review found loss-making earnings headline wording; Astra fixed it and the scoped re-review is clean.
- Post-integration pilot: 2400 stock-days, 2.442% daily log-return volatility, 10/10 final saved states restored.
- Original black terminal, ¥5,000 starting capital and integer-fen accounting conventions and legacy trading state preserved; game account restored from normal backup after migration testing.
