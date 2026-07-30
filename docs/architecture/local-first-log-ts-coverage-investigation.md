# Investigation: Deriving View Coverage from Convex's Log Timestamp

**Status:** Investigation complete — feasible, recommended; sequencing decision needed
**Date:** 2026-07-30
**Context:** Adversarial sync campaign (ct-40155) finding SRV-01/02/05. The campaign's fix demoted the hand-maintained view revision to a monotonic watermark. This memo answers: can coverage instead be *derived from the platform's own read-set tracking*, making the entire proxy-drift category impossible by construction?

## The finding: yes — the platform carries both halves on the wire, and the read half is public API

Convex executes every query at one backend log timestamp and re-executes it when anything in its **read set** changes — joined user rows, the conversation's privacy fields, membership: everything. That timestamp is exactly the "result version" our `local_view_heads` machinery hand-approximates, and the client SDK (v1.36.1) exposes it:

| primitive | where | surface |
|---|---|---|
| Per-transition log timestamp | `Transition.timestamp: TS` (u64 Long) — the log position at which **all delivered query results are simultaneously valid** | **`@public`** (`browser/sync/client.d.ts:177-187`) |
| Transition subscription | `BaseConvexClient.addOnTransitionHandler(fn: (t: Transition) => void)` — per-query `{token, modification}` pairs + `reflectedMutations` + timestamp | **`@public`** (`client.d.ts:252`) |
| High-water mark | `BaseConvexClient.getMaxObservedTimestamp()` | **`@public`** (`client.d.ts:232`) |
| Query token derivation | `serializePathAndArgs(udfPath, args): QueryToken` | exported; documented as *runtime-only, never persist* (`udf_path_utils.d.ts`) |
| Mutation commit timestamp | `MutationSuccess.ts` on the wire (`protocol.d.ts:154`); surfaced per-transition as `reflectedMutations: [{requestId, result}]` | wire + transition-level; **`requestId` of one's own mutation is NOT publicly obtainable** (`mutation()` returns only the result) |
| React client → base client | `ConvexReactClient.sync` getter exists in shipped JS (`react/client.js:100`) and is load-bearing (the paginated client is built on it) but is **omitted from the public d.ts** — access needs a typed cast |

Timestamps are backend log positions: monotonic and comparable across tabs, devices, and reconnects — precisely the property the durable writer fence needs.

## What the redesign looks like (coverage kind `log-ts`)

1. New coverage kind `{ kind: "log-ts", ts: string }` (Long serialized as decimal string; compared numerically). Adapter `compareCoverage` gains one arm.
2. A single transition stamper per engine: `addOnTransitionHandler` correlates each registered contract's `serializePathAndArgs(query, args)` token with updated results and delivers `(result, ts)` to the session — replacing the `useQuery`-effect delivery path with a strictly better one (values AND their log position, atomically).
3. `useLocalView` keeps `useQuery` only to hold the subscription open; applies come from the stamper.

### What it makes impossible by construction
- **The entire SRV family.** Join drift (user rename), access-input changes (privacy, membership), and revision-domain moves (user merge) all change the query's read set → new transition → strictly higher ts. No server code has to remember to "advance a head" ever again.
- **Equal-coverage ambiguity.** Equal ts ⇒ same log position ⇒ *identical results by definition*. The divergence tripwire the campaign retired (SRV-01) returns at **full strength**: equal-ts-different-content becomes a true corruption signal again, and the security rule (no access change at equal coverage) becomes exact rather than conservative.

### What gets deleted
`local_view_heads` (read side), `advanceLocalViewRevision` + all six access-mutation call sites added in SRV-02, the merge head-migration from SRV-05 (receipts migration stays), `revisionPrincipalId` plumbing, the viewWriters revision choreography, and the guard test pinning the advance call sites. The server-side view code collapses to: authorize → project → return rows. This is the §21 test — feature code shrinks, repair code is deleted.

## The one gap: write-path coverage

Overlay retirement needs "this view result provably includes my write" — i.e., view ts ≥ my mutation's commit ts. The commit ts is on the wire (`MutationSuccess.ts`) and per-transition (`reflectedMutations`), but the public `mutation()` API returns only the result, and one's own `requestId` is private. Correlating by result value is value-equality inference, which the design bans. Options:

- **(a) Interim (works today):** write path keeps the receipt machinery exactly as built — `runLocalCommand` dedupe + heads *for command coverage only*. Sound, already shipped, but keeps heads alive.
- **(b) Upstream ask (small, well-motivated):** Convex exposes either the `requestId` (an option on `mutation()`) or the commit ts on resolution. Both already exist internally; `BaseConvexClient` is explicitly marketed for "directly integrating state management libraries," and any such integration needs exactly this. With it, overlay retirement becomes platform-exact — the transition that first reflects the mutation retires the overlay in the same local commit that applies its query results — and `local_view_heads` is deleted entirely.
- (c) Version-pinned access to the private request counter — rejected: an invariant resting on an underscored field.

## Risks / cautions

- `QueryToken` serialization is documented unstable → derive at runtime only, never persist (durable coverage stores only the ts).
- `ConvexReactClient.sync` is shipped-but-untyped → one typed cast, flagged for review on client upgrades; alternatively ask Convex to bless it in types (same upstream conversation as (b)).
- Paginated queries route transitions through `PaginatedQueryClient`; `addOnTransitionHandler` is additive and does not interfere — but future windowed contracts should be designed against this surface from the start.
- Coverage kinds cannot mix within one view — a slice switches read coverage and its commands' required coverage together, per slice, behind the existing shadow→cutover machinery.

## Recommendation

Adopt `log-ts` coverage as the target design — it is the "deepest principled solve": coverage becomes a *derived* value from the platform's read-set tracking rather than a hand-maintained shadow of it, and the campaign's largest bug family becomes unrepresentable. Sequencing is the open decision:

- **If Step-2 timing is flexible:** file the upstream ask now, ship read-path `log-ts` behind the existing shadow gate, and land the write path directly on platform retirement when the ask resolves — avoiding double-building command coverage.
- **If Step-2 must ship now:** ship it on the existing receipt/head machinery (proven by the campaign), with `log-ts` as a planned per-slice migration that deletes heads afterward.

Either way, the upstream request costs one issue filed today and unlocks deleting the entire coverage-maintenance surface.
