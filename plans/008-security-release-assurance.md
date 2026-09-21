# Plan 008: Authenticate releases and make security coverage repeatable

> Proposed implementation plan for discussion; this review does not authorize execution or deployment.
> Planned against 07a081b853ca9bad1a1872eb757eb69a5c1acd34 on 2026-09-21, including existing uncommitted work.

Priority P1 updater/ws; P2 broader assurance. Effort L; change risk high for update bootstrap. Covers PARENT-07/08/09 and remaining hardening/coverage gaps. Coordinate bridge tests with plan 004; full acceptance matrix follows all fixes.

## Why and current state

packages/cli/src/update.ts:35 interpolates a manifest URL inside an execSync shell command. A controlled URL can trigger shell evaluation before checksum comparison. Canonical cli-kit update/updater.ts:249-269 downloads from an unsigned manifest and compares a checksum supplied by that same source. web/public/install.sh:56-91 downloads and installs directly. CI hashes staged objects and signs Darwin binaries, but client trust is not independently anchored against a compromised release source.

CLI package.json pins ws 8.18.0; upstream GHSA-96hv-2xvq-fx4p is fixed in 8.21.0. A pre-auth bridge parser is reachable as described in plan 004. The broader audit generated 96 high/critical advisory/version match rows, not 96 proven vulnerabilities.

## Scope and conventions

Edit CLI update adapter/tests, canonical ~/src/platform/packages/cli-kit/src/update and release helpers/tests, installer, cut/finalize workflows and manifests, affected dependency manifests/bun.lock; add security inventory/verification tooling and documentation. Live IAM, account history, native builds and backup checks are read-only assurance tasks unless separately authorized.

Do not hand-edit generated platform packages, rotate production signing secrets, blanket-upgrade unrelated frameworks, start load attacks, dump environment values or change all remote credentials. Follow existing hash/signature verification and CI-only release conventions.

## Steps and verification

1. Replace shell interpolation with argv execution or direct fetch; validate HTTPS, allowed origin and redirect chain before download. Define digest format/size bounds. Tests treat shell metacharacters as literal rejected data and stub process/network.
   Verify: add packages/cli/src/update.test.ts; bun test that file and canonical cli-kit update suite. No shell process is invoked and failed validation cannot replace the binary.
2. Add independent signed-manifest verification with a pinned public key, clear signing-key rotation and emergency recovery, anti-rollback/version policy and platform signature checks. Define trusted bootstrap for existing clients and installer. Hash/signature/architecture verification occurs before executable replacement; use atomic safe files and preserve rollback availability.
   Verify: canonical cli-kit bun test covers altered manifest, wrong/rotated key, modified artifact, bad redirect, downgrade, wrong arch, partial download and interrupted replacement. An isolated install fixture never runs downloaded content. CI dry_run builds/signs/verifies without publication only when authorized.
3. Upgrade the actually resolved CLI ws to a patched release; verify the resolved import, not just package.json. Add pre-auth bounds from plan 004. Triage every audit row by resolved path, affected symbol, untrusted input and deployment mode. Record dev-only/unreachable determinations with evidence and review expiry; do not suppress raw audit output as a clean bill of health.
   Verify: bun audit --json plus a version/reachability ledger; selected vulnerable runtime paths are fixed. Run bridge host/protocol tests and cast check cli. No uncontrolled resource-exhaustion test.
4. Generate public entrypoint inventory and exercise real handlers in a permission matrix: anonymous, owner, teammate, admin, other team, revoked member, share guest, wrong-table ID, expired/wrong-purpose token, missing device and stale runner. Cover org/delegation/decision, invitations, chat/calls/transcripts, task/plan/doc/project joins, storage and uploads. Each unresolved cell is a named task, not implicitly safe.
   Verify: machine-readable inventory has an auth class/resource judge/quota/revocation entry or explicit unresolved status for every exported endpoint; new negative handler tests pass. Add direct API tests alongside HTTP/UI tests.
5. Review storage capability revocation/quota, user-supplied GitHub identity downstream uses, Linux browser sandbox/credential separation, config-path symlinks and auth callback body limits. Inspect live release/infra IAM, R2 roles, network exposure, backup restoration, secret-history scans and telemetry redaction without printing secrets. Reuse ct-39959 for provider-key rotation planning.
   Verify: produce evidence checklist with date, runtime version, finding/result and owner; restore only synthetic backup data into an isolated environment. Missing access is explicit, never marked passed.
6. Establish one security release owner and compatibility matrix. Run cast check, bun run lint, bun run test once for the integrated tree in tmux, then targeted backend end-to-end, browser, packaged Electron and mobile verification. Required build/release dry runs must account for existing scripts' publishing/network side effects before execution.

## Acceptance and maintenance

Install/update cannot execute unsigned, wrong-platform or altered artifacts, and no metadata is interpreted as shell syntax. Reachable advisories have fixes or explicit time-bound risk decisions. All 28 finding rows have verified closure or a reviewed disposition, and the remaining surface matrix is complete. Record distinct backend/web/CLI/desktop/mobile deployment versions; a fixed main branch alone does not protect old clients. Re-run boundary tests for every new public endpoint, content renderer, provider and release mechanism.

## Working and release rules

Work in the main checkout, as this repository requires. Before edits run git status --short and git diff for the scoped files; other sessions own existing diffs. Compare this plan's excerpts with current code and pause to reconcile material drift. Do not revert or stage others' changes. Keep fixes in small conventional commits, for example fix(security): enforce resource authority. No push, merge or production deployment is part of executing this proposed plan without the human's direction.

Use Bun and existing test helpers. Run long commands in a dedicated tmux session; keep its log and result. Typecheck only with cast check, never a separate tsc. After focused tests pass, the release owner runs cast check, bun run lint and bun run test once for the integrated change; record unrelated baseline failures without claiming the gate passed. Add backend integration tests with disposable accounts and fixtures; client changes require real-browser verification through cast browser. Browser probes must use harmless markers and fake capabilities, never live private data.

Shared platform code is canonical in ~/src/platform: change and test it there, then run scripts/vendor-platform.sh from Codecast, followed by scripts/vendor-platform.sh --check-manifest. The vendor script refreshes dependency caches, so coordinate with active dev-server owners. Never hand-edit platform/packages. For an authorized release, deploy Convex only through packages/convex/deploy.sh, before a dependent web push; use CI for CLI releases. Record backend, web, CLI, desktop and mobile versions separately.

Stop and report if current behavior invalidates the stated threat model, a proposed fix needs an unlisted authority/schema migration, legitimate cross-user execution has no documented grant, or a test would affect production or real credentials. Resolve ordinary test failures, but do not invent a permissive fallback to make compatibility tests pass.

Done means all stated negative cases fail with no side effects, positive cases pass, focused gates and required integration checks have receipts, affected release versions and compatibility windows are recorded, and the matching plans/README.md row is updated. A passing old test suite alone is insufficient.

