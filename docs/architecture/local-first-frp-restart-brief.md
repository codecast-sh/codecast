# Local-First FRP and Session Execution Coherence

Status: restart brief; no implementation is approved by this document

Written: 2026-07-22

Starting point: clean worktree at `6cb56492`

## Why this document exists

This work began with a concrete failure: a conversation displayed the Codex icon while the model label said Fable. Investigation showed that this was not a cosmetic mismatch. The conversation had been requested as Codex, but its first message was delivered to a fallback Claude session. A later message could then reach the originally created Codex thread. One logical conversation could therefore be split across two runtimes.

That failure led to a broader architectural question: if Codecast is built around Convex, a persistent local database, optimistic commands, and functional reactive UI reads, why can server and client state drift or require repair loops at all?

An initial implementation tried to answer that question with a broad cross-entity replication system. It became large and relationship-aware. In particular, it added special by-ID comment paths, conversation-dependent invalidations, inherited document pagination, authorization metadata, and a very large client feed hook. The result was technically ambitious but architecturally worse: replication had started reconstructing domain relationships and access control.

That implementation was rejected and fully removed. This document captures the original problem, the strategic value that must be preserved, the lessons from the rejected approach, the design constraints, and the proof required before a new implementation is accepted.

## Executive summary

The goal is not “add a better change feed.” The goal is to make Codecast's state model more coherent:

1. Convex owns durable, authoritative facts and semantic transitions.
2. Codecast's local database remains the UI's fast, persistent, offline-capable read model.
3. Local user intent is applied immediately and sent through the existing durable outbox.
4. Server state enters the local database through one small, declarative integration boundary.
5. Only data with a clean replication contract belongs in generic durable replication.
6. Relational or demand-driven views remain normal Convex reactive queries that populate the local cache.
7. The daemon must resolve one runtime binding per conversation before delivering messages; agent identity cannot be inferred from competing in-memory maps.

The central discipline is:

> Infrastructure may centralize a rule, but it may not invent a second domain model to do so.

The target should make the codebase smaller and easier to explain. A generic mechanism that requires special comment endpoints, relationship event types, nested paginators, scope metadata copied into client rows, or hundreds of lines of entity branches has failed the design test even if its tests pass.

### The plain-English mental model

Think of Convex as the official ledger and the local database as the user's always-open notebook.

- The product reads the notebook, so it is instant and works with the network asleep.
- A user edit is written into the notebook immediately and placed in a durable outgoing tray.
- Convex accepts or rejects the command and remains the final authority.
- Server facts update the notebook through one trusted application boundary.
- Reactive selectors are pure views over the notebook; they do not run repair procedures.

The subtle correction is that the notebook contains different kinds of pages. A complete task table, an inbox derived from assignments, an open comment thread, a heartbeat, and a local draft do not all need the same delivery mechanism. Cutting-edge FRP means that each has one explicit source and that downstream state is derived automatically. It does not mean pretending every relationship is an independently replicated row.

## The original failure

### User-visible symptom

The conversation header showed:

- a Codex/OpenAI icon, derived from the conversation's `agent_type`; and
- a Fable model label, derived from a later model update produced by the runtime transcript.

Both values accurately reflected different parts of a split system. The display was exposing a contradiction already present in the data.

### Observed causal chain

The relevant clean-tree code is in [`packages/cli/src/daemon.ts`](../../packages/cli/src/daemon.ts).

1. The web flow creates a conversation with a requested agent type.
2. The daemon receives a `start_session` command and the first pending message close together.
3. The Codex start path creates an app-server thread and eventually registers it in `appServerConversations`.
4. `deliverMessage` can run before that registration is visible.
5. Its wait path polls `startedSessionTmux`, which the app-server path does not populate.
6. After the wait, `startFreshSessionForDelivery` starts a Claude tmux session and hardcodes Claude as the agent.
7. Claude transcript discovery later updates the model field, while the requested `agent_type` remains Codex.
8. The orphaned Codex registration may receive a later message, creating true split-brain execution.

### What this teaches us

This is not fundamentally an icon bug, a polling-duration bug, or merely a missing map lookup. The system has multiple imperative representations of “which runtime owns this conversation”:

- requested agent data on the conversation;
- daemon command state;
- `appServerConversations`;
- `startedSessionTmux`;
- transcript/session discovery caches; and
- a fallback that independently chooses a runtime.

Message delivery is allowed to act before those representations have converged.

The correct abstraction must make runtime binding a single resolved fact or state transition. Delivery should consume that fact. It should not guess which registry will eventually contain it.

## The broader category of failure

The same structural smell appears on the client, although the mechanisms are different.

Convex is reactive, but Codecast does not render every server query directly. It deliberately maintains a persistent local read model:

- normalized Zustand collections in [`packages/web/store/inboxStore.ts`](../../packages/web/store/inboxStore.ts);
- IndexedDB/Dexie persistence in [`packages/web/store/idbCache.ts`](../../packages/web/store/idbCache.ts);
- the native persistence adapter in [`packages/web/store/idbCache.native.ts`](../../packages/web/store/idbCache.native.ts);
- reactive local selectors;
- optimistic actions;
- pending-field protection in [`packages/web/store/syncProtocol.ts`](../../packages/web/store/syncProtocol.ts); and
- a durable dispatch outbox in [`packages/web/store/mutativeMiddleware.ts`](../../packages/web/store/mutativeMiddleware.ts).

This is strategically valuable. The UI can paint from disk, read synchronously, filter locally, and accept writes while disconnected. It is more than an ordinary frontend cache and should not be replaced with “call `useQuery` everywhere.”

The weakness is the inbound path. Different server data currently reaches the local database through overlapping mechanisms:

- live Convex subscriptions;
- recent/delta query windows;
- paginated completeness crawls;
- a cross-entity catch-up feed;
- focus, reconnect, and interval probes;
- ghost/existence sweeps;
- separate liveness overlays; and
- client-side clock interpretation.

Each mechanism was added for a real reason. Together they create several writers with different meanings for time, absence, completeness, and deletion.

Examples in the clean tree include:

- [`packages/web/hooks/useSyncChangeFeed.ts`](../../packages/web/hooks/useSyncChangeFeed.ts), currently a catch-up safety net;
- [`packages/web/hooks/useSyncInboxSessions.ts`](../../packages/web/hooks/useSyncInboxSessions.ts), which combines several session channels and recovery behavior;
- [`packages/web/hooks/useSyncTasks.ts`](../../packages/web/hooks/useSyncTasks.ts) and [`packages/web/hooks/useSyncDocs.ts`](../../packages/web/hooks/useSyncDocs.ts), which combine live windows with reconciliation crawls;
- [`packages/web/hooks/reconcileCrawl.ts`](../../packages/web/hooks/reconcileCrawl.ts); and
- [`packages/web/hooks/ghostSweep.ts`](../../packages/web/hooks/ghostSweep.ts).

This creates recurring ambiguity:

- Does an omitted row mean deleted, unauthorized, outside a bounded window, filtered out, or not yet crawled?
- Which stream owns a field when a live query, overlay, crawl, and optimistic edit all carry it?
- Can an older snapshot overwrite a newer local or server transition?
- How does a hard delete remain deleted after IndexedDB hydration?
- How does a client learn that access to a previously cached row was revoked?
- How does time-dependent meaning change if no durable value changes?

These are replication-contract questions, not individual screen bugs.

### Clean-tree change-feed baseline

The existing feed is useful evidence, but it is not yet the desired proof:

- [`packages/convex/convex/changeLog.ts`](../../packages/convex/convex/changeLog.ts) tracks conversations, tasks, documents, and plans through a mutation wrapper.
- It stores one mutable latest row per entity and uses one scalar server `Date.now()` cursor across owner/team visibility streams.
- [`packages/web/hooks/useSyncChangeFeed.ts`](../../packages/web/hooks/useSyncChangeFeed.ts) re-reads a ten-second overlap, groups IDs by type, and asks authorized by-ID queries for current rows.
- On a first run it stamps the current time as its cursor and relies on per-table crawls to establish completeness.
- Live subscriptions are the steady-state path; focus/reconnect and a 45-second interval nudge catch-up.

The good ideas are the low-level coverage point, explicit changed IDs, authorized current-state re-fetch, and idempotent local application. The known proof failures are the finite timestamp overlap, first-run cursor stamping without a snapshot/head handshake, a scalar cursor merging independent visibility streams, and a mutable latest row that can lose the old-scope history needed for revocation after a move. The other unresolved issues are access revocation, eligibility, and the indefinite coexistence of multiple repair systems. The next run should preserve the good ideas only if they survive the written invariants; it should not assume the current feed must become the universal transport.

## Strategic priorities

Priorities are ordered. A later priority must not compromise an earlier one.

### P0 — Prevent contradictory execution and lost user intent

One conversation must have one resolved runtime target for each turn. Delivery may be at-least-once internally, but idempotency and deduplication must produce one logical effect at that binding or leave the message visibly pending. The system must never silently fall back to another agent family.

### P1 — Preserve security and exact data ownership

After a client authenticates or reconnects and establishes current authorization, the local database must physically purge data whose access was revoked. Replication must reuse canonical server authorization; it must not approximate or duplicate it. Signed-out and offline behavior for previously cached protected rows must be explicitly designed rather than assumed safe.

### P2 — Increase conceptual coherence

The change must reduce the number of independent state machines and definitions. Correctness implemented through more special cases is not success.

### P3 — Preserve and improve the local-first experience

Cached first paint, synchronous local reads, reactive selectors, optimistic edits, offline command durability, web IndexedDB, and native persistence remain first-class requirements.

### P4 — Make correctness systemic at a choke point

The design should allow strong protocol tests and coverage guards to prove a shared invariant once. Product screens should only require wiring tests.

### P5 — Maintain performance and deployability

Do not turn a logical choke point into a globally contended physical record, cause high-churn heartbeats to invalidate large views, or require a flag-day upgrade across web, mobile, desktop, CLI, and daemon.

### P6 — Expand breadth only after the abstraction is proven

The number of entity types migrated is not a success metric. A narrow, exact primitive is better than broad nominal coverage with hidden exceptions.

## What must be preserved

The clean-tree local-first architecture already has strong pieces:

### Local reads and persistence

- Zustand is the in-memory read database.
- IndexedDB persists web/desktop collections and metadata.
- The native adapter gives mobile equivalent persistence semantics.
- Hydration provides cached first paint.
- Local selectors provide FRP-style dependency tracking over the local state.

### Local writes

- Store actions apply optimistic changes immediately.
- Mutative patches identify the actual changed rows and fields.
- Pending entries prevent stale server payloads from clobbering unacknowledged local intent.
- The durable outbox survives reloads and reconnects.
- Permanent server rejection and transient transport failure already have different semantics.

### Convex

- Convex remains authoritative for durable server state.
- Convex mutations give atomic server transitions.
- Convex queries give reactive, consistent read views.
- Existing live queries remain an excellent steady-state transport when their result has a clear meaning.

### Existing declarative direction

[`packages/web/store/clientSyncRegistry.ts`](../../packages/web/store/clientSyncRegistry.ts) already centralizes persistence, hydration, local-first protection, and dispatch metadata. The restart should learn from this registry without assuming that every registered local collection has the same inbound replication semantics.

That distinction matters: “persisted,” “optimistically writable,” “reactively cached,” and “fully replicated offline collection” are separate capabilities.

## The key data-model boundary

Before changing code, classify each piece of state. Do not put every local collection into the same transport.

| Category | Meaning | Correct treatment |
|---|---|---|
| Canonical self-scoped entity | Its own canonical row completely determines identity, visibility scope, and serialized local shape | Candidate for generic durable snapshot/tail replication |
| Authoritative reactive view | Membership or shape is derived from joins, assignments, privacy, filters, or other rows | Convex query owns the view; local cache may persist its latest result |
| Demand-driven relation | Needed only when a parent/detail surface is open, such as a comment thread | Reactive scoped query populates local cache; not necessarily in global catch-up |
| Operational high-churn state | Heartbeats, presence, leases, transient runtime observations | Keep outside broad UI replication; write semantic transitions when meaning changes |
| Local-only state | Navigation, drafts, collapse state, device history | Persist locally; never replicate as server truth |
| Command/intent | A requested action not yet acknowledged by the authority | Optimistic local overlay plus durable idempotent outbox |

An entity is eligible for a generic durable row replica only if all of the following are true:

1. Its canonical row contains its complete replication scope.
2. Snapshot and change-tail lookup use the same authorization rule.
3. Snapshot and tail return the same canonical projection.
4. Create, update, delete, scope move, and access loss have unambiguous convergence semantics.
5. Adding it requires a declarative registry entry rather than new transport branches.

If any condition fails, either normalize the domain first or keep the data query-owned.

### Known non-candidates at the start

These should not be forced into a generic global replica in the first implementation:

- **Conversation comments.** They are already fetched as a reactive conversation-scoped query and written into the local comments cache by [`packages/web/hooks/useConversationComments.ts`](../../packages/web/hooks/useConversationComments.ts). Their visibility follows the conversation. A global comments feed would need to reconstruct that relationship.
- **Documents with conversation-inherited visibility.** If document access can come from a linked conversation while `team_id` says something else, the row does not contain one complete scope truth.
- **Inbox membership derived from assignments or privacy relations.** The authoritative inbox query owns this view unless membership is normalized into a canonical projection.
- **Tasks whose visibility is granted through non-row-local assignee relationships.** Audit and normalize before declaring them self-scoped.

These exclusions do not weaken the local-db experience. A reactive query can still populate and persist the same local table. The distinction is about who owns completeness and deletion semantics.

## Governing invariants

### 1. Durable semantic facts

Every durable user-visible semantic transition must ultimately correspond to authoritative data, not only the passage of client time or an in-memory daemon event.

High-frequency observations need not all be replicated. For example, heartbeats can update an operational lease while only lease expiry writes a semantic `stopped` transition.

### 2. One runtime binding per conversation turn

Delivery consumes a resolved execution binding. It may wait for that binding, create it through the same state machine, or fail visibly. It may not independently select a different agent because one in-memory registry is late.

Requested runtime and actual runtime should be explicit facts. If they differ, that difference must be intentional, validated, and visible—not inferred later from contradictory fields.

### 3. One local application boundary

All authoritative server payloads that update the persistent local database pass through one small application API. That API owns:

- canonical row upsert;
- explicit removal;
- optimistic-field reconciliation;
- persistence;
- principal isolation; and
- one reactive store publication.

Individual hooks should not invent merge, deletion, or pending-write rules.

### 4. Exact local-replica equation

For fully replicated collections:

```text
local visible state
= fold(authoritative snapshot, complete ordered server changes)
+ unacknowledged local commands
```

When the client reports “caught up,” and the outbox is empty, its normalized local representation must equal the authoritative server representation for the same principal and scope.

### 5. Absence has an explicit meaning

Absence from a partial, bounded, filtered, or demand-driven query never means deletion.

Deletion can be concluded only from:

- an explicit delete/revocation transition; or
- absence from a result whose contract is explicitly complete and authoritative for the checked IDs or scope.

### 6. Authorization remains server-owned

The transport may route an invalidation, but it must not reconstruct joins or permissions. The safe apply rule for a changed ID is:

1. ask the canonical authorized server query for current state;
2. upsert the returned row; or
3. remove the local row if the authoritative query omits it.

Snapshot and by-ID lookup must agree on both domain and projection for the same principal and scope:

```text
normalize(snapshot[id]) == normalize(byId(id))
```

This includes active/archive/hidden filters, not only whether both endpoints can see the ID.

### 7. Snapshot and tail form one proven history

If an ordered tail is used, snapshot bootstrap needs an exact handshake:

1. capture a server head/watermark;
2. obtain the complete snapshot associated with that boundary; and
3. replay every committed change after the boundary.

`Date.now()` plus an overlap window is a recovery heuristic, not a proof. A random tie-breaker does not create commit ordering. The chosen cursor mechanism must prove no gaps across concurrent writes, page boundaries, restarts, and scope moves.

### 8. Scope movement is a first-class transition

Moving a row from one visibility scope to another must remove it from the old scope and add it to the new scope. A mutable “latest event per entity” is insufficient unless it preserves the old-scope revocation.

### 9. Principal isolation is part of persistence

Replica data, cursors, bootstraps, and queued commands must be namespaced or cleared by authenticated principal. A user switch must not show or dispatch the previous user's persisted state, even briefly.

### 10. The principal's active scope set has a lifecycle

Row-local `team_id` is not enough; visibility also depends on the viewer's current memberships. The client needs one authoritative reactive set of active scopes:

- scope added → bootstrap that scope before claiming completeness;
- scope removed → atomically purge its rows and cursor/bootstrap state; and
- membership silence in an entity tail → no inference.

This is distinct from an individual entity moving between scopes and from switching authenticated principals.

### 11. Correctness does not depend on a timer

Intervals, focus events, wake events, and reconnect nudges may restore transport liveness. They may not be the only way a semantic update, deletion, or access revocation becomes correct.

### 12. Extension is declarative

Once a generic replica exists, adding an eligible collection should add data to a contract, not branches to a state machine. If a new collection requires its own polling hook, relation invalidation type, deletion repair, or cursor logic, either the abstraction is incomplete or the collection is not eligible.

## Desired architecture shape

This is a logical model, not a requirement for one giant file or one globally contended stream.

### Outbound path

The existing direction is fundamentally right:

```text
user action
  -> local store action
  -> immediate optimistic state
  -> persisted command/outbox entry
  -> Convex mutation
  -> acknowledgement or explicit rejection
```

The restart should tighten idempotency and principal safety where necessary, not replace this path.

### Inbound path

```text
Convex authoritative query/change
  -> small transport adapter
  -> one local authoritative-apply boundary
  -> IndexedDB/native persistence + Zustand publication
  -> reactive local selectors
```

Different data categories may use different Convex query shapes. They must share application semantics, not necessarily one global event table.

For a self-scoped replicated entity, an ordered snapshot/tail may be appropriate. For an inbox, the complete reactive membership query may be the correct authority. For comments, the open conversation's reactive query may be sufficient. “One clerk” means one definition of how authoritative data lands locally, not one mechanism pretending every domain relation is a row.

### Execution binding path

```text
conversation + requested execution spec
  -> one per-conversation execution coordinator
  -> resolved binding (agent family, runtime/session/thread, owner device, epoch)
  -> pending message delivery
  -> durable actual-runtime/session facts
```

The next run must decide whether the resolved binding is represented by an existing Convex record, a new normalized projection, or an in-process promise backed by durable facts. The proof obligation is more important than the representation: every delivery path must consume the same binding, including recovery and fallback.

## Lessons from the rejected implementation

The removed implementation touched roughly fifty files and grew the client feed hook by hundreds of lines. That size was not merely an aesthetic problem; it revealed missing boundaries.

### 1. Persistence registry is not replication eligibility

The attempt treated most persisted local collections as if they needed identical global snapshot/tail behavior. This pulled comments, projects, buckets, assignments, documents, and relational inbox concerns into one engine.

Learning: classify data first. Preserve a local cache without claiming global completeness.

### 2. Replication must not become an authorization graph

Comments and documents inherited access through conversations. The attempted feed added relationship invalidations and client-side dependent discovery.

Learning: if scope is not row-local, keep the authoritative relation in the Convex query or normalize the domain. Do not teach the transport to traverse it.

### 3. A large hook is a symptom, not just a file-organization problem

The feed hook accumulated bootstrap, cursor recovery, authorization manifests, scope pruning, entity fetching, project derivation, inbox membership, mobile wake behavior, and optimistic cleanup.

Learning: moving those functions into more files would not solve the problem. Remove responsibilities until the transport has one job.

### 4. Entity-specific by-ID endpoints can hide semantic mismatch

Adding `webGetByIds` functions made the engine look uniform while each function encoded different filters, access paths, and projections.

Learning: snapshot/by-ID parity is a domain invariant to prove, not an adapter shape to assume.

### 5. Cursor cleverness is not ordering

Timestamp overlap, random suffixes, and finite replay windows cannot prove a gap-free commit order. A late attempt at per-scope clocks added more schema and write-path machinery before the data boundary was settled.

Learning: choose a database-backed ordering model with a written proof and retention/rebootstrap story before implementing the client.

### 6. A choke point must stay logical

Intercepting low-level writes can provide coverage, but a wrapper that tries to derive every relationship scope becomes a second application layer.

Learning: use guards to ensure eligible writes cannot bypass the protocol. Do not use the wrapper to guess domain semantics.

### 7. Complexity must buy deletion

Infrastructure is justified when one small concept lets us remove several repair mechanisms. Adding a new engine while keeping every old live query, crawl, timer, and sweep makes the system harder to validate.

Learning: every migration phase needs an explicit list of legacy code it makes unnecessary and a proof gate before deletion.

## Complexity and elegance guardrails

The next implementation must satisfy these throughout the work, not only during final cleanup:

- No replication-specific code in `comments.ts` for the first slice.
- No relationship event types such as `conversation_dependents` or `comment_threads`.
- No nested “page conversations, then page their dependent documents” snapshot protocol.
- No client-side reconstruction of team membership, privacy, assignment, or ownership.
- No `_replica_*` domain fields used to compensate for missing canonical scope.
- No interval or focus event as a correctness dependency.
- No timestamp/nonce cursor described as gap-free.
- No per-collection branches in the core engine beyond declarative adapters.
- No derived UI concerns—project-path aggregation, inbox categorization, count calculation—inside transport code.
- No migration of a collection until snapshot, by-ID, access, and deletion semantics are written down.
- No compatibility branch without a removal condition.
- No broad rewrite before a narrow reference slice is proven.

Positive tests for elegance:

- A new engineer can explain the system in five sentences.
- The main invariant is visible in types and APIs, not only comments.
- The React/native mount is thin; it does not contain the protocol.
- An eligible new entity is registered rather than hand-wired.
- A non-eligible relational view has an obvious query owner.
- The final cutover removes more independent correctness mechanisms than it adds.
- A diff review should feel progressively calmer: fewer branches, fewer special cases, fewer duplicated scope rules.

## Client and system inventory

### Convex backend

Role:

- authoritative domain state;
- authorization;
- transactional mutations;
- reactive query dependencies;
- durable semantic transitions; and
- any ordered change primitive selected for eligible collections.

Audit requirements:

- all mutation boundaries invoked directly or through actions, schedulers, CLI, and daemon calls;
- projection consistency between list/snapshot and by-ID queries;
- access revocation and scope movement;
- backwards compatibility with deployed clients; and
- high-churn writes that must not fan out through broad subscriptions.

### Web

Role:

- full local database and outbox;
- most complete set of current sync hooks;
- local reactive UI reads; and
- reference implementation for IndexedDB transactions and hydration.

Audit requirements:

- every collection in `CLIENT_SYNC_REGISTRY` classified by capability;
- every sync hook assigned one clear authority/completeness contract;
- old crawls/sweeps removed only after proof; and
- separate windows/palette behavior and principal switching;
- unauthenticated and public-share routes that mount within the same application shell; and
- concurrent same-origin tabs/windows sharing one IndexedDB database.

### Electron/desktop

Electron primarily hosts the web client but adds sleep, wake, backgrounding, app upgrades, and long-lived IndexedDB behavior. It needs lifecycle and upgrade validation even if it receives no architecture-specific code.

### Mobile

Mobile shares the web store and native persistence adapter, but its mounted sync surface is not identical. [`packages/mobile/components/StoreSyncBridge.tsx`](../../packages/mobile/components/StoreSyncBridge.tsx) currently mounts inbox and bucket synchronization globally, while tasks/docs/plans are also mounted by screens.

Audit requirements:

- exact global versus screen-scoped subscriptions;
- native persistence transaction behavior;
- app background/foreground recovery;
- principal switching; and
- no assumption that a browser `document`, focus event, or IndexedDB API exists.

### CLI and daemon

The CLI/daemon generally should not host the UI replica. They are direct Convex writers, command consumers, runtime observers, and session executors.

They matter in two ways:

1. Their writes must pass through the same authoritative semantic mutation boundaries as web/mobile writes.
2. The daemon's execution-binding state machine is the source of the original split-brain bug and needs its own principled choke point.

Avoid touching broad CLI surfaces merely for symmetry. Audit them for mutation coverage, idempotency, and runtime binding.

### Shared package

Use shared types/contracts only when they express a real cross-system invariant. Do not create a large registry that falsely implies identical behavior across all collections.

## Decisions that must be made before coding

The next run should answer these in writing and obtain a design review before broad edits.

### A. What is the first reference slice?

Recommended: start with the original session execution race because it is concrete, high-risk, and exposes the “one durable fact, one consumer” principle. Add a deterministic failing test before changing behavior.

A separate narrow replica slice may follow using the simplest genuinely self-scoped entity. Do not start with sessions, comments, documents, or assigned tasks if their view scope is relational.

These are two separate proofs. Fixing runtime binding does not approve a replication design. The local-FRP work still needs its own Phase 1 design review, eligibility decision, and narrow conformance slice.

### B. Which local collections truly require offline completeness?

For each collection, document:

- whether the UI must see the complete set while offline;
- whether it is safe to show a last-known cached subset;
- who owns membership;
- how deletes and access revocation arrive;
- whether it is globally mounted or screen-demanded; and
- whether optimistic writes exist.

### C. What is the exact server ordering primitive?

If a tail is required, provide a proof for:

- strict ordering within every consumed scope;
- concurrent commits;
- page boundaries;
- snapshot races;
- scope moves;
- retention;
- cursor expiry and rebootstrap; and
- avoiding a global hot counter.

Do not implement the client until this is settled.

### D. What does a complete snapshot mean?

Define the principal, workspace/scope, entity domain, archived/hidden filters, projection shape, and high-watermark. Snapshot and tail must describe the same set.

### E. What is the canonical session semantic projection?

Separate:

- requested agent/runtime;
- actual bound runtime/session/thread;
- operational heartbeat/lease;
- semantic work state and reason;
- owner device and epoch; and
- UI presentation fields.

Decide which already exist, which are derived, and which require normalization. Avoid full event sourcing unless it demonstrably simplifies the current model.

### F. How are old clients supported?

Convex deployments are shared while web, desktop, mobile, CLI, and daemon versions roll independently. The plan needs feature detection, compatibility duration, rollback, and a point when legacy schema/query branches can be deleted.

## Recommended execution sequence

### Phase 0 — Re-establish a clean baseline

1. Confirm clean `HEAD` and record unrelated baseline failures.
2. Reproduce the Codex/Claude delivery race deterministically.
3. Measure current cached first paint, steady-state propagation, wake recovery, disk writes, and Convex reads.
4. Inventory every client and every current local collection.
5. Classify each collection using the data-model table above.

Deliverable: an inventory and failing tests, with no broad implementation.

### Phase 1 — Write the contracts before the machinery

Produce small design records for:

- runtime binding;
- authoritative local apply semantics;
- replica eligibility;
- ordering/bootstrap, if needed;
- access revocation; and
- principal isolation.

Each contract must include invariants, counterexamples, and removal targets.

Deliverable: a reviewed design whose core can be explained without implementation detail.

### Phase 2 — Fix the original execution-binding race as the reference pattern

1. Replace independent runtime selection paths with one per-conversation coordinator.
2. Make the first-message path wait on or create the same binding as `start_session`.
3. Remove the hardcoded cross-agent fallback or make fallback honor an explicit server policy.
4. Record requested and actual runtime coherently.
5. Test all interleavings: message first, start first, simultaneous, restart, failed start, stale binding, remote owner, and follow-up message.

Deliverable: the original bug is impossible by construction, not merely less likely.

### Phase 3 — Build the smallest local authoritative-apply boundary

Centralize only the semantics already common across local tables:

- apply canonical rows;
- remove authoritative IDs;
- preserve/reconcile pending local intent;
- persist data and cursor/metadata atomically where required; and
- publish one local reactive state transition.

Do not add a global feed yet unless the chosen first replicated entity proves it is needed.

Deliverable: one small pure API with adapter contract tests for memory, IndexedDB, and native persistence.

### Phase 4 — Prove one self-scoped replicated entity

If offline-complete replication is required:

1. choose one simple row-local entity;
2. implement exact snapshot/tail or an equivalent proven Convex view;
3. run the full convergence and fault-injection suite;
4. compare it in shadow mode against authoritative server state; and
5. remove that entity's old repair path only after equality is proven.

Deliverable: a narrow reference that gets simpler at cutover.

### Phase 5 — Expand only through conformance

For every proposed entity:

1. prove eligibility;
2. run the same parameterized contract;
3. add only declarative metadata;
4. show which old code becomes unnecessary; and
5. reject the migration if transport branches grow.

Deliverable: breadth without new state-machine logic.

### Phase 6 — Cross-client rollout

Validate web, Electron, mobile, CLI, and daemon according to their actual roles. Use shadow comparison and staged feature flags where protocol compatibility requires it.

### Phase 7 — Delete legacy correctness machinery

Disable and then remove crawls, ghost sweeps, recovery timers, or overlays only when their invariant is subsumed and the chaos suite remains green without them.

The final architecture is not complete while two correctness systems coexist indefinitely.

## Validation and testing plan

The proof target is convergence and coherent execution, not “the UI looked right.”

### Core oracle

For a fully replicated collection:

> When a principal is caught up and has no pending command affecting a row, the normalized local row set exactly equals the normalized authoritative server row set for that principal and scope.

For session execution:

> Every delivered turn is associated with exactly one resolved runtime binding whose actual agent/runtime agrees with the durable conversation/session facts shown to every client.

### Gate 1 — Deterministic original-bug regression

Build a test harness that can pause between:

- app-server thread creation;
- conversation-to-thread registration;
- pending-message observation;
- delivery target resolution; and
- fallback/recovery.

Exercise every ordering. Assert:

- a missing or late binding never selects a different agent family unless an explicit durable policy transition authorizes it; parameterize this over every supported family (`codex`, `claude_code`, `cursor`, `gemini`, `cowork`, `opencode`, `pi`, and any registry additions);
- each turn has one logical delivery effect at one runtime binding;
- a later runtime epoch is allowed only through an explicit, ordered, durable rebind, and no message may be delivered across both epochs;
- failed binding leaves the message pending or reports a visible error;
- duplicate start/delivery events are idempotent; and
- UI agent/model fields cannot describe incompatible runtimes.

### Gate 2 — Pure local-apply tests

Test the authoritative apply reducer independently of React, Convex, and storage:

- upsert create/update;
- explicit remove;
- duplicate batch;
- older revision after newer revision;
- optimistic field plus unrelated server change;
- acknowledgement clearing the pending overlay;
- server rejection/rollback;
- delete with pending local command;
- principal change; and
- multi-table atomic batch if the protocol promises it.

Useful properties:

```text
apply(e, apply(e, s)) = apply(e, s)

fold(snapshot, completeTail) = authoritativeState

cursor(next) >= cursor(previous)

unrelated server changes preserve pending local intent
```

Run generated histories in CI and retain every failing seed as a regression.

### Gate 3 — Server protocol proof

Against a real local Convex deployment, not only mocked database writers:

- every eligible insert, patch, replace, and delete is observable through the chosen contract;
- a write racing every snapshot page appears in the snapshot or tail, never neither;
- concurrent commits and page-boundary ties cannot be skipped;
- scope movement removes old visibility and adds new visibility;
- authorization loss removes persisted client data;
- snapshot and by-ID projection/visibility are identical;
- cursor expiration leads to an explicit rebootstrap; and
- unsupported protocol versions fail without advancing local state.

If low-level mutation interception is used, keep a static/runtime guard proving eligible writes cannot bypass it. The interceptor should route facts, not derive relationships.

### Gate 4 — Persistence adapter contract

Run one suite against:

- in-memory adapter;
- Dexie/IndexedDB; and
- native persistence adapter.

Required cases:

- data and cursor/metadata commit atomically;
- crash before commit persists neither;
- crash after commit persists both;
- restart hydration recreates the same state;
- duplicate replay is harmless;
- authoritative deletion cannot resurrect from hydration;
- pending commands/drafts survive upgrade;
- cached server data can be rebuilt safely; and
- principal switch cannot reveal or dispatch prior-principal state.

### Gate 5 — Multi-client integration

Use:

- two independently persisted web clients;
- multiple same-origin tabs/windows concurrently applying through one shared IndexedDB;
- the native persistence/store adapter;
- one CLI/daemon writer and executor;
- controllable network links and clocks; and
- the server/local truth comparator.

Scenarios:

- create, edit, move, and delete from each writer;
- client offline during hundreds or thousands of changes;
- client crash before/after local apply and cursor persistence;
- lost acknowledgement followed by outbox replay;
- hard delete while another client is offline;
- access grant followed by revocation;
- auth-null startup, login, logout, and account switch while protected rows are cached;
- opening public-share/unauthenticated routes in the same browser profile as an authenticated app;
- account switch with warm local storage;
- desktop sleep/wake;
- mobile background/foreground; and
- daemon restart during runtime binding and message delivery.

### Gate 6 — Product conformance

Every eligible replicated entity runs the same parameterized behavior:

```text
create
update ordinary field
move scope
concurrent local/remote edit
delete
offline catch-up
restart
access revoke
principal switch
```

Reactive query-owned views get a different contract: complete-result replacement or scoped cache update according to the query's declared semantics. They should not be forced through the row-replica suite.

### Gate 7 — Performance

Capture a baseline first. The numbers below are placeholders to be replaced by measured product SLOs during Phase 0, not pre-approved architectural requirements:

- cached first paint does not regress by more than 10%;
- local action appears within the next frame;
- active-client server propagation p95 under 1 second and p99 under 3 seconds;
- one changed row does not rewrite an entire collection;
- a no-op payload causes no disk write or selector churn;
- 10,000-change catch-up does not block the UI for more than a frame at a time;
- memory, disk, CPU, and Convex reads do not regress by more than 10%; and
- operational heartbeats that do not change semantics cause no broad UI/local-database churn.

Track replication lag, batch size, apply duration, cursor age, rebootstrap count, outbox age, digest mismatch, rows changed per event, and disk writes per event.

### Gate 8 — Shadow comparison and rollout

Before any new source drives product reads:

1. run it in shadow;
2. compare its normalized state to the authoritative server;
3. classify every mismatch as pending optimism, expected projection difference, or divergence;
4. exercise all client lifecycle paths; and
5. retain rollback through at least two client release cycles.

Suggested placeholder exit bar, to be replaced by a rollout policy based on baseline risk and release cadence:

- seven consecutive days of internal use;
- zero unexplained missing, extra, resurrected, or unauthorized rows after catch-up;
- zero cursor gaps/regressions;
- zero lost outbox operations; and
- performance budgets met.

### Gate 9 — Remove the backstops

For a canary cohort, disable the legacy correctness paths replaced by the new invariant. Repeat the chaos suite.

If disabling a crawl, sweep, poll, or overlay causes divergence, the new design is missing a dependency. Restore the old path and fix the model; do not add another repair loop.

### Gate 10 — Requested adversarial review loop

Only after implementation and self-validation:

1. Run three independent Fable reviewers and three independent Codex reviewers.
2. Give all six the architecture brief, full diff, test evidence, and a mandate to search for correctness, security, data-model, concurrency, compatibility, performance, and unnecessary-complexity failures.
3. Deduplicate findings by root cause.
4. Fix or explicitly reject every material finding with evidence.
5. Re-run self-validation.
6. Start another round of three Fable plus three Codex reviewers.
7. Continue until reviews converge to normal high-signal feedback rather than uncovering new architectural classes of failure.

Reviewer prompts must specifically ask:

- Where did replication become a second domain/authorization model?
- Which new code could be deleted by choosing a better invariant?
- Which result is partial but treated as complete?
- Which time/cursor claim is heuristic rather than proven?
- Which client or old-version path was missed?
- Which legacy mechanism is still required, and what missing dependency does that reveal?

## Definition of done

This effort is complete only when all of the following are true:

- The original Codex/Claude split-brain race is impossible under deterministic interleaving tests.
- Requested and actual runtime facts cannot silently contradict each other.
- The local-first database remains the UI's fast, persistent read model.
- There is one clear application boundary for authoritative server data.
- Every globally replicated entity satisfies the row-local scope and snapshot/tail parity contract.
- Relational/demand-driven views remain clearly query-owned unless normalized first.
- Caught-up local state equals authoritative server state modulo explicit pending commands.
- After current authorization is established, access revocation physically removes unauthorized persisted rows.
- Correctness survives offline periods, crashes, replay, sleep/wake, and principal changes.
- Web, Electron, mobile, CLI, and daemon have been audited according to their actual roles.
- Legacy repair machinery made redundant by the new invariant has been deleted.
- The resulting code is materially easier to explain and contains fewer independent correctness mechanisms.
- The requested adversarial review rounds converge with no unresolved material findings.

## Instructions for the next run

1. Read this document before inspecting the rejected-session transcript.
2. Work from clean `HEAD`; do not recover the abandoned diff.
3. Reproduce and test the original runtime-binding race first.
4. Produce the state/collection classification and written contracts before broad changes.
5. Ask for a design review at the end of Phase 1.
6. Implement one narrow reference slice.
7. At every step ask: did this remove a state machine, duplicate rule, or repair path?
8. Stop and redesign if comments, relationship invalidations, nested scope traversal, or a giant feed hook begin to reappear.

The intended outcome is a tightening of Codecast's architecture: more functional, more declarative, more predictable, more local-first, and less code—not a sophisticated new subsystem that the rest of the product must learn to appease.
