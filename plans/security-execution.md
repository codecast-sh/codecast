# Security execution control — pl-734

The human authorized full end-to-end implementation, verification and completion on 2026-09-21. This supersedes the earlier proposal-only wording in the audit plans. Bring product tradeoffs and regressions to the human; routine engineering choices and verification proceed autonomously. Root session jx7f70q owns integration and releases.

## Definition of done

- Every one of the 28 register entries has an independently reviewed fix or evidence-backed disposition; no silent omissions.
- Regression tests exercise the failed trust boundary through real handlers, not only mirrored helper logic.
- Backend direct APIs and HTTP routes have equivalent authority checks. Client fixes are browser-verified; Electron/mobile claims require packaged/native evidence.
- Existing supported flows remain usable; any intentional feature restriction, identity migration or compatibility change has a recorded product decision.
- Typecheck, tests and lint run once on the integrated result, with all relevant failures resolved. Security gates cannot be waived by unrelated green tests.
- Required backend/web/CLI/extension/desktop/mobile release versions are recorded and verified. Source-only completion is not end-to-end completion.
- Evidence/history review, configuration validation and remaining surface coverage are closed or have a real external blocker explicitly brought to the human.

## Execution model

Use tmux-based implementers and fresh reviewers, maximum three workers concurrently. Repository instruction requires the shared main checkout; do not create competing worktrees. Workers have non-overlapping file ownership. Root owns commits/pushes/deploys and canonical platform vendoring; workers never run whole-tree stage/format/install or deploy. Existing diffs belong to other sessions and must be preserved.

Each worker reads its numbered plan and relevant detailed audit. It claims its parent task, implements in bounded slices, runs focused tests through actual code and cast check, posts evidence, and reports exact changed files and remaining cases. It leaves the task in review, not done, until root's independent review and end-to-end verification. No prompt dry-run outside the approved harness. No real-account exploit, load attack, live media capture or secret-value output.

Use Bun. Typecheck only through cast check. Long tests/services use tmux. No separate agent Chrome; use cast browser with harmless fixtures. Canonical shared auth/cli-kit edits occur in ~/src/platform; never edit generated mirrors. Root serializes vendor refreshes and observes active dev services.

## Initial wave ownership

| Worker | Task | Owned scope | Explicit exclusions |
|---|---|---|---|
| security-impl-identity | ct-53052 | Canonical auth provider/callback/config/redirect and tests; then Codecast verified alias/Slack admission if no product decision blocks it | No vendor refresh, no cache/auth-storage files, no commits/deploys, no historical merges/deletes |
| security-impl-backend | ct-53053 | dispatch, managedSessions, data/workspace lists, public content-search endpoint and tests | No users.ts/slackSync.ts/auth core initially; no image ingestion hunks in messages.ts; direct-token migration after boundary contract review |
| security-impl-content | ct-53054 | castChart/canvasSanitize/HtmlSnippet, mobile canvas, Electron admission/permissions and tests, web response policy | Preserve existing Electron routing diff; no cache/publishing code, no real capabilities, no commits/deploys |

Root meanwhile checks release/runtime configuration, prepares the endpoint/coverage ledger and production-safe integration environment, coordinates file owners, and prepares the next independent wave. No new work is launched into files owned by a current worker.

## Review and release process

1. Worker writes a red regression, repairs it, verifies positive behavior, and returns a bounded diff/test receipt.
2. Fresh reviewer challenges both the fix and the tests; root independently inspects high-risk paths and reproductions.
3. Routine defects return for repair until correct. Product regressions/schema authority tradeoffs become one concrete decision with options and evidence; independent work continues.
4. Root integrates small commits containing only owned security changes. Keep git history flat. Deploy Convex through deploy.sh before any dependent web push; CLI releases use CI. Do not treat the dirty main tree as a safe deployment snapshot without checking origin freshness and every included diff.
5. Final critics attack identity/resource authority, local/content/native boundaries, and product/revocation completeness. New material findings join the ledger and are fixed before closing the plan.

## Current progress

Execution started. Audit task ct-53045 is complete; implementation tasks ct-53052–ct-53059 remain open until the criteria above are met. Detailed evidence and current assignments live in task comments and this plan. A passing review is not a production verification receipt.
