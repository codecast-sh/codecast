# Plan 005: Bind integration grants to the authenticated confirmer

> Proposed implementation plan for discussion; this review does not authorize execution or deployment.
> Planned against 07a081b853ca9bad1a1872eb757eb69a5c1acd34 on 2026-09-21, including existing uncommitted work.

Priority P1; effort M-L; change risk medium. Covers PARENT-01/02 and investigation of GitHub identity claims. No dependency; canonical identity conventions from plan 001 must remain compatible.

## Why and current state

packages/shared/contracts/githubAppInstallState.ts:44 parses unsigned base64 JSON. Public http.ts:174-217 accepts its user/scope/team identity, fetches installation details using application credentials and stores the binding. githubApp.ts:294-295 refuses changing an already-linked installation, but first linking does not prove the callback caller controls the installation.

Generic OAuth has signed state, but oauthConnectors.ts:366-383 immediately patches an existing confirmed grant:

    const stillPending = !!existing.pending_confirm_hash;
    ...
    ...(stillPending ? { pending_confirm_hash: args.pending_confirm_hash, pending_expires_at: now + CONFIRM_TTL_MS } : {})

finishConfirm:431 returns early when there is no pending hash. connectionForWork:495-503 then accepts the replaced grant. A reconnect can therefore bypass the very confirmation required for first connect.

## Scope and conventions

Edit githubAppInstallState.ts, githubApp.ts, HTTP install callback, install UI flow/tests; oauthConnectors.ts and connector confirmation UI/tests, schema only for pending intents/replacements. Review users.linkGitHub and authority-bearing downstream claims; do not treat display identity as verified without provider proof. Provider-specific adapters, Gmail and webhook routes stay unchanged unless tests establish the same defect.

Use githubApp.access.test.ts and oauthConnectors.test.ts as fake-DB handler patterns. Keep provider secrets encrypted and never log grant/token bodies. Signing state is necessary but not proof of installation ownership.

## Steps and verification

1. Add install-intent records bound to authenticated Codecast principal, exact scope, expiry and single-use nonce. Revalidate current team administration at completion. Establish authenticated GitHub-user access to installation using the supported user-token flow before binding. Preserve the existing-binding protection and handle legitimate reinstall explicitly.
   Verify: bun test packages/convex/convex/githubApp.access.test.ts packages/web/lib/githubAppInstall.test.ts packages/convex/convex/githubApp.repositories.test.ts. Forged identity/state, wrong installer, expired/replayed intent, revoked membership and concurrent binding all refuse without writes. Valid first install/reinstall succeeds.
2. Separate pending reconnect credentials from active credentials. Confirmation must authenticate the initiating user and revalidate current scope authority and expected provider account; atomically promote and consume the intent. Failure/expiry leaves the old grant usable; abandoned replacement secrets are removed/revoked when appropriate.
   Verify: bun test packages/convex/convex/oauthConnectors.test.ts. Existing confirmed row + new provider account remains old/usable until correct confirmation. Wrong user, wrong workspace, replay, expiry and lost membership cannot activate the new grant. Concurrent refresh/reconnect cannot restore stale credentials.
3. Check team scope resolution for active_team_id fallback and membership freshness. Personal workspace is a positive value; absence of active team cannot silently select historical routing team. Audit users.linkGitHub: claimed numeric ID/username becomes authority only after a token-backed provider lookup.
   Verify: extend the same suites with personal/team transitions and a fixture showing an unverified claimed GitHub identity cannot affect protected assignments or access. If it is purely display metadata, document that limitation rather than inventing a takeover.
4. Run cast check convex and cast check web. In provider test tenants, test installation authorization and reconnect end to end with two disposable Codecast users; mock only external side effects that would contact real users.

## Acceptance and maintenance

No public callback can choose the Codecast principal whose integration it creates. No replacement grant is usable before authenticated confirmation. Current scope authority is checked at completion, not only initiation. All grants have audit events with redacted identifiers, actor, scope, outcome and intent correlation. Preserve existing webhook HMAC/replay checks and Gmail's separate confirmation model.

## Working and release rules

Work in the main checkout, as this repository requires. Before edits run git status --short and git diff for the scoped files; other sessions own existing diffs. Compare this plan's excerpts with current code and pause to reconcile material drift. Do not revert or stage others' changes. Keep fixes in small conventional commits, for example fix(security): enforce resource authority. No push, merge or production deployment is part of executing this proposed plan without the human's direction.

Use Bun and existing test helpers. Run long commands in a dedicated tmux session; keep its log and result. Typecheck only with cast check, never a separate tsc. After focused tests pass, the release owner runs cast check, bun run lint and bun run test once for the integrated change; record unrelated baseline failures without claiming the gate passed. Add backend integration tests with disposable accounts and fixtures; client changes require real-browser verification through cast browser. Browser probes must use harmless markers and fake capabilities, never live private data.

Shared platform code is canonical in ~/src/platform: change and test it there, then run scripts/vendor-platform.sh from Codecast, followed by scripts/vendor-platform.sh --check-manifest. The vendor script refreshes dependency caches, so coordinate with active dev-server owners. Never hand-edit platform/packages. For an authorized release, deploy Convex only through packages/convex/deploy.sh, before a dependent web push; use CI for CLI releases. Record backend, web, CLI, desktop and mobile versions separately.

Stop and report if current behavior invalidates the stated threat model, a proposed fix needs an unlisted authority/schema migration, legitimate cross-user execution has no documented grant, or a test would affect production or real credentials. Resolve ordinary test failures, but do not invent a permissive fallback to make compatibility tests pass.

Done means all stated negative cases fail with no side effects, positive cases pass, focused gates and required integration checks have receipts, affected release versions and compatibility windows are recorded, and the matching plans/README.md row is updated. A passing old test suite alone is insufficient.

