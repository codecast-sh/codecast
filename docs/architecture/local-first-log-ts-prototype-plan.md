# Read-Path Prototype Plan: `log-ts` Coverage

**Status:** SUPERSEDED BY IMPLEMENTATION (2026-07-30, same day): the echoed-command-id realization (design §11.4 proof #3) removed the upstream dependency, so the read path AND write-path coverage shape were built immediately — see local-first-v3-rollout-pipeline.md for the implemented state and rollout stages. This document remains as the design rationale for the phases; the pipeline doc is operative.
**Prereq reading:** local-first-log-ts-coverage-investigation.md; sync matrix rows SRV-01/02/05, R-13.

## Governing rule (from the campaign): one slice, one coverage kind, atomically

A view's read coverage and every command coverage that can affect that view switch **together, per slice, in one flag state**. Coverage kinds are incomparable across kinds by design, so a view materialized at `log-ts` while a command requires `view-revision` coverage (or vice versa) can never reconcile — a frozen-overlay bug by construction. Mechanically:

- The slice flag selects a **(view contract, command contract) pair**; contract ids version together (`comments.byConversation/v3` ⇔ `comments.commands/v3`).
- A CI guard (functions.guard.test.ts style) asserts the pairing: no command contract may name a required-coverage kind different from its owning view contract's coverage kind.
- Until the upstream ask resolves, slices with live commands (post-Step-2) simply do not flip to log-ts; slices that are read-only today (current state) can prototype freely.

## Semantics: two kinds, two truths

- `view-revision` (existing): a **watermark** — under-covers the result by construction (joins, access inputs), so equal-coverage content drift is accepted from the fenced live source (campaign fix SRV-01). Unchanged.
- `log-ts` (new): a **result version** — equal ts means the same log position, so equal-ts content divergence is impossible in a correct system. The adapter's divergence tripwire returns at FULL strength for this kind only: equal-ts + different content → reject + zero-tolerance telemetry. The security rule (no access transition at equal coverage) becomes exact rather than conservative.

## Phases

**P0 — coverage primitive.** `{ kind: "log-ts", ts: string }` (u64 Long as decimal string; numeric-by-length-then-lex compare, helper + property tests). Adapter `compareCoverage` arm: log-ts vs log-ts ordered; log-ts vs anything else incomparable. Restore the equal-divergence throw for this kind (complete + segment paths). Extend adapter contract tests + writerHandoff tests parameterized over both kinds.

**P1 — transition stamper.** One module owning the single typed cast to `ConvexReactClient.sync` (isolated, flagged for review on convex upgrades). Registers `addOnTransitionHandler`; maintains a runtime-only map `serializePathAndArgs(query, args) → mounted session` (tokens are documented non-persistable — derived fresh per mount, never stored). Each transition delivers `(decodedResult, { kind: "log-ts", ts })` per updated registered token, into `LocalViewSession` through a stamped-delivery entry point that reuses the existing FIFO queue, supersession handling, and writer-handoff logic. `useLocalView` keeps its `useQuery` call solely to hold the subscription in the query set; result values flow exclusively from the stamper when the contract is log-ts (no dual-path applies).

**P2 — contract axis.** `defineQueryView` gains `coverage: "view-revision" | "log-ts"` (default unchanged). A log-ts contract is a NEW contract id (coverage semantics are contract semantics — §20; the shadow clock resets, which is the point). Reference slices get v3 contract definitions alongside v2; the slice flag gains a `log-ts-shadow` mode.

**P3 — shadow soak with the restored tripwire.** Run v3 (log-ts) materialization in shadow beside whatever is authoritative, reusing the digest machinery, plus two new payload-free checks: (a) per-view ts strictly monotonic across applies; (b) equal-ts re-deliveries digest-equal (tripwire evidence gathered in shadow BEFORE the throw ships in cutover). Multi-tab: two tabs' ts values interleave arbitrarily but compare globally — covered by parameterized writer-handoff tests plus the soak.

**P4 — cutover + deletion.** Per-slice cutover via the existing gate (§20). `local_view_heads` and the advance call sites are deleted only when the LAST slice's read AND write coverage have left view-revision — i.e., after the upstream ask lands and Step-2 commands migrate. Until then heads shrink to write-coverage-only duty; the deletion is a checklist entry on §26, not an aspiration.

## Test surface (extends the campaign suites)

Adapter-kind ordering properties; stamper token-mapping unit tests (fake transitions); session stamped-delivery through supersession/handoff/regrant paths; equal-ts divergence rejection; cross-kind incomparability rejection; NET-05-style randomized two-tab interleavings under log-ts; guard test for the pairing rule.

## Out of scope

Write-path migration (blocked on upstream), paginated/windowed contracts (must be designed against `PaginatedQueryClient` from the start — matrix R-13), native adapter.
