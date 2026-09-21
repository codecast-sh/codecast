# Plan 007: Make logout and account changes an all-window boundary

> Authorized for end-to-end execution by the human on 2026-09-21. Root session jx7f70q owns integration and release; escalate product tradeoffs/regressions, not routine implementation choices.
> Planned against 07a081b853ca9bad1a1872eb757eb69a5c1acd34 on 2026-09-21, including existing uncommitted work.

Priority P1; effort L; change risk high. Covers CLIENT-04. Coordinate canonical auth vendoring with plan 001; server repairs need not wait for this work.

## Why and current state

Codecast supplies durableAuthStorage, a wrapper object, to ConvexAuthProvider. Installed @convex-dev/auth 0.0.79's storage listener ignores an event unless:

    if (event.storageArea !== storage) return;

Native events carry native localStorage, so the wrapper fails that identity comparison. The mismatch was reproduced with a real synthetic StorageEvent. packages/web/hooks/useCodecastSignOut.ts clears only the caller's protected in-memory store before purging disk. syncReplication.ts uses an origin-wide channel/lock; idbCache.ts:85 names one codecast-store DB. Full two-account disclosure timing remains an integration validation item, not an established indefinite server-access claim.

## Scope and conventions

Edit canonical ~/src/platform/packages/auth/src/web/durableAuthStorage.ts and local auth/provider synchronization helpers/tests; Codecast web/src/providers.tsx, hooks/useCodecastSignOut.ts, hooks/useSyncRole.ts, store/syncReplication.ts, store/idbCache.ts and protected-memory/hydration boundaries. Add tests beside existing auth/cache/replication suites. Do not rewrite inbox rendering, optimistic actions or unrelated account usage UI.

Preserve local-first/offline boot for the same verified principal. All data enters through syncTable/syncRecord and pending protection; never fix replication by raw slice assignment. Existing mobile authTrust behavior and principal-scoped gesture replication provide patterns, but do not copy mobile code blindly.

## Steps and verification

1. Build a browser fixture with two actual mounted auth providers and separate windows sharing a profile, fake token issuer and delayed hydration/replication. Demonstrate logout/account-change propagation failure without real credentials.
   Verify: add packages/web/lib/__tests__/authPrincipalIsolation.test.ts and a browser fixture. Record behavior before repair; do not substitute a test that merely compares storage objects.
2. Introduce a supported explicit principal invalidation path for the auth storage wrapper. On logout/change, stop old dispatch and sync ownership synchronously, increment a principal epoch, clear protected memory across all windows, and reject late callbacks with the old epoch. Disk purge failure must not silently resume old-principal reads.
   Verify: canonical auth bun test; new integration tests confirm every provider exits old auth before new cache paint. Test token rotation within same user separately so routine refresh does not clear the app.
3. Namespace cache, channel and host election by verified principal, or implement an explicitly tested single-principal-per-origin protocol. No follower may accept state from another principal; no pending mutation may replay under the next account. Dispose channels/listeners and release locks on transition.
   Verify: two-window tests exercise host logout, follower logout, host crash, delayed IDB read, delayed message, offline switch, rapid switch back, token expiry, device sleep/resume and stale outbox. No old row appears in new account state and no old mutation is dispatched under a new identity.
4. Migrate existing global cache without exposing it before principal verification. Preserve same-account offline data only when its ownership is established; otherwise clear it safely. Coordinate schema/version signature guards.
   Verify: migration fixtures for fresh, known-owner and unknown-owner caches; no unowned protected first paint. Run cast check web and canonical auth suite, then scripts/vendor-platform.sh --check-manifest after the coordinated vendor refresh.
5. Repeat browser and Electron multi-window flows with disposable accounts on staging. Test logout, login, popouts and offline reopening; verify server session revocation separately from UI clearing.

## Acceptance and maintenance

Logout clears every open window before another principal can render or dispatch. Hydration/replication are bound to the verified principal and transition epoch. Ordinary offline boot, optimistic edits and same-user token rotation remain correct. No claim of full closure without actual two-window tests. Watch every future sync feeder, persistence table and window type for principal scoping.

## Working and release rules

Work in the main checkout, as this repository requires. Before edits run git status --short and git diff for the scoped files; other sessions own existing diffs. Compare this plan's excerpts with current code and pause to reconcile material drift. Do not revert or stage others' changes. Keep fixes in small conventional commits, for example fix(security): enforce resource authority. The human has directed full end-to-end completion. Workers do not commit, push or deploy; the root release owner integrates and releases after verification, escalating concrete product tradeoffs or regressions.

Use Bun and existing test helpers. Run long commands in a dedicated tmux session; keep its log and result. Typecheck only with cast check, never a separate tsc. After focused tests pass, the release owner runs cast check, bun run lint and bun run test once for the integrated change; record unrelated baseline failures without claiming the gate passed. Add backend integration tests with disposable accounts and fixtures; client changes require real-browser verification through cast browser. Browser probes must use harmless markers and fake capabilities, never live private data.

Shared platform code is canonical in ~/src/platform: change and test it there, then run scripts/vendor-platform.sh from Codecast, followed by scripts/vendor-platform.sh --check-manifest. The vendor script refreshes dependency caches, so coordinate with active dev-server owners. Never hand-edit platform/packages. For an authorized release, deploy Convex only through packages/convex/deploy.sh, before a dependent web push; use CI for CLI releases. Record backend, web, CLI, desktop and mobile versions separately.

Stop and report if current behavior invalidates the stated threat model, a proposed fix needs an unlisted authority/schema migration, legitimate cross-user execution has no documented grant, or a test would affect production or real credentials. Resolve ordinary test failures, but do not invent a permissive fallback to make compatibility tests pass.

Done means all stated negative cases fail with no side effects, positive cases pass, focused gates and required integration checks have receipts, affected release versions and compatibility windows are recorded, and the matching plans/README.md row is updated. A passing old test suite alone is insufficient.

