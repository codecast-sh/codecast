# Plan 002: Authorize every resource and bind patch IDs to their table

> Authorized for end-to-end execution by the human on 2026-09-21. Root session jx7f70q owns integration and release; escalate product tradeoffs/regressions, not routine implementation choices.
> Planned against 07a081b853ca9bad1a1872eb757eb69a5c1acd34 on 2026-09-21, including existing uncommitted work.

Priority P0 first slice / P1-P2 remainder; effort L in separate patches; change risk medium, high for credential migration. Covers BACKEND-03/04/05/06/08/09. No dependency on identity repair; release both urgently.

## Why and current state

A signed-in user is not entitled to mutate every known ID. Generic patches select a table policy using caller input, then read/write the actual supplied ID without verifying its table:

    const doc = await ctx.db.get(docKey as Id<any>);

packages/convex/convex/dispatch.ts:369-458 checks user_id on that row but may use the conversations/buckets field rules on a membership. Real fixture testing promoted a member to admin.

managedSessions.ts:220-240 removes target conversation registrations and inserts a fresh caller-owned session without authorizing that conversation. :674-684 then trusts the attachment to read pending prompts; markMessageDelivered at :688-716 authenticates only. data.ts:201-204 returns records = all for all-workspaces, including other users' private team-routed rows. messages.ts:2583-2614 checks existence of a stored share token instead of possession.

The canonical auth apiTokens.ts deliberately checks device binding only in HTTP cliRoute; directly callable functions such as users.getMyPendingCommands accept the bearer without that check.

## Scope and conventions

Edit dispatch.ts and tests; managedSessions.ts and registration/reclaim/delivery tests; data.ts and workspace tests plus list consumers where needed; messages.ts and share-token tests; canonical apiTokens.ts, Codecast credential adapters/http.ts/users.ts and direct token consumers for a staged migration. Add schema fields only for an agreed execution grant/credential contract.

Workspace is access; team_id is routing. Preserve that distinction. Reuse lib/access.ts and privacy.ts rather than inventing parallel membership rules. Execution authority is stricter than visibility, but authorized cross-user reparenting must remain possible through an explicit grant. Match dispatch.test.ts's public _handler fixtures and fake DB; add a disposable Convex integration case for actual typed-ID behavior.

## Steps and verification

1. Before any generic read/write, normalizeId for the selected table and reject mismatch. Replace field denylists with explicit client-editable allowlists in a separate reviewable patch; sensitive identity, membership, workspace and command fields use named server mutations. Unknown patch/action contracts fail closed.
   Verify: bun test packages/convex/convex/dispatch.test.ts packages/convex/convex/authorizationContainment.test.ts. Add membership/token/command IDs under every wrong policy; no writes or side effects. Valid optimistic/outbox edits still pass.
2. Centralize conversation execution admission. Apply it before registration cleanup, relinking, cross-user stale reclaim, pending reads and delivery acknowledgments. Validate registered device ownership when a device is supplied/required; omission cannot bypass execution authority. Test fresh/stale/live session IDs, omitted device, revoked runner, legitimate handover, concurrent claims and foreign pending-message IDs.
   Verify: bun test packages/convex/convex/managedSessions.register.test.ts packages/convex/convex/managedSessions.reclaim.test.ts packages/convex/convex/managedSessions.ackInjected.test.ts plus new delivery-authorization tests. Foreign cases produce no deletion/patch; valid delivery succeeds.
3. Apply canonical access predicates to all-workspaces unions and joins. Preserve explicit assignee grants and owner access. Lists must agree with by-ID predicates for team-routed-private rows.
   Verify: bun test packages/convex/convex/data.workspace.test.ts packages/convex/convex/syncLog.test.ts. Add public plans/docs/projects/initiatives list cases, not only helper tests.
4. Require presented share token through privacy.checkConversationAccess in the public content query, or remove it after proving no callers. Bound scans.
   Verify: bun test packages/convex/convex/privacy.shareToken.test.ts plus the new public-content-query tests; missing/wrong/revoked tokens yield no predicate result.
5. Inventory every directly callable api_token function. Define credential class and device contract once, then enforce it at the actual public boundary, or move implementations internal behind an authenticated adapter. Merely accepting a device_id string is not cryptographic possession. Do not globally reject old daemons without a versioned migration.
   Verify: bun test packages/convex/convex/apiTokens.deviceBinding.test.ts and canonical auth suite. Test HTTP and direct Convex with absent/wrong/correct device, expired/revoked tokens and setup/session credentials. Run cast check convex.

## Acceptance and maintenance

Disposable two-team integration fixtures must demonstrate no cross-account resource reads/writes and no cross-table patching. Legitimate runner transitions, outbox replay and share navigation still work. Maintain a public endpoint matrix recording auth class, resource judge, editable fields and side effects. New transport wrappers cannot be the sole check if underlying functions stay public.

## Working and release rules

Work in the main checkout, as this repository requires. Before edits run git status --short and git diff for the scoped files; other sessions own existing diffs. Compare this plan's excerpts with current code and pause to reconcile material drift. Do not revert or stage others' changes. Keep fixes in small conventional commits, for example fix(security): enforce resource authority. The human has directed full end-to-end completion. Workers do not commit, push or deploy; the root release owner integrates and releases after verification, escalating concrete product tradeoffs or regressions.

Use Bun and existing test helpers. Run long commands in a dedicated tmux session; keep its log and result. Typecheck only with cast check, never a separate tsc. After focused tests pass, the release owner runs cast check, bun run lint and bun run test once for the integrated change; record unrelated baseline failures without claiming the gate passed. Add backend integration tests with disposable accounts and fixtures; client changes require real-browser verification through cast browser. Browser probes must use harmless markers and fake capabilities, never live private data.

Shared platform code is canonical in ~/src/platform: change and test it there, then run scripts/vendor-platform.sh from Codecast, followed by scripts/vendor-platform.sh --check-manifest. The vendor script refreshes dependency caches, so coordinate with active dev-server owners. Never hand-edit platform/packages. For an authorized release, deploy Convex only through packages/convex/deploy.sh, before a dependent web push; use CI for CLI releases. Record backend, web, CLI, desktop and mobile versions separately.

Stop and report if current behavior invalidates the stated threat model, a proposed fix needs an unlisted authority/schema migration, legitimate cross-user execution has no documented grant, or a test would affect production or real credentials. Resolve ordinary test failures, but do not invent a permissive fallback to make compatibility tests pass.

Done means all stated negative cases fail with no side effects, positive cases pass, focused gates and required integration checks have receipts, affected release versions and compatibility windows are recorded, and the matching plans/README.md row is updated. A passing old test suite alone is insufficient.

