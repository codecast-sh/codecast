# Plan 001: Require proof before linking identities

> Authorized for end-to-end execution by the human on 2026-09-21. Root session jx7f70q owns integration and release; escalate product tradeoffs/regressions, not routine implementation choices.
> Planned against 07a081b853ca9bad1a1872eb757eb69a5c1acd34 on 2026-09-21, including existing uncommitted work.

Priority P0; effort M; change risk medium. Covers BACKEND-01, BACKEND-02, BACKEND-07 and PARENT-06. No implementation dependency; coordinate platform vendoring with plan 007.

## Why and current state

An attacker-owned Apple identity can claim another account's email. Password signup can attach credentials to an existing OAuth-only user when verification is off. Alternate contact email can also become Slack DM authority without mailbox proof.

The canonical files are ~/src/platform/packages/auth/src/convex/providers.ts, callbacks.ts and createAuthConfig.ts. Their Codecast mirror shows providers.ts:42 preferring supplied email:

    const email = ((args.email as string | undefined) ?? tokenEmail)?.toLowerCase().trim();

callbacks.ts:65 accepts only existingUserId/profile context, then looks up profile.email and returns that existing user at :89. It ignores proof/provenance. createAuthConfig.ts:138-153 enables password verification only with AUTH_EMAIL_VERIFICATION=1. callbacks.ts:32 checks redirects by startsWith(siteUrl).

Codecast packages/convex/convex/users.ts:addAlternateEmail schedules slackSync.claimSlackPeopleByEmail without verification. slackSync.ts:1622-1663 assigns identity and schedules DM retargeting; :1253-1285 changes room membership. Profile display data must not establish authority.

## Scope and conventions

Edit canonical auth provider/callback/config files and adjacent tests; Codecast auth.ts configuration, users.ts alias lifecycle, slackSync.ts verified-identity admission, schema.ts only for explicit verification/provenance fields, and their tests. Add migration/report code only after the data policy is approved. Do not merge/delete existing users, retarget historical DMs by heuristic, or change unrelated profile fields.

Follow the existing auth factory and Codecast fake-DB handler-test pattern, as used in packages/convex/convex/apiTokens.deviceBinding.test.ts. Keep account IDs tied to verified provider subjects. Apple private relay emails and absent email on returning sign-in are valid cases.

## Steps and verification

1. Add canonical auth tests with two different synthetic users. A new verified Apple subject plus a mismatched supplied email must never select the supplied-email user. Test missing/unverified token email and already-linked Apple subject. Add a real auth-library account-creation fixture, mocking the provider network only, so callback and credential persistence both run.
   Verify: from ~/src/platform/packages/auth run bun test; new negative cases must fail before repair and pass afterward.
2. Derive authoritative Apple claims only from the verified token. Preserve caller-supplied display name as display data. Make the callback consume trusted provider/linking context; unverified profile text must not deduplicate usable accounts. Password signups require proof before activation/linking. Cover existing OAuth-only and existing password accounts, concurrent signups, recovery and verified legitimate links.
   Verify: same canonical suite passes; no duplicate usable credential is created for another user.
3. Replace redirect string-prefix logic with parsed exact origins and a separate explicit native-link policy. Test sibling/prefix hosts, userinfo, protocol-relative targets, bad schemes, relative paths and expected desktop/mobile callbacks.
   Verify: canonical auth suite passes; malicious destinations are rejected and intended flows preserved.
4. Model alternate addresses as unverified until mailbox/provider proof succeeds. Only verified, uniquely owned identities can schedule Slack claim/DM mapping. Preserve manual mappings. Before enabling legacy aliases, produce a read-only count/report of ambiguous mappings; do not silently bless them.
   Verify: bun test packages/convex/convex/slackSync.test.ts plus a new packages/convex/convex/users.aliasVerification.test.ts; if slackSync.test.ts does not exist at execution time, locate its existing split suites with rg and record the replacement. Add a fixture proving unverified alias causes zero room/member/message writes.
5. Vendor canonical auth, then run cast check convex and cast check web. Run disposable staging sign-in/link/recovery tests and Slack-room fixtures. Record whether the deployed verification flag is enabled without printing other environment values.

## Acceptance and maintenance

All cases above must pass. Account linking must require an explicit proof source; no unauthenticated profile field can create login or DM authority. The security release owner separately reviews historic links/membership changes, preserves evidence and proposes targeted revocation. Do not infer past abuse merely from an alternate email. Audit every new provider against the same contract.

## Working and release rules

Work in the main checkout, as this repository requires. Before edits run git status --short and git diff for the scoped files; other sessions own existing diffs. Compare this plan's excerpts with current code and pause to reconcile material drift. Do not revert or stage others' changes. Keep fixes in small conventional commits, for example fix(security): enforce resource authority. The human has directed full end-to-end completion. Workers do not commit, push or deploy; the root release owner integrates and releases after verification, escalating concrete product tradeoffs or regressions.

Use Bun and existing test helpers. Run long commands in a dedicated tmux session; keep its log and result. Typecheck only with cast check, never a separate tsc. After focused tests pass, the release owner runs cast check, bun run lint and bun run test once for the integrated change; record unrelated baseline failures without claiming the gate passed. Add backend integration tests with disposable accounts and fixtures; client changes require real-browser verification through cast browser. Browser probes must use harmless markers and fake capabilities, never live private data.

Shared platform code is canonical in ~/src/platform: change and test it there, then run scripts/vendor-platform.sh from Codecast, followed by scripts/vendor-platform.sh --check-manifest. The vendor script refreshes dependency caches, so coordinate with active dev-server owners. Never hand-edit platform/packages. For an authorized release, deploy Convex only through packages/convex/deploy.sh, before a dependent web push; use CI for CLI releases. Record backend, web, CLI, desktop and mobile versions separately.

Stop and report if current behavior invalidates the stated threat model, a proposed fix needs an unlisted authority/schema migration, legitimate cross-user execution has no documented grant, or a test would affect production or real credentials. Resolve ordinary test failures, but do not invent a permissive fallback to make compatibility tests pass.

Done means all stated negative cases fail with no side effects, positive cases pass, focused gates and required integration checks have receipts, affected release versions and compatibility windows are recorded, and the matching plans/README.md row is updated. A passing old test suite alone is insufficient.

