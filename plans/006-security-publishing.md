# Plan 006: Isolate published content from control credentials and enforce gates at every write

> Authorized for end-to-end execution by the human on 2026-09-21. Root session jx7f70q owns integration and release; escalate product tradeoffs/regressions, not routine implementation choices.
> Planned against 07a081b853ca9bad1a1872eb757eb69a5c1acd34 on 2026-09-21, including existing uncommitted work.

Priority P1 token isolation; P2 public-write and cache controls. Effort L; change risk high. Covers PARENT-03/04/05. No dependency; coordinate browser policy with plan 003.

## Why and current state

artifactsHttp.ts:1060-1091 combines arbitrary publisher HTML with controls in one document. artifactPages.ts:445-454 reads owner/edit/comment identity from location.hash. The response sandbox omits same-origin but allows scripts: it protects app storage, not the capabilities in its own document. Owner keys authorize management and owner-gated comment delivery into a linked agent session.

HTTP comments apply a limiter at artifactsHttp.ts:727-764, but the public artifacts.submitComments mutation at artifacts.ts:1145-1282 has no matching password/expiry/rate check. A synthetic expired password page accepted an anonymous comment directly; agent delivery remained owner-gated.

Current/historical response cache policies at artifactsHttp.ts:834-836 and the edge worker's forced public cache can serve stale authorized bodies after gate changes. Previously downloaded bytes cannot be revoked; future network response behavior can be defined and tested.

## Scope and conventions

Edit artifactsHttp.ts, artifactPages.ts, artifacts.ts, internal artifact auth helpers/schema, web/app/artifacts/auth/page.tsx and publishing UI/CLI link consumers as needed, infra/artifact-edge/worker.js and tests. Keep raw interactive published HTML supported; do not silently remove all scripts or move management authority into child postMessage payloads.

Use artifacts.test.ts and artifactsHttp.test.ts handlers/fake storage as exemplars. Distinguish owner/manage, link-edit, commenter identity, viewing gate and public content. Each capability should authorize only one role and have explicit revocation/expiry.

## Steps and verification

1. Place raw content in a sandboxed child document on an isolated origin/document. Place management/comment controls in a trusted parent/sibling. Raw content must never receive owner/edit/comment identity credentials through hash, DOM, parent messages or inherited storage. Replace page-level comment authority with trusted UI calls or narrowly scoped short-lived grants.
   Verify: bun test packages/convex/convex/artifactsHttp.test.ts packages/convex/convex/artifacts.test.ts plus new rendering/capability tests. Browser fixture runs arbitrary harmless child script: cannot observe synthetic parent secrets or invoke control operations. Legitimate owner management, edit-link and signed-in comments still work.
2. Define a minimal validated postMessage protocol if needed: exact child window, expected origin/opaque-frame handling, message shape, bounded size and allowed action. Resize/navigation requests never carry authority or trigger agent delivery. Keep trusted controls visually distinct from content.
   Verify: browser fixture sends forged messages from sibling/nested/foreign frames; no privileged action occurs. Test deep links, fullscreen, downloads, mobile display and existing published URLs.
3. Move gate/rate/size checks into the authoritative mutation core, or make writes internal behind a checked public interface. Direct Convex and HTTP must have the same password, expiry, comments-disabled and quota behavior. Review recordView spam and identity spoofing separately. Keep owner-only delivery to sessions.
   Verify: direct _handler tests for anonymous wrong gate/expired page/oversize/repeated submissions yield no stored comment or delivery. Valid anonymous/public and authenticated/gated submissions follow product policy. Atomic limiter tests cover concurrency.
4. Set no-store/private policy for protected or token-bearing representations. Cache only authorization-independent public content, cap TTL to expiry and invalidate/purge when gate/delete state changes. Decide and document a future-network revocation bound before rollout.
   Verify: warmed local cache/edge fixture tests password addition/change, edit revocation, expiry, delete, old version and asset URLs. After the bound, old URLs cannot obtain a new protected body. Do not assert deletion of bytes already saved by viewers.
5. Run cast check convex and cast check web. Verify owner/edit/comment flows and raw-page isolation in cast browser using synthetic artifacts; no production agent delivery. Use staging R2/edge deployment for actual cache semantics before closure.

## Acceptance and maintenance

Raw page script cannot obtain a control/identity capability even when the owner views it. Direct public writes cannot bypass gates. Revocation semantics are tested across origin/CDN/browser. Inventory and rotate/revoke legacy capabilities deliberately, including commenter tokens that currently do not expire; do not break all published links without an approved migration.

## Working and release rules

Work in the main checkout, as this repository requires. Before edits run git status --short and git diff for the scoped files; other sessions own existing diffs. Compare this plan's excerpts with current code and pause to reconcile material drift. Do not revert or stage others' changes. Keep fixes in small conventional commits, for example fix(security): enforce resource authority. The human has directed full end-to-end completion. Workers do not commit, push or deploy; the root release owner integrates and releases after verification, escalating concrete product tradeoffs or regressions.

Use Bun and existing test helpers. Run long commands in a dedicated tmux session; keep its log and result. Typecheck only with cast check, never a separate tsc. After focused tests pass, the release owner runs cast check, bun run lint and bun run test once for the integrated change; record unrelated baseline failures without claiming the gate passed. Add backend integration tests with disposable accounts and fixtures; client changes require real-browser verification through cast browser. Browser probes must use harmless markers and fake capabilities, never live private data.

Shared platform code is canonical in ~/src/platform: change and test it there, then run scripts/vendor-platform.sh from Codecast, followed by scripts/vendor-platform.sh --check-manifest. The vendor script refreshes dependency caches, so coordinate with active dev-server owners. Never hand-edit platform/packages. For an authorized release, deploy Convex only through packages/convex/deploy.sh, before a dependent web push; use CI for CLI releases. Record backend, web, CLI, desktop and mobile versions separately.

Stop and report if current behavior invalidates the stated threat model, a proposed fix needs an unlisted authority/schema migration, legitimate cross-user execution has no documented grant, or a test would affect production or real credentials. Resolve ordinary test failures, but do not invent a permissive fallback to make compatibility tests pass.

Done means all stated negative cases fail with no side effects, positive cases pass, focused gates and required integration checks have receipts, affected release versions and compatibility windows are recorded, and the matching plans/README.md row is updated. A passing old test suite alone is insufficient.

