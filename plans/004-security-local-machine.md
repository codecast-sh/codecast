# Plan 004: Separate content delivery from local machine control

> Authorized for end-to-end execution by the human on 2026-09-21. Root session jx7f70q owns integration and release; escalate product tradeoffs/regressions, not routine implementation choices.
> Planned against 07a081b853ca9bad1a1872eb757eb69a5c1acd34 on 2026-09-21, including existing uncommitted work.

Priority P1 active content/parser; P2 hooks/copy. Effort L in small fixes; change risk medium. Covers LOCAL-01/02/03 and the admission half of PARENT-08. Dependency upgrade coordinated with plan 008.

## Why and current state

packages/cli/src/vault/vaultServer.ts:160-169 serves SVG bytes with their MIME type and no restrictive CSP/disposition. :343-354 accepts the full loopback bearer in an attachment URL. terminal/terminalServer.ts accepts that same bearer and loopback origin, so opening an attacker-provided SVG as a document crosses from repository content to machine authority. Normal img rendering is inert.

daemon.ts:2105 accepts unauthenticated GET /hook/status, including transcript_path. At :28030 the hook sink calls handleStatusData but independently persists/schedules ingestion after rejection. Legacy remote/session-move.ts:863-870 joins repo manifest setup.copy paths into both worktrees without containment. cloud/transfer.ts already contains validateRelativePath/sourceStat patterns.

browser/bridge/host.ts:1123 installs maxPayload 256 MiB before authentication; :1200 rejects only HTTP(S) Origins, allowing null into extension upgrade. HMAC still gates commands. Raw local clients can reach vulnerable ws fragmentation; browsers cannot select that fragmentation.

## Scope and conventions

Edit vault response/auth capability handling, terminal shared admission if needed, web/lib/vault/client.ts URL construction, daemon hook router/sink and installed-hook generator, launchToken.ts migration, legacy copy and shared cloud-transfer validation, bridge host/protocol tests. Use existing loopbackIdentity and scoped vault path helpers; preserve private socket/token modes and HMAC mutual proof.

Do not broaden global loopback-origin trust, disable terminal auth, change human browser pairing, run exhaustion against a daemon, copy real files remotely, or treat intentional repo setup commands as forbidden.

## Steps and verification

1. Add an inert fixture using the real vault handler. Assert active SVG/document responses have a script-blocking sandbox/CSP and nosniff policy; keep legitimate img/media/PDF usage. Replace full bearer in URLs with an expiring file/vault-read capability that cannot authorize terminal, filesystem mutations or other files. Redact URL capabilities in logs.
   Verify: bun test packages/cli/src/vault/vaultScope.test.ts plus new attachment-capability tests. In cast browser, direct-open synthetic SVG: marker never executes. Test same capability against inert terminal/write handlers: all deny.
2. Authenticate hook ingress using an envelope available to installed hooks or a private local socket. Return explicit acceptance and gate every persistence/scheduling side effect on it. Resolve transcript path from accepted session identity rather than arbitrary input. Plan old-hook replacement and early-boot replay explicitly.
   Verify: new daemon hook-ingress tests call the real router/sink with inert storage/sync. Missing/wrong/stale token, wrong Host/Origin, unknown session and mismatched transcript cause zero side effects; valid hook updates and syncs once. Test statusline POST too.
3. Reuse one strict copy collector for legacy and cloud paths. Validate relative path, canonical source/ancestor and destination containment before any mkdir/rsync. Fail clearly on invalid manifest instead of hiding rejection behind fallback.
   Verify: bun test packages/cli/src/cloud/transfer.test.ts packages/cli/src/workspace/manifest.test.ts plus new remote/session-move.copy.test.ts. Stub only process execution. Traversal/absolute/intermediate-symlink fixtures schedule zero transfers; nested legitimate setup files copy.
4. Reject unexpected/null Origin at extension upgrade. Preserve intended absent-origin/native extension behavior only through documented authenticated pairing. Separate small pre-auth hello limits from authenticated screenshot traffic; add deadline/concurrency limits and clean forbidden sockets before message parsing.
   Verify: bun test packages/cli/src/browser/bridge/host.test.ts packages/cli/src/browser/bridge/protocol.test.ts. Null/hostile Origins fail pre-upgrade; wrong proof cannot replace current extension; valid pairing/control and large authenticated screenshots still work. No load testing on the user's bridge.
5. Run cast check cli and cast check web. Test installed hooks and attachment display against a disposable daemon/config directory with all machine execution replaced by inert fixtures; test real Chrome only for harmless rendering and bridge admission.

## Acceptance and maintenance

Attachment authority is narrow and expiring. Rejected hooks perform no work. Copy boundaries match between old/new remote paths. Unauthenticated bridge messages have bounded resources. Keep protocol compatibility tests across supported CLI/extension versions; tie legacy hook removal to a documented release window. Wider authorized remote transfers require an explicit user-level grant, not repository path tricks.

## Working and release rules

Work in the main checkout, as this repository requires. Before edits run git status --short and git diff for the scoped files; other sessions own existing diffs. Compare this plan's excerpts with current code and pause to reconcile material drift. Do not revert or stage others' changes. Keep fixes in small conventional commits, for example fix(security): enforce resource authority. The human has directed full end-to-end completion. Workers do not commit, push or deploy; the root release owner integrates and releases after verification, escalating concrete product tradeoffs or regressions.

Use Bun and existing test helpers. Run long commands in a dedicated tmux session; keep its log and result. Typecheck only with cast check, never a separate tsc. After focused tests pass, the release owner runs cast check, bun run lint and bun run test once for the integrated change; record unrelated baseline failures without claiming the gate passed. Add backend integration tests with disposable accounts and fixtures; client changes require real-browser verification through cast browser. Browser probes must use harmless markers and fake capabilities, never live private data.

Shared platform code is canonical in ~/src/platform: change and test it there, then run scripts/vendor-platform.sh from Codecast, followed by scripts/vendor-platform.sh --check-manifest. The vendor script refreshes dependency caches, so coordinate with active dev-server owners. Never hand-edit platform/packages. For an authorized release, deploy Convex only through packages/convex/deploy.sh, before a dependent web push; use CI for CLI releases. Record backend, web, CLI, desktop and mobile versions separately.

Stop and report if current behavior invalidates the stated threat model, a proposed fix needs an unlisted authority/schema migration, legitimate cross-user execution has no documented grant, or a test would affect production or real credentials. Resolve ordinary test failures, but do not invent a permissive fallback to make compatibility tests pass.

Done means all stated negative cases fail with no side effects, positive cases pass, focused gates and required integration checks have receipts, affected release versions and compatibility windows are recorded, and the matching plans/README.md row is updated. A passing old test suite alone is insufficient.

