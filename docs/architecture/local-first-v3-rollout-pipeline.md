# v3 (log-ts) Rollout Pipeline

**Status:** Proposed to the deploy owner (jx7et9e) 2026-07-30; implementation of every today-buildable piece is committed (see "Implemented state").
**Division of labor:** this doc + the build = ct-40178; review, push, every deploy, and every flag flip = jx7et9e, recorded on pl-205.

## Response to the sequencing proposal

**AGREED: skip the v2 read cutover entirely; cut reads v1→v3 once.** One migration for users, and the SRV family dies in the same step.

**One correction to "run v3 shadow beside the current v2 shadow":** the two contracts cannot run concurrently *in one browser for the same view* — they share the view key, and the durable writer pins one contract per key (a v3 claim supersedes the v2 writer; the v2 session then fences out). The flags therefore SWITCH a slice's contract rather than adding one: `shadow-lts` **replaces** `shadow` for that slice. The digest gate is uninterrupted — the comparison stays v1-vs-durable-view, with the v3 contract underneath — but v2-shadow and v3-shadow evidence accumulate sequentially per slice (or in parallel across user cohorts/slices, never within one browser+view). The soak clock intentionally resets at the switch: coverage semantics are contract semantics (§20).

## Stages (each gate = jx7et9e flag flip after review)

1. **v3 shadow** — flip `VITE_LOCAL_FIRST_COMMENTS_MODE` / `VITE_LOCAL_FIRST_BUCKETS_MODE` from `shadow` to `shadow-lts`. First mount in each browser migrates the durable view via contract supersession (one-time fresh bootstrap; durable v2 rows for the slice are dropped and rebuilt — invisible to users since v1 still renders). Evidence: existing digest equality (`__CODECAST_SHADOW_VALIDATION__`) PLUS the log-ts invariants now enforced durably (monotonic ts; equal-ts divergence rejected loudly — watch `PrincipalStoreIdentityError` counts, which are zero-tolerance signals).
2. **Read cutover v1→v3** — flip to `cutover-lts` once the v3 soak matches the §20 gate. Rollback = revert the env var (v1 query resumes feeding the store; the durable v3 view stays consistent for a later retry).
3. **Write path (Step 2/Track B3)** — commands wired through the journal against the existing receipt-backed handlers, with `requiredCoverage: { kind: "command-id", contractId: <v3>, viewKey }`. Gate unchanged: CMD-02 + R-01 + R-11 + DWB-03. **This shape lands once**: the echoed-id proof works today, and the convex-js #182 upgrade changes only how the view learns coverage internally — no command-contract change.
4. **Deletion** — after all slices' reads and writes leave view-revision: delete `local_view_heads` read machinery, `advanceLocalViewRevision` call sites (including the six SRV-02 access-advance sites), the merge head-migration, and `revisionPrincipalId` plumbing. Until then they serve the un-migrated small views and rollback paths.

**Deploy ordering (standing rule, DEC-01 precedent):** convex before web at stage 1 — the envelope echo (`commandIds`) must be live before any `-lts` client mounts, or v3 grants apply with empty echo (safe — commands don't exist yet — but the soak should measure the real thing). The echo is additive, so v2/v1 clients are unaffected. Note: today's 12:51 convex deploy already carried this WIP from the shared tree; the reviewed redeploy from this committed state supersedes it cleanly.

## Implemented state (committed, awaiting review)

- Coverage kind `log-ts` (u64 log position + echoed command ids) with kind-aware semantics: watermark (view-revision) keeps latest-fenced-wins at equality (matrix SRV-01); log-ts gets the **full-strength tripwire** — equal-ts divergent content or access change is rejected as corruption (`PrincipalStoreIdentityError`, zero-tolerance class).
- Contract supersession: `claimViewWriter(..., { supersedes })` migrates a durable view across contract ids atomically (content re-bootstrap, coverage domain reset, reference-counted grant release); undeclared contract changes still rejected.
- Transition stamper: watch-based `(result, logTs)` consistent pairs from the public `watchQuery`/`localQueryResult` surface; one isolated cast for `getMaxObservedTimestamp` (the design's only internal touch). The stamper's watch holds the subscription; Convex-level optimistic updates are forbidden on stamped queries (documented in-module).
- v3 contracts for both reference slices (`*.byConversation/v3`, `buckets.principal/v3`) consuming the v2 envelope (declared via `envelopeContractId`); `shadow-lts`/`cutover-lts` flag modes wired through both slice hooks; writer handoff, session recovery, and cutover store-pruning all operate identically under log-ts.
- Server: granted envelopes echo the caller's acknowledged receipt ids for the view (`echoedCommandIdsForView`, same-snapshot proof; scan 200/limit 64); all 8 v2 command handlers (5 comments + 3 buckets) attach `command-id` receipt coverage naming the v3 contracts. Both additive; guard-test-pinned.
- Tests: 13 new client (`logTsCoverage.test.ts`: ordering, tripwire, supersession, echoed-id reconciliation both orders, stamper, stamped end-to-end with handoff), 2 new server (envelope echo filtering; guard pins), 9 updated pins (receipts carry two coverage entries; envelope carries `commandIds`). Suites: web local-first 111/111, convex 911/911, tsc clean both.

## Waiting on Convex (documented residuals — nothing blocks today's value)

| item | what it unlocks | until then |
|---|---|---|
| **convex-js #182** (filed): mutation commit-ts or requestId on resolution | Platform-exact overlay retirement: compare view ts ≥ my commit ts. Removes the echo entirely — the receipts read leaves every view query (fan-out cost gone), and the scan-200/limit-64 echo window residual (a command outrunning 200 newer receipts before any refire → parked awaiting-coverage) becomes impossible. | Echoed-id proof: sound (same-snapshot), bounded-window, human-rate-safe; window documented in `echoedCommandIdsForView`. |
| #182 companion: bless `ConvexReactClient.sync` in types | Deletes the one internal cast (isolated in `transitionStamper.ts`). | The cast rides a load-bearing shipped getter; flagged for review on convex upgrades. |

## Review checklist for this batch

- The equal-ts tripwire fires `PrincipalStoreIdentityError` (zero-tolerance telemetry class) — confirm that's the wanted severity vs a fence error.
- Supersession drops slice content for a one-time re-bootstrap (blank durable paint until first stamped result, behind shadow). Confirm acceptable for the `shadow-lts` flip.
- Echo cost: every v2 view query now also reads the caller's recent receipts — refires per caller command ack are the retirement mechanism, but it's a new read-set dependency on a per-user table. Bounded (200 rows), but worth eyes.
