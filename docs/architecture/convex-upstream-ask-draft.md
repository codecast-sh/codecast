# Upstream Convex feature request — FILED

**Filed:** https://github.com/get-convex/convex-js/issues/182 (2026-07-30, approved by Samvit)
**Status:** awaiting maintainer response; the log-ts write-path migration (see the prototype plan) unblocks when it resolves.

---

**Title:** Expose a mutation's commit timestamp (or requestId) on resolution, for state-library integrations built on `BaseConvexClient`

**Body:**

We're building a durable local-first layer on top of `BaseConvexClient` — persistent IndexedDB materialization of query results with a durable optimistic-command journal — which is exactly the use case the class documents ("Low-level client for directly integrating state management libraries with Convex").

The transition surface is excellent for the read side: `addOnTransitionHandler` gives us each query's new result together with `Transition.timestamp`, so we can stamp durable snapshots with the log position they're valid at. That timestamp is doing a lot of work for us: it's a result-version that covers the query's whole read set by construction.

The write side has one gap. To retire a **durable** optimistic overlay safely, we need to prove "this delivered query result includes my mutation's write" — i.e., `transition.timestamp >= my mutation's commit timestamp`. Both halves of that comparison already exist in the client:

- the wire's `MutationSuccess` carries `ts` (the commit timestamp), and
- `Transition.reflectedMutations` lists `{ requestId, result }` for mutations first reflected by that transition,

but neither is reachable from application code: `mutation()` resolves with only the function's return value, and the `requestId` it was assigned is private. So today there is no sound way to correlate our own mutation with the transition that first reflects it. (Matching by result value is not sound — values can be equal by coincidence, and ABA is real.)

**Ask:** any one of the following would fully unblock this, in our order of preference:

1. An opt-in on `mutation()` (e.g. a `MutationOptions` field) that resolves with `{ value, ts }` — the commit timestamp alongside the result; or
2. an option that surfaces the assigned `requestId` (so we can watch for it in `reflectedMutations`); or
3. a documented callback for "mutation reflected" keyed by something the caller can hold.

Option 1 is the smallest surface and composes directly with `getMaxObservedTimestamp()`/`Transition.timestamp`.

**Related small ask:** `ConvexReactClient` ships a `sync` getter returning its `BaseConvexClient` (the paginated query client is built on it), but it's omitted from the public type declarations. Blessing it in types would let React apps register transition handlers on the same query set as their hooks without a cast. If there's a reason it's untyped, guidance on the supported way to reach the underlying client from `ConvexReactClient` would serve the same purpose.

Happy to share more detail on the integration or test a preview build.

---

**Reviewer notes (not part of the issue):**
- Deliberately generic — no codecast internals, no repo links, no security-relevant detail about our sync layer.
- Verified against convex-js 1.36.1: `Transition`/`addOnTransitionHandler`/`getMaxObservedTimestamp` are `@public` (browser/sync/client.d.ts:177–252); `MutationSuccess.ts` at protocol.d.ts:154; untyped `get sync()` at react/client.js:100.
- If maintainers push back on exposing timestamps, the fallback ask is #2 (requestId), which leaks nothing new — `reflectedMutations` already exposes requestIds publicly.
