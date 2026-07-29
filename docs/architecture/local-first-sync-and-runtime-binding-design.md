# Principal-Safe Local-First State and Execution Binding

**Status:** Approved implementation design; implementation in progress  
**Audience:** Web, mobile, Convex, CLI/daemon, and infrastructure engineers  
**Date:** 2026-07-23  
**Supersedes as an implementation plan:** [Local-First FRP and Session Execution Coherence](./local-first-frp-restart-brief.md)

The earlier restart brief remains useful as incident history and as a record of rejected approaches. This document is the implementation-facing design. It separates two systems that share a design discipline but do not share an implementation:

1. principal-safe synchronization between Convex and Codecast's persistent local state; and
2. coherent binding between a conversation and the runtime that executes it.

The contracts in this document were accepted for implementation on 2026-07-23. Deployment remains a separate review gate.

---

## 1. Executive decision

Codecast will continue to render from a fast, persistent, offline-capable local materialized state. Convex remains the authoritative source of durable product facts, authorization, and transactions.

We will replace the current collection of overlapping cache-repair mechanisms with a small set of mandatory, typed boundaries:

- a **principal boundary** controls which protected local store may be opened;
- a **server-apply boundary** is the only path by which authoritative server results modify persistent local state;
- a **view contract** states its inbound shape, storage ownership, and lifecycle;
- a **command boundary** durably records local intent before exposing its optimistic effect;
- an **execution coordinator** is the only path that creates or resolves a conversation's runtime binding.

Domain contract authors declare completeness, projection ownership, and access-envelope shape once. Feature code selects a registered view with typed arguments and names the command the user requested. Infrastructure owns merging, ordering, persistence, retries, crash recovery, stale-result rejection, principal switching, and command reconciliation.

The north star is:

> Codecast renders from a principal-scoped local materialized view. Convex results and local commands cross a small set of mandatory, typed transaction boundaries. Application code declares intent; it does not implement synchronization.

### 1.1 Two independent workstreams

```text
Local-state workstream

Convex authoritative query / proven delta
                    |
                    v
             source contract
                    |
                    v
      principal-scoped local commit boundary
          |              |              |
          v              v              v
       entities     view membership   sync metadata
          \______________|______________/
                         v
                optimistic projection
                         v
                  reactive selectors


Execution workstream

requested execution target
          |
          v
ExecutionCoordinator(conversation, epoch)
      | starting
      |-----------------> ready binding -----> deliver(message, epoch)
      |
      `-----------------> failed ------------> pending / visible error
```

The original Codex-to-Claude incident motivated both discussions, but fixing execution binding does not validate a local synchronization design, and local synchronization machinery must not be used to solve runtime ownership.

---

## 2. Context and trust boundary

### 2.1 What is trusted

Convex is the trusted platform boundary for:

- transactional server mutations;
- authoritative durable records;
- authenticated server execution;
- reactive query recomputation; and
- server-side authorization decisions.

This design is not a response to Convex being unreliable. It is a response to ambiguity in Codecast's custom materialization layer between Convex and the local database.

Our Convex **application code** can still contain incorrect access checks, inconsistent query domains, or mismatched projections. Those are product bugs above the Convex platform and must be corrected.

### 2.2 Why the local database remains

The local database is a deliberate product capability, not an accidental cache. It provides:

- cached first paint without a server round trip;
- synchronous local reads and filtering;
- stable local state while the network sleeps or reconnects;
- optimistic interaction without network latency; and
- a foundation for offline-capable workflows.

Replacing it with direct `useQuery` reads throughout the UI would discard valuable product behavior. The objective is to make the local materialization trustworthy and simpler to use.

### 2.3 What is failing today

Authoritative data currently reaches the local store through several mechanisms with different semantics:

- live subscriptions;
- recent or bounded query windows;
- timestamp deltas;
- completeness crawls;
- a cross-entity change feed;
- focus, reconnect, and interval probes;
- ghost and existence sweeps;
- liveness overlays; and
- optimistic pending-field protection.

The mechanisms disagree about:

- whether omission means deletion, filtering, revocation, or simply “not in this page”;
- which source owns a field;
- whether an older response may overwrite a newer state;
- how a hard deletion survives hydration;
- how authorization loss purges persisted data; and
- how a command is acknowledged or rejected.

The result is a family of synchronization bugs rather than one isolated defect.

---

## 3. Goals

### 3.1 Product goals

1. Preserve cached first paint, synchronous local reads, optimistic interaction, and useful offline behavior.
2. Converge to the same authoritative state as Convex whenever the client is caught up and has no pending commands.
3. Make logout, account switching, membership changes, deletion, and access revocation safe for persisted data.
4. Recover predictably from crashes, reloads, sleep, reconnects, duplicate delivery, and stale responses.
5. Keep web, Electron, and mobile behavior contractually equivalent where they advertise the same capability.

### 3.2 Architecture goals

1. Eliminate bug classes through mandatory choke points rather than repair timers.
2. Make completeness, scope, projection ownership, and ordering explicit and machine-checkable.
3. Separate canonical entities, view membership, operational overlays, and unacknowledged commands.
4. Keep authorization and relationship logic on the server; infrastructure must not recreate a second domain model.
5. Make infrastructure adoption reduce application code.
6. Add a collection or view through a declarative contract, not a new synchronization state machine.
7. Ensure every new mechanism earns the deletion of an old repair path.

### 3.3 Developer-experience goal

Feature code should approach this shape:

```ts
useLocalView(commentThreadView, { conversationId });

await commands.execute(renameBucketCommand, {
  bucketId,
  name,
});
```

Feature code should not decide how to merge snapshots, advance cursors, plant tombstones, drain an outbox, recover after a crash, or purge another principal's data.

---

## 4. Non-goals

This initiative will not:

- replace Convex with a client-owned authority;
- require every screen to render directly from Convex queries;
- build a universal relation-aware replication graph;
- infer authorization from client-side relationships;
- require a global ordered change feed for every collection;
- introduce full event sourcing for product state or runtime state;
- promise exactly-once external runtime injection where a driver has no idempotency mechanism;
- migrate every local collection in one release; or
- unify local synchronization and runtime execution in one code subsystem.

“Functional” and “reactive” describe the desired shape—explicit inputs, pure transitions, derived views—not a requirement to adopt an FRP framework or vocabulary.

---

## 5. Vocabulary

| Term                      | Meaning                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Principal**             | The authenticated user identity that owns a protected local store and its commands.                              |
| **Entity**                | A canonical durable server record with a stable identity and version.                                            |
| **View**                  | A server-authoritative set or projection identified by a stable key and scope.                                   |
| **View membership**       | The entity IDs currently belonging to a view. Membership is not the entity itself.                               |
| **Complete view**         | A result whose contract proves membership is exhaustive for its declared domain and scope.                       |
| **Partial result**        | A page, bounded window, search result, or other contract-declared segment whose omissions carry no meaning.      |
| **Delta**                 | Explicit versioned upserts, removals, or revocations following a proven cursor.                                  |
| **Operational overlay**   | High-churn or derived state such as presence or liveness that is not a canonical entity field.                   |
| **Command**               | A durable request for an authoritative mutation, identified by a principal-scoped idempotency key.               |
| **Optimistic effect**     | A deterministic local projection of an unacknowledged command.                                                   |
| **Source epoch**          | A local generation identifying one mounted source instance and its exact arguments.                              |
| **Entity version**        | A server-issued value that increases whenever canonical semantic fields change.                                  |
| **Execution target**      | The immutable agent family, project, and isolation target authorized for one execution epoch.                    |
| **Runtime configuration** | Revisioned model and effort settings bound immutably to an execution epoch in the initial protocol.              |
| **Execution binding**     | The ready runtime's actual agent, transport, handle, owner device, state, and epoch.                             |
| **Grant key**             | An opaque server-issued identifier for an authorization/retention grant; clients compare but never interpret it. |

---

## 6. Responsibility boundaries

| Layer                  | Owns                                                                          | Must not own                                       |
| ---------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| Convex domain query    | Authentication, authorization, membership, projection, explicit access result | Client persistence or optimistic state             |
| Convex command handler | Transactional mutation, idempotency, authoritative receipt/version            | Client retry loop                                  |
| Source adapter         | Contract ID, view key, normalization, source epoch                            | Domain authorization reimplementation              |
| Local state engine     | Stale rejection, atomic apply, membership, persistence, command overlays      | Invented joins or access rules                     |
| Persistence adapter    | Transactions, crash durability, schema migration, local commit ordering       | Product merge semantics                            |
| Feature/UI code        | Selecting a view, rendering selectors, issuing named commands                 | Merge, deletion, cursor, retry, or tombstone logic |
| Execution coordinator  | Creating, resolving, fencing, and recovering runtime bindings                 | UI state synchronization                           |
| Runtime driver         | Agent-specific start, resume, deliver, inspect, and stop operations           | Selecting a different agent family                 |

The server remains the only authority on who may see a row. The client may cache an authorization result, but it may not derive a new grant.

---

## 7. Security prerequisites

Security remediation is Phase 0 and is not gated behind the larger architecture rollout.

### 7.1 Server query authorization

Every client-supplied scope identifier is untrusted. A server query must validate membership or ownership before using `team_id`, `project_id`, conversation ID, or any other scope to read records.

Known code requiring immediate remediation and regression tests includes:

- `docs.webListPaginated`, which currently accepts a client team and scans it directly;
- `tasks.webList` and `tasks.webListPaginated`, which currently trust a client team;
- task and plan project-index branches that do not apply canonical access filtering; and
- comment/count/detail endpoints whose access domains differ from the parent surface.

This is broader than those named endpoints. The current data context has an `unscoped` mode that returns raw queries and treats every document as accessible. An invalid client-supplied team can fall through to that mode. Before sync work begins, audit every public query and mutation that uses `createDataContext`, `.unscoped`, `.raw`, a client team/project identifier, or a global index.

The replacement must be a fail-closed authorized data gateway, not a growing list of call-site patches:

- invalid or unauthorized explicit scope -> `forbidden`;
- omitted scope -> an explicitly selected personal, active, or all-authorized scope;
- internal unscoped access -> available only through an internal-only API with a separate type;
- public query builders -> incapable of producing a raw unscoped data context.

The safe rule is:

```text
untrusted scope argument
    -> canonical server access check
    -> authorized query
    -> explicit access result
```

Every protected view uses one access-result algebra:

```text
unavailable / unauthenticated -> do not apply; retain the last authorized cache behind the principal gate
granted                      -> apply the authoritative payload
forbidden                    -> revoke the named grant/scope and purge exclusive protected state
missing                      -> authoritative parent/entity absence under the contract's removal rule
```

Returning `[]` for “authorized but empty,” “auth is unresolved,” “forbidden,” and “missing” is insufficient for a persisted local view. The public-endpoint access audit and fail-closed gateway are blocking prerequisites for trusting any snapshot, crawl, or materialized view. A transient unavailable/unauthenticated result must never erase a previously valid offline view.

### 7.2 Principal-scoped persistence

Protected state must never use one global database or flat keyspace.

The target layout is:

```text
Device launcher store (non-sensitive)
  - schema version
  - last verified principal binding
  - durable authentication generation / lock state
  - device-only preferences approved for cross-account use

Principal store: codecast-store-v2:<deployment>:<opaque-principal-key>
  - entities
  - views and memberships
  - command journal
  - sync metadata
  - conversation messages
  - principal-specific UI state
```

Rules:

1. A protected store may open only after a credential is matched to a previously verified principal identity or the server verifies the current identity.
2. A token's mere presence is not permission to open whichever database was used last.
3. Account switching closes the old store and clears its in-memory projection before opening another.
4. Explicit logout synchronously locks the store, clears memory, stops dispatch, and purges that principal's protected local data before navigation completes.
5. Every command record includes the principal identity even though the enclosing database is already namespaced.
6. A dispatcher refuses to send a command if its principal does not equal the current authenticated principal.
7. Server-confirmed membership or access revocation atomically removes the affected grants, memberships, rows no longer authorized through any other grant, and associated sync metadata.

The in-memory runtime has an explicit lifecycle:

```text
locked
  -> resolving
  -> opening(principal, principalEpoch)
  -> offline-ready(principal, principalEpoch)
  -> server-verified(principal, principalEpoch)
  -> locking / purging
  -> locked
```

`resolving` renders no protected state. `offline-ready` may render only a credential-bound, last-verified namespace and may not dispatch commands or apply new server results. `server-verified` enables authoritative apply and command drain.

Every asynchronous source and local transaction captures `principalEpoch` and checks it again at commit. Account switch increments the durable launcher generation and synchronously gates protected rendering before asynchronous close or purge work begins. Signout commits the launcher lock/generation before clearing memory and broadcasting the transition. A frozen or resumed tab checks that durable generation before rendering or committing, so correctness does not depend on receiving the broadcast.

Anonymous or public-share caching, if retained, uses a separate public namespace that can never receive protected rows or commands.

Offline boot may open the last verified principal store only when the durable authentication session still identifies the same locally verified principal. Dispatch remains disabled until the current server session is verified. If the principal cannot be established, boot fails closed rather than displaying protected cache data. The exact auth-library integration must be proven with tests before protected hydration is enabled.

### 7.3 Public and shared routes

Cached row presence is never evidence of current access. Public/shared routes must wait for an explicit server access result unless they are opening a protected store already verified for the same principal and using a contract that permits offline access.

A cached session must not be promoted to `owner` merely because its ID exists locally.

### 7.4 Legacy cache and outbox migration

The existing unnamespaced database cannot safely be assigned to the currently authenticated user after the fact.

Migration rules:

1. Do not copy protected cached entities or messages into a v2 principal store. Re-bootstrap them from authoritative queries.
2. Ship a bridge release before v2 cutover that stamps every newly written command and irreplaceable local draft with verified principal, schema version, and idempotency key.
3. Stop automatic dispatch of the legacy global outbox before authentication is established.
4. Migrate only bridge-stamped entries whose principal matches the verified v2 store. Preserve their original idempotency keys; migration must not turn old intent into a new logical command.
5. Quarantine every untagged legacy must-deliver command, especially messages. It remains opaque and non-executable because the existing `currentUser` row cannot prove ownership of residue in the shared store.
6. Never adopt an untagged command into the current principal, even after target access succeeds. Access to a target does not prove who authored the queued intent, and assigning a new idempotency key could duplicate an effect already attempted by an older build.
7. Offer only device-level recovery actions for untagged entries: export an opaque recovery archive, explicitly abandon it, or purge it. Do not render its protected payload inside the current principal session, silently dispatch it, or silently discard it.
8. Delete the legacy database only after every quarantine has been exported, explicitly abandoned, or purged.

---

## 8. Local materialized-state model

### 8.1 Separate state by meaning

The local engine stores four kinds of protected state separately:

```ts
type PrincipalState = {
  entities: EntityStore;
  views: ViewStore;
  viewProjections: ViewProjectionStore;
  commands: CommandJournal;
  commandReceipts: CommandReceiptStore;
  sync: SyncMetadata;
};
```

#### Entities

Canonical server rows, keyed by entity type and ID. Canonical fields have one declared source of truth and a server-issued entity version.

#### Views

Membership and view-owned projection data keyed by a stable `ViewKey`, such as:

```text
comments:conversation:<conversation-id>
buckets:principal:<principal-id>
tasks:workspace:<workspace-id>:active
inbox:principal:<principal-id>
```

Removing an ID from a view does not automatically delete the entity. An entity can remain referenced by another view, an open detail surface, a pending command, or a retention policy.

#### View projections

Query-owned enriched rows that are not canonical entities. A view projection can contain joins, display metadata, or derived fields without competing to overwrite a shared canonical row. Duplicating a small projection in two views is preferable to inventing unsafe cross-view merge semantics.

#### Commands and receipts

Durable unacknowledged intent and its terminal server outcome. Pending optimistic state is folded from command records rather than mixed into server rows or deletion tombstones. Receipts make server deduplication and causal acknowledgment explicit.

#### Sync metadata

Per-view source epochs, accepted revisions/cursors, access grants, bootstrap state, and local commit sequence. This is infrastructure metadata, not optimistic user intent.

Device-only navigation or appearance settings live outside this model unless they are intentionally principal-specific.

### 8.2 Visible-state equation

For a local view:

```text
visible(view)
  = project(authoritative entities, authoritative view membership, view projections)
  + deterministic effects of unacknowledged commands
  + explicitly non-authoritative operational overlays
```

When the client is caught up, has current authorization, and has no pending command affecting the view:

```text
normalize(local view) == normalize(authoritative server view)
```

The equality is asserted only for the exact principal, scope, filters, projection, and completeness contract named by the view.

### 8.3 Canonical fields versus view-owned fields

An enriched query must not silently become a second writer of canonical entity state.

Examples such as plan `active_agents`, project counts, session liveness, or display badges may change when related records change without the canonical row's version changing. They must be represented as one of:

- view-owned projection fields;
- a separately versioned operational overlay; or
- durable canonical fields whose owner updates their entity version.

If a query cannot provide a canonical row version and carries joined or time-derived fields, its result remains view-owned. It is not eligible for generic canonical-entity merging.

---

## 9. The authoritative server-apply boundary

All server data that modifies protected persistent state must pass through one logical API. “One boundary” means one set of enforced semantics; it does not mean one universal transport or one enormous reducer.

### 9.1 Required operations

```ts
interface AuthoritativeApply {
  replaceView(input: CompleteViewInput): Promise<LocalCommit>;
  replaceWindow(input: BoundedWindowInput): Promise<LocalCommit>;
  replacePage(input: BoundedPageInput): Promise<LocalCommit>;
  applyDelta(input: OrderedDeltaInput): Promise<LocalCommit>;
  removeEntities(input: ExplicitRemovalInput): Promise<LocalCommit>;
  revokeScope(input: ScopeRevocationInput): Promise<LocalCommit>;
}

interface OperationalApply {
  apply(input: OperationalOverlayInput): Promise<LocalCommit> | MemoryCommit;
}
```

Every `AuthoritativeApply` operation is a durable transaction. Operational state has a separate boundary because presence and liveness must not acquire canonical durability or ordering semantics accidentally. An operational contract explicitly selects memory-only publication or durable application; durable operational application still follows disk-before-memory publication.

### 9.2 Complete-view replacement

A complete-view payload must identify:

```ts
type GrantKey = string & { readonly __brand: "GrantKey" };

type SourceCoverage =
  | { kind: "none" }
  | { kind: "view-revision"; revision: string }
  | { kind: "command-ids"; commandIds: readonly string[] }
  | { kind: "coverage-token"; token: string };

type CompleteViewInput = {
  principalId: string;
  principalEpoch: number;
  contractId: string;
  viewKey: string;
  writerEpoch: number;
  sourceEpoch: string;
  sourceSequence: number;
  coverage: SourceCoverage;
} & (
  | {
      access: "granted";
      grantKeys: readonly GrantKey[];
      rows: readonly unknown[];
    }
  | {
      access: "forbidden";
      revokedGrantKeys: readonly GrantKey[];
      rows?: never;
    }
  | {
      access: "missing";
      releasedGrantKeys: readonly GrantKey[];
      removals: readonly ExplicitEntityRemoval[];
      rows?: never;
    }
);
```

The source adapter, not feature code, obtains this branded input from a registered contract. `unavailable` and `unauthenticated` never become apply inputs: they leave the last authorized durable state untouched behind the principal gate.

Grant keys are minted by the authorized server contract and attached to the view and, when a row can survive through several independent access paths, to the normalized row references. The local engine stores and reference-counts the opaque keys. It does not parse a key or reconstruct team, assignment, ownership, privacy, or parent relationships. A granted replacement also replaces that view's grant associations. A `missing` result releases the view associations without claiming a security revocation; a `forbidden` result revokes the named grants. An entity is security-purged when no surviving server-issued grant permits its retention.

`SourceCoverage` is contract metadata consumed by the command reconciler, not a client-authored version. A command contract that relies on view coverage must require the matching coverage kind and comparison rule; `none` can never retire an optimistic overlay.

Semantics:

1. Reject a payload for the wrong principal or principal epoch, contract, durable writer epoch, source epoch, or an older source sequence.
2. Normalize and validate rows against the contract.
3. Upsert canonical fields only through their declared owner and version rule.
4. Atomically replace membership for `viewKey`.
5. Omission removes membership only; it never by itself declares a canonical entity deleted or access revoked.
6. A view-owned projection omitted from its owning complete view is removed with that membership.
7. A canonical row omitted from one view becomes eligible for ordinary garbage collection only after no view, explicit server grant, detail retention, or command references it. Garbage collection is not recorded as an authoritative server deletion.
8. If access is `forbidden`, route the named opaque grant keys through explicit scope revocation rather than treating the payload as an ordinary empty list.
9. If access is `missing`, remove the named parent/detail membership, release that view's prior grant references, and apply only the explicit entity removals carried by that registered contract; empty `removals` means no canonical deletion.
10. Persist entities/projections, membership, opaque grants, and sync metadata in one local transaction.
11. Publish one in-memory commit after durable success.

A bounded list, page, search result, status filter, or recent window cannot call `replaceView` unless its contract defines that exact bounded or filtered result as the complete view. It may never imply global entity deletion.

### 9.3 Ordered deltas

A delta is accepted only when the source provides:

- a cursor with a proven strict ordering contract;
- explicit upsert, delete, and revocation operations;
- entity versions for canonical rows;
- duplicate-safe replay;
- gap detection or a defined re-bootstrap path; and
- a snapshot/bootstrap protocol that describes the same domain and projection.

```ts
type OrderedDeltaInput = {
  principalId: string;
  principalEpoch: number;
  contractId: string;
  streamKey: string;
  sourceEpoch: string;
  previousCursor: string;
  nextCursor: string;
  coverage: SourceCoverage;
  changes: Array<
    | {
        type: "upsert";
        entity: unknown;
        entityVersion: string;
        grantKeys: readonly GrantKey[];
      }
    | {
        type: "delete";
        entityId: string;
        tombstoneVersion: string;
      }
    | { type: "revokeGrant"; grantKey: GrantKey }
  >;
};
```

The transaction rejects a cursor gap, a stale cursor, or an older entity version. Duplicate application is idempotent.

`Date.now()` plus an overlap window is not an ordered-delta contract. A mutable latest-event row that forgets the old scope is not a revocation history.

### 9.4 Bounded windows and pages

Recent-item queries, message windows, search results, and pagination are neither complete entity scopes nor ordered deltas. They receive explicit segment contracts:

```ts
replaceWindow({
  principalId,
  principalEpoch,
  contractId,
  viewKey,
  windowKey,
  writerEpoch,
  sourceEpoch,
  sourceSequence,
  access: "granted",
  grantKeys,
  coverage,
  rows,
});

replacePage({
  principalId,
  principalEpoch,
  contractId,
  viewKey,
  pageKey,
  writerEpoch,
  sourceEpoch,
  sourceSequence,
  access: "granted",
  grantKeys,
  coverage,
  rows,
});
```

They replace membership or view-owned projections only inside the named window/page segment. Omission never removes data outside that segment and never implies global deletion. Unavailable results do not apply; forbidden/missing segment sources use the same registered revocation/removal transitions rather than forging a granted segment. The infrastructure, not feature code, owns segment overlap, identity deduplication, and invalidated-source rejection.

### 9.5 Other partial results

Partial results may upsert rows or populate view-owned pages, but omission has no deletion or revocation meaning.

The API must make it impossible to accidentally pass a partial payload to a complete-view operation. Completeness belongs in the contract type, not a boolean selected ad hoc at a call site.

### 9.6 Explicit removals and revocations

Deletion and authorization loss are different facts:

- **delete** means the authoritative entity no longer exists;
- **membership removal** means the entity no longer belongs to one view;
- **scope revocation** means the server explicitly says the principal no longer has an authorization grant through that scope.

They must have different operations and metadata. None may share the same representation as an unacknowledged local delete command.

```ts
type ExplicitEntityRemoval = {
  entityType: string;
  entityId: string;
  tombstoneVersion: string;
  deletionOwnerContractId: string;
};

type ExplicitRemovalInput = {
  principalId: string;
  principalEpoch: number;
  contractId: string;
  sourceEpoch: string;
  sourceSequence: number;
  removals: readonly ExplicitEntityRemoval[];
};

type ScopeRevocationInput = {
  principalId: string;
  principalEpoch: number;
  contractId: string;
  viewKey: string;
  writerEpoch: number;
  sourceEpoch: string;
  sourceSequence: number;
  revokedGrantKeys: readonly GrantKey[];
  reason: "forbidden" | "membership-removed" | "policy-revoked";
};
```

Every canonical entity type has one declared deletion owner. A canonical removal carries a server-issued tombstone version in the same version domain as upserts; a stale removal cannot erase a newer row, and an older upsert cannot resurrect a newer tombstone. If a source cannot provide that proof, it may remove view membership/projection only. Authoritative tombstone metadata is retained until the server contract proves older upserts can no longer arrive; it is not optimistic delete intent.

The source runtime constructs this input from the exact grant keys previously bound to the now-forbidden contract/view. Application code cannot name or synthesize grants. The normal principal, writer, and source fences reject a late revocation from a closed source. In one transaction, revocation removes those keys, all memberships/projections retained exclusively through them, commands no longer authorized for them, and canonical rows with no surviving view, grant, or independently authorized retention reference.

### 9.7 Ordering domains and stale callbacks

The system uses several distinct order domains. They are never compared with each other:

- `principalEpoch` fences account changes;
- `writerEpoch + sourceSequence` orders one durable complete-view writer;
- an opaque server cursor orders one proven delta stream;
- entity version orders a canonical row written by multiple sources; and
- local command sequence orders optimistic intent.

Every mounted source instance allocates a fresh source epoch bound to its principal, contract, and exact arguments. Changing workspace, team, conversation, filters, or principal closes the old source epoch. Remounting the same arguments still receives a new epoch. The durable writer epoch is a separate multi-window fence: it decides which source instance may materialize the view. No protected result becomes renderable in any tab until the fenced writer has committed it durably; non-writers may hold transport bookkeeping, but not a competing private authoritative projection.

Results from a closed epoch are discarded even if an asynchronous request completes later. Within an epoch, `sourceSequence` prevents an older callback from replacing a newer result.

Server entity versions, not source sequence, resolve canonical-row conflicts across different views. Client wall-clock time is permitted for telemetry and retention, never authoritative order.

### 9.8 Local garbage collection

An entity becomes eligible for local deletion only when:

- no active view membership references it;
- no current authorization grant requires retaining it;
- no pending command targets it;
- no pinned detail/offline retention policy retains it; and
- its retention grace period has elapsed, unless an explicit security revocation requires immediate purge.

Garbage collection is storage policy. It must not be confused with server deletion.

---

## 10. Declarative view contracts

Infrastructure needs domain declarations, but those declarations must not duplicate server authorization logic.

Conceptually:

```ts
const commentThreadView = defineCompleteView({
  id: "comments.byConversation/v1",
  key: ({ principalId, conversationId }) =>
    `comments:${principalId}:${conversationId}`,
  query: api.comments.getConversationCommentSummary,
  inbound: complete(),
  storage: projection(commentSummarySchema),
  lifecycle: demand(),
  normalize: normalizeCommentThread,
});
```

Every contract declares three independent axes:

| Axis          | Choices                           | Meaning                                                                                 |
| ------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| Inbound shape | `complete`, `segment`, or `delta` | What omission and ordering mean for this result.                                        |
| Storage shape | `canonical` or `projection`       | Whether rows may update shared versioned entities or only this view's owned projection. |
| Lifecycle     | `global`, `demand`, or `prefetch` | When infrastructure mounts, retains, and refreshes the source.                          |

None of these choices implies another. A demand view may be complete; a global view may still be projection-owned; a segment never gains deletion authority by being prefetched.

The contract also declares:

- stable identity and schema version;
- server query and argument shape;
- view-key derivation;
- exact complete membership scope;
- the selected inbound, storage, and lifecycle axes;
- entity codec and entity-version field, if canonical;
- offline retention policy; and
- server-issued grant-key mapping for the view and normalized row references.

The contract does **not** declare who may see a row. The query returns an explicit authorized result after applying the canonical server access rule.

Adding a view should not require adding a branch to the state engine.

Only the central source runtime can turn a registered contract result into branded `CompleteViewInput`, `BoundedWindowInput`, `BoundedPageInput`, or `OrderedDeltaInput`. Feature code supplies typed query arguments and consumes selectors; it cannot pass arbitrary rows to the apply API or choose completeness, storage ownership, revocation, or ordering at runtime.

Use separate registries for separate capabilities:

1. canonical entity and view-projection schemas;
2. materialized view contracts;
3. command contracts; and
4. pure local-only persistence.

Do not extend the current registry's conflation of persistence, hydration, optimistic protection, and server dispatch.

The boundary is mandatory after a slice migrates:

- feature code cannot import persistence adapters;
- migrated views cannot call `syncTable` or supply an `isDelta` flag;
- feature code cannot manipulate deletion tombstones, cursors, or command receipts;
- server-bound user intent enters through the command runtime; and
- development/static guards fail on new bypasses.

---

## 11. Durable command journal and optimistic state

### 11.1 Command lifecycle

```text
created
  -> durably queued
  -> sending
  -> acknowledged-awaiting-coverage
  -> reconciled

or

created
  -> durably queued
  -> rejected
  -> rolled back / corrected

or, for an unknowable external side effect

created
  -> sending
  -> ambiguous
  -> explicit recovery

or, after the server's advertised dedupe horizon

durably queued / sending
  -> replay-expired
  -> explicit recovery
```

No durable command is silently abandoned because the application has restarted a fixed number of times.

Commands that do not deserve durable retry must be explicitly classified as ephemeral or safely coalescible. They do not masquerade as durable commands.

### 11.2 Local transaction before visibility

For a durable command, the local engine must atomically commit:

- command ID and principal;
- command name and validated arguments;
- concrete, schema-versioned optimistic operations derived from the validated command;
- target entity/view references;
- creation order; and
- server-advertised `retryUntil` when dedupe is not permanent; and
- lifecycle state.

Only after the durable transaction succeeds may the optimistic effect be published as committed local state. The operation does not wait for the network.

Persist the concrete optimistic operations, not only JavaScript arguments that a future application version might interpret differently. Hydration can therefore replay the same effect across an upgrade or route the record through an explicit command migration.

If durable storage is unavailable, the engine must expose a degraded capability. It may reject durable offline commands or explicitly offer an ephemeral action; it may not claim durability while swallowing the failure.

### 11.3 Idempotency

Every replayable command must be either:

- inherently idempotent under its arguments; or
- accepted by a server handler that deduplicates by `(principalId, commandId)` and returns the original authoritative receipt.

Create, toggle, append, and external-side-effect commands are not assumed idempotent. A common Convex command helper should enforce receipt lookup and mutation in one server transaction without moving domain logic into the transport.

The server binds a command ID to a SHA-256 digest of its canonical, validated arguments. It does not retain a second full copy of user-authored payload in the indefinitely retained receipt. Receipt results and corrections remain minimal and contain only what reconciliation requires.

### 11.4 Acknowledgment and rejection

A command is not acknowledged because a later row happens to contain the desired value. Acknowledgment refers to the command ID and returns an authoritative receipt with a mandatory reconciliation proof.

Every command eligible for optimistic cutover declares exactly how the authoritative state will causally cover that receipt. The proof is one of:

1. an authoritative canonical write set with entity versions, applied with the receipt;
2. a complete owning-view replacement and server revision that includes the command; or
3. an opaque server coverage token or command ID carried by the owning source and comparable with the receipt.

Value equality is never a proof: an ABA change or another actor can produce the same value. Entity versions are not sufficient for query-owned projections whose joined fields can change independently. If a command cannot supply one of the three proofs, it may remain non-optimistic or on the legacy path, but it cannot cut over to the new optimistic runtime.

On acknowledgment:

1. apply returned authoritative rows/versions when that is the declared proof;
2. mark the command `acknowledged-awaiting-coverage` when a later view revision/token must arrive;
3. remove its optimistic effect only in the transaction that proves authoritative coverage; and
4. retain the receipt for at least the maximum supported client retry/replay horizon before compacting it under an explicit server dedupe policy.

The authoritative rows, receipt, command lifecycle transition, and overlay retirement commit as one local transaction.

On rejection:

1. persist the terminal rejection;
2. remove or transform the optimistic effect;
3. apply authoritative correction or request the canonical view;
4. expose a user-visible failure for user-authored intent; and
5. never retry a permanent rejection indefinitely.

The rejection receipt, authoritative correction, command lifecycle transition, and overlay removal likewise commit atomically.

Rollback does not apply old inverse patches to whatever state happens to exist now. Removing the rejected command from the ordered overlay fold reveals the newest authoritative base plus every later active command, avoiding rollback-over-newer-state bugs.

Security revocation outranks optimistic retention. Revoking the last grant for a command's target atomically blocks commands that have not reached the server, retires their overlays, and purges protected base/projection data. A `sending` command has an unknown ordering relative to the server revocation: stop blind retry and resolve its receipt. If the command committed first, consume its receipt and then let revocation remain the final visible/persisted state; if authorization lost first, consume the rejection. Neither outcome may restore the revoked content or retry forever.

A command record contains the concrete data needed to render and reconcile its own effect while authorized; it must not keep otherwise revoked server rows alive. User-authored payload may survive revocation only under a separate server-authorized ownership policy. Otherwise the purge removes it as protected content.

Server receipt retention defines the supported automatic replay horizon. When dedupe is not permanent, the command stores the server-advertised `retryUntil`; dispatch atomically transitions an older command to visible, non-dispatchable `replay-expired` before any network effect. Recovery may query authoritative state, export intent, or ask the user to issue a new logical command, but it never silently assigns a new command ID. Alternatively, the server may retain a compact dedupe tombstone indefinitely. The server must not forget a command ID while a supported client can still replay it automatically.

### 11.5 Ordering and coalescing

Commands are ordered per principal and conflict key, not necessarily through one global queue. Independent commands may dispatch concurrently.

Coalescing is allowed only when a command contract proves it preserves semantics—for example, replacing several unsent last-write-wins preference updates with the newest one. User-authored messages, creates, and non-commutative toggles are not coalesced.

---

## 12. Persistence adapter contract

Web and native adapters must satisfy the same semantic contract before advertising the same local-first capability.

### 12.1 Required capabilities

Each adapter must provide:

- open/close by principal;
- schema migration scoped to that principal;
- atomic transactions over entity, view, command, and metadata records affected by one local commit;
- compare-and-reject behavior for stale local commits;
- monotonic local commit sequence;
- durable command enumeration in creation order;
- explicit, observable storage errors;
- safe purge by principal or revoked scope; and
- crash-consistent hydration from the last committed transaction.

An API-shaped native substitute that rewrites unrelated JSON blobs independently is not semantically equivalent to a transactional IndexedDB adapter.

If the current native KV layer cannot meet the contract, the implementation must use direct SQLite transactions or declare a reduced capability rather than weakening the invariant.

### 12.2 Disk before memory publication

The local database is the durable local source. A commit follows:

```text
validate transition
  -> durable local transaction
  -> obtain local commit sequence
  -> publish one in-memory state transition
  -> notify other windows/processes
```

A crash after disk commit but before publication recovers on hydration. A crash before disk commit must not leave a state the UI had treated as durably accepted.

### 12.3 Multi-window behavior

Multiple browser windows share IndexedDB but not module-local Zustand state. Correctness may not depend on each window's private shadow of what it thinks is persisted.

Every durable commit receives a local commit sequence. After commit, the writer broadcasts the sequence and affected keys. Other windows transactionally reload the current durable snapshot for those keys at that head; if they observe a sequence gap, they reload the relevant principal snapshot rather than pretending an unavailable commit history can be replayed. Broadcast is a liveness optimization. Focus/reopen compares the durable head and launcher auth generation before rendering, so losing a broadcast does not lose correctness.

Concurrent windows use database transactions and version checks. They do not resolve conflicts using last callback wins.

Complete Convex subscriptions in separate tabs do not automatically carry comparable server revisions. Durable persistence of one view therefore requires one of two proven fences:

1. a server-issued monotonic view revision; or
2. a durable per-view writer epoch, acquired transactionally by one tab.

The initial design should spike a fenced per-view writer. Only the current writer may materialize that source: it durably commits a result, then every tab—including the writer—publishes from the resulting local commit. Non-writers do not apply their private Convex callbacks to protected memory.

Handoff allocates a higher writer epoch. The new writer discards every result produced before acquisition and starts a fresh authoritative subscription/bootstrap before its first commit; a higher writer epoch fences the former writer but is not itself evidence that a pre-acquisition snapshot is fresher. An old writer's transaction fails the fence even if its callback arrives late. Lease expiry may improve handoff liveness, but correctness comes from the epoch comparison and post-acquisition bootstrap, not the timer or tab leadership.

If browser lifecycle behavior makes this impractical, the relevant view must gain a server-issued revision before multi-tab durable replacement is enabled. This decision is a gate for the first complete-view slice.

### 12.4 Stable reactive publication

The in-memory mirror should preserve unchanged object identities and publish once per local commit for performance. This is an implementation quality requirement, not the source of correctness. Correctness resides in the durable transition and version checks.

---

## 13. Convex source contracts

### 13.1 Queries own domain semantics

The authoritative query owns:

- current authorization;
- membership and filters;
- projection shape;
- completeness claim; and
- the shared `unavailable/unauthenticated`, `granted`, `forbidden`, or `missing` access result.

The local engine owns none of those rules.

### 13.2 Snapshot/by-ID parity

If a change transport invalidates an entity ID and then fetches its current state by ID, the list/snapshot and by-ID endpoint must use the same:

- authorization domain;
- active/archive/hidden filters, or an explicitly documented superset;
- canonical projection;
- entity version; and
- scope interpretation.

At minimum:

```text
normalize(snapshot[id]) == normalize(byId(id))
```

for every ID in the snapshot domain.

Current tasks, documents, conversations/inbox, and enriched plans do not satisfy this requirement without normalization.

### 13.3 Active scope lifecycle

Team membership and other grants are their own authoritative reactive view.

```text
scope added   -> establish grant -> bootstrap its required views
scope removed -> revoke grant -> atomically purge exclusive protected state
```

Silence in an entity feed does not imply that a team membership still exists.

On reconnect, every persisted protected scope—not only views mounted on the current screen—must be refreshed, validated through a domain-owned access receipt, or purged. A cache cannot retain an authorization grant forever merely because the corresponding screen was never reopened.

### 13.4 When a change tail is justified

A generic ordered tail is not the default architecture. Use a complete reactive query or complete scoped crawl when it can express the required view within acceptable cost.

A new tail requires a separate reviewed protocol proving:

- one strict order for every consumed source;
- a snapshot/head handshake or equivalent gap-free bootstrap;
- page-boundary safety, including cursor ties;
- concurrent commit behavior;
- old-scope revocation on moves;
- membership addition/removal behavior;
- retention and cursor expiry;
- re-bootstrap behavior; and
- no unacceptable global or per-scope write hotspot.

Until such a protocol exists, the current `Date.now()` change feed remains a best-effort repair signal. It must not be described as proof that a local collection is caught up.

---

## 14. Initial collection classification

This table describes the starting position, not an immutable final taxonomy.

| Local data                               | Initial owner/contract                                                                                | First action                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Buckets                                  | Complete principal-scoped reactive view                                                               | First `replaceView` reference slice                                                 |
| Bucket assignments                       | Complete principal-scoped relation view, returned with buckets                                        | Apply atomically with the bucket result                                             |
| Conversation comments                    | Complete demand-driven conversation view                                                              | Second `replaceView` slice; explicit access result                                  |
| Inbox membership                         | Relational authoritative view derived from ownership, assignments, privacy, and hidden state          | Keep query-owned; store membership separately from conversations                    |
| Canonical conversations                  | Potential canonical entity, distinct from enriched inbox/session projection                           | Do not migrate until projection and binding fields are normalized                   |
| Session liveness/presence                | Operational overlay                                                                                   | Keep out of broad durable entity replication                                        |
| Tasks                                    | Currently inconsistent: assignee is row-local, but list access, by-ID access, and feed scope disagree | Fix authorization/projection contract; remain query-owned meanwhile                 |
| Documents                                | Canonical access is row-based today, while workspace membership can be conversation-derived           | Keep workspace views query-owned; normalize before canonical replication            |
| Plans                                    | Enriched view includes derived liveness                                                               | A stripped canonical plan may become the first replicated entity after access fixes |
| Projects                                 | Query-owned enriched view with derived counts                                                         | Do not treat as a canonical delta table                                             |
| Teams, memberships, favorites, bookmarks | Small principal-scoped views, subject to individual access/projection audit                           | Early follow-up after reference slices                                              |
| Conversation messages                    | Demand-driven, windowed conversation history plus pending sends                                       | Design separately after command journal and principal isolation                     |
| Current user                             | Principal metadata                                                                                    | Store only inside the principal namespace                                           |
| Navigation, drafts, layout               | Device-local or principal-local UI state by explicit policy                                           | Never treat as server entity replication                                            |
| Pending user intent                      | Durable command journal plus ordered optimistic operations                                            | Replace pending fields and entity tombstones                                        |

No collection enters generic durable replication merely because it is currently persisted or marked `localFirst`.

---

## 15. Runtime execution binding

This section is a separate implementation track that follows the same “one fact, one boundary” discipline.

### 15.1 Current failure

The current daemon can:

1. begin a Codex app-server thread;
2. receive a pending message before the thread-to-conversation map is registered;
3. wait on a tmux-only registry that the Codex path will never populate; and
4. start a fresh Claude tmux runtime through a hardcoded fallback.

Later messages may reach the registered Codex thread, creating split-brain execution. App-server delivery failure can also remove the Codex registration and enter generic tmux/Claude recovery.

This is broader than one missing map recheck. Runtime selection is duplicated across start, delivery, resume, discovery, and fallback paths.

### 15.2 Execution model

The authorized target, revisioned runtime configuration, and actual ready binding are different durable facts:

```ts
type ExecutionTargetSpec = {
  conversationId: string;
  epoch: number;
  requestedAgent: AgentClientId;
  transport: "app-server" | "tmux" | "external";
  projectPath: string;
  isolation?: IsolationSpec;
};

type RuntimeConfiguration = {
  revision: number;
  model?: string;
  effort?: string;
};

type PendingSuccessor = {
  state: "waiting-for-drain";
  target: ExecutionTargetSpec; // exactly current epoch + 1
  configuration: RuntimeConfiguration;
  ownerDeviceId: string;
  daemonBootId: string;
  requiredCapabilities: readonly RuntimeCapability[];
  policy: "drain-current" | "cancel-unstarted";
  requestedAtConversationSequence: string;
};

type ExecutionBase = {
  target: ExecutionTargetSpec;
  configuration: RuntimeConfiguration;
  ownerDeviceId: string;
  daemonBootId: string;
  requiredCapabilities: readonly RuntimeCapability[];
  pendingSuccessor?: PendingSuccessor;
};

type ReadyBinding = {
  conversationId: string;
  epoch: number;
  requestedAgent: AgentClientId;
  actualAgent: AgentClientId;
  transport: "app-server" | "tmux" | "external";
  handle: string;
  ownerDeviceId: string;
  daemonBootId: string;
  runtimeId: string;
  operationId: string;
  appliedConfigurationRevision: number;
  protocolVersion: number;
  capabilities: readonly RuntimeCapability[];
};

type ExecutionRecord =
  | (ExecutionBase & { state: "requested" })
  | (ExecutionBase & { state: "starting"; operationId: string })
  | (ExecutionBase & { state: "ready"; binding: ReadyBinding })
  | (ExecutionBase & {
      state: "start-failed-before-effect";
      operationId: string;
      failure: StructuredFailure;
    })
  | (ExecutionBase & {
      state: "start-ambiguous";
      operationId: string;
      suspectedRuntimeId?: string;
      failure: StructuredFailure;
    })
  | (ExecutionBase & { state: "stopped"; stoppedReason: string })
  | (ExecutionBase & {
      state: "quarantined";
      binding?: ReadyBinding;
      operationId: string;
      failure: StructuredFailure;
    });
```

`ExecutionBase` contains the immutable target, runtime configuration, owner device and exact daemon incarnation, protocol requirements, and any durably requested successor. The discriminated union prevents a requested or pre-effect failure from pretending it has a usable handle and preserves the evidence needed to inspect an ambiguous start. A generic `failed` state never authorizes retry.

Ambiguity is recorded at the boundary where it occurred. An ambiguous runtime creation is durable `start-ambiguous` evidence on the binding, retaining the operation and suspected runtime IDs. An ambiguous message injection is durable evidence on the delivery attempt, message, and conversation-global slot. Protocol v1 deliberately has no generic `runtime-ambiguous` binding state and no representable-but-unhandled `stopping` state: a ready binding becomes `stopped` or `quarantined` only after the corresponding external disposition has completed or been proven. The exact schema uses dedicated execution-binding and delivery-attempt records; it does not rely only on in-memory maps or turn the subsystem into a general event store.

For a ready binding, `actualAgent` must equal the strictly parsed `requestedAgent`. If product policy chooses another agent family, it first creates a new execution target and epoch; it is not represented as an unexplained mismatch inside one binding.

Convex is the authority that creates or advances an execution epoch. `ExecutionTargetSpec` is immutable within that epoch. Advance the epoch whenever the authorized delivery target may change: agent-family replacement, project/worktree replacement, transport/runtime replacement, destructive restart, owner-device transfer, or replacement of a runtime that might still survive.

Model and effort live in a separately typed, revisioned `RuntimeConfiguration`, but the initial protocol binds that configuration immutably to the epoch. Any model or effort change requests the successor epoch just like a target replacement. Startup records the exact applied configuration revision in the ready binding, and a permit must match it. This intentionally avoids a second crash-prone external reconfiguration protocol. A future in-place optimization requires its own durable `reconfiguring` state, idempotent operation ID, inspect/adopt proof, permit exclusion, and reviewed protocol before this rule may be relaxed.

A `start_session` command is a wake-up hint carrying the current epoch. It is not another source of execution truth.

### 15.3 Coordinator rule

There is one `ExecutionCoordinator` per daemon process and one single-flight operation per `(conversationId, epoch)`. The in-process single-flight is a latency optimization; Convex compare-and-set transitions are the inter-process authority when two daemon processes race.

Both `start_session` and `deliverMessage` call the same operation:

```ts
ensureBinding(conversationId, expectedEpoch): Promise<ReadyBinding>
```

Rules:

1. Publish the in-flight coordinator entry before the first asynchronous start operation.
2. If delivery arrives first, it may initialize the same requested spec through the coordinator.
3. Delivery may await a starting binding, consume a ready binding, or fail visibly.
4. Delivery never independently selects an agent or transport.
5. Recovery may restart or adopt only the requested agent family unless an explicit durable policy transition changes the spec and epoch.
6. A failed app-server turn does not imply permission to start Claude.
7. Unknown agent values fail closed. Compatibility aliases such as `cowork -> claude` are explicit, tested policy—not a default branch.
8. A late start completion publishes `ready` only through a compare-and-set on conversation, epoch, and owner; if it loses, it tears down or quarantines the stale runtime.

### 15.4 Epoch fencing

Reconfiguration, restart, or device ownership transfer requests a new execution epoch before delivery to the replacement may begin. The old epoch remains authoritative until the advancement transaction is allowed to linearize.

Pending-message claim, injection state, and terminal status carry:

```text
conversationId + executionEpoch + configurationRevision
+ ownerDeviceId + daemonBootId + runtimeId + deliveryId
```

Before the external side effect, the daemon revalidates the fence. A stale worker may not deliver into a previous binding after a new epoch or owner has won.

The normal-protocol guarantee is scoped to one stable logical delivery ID:

> One `deliveryId` is never authorized for delivery across two execution epochs or agent families.

Convex assigns every submitted message a strictly increasing, gap-accounted `conversationSequence` in the same transaction that stores it. This server sequence—not creation time or a client timestamp—is the total delivery order. A message is stamped with the active epoch, or with the already-allocated pending successor epoch when it arrives after the supersession admission boundary. Delivery obtains a durable permit:

```ts
type DeliveryPermit = {
  messageId: string;
  deliveryId: string;
  conversationSequence: string;
  attemptId: string;
  conversationId: string;
  executionEpoch: number;
  configurationRevision: number;
  ownerDeviceId: string;
  daemonBootId: string;
  runtimeId: string;
};

type StartedDeliveryPermit = DeliveryPermit & {
  state: "delivery-started";
  readonly __brand: "StartedDeliveryPermit";
};
```

The claim mutation atomically acquires the one conversation-global delivery slot and compares the candidate with the durable next nonterminal `conversationSequence`. It verifies that the message is pending, its epoch is active, the binding is ready, the configuration revision equals `appliedConfigurationRevision`, the owner is current, and no other active attempt owns the slot. Every terminal disposition advances the head across the contiguous terminal prefix in the same transaction; claimed, started, retryable pre-effect failures, and unresolved ambiguity do not. A new epoch therefore cannot create a second slot or pass an older message.

The terminal message dispositions are closed and explicit:

```text
delivered
rejected
cancelled-by-supersession
correlated-delivered
abandoned-ambiguous
```

`failed-before-effect` is terminal for one attempt, not for the message: it releases the slot and returns the same sequence to pending unless policy rejects or cancels it. Correlation that proves no effect likewise makes the same message retryable. Risk-bearing resend first records the original as `abandoned-ambiguous`, advances the head, and creates a new sequence and `deliveryId`. No recovery-specific status may bypass this disposition transition.

Immediately before invoking a driver, one server mutation transitions the permit from `claimed` to `delivery-started` while rechecking the ready binding and fence, and returns a branded `StartedDeliveryPermit`. Epoch advancement conflicts transactionally with a `delivery-started` permit. This transition—not a read followed by an external call—is the control-plane linearization point. Every tmux paste and app-server turn path requires both a `ReadyBinding` and the matching started permit. Direct injection without them is an architectural violation.

```text
pending -> claimed -> delivery-started -> delivered
                        |
                        +-> failed-before-effect
                        `-> ambiguous
```

Epoch advancement follows one centralized, durable policy:

1. requesting a replacement writes one `pendingSuccessor` with epoch N+1, its own next owner/capability requirements, and atomically closes admission to epoch N; the current owner fields remain unchanged while N drains, and new messages receive sequence order normally but target N+1 and cannot yet be claimed;
2. under `drain-current`, every older epoch-N sequence reaches a terminal state before N+1 activates;
3. under `cancel-unstarted`, one bounded transaction records an epoch-N `cancelledThroughSequence` cutoff and cancels the at-most-one claimed-but-not-started permit; matching unclaimed rows are immediately non-claimable and logically `cancelled-by-supersession`, then bounded background batches materialize that disposition for audit without affecting correctness;
4. a `delivery-started` permit keeps the successor in `waiting-for-drain`; the old epoch remains current and no replacement delivery can start until that permit reaches `delivered`, proven `failed-before-effect`, or an explicitly resolved `ambiguous` state;
5. activation atomically verifies the conversation-global queue head, the chosen drain/cancel policy, and the absence of an active permit before replacing N with N+1; and
6. an ambiguous head message blocks later messages and successor activation until correlation, idempotent replay, proven runtime quarantine, or an explicit user recovery decision resolves it.

Only one successor may be pending. A later replacement request is rejected, or may replace the pending successor only before any message has been admitted to its epoch and before startup begins. Otherwise it waits for that successor to activate or be explicitly cancelled; cancelling it must also terminally dispose of every message already assigned to it rather than retargeting them.

Epoch-stamped messages are never silently retargeted. If a user elects to resend content whose old outcome remains ambiguous, the resend is a new logical command with a new `deliveryId`; the original remains visibly resolved as risk-accepted/abandoned-ambiguous. That explicit action is outside the one-`deliveryId` guarantee and cannot make the original appear exactly-once.

This closes the time-of-check/time-of-use hole: a worker paused after acquiring delivery authority prevents a new epoch from becoming active. It does not claim that Convex can physically stop a partitioned process. Releasing an ambiguous permit without runtime-enforced fencing is an explicit risk-bearing recovery action, not a normal retry path.

### 15.5 Restart and orphan recovery

Starting an external runtime and persisting its handle cannot be one database transaction. The coordinator therefore records a durable `starting` binding and operation ID before the external side effect.

After a crash:

1. inspect the durable binding;
2. use the driver to find a runtime tagged with the operation ID or conversation/epoch;
3. adopt it if it matches the requested agent and fence;
4. retry startup in the same epoch only if the driver proves that no runtime was created or deduplicates startup by the same operation ID;
5. transition an `unknown` inspection to durable `start-ambiguous`, retaining the operation ID and suspected runtime evidence, and do not create another runtime automatically; and
6. terminate or quarantine an orphan where possible, otherwise leave the binding visibly blocked.

A new epoch may replace a prior runtime only after the old target is proven stopped or durably quarantined from delivery. If the old runtime might survive and has no runtime-enforced fence, automatic replacement is unsafe. Changing from app-server to tmux is a replacement target and therefore a new epoch even when the requested agent family is unchanged, unless a driver proves both transports address the same underlying runtime and the old path cannot survive.

Legacy or externally discovered sessions need an explicit adoption transition into a new epoch. They must not bypass the coordinator indefinitely.

An explicit kill advances to a stopped epoch and invalidates earlier bindings and unstarted permits. A later user message may atomically request the next epoch under the product's restart policy.

### 15.6 Delivery semantics and exactly-once limits

Runtime coherence and delivery idempotency are separate proofs.

`deliveryId` is stable for the logical message across attempts; `attemptId` changes on each permitted try. Where a driver accepts an idempotency key, use `deliveryId` and deduplicate. Where tmux or an app-server API exposes only an external side effect followed by acknowledgment, a crash can leave an ambiguous result.

Until transcript correlation or driver idempotency resolves that ambiguity, the honest guarantee is:

- exactly one authorized target binding and epoch for a logical message;
- at most one active attempt and strict conversation order;
- automatic retry only after a proven pre-effect failure, or with driver idempotency/correlation using the same `deliveryId`; and
- a possible zero-or-one unknown outcome represented by explicit `ambiguous`, never hidden by delivery into another runtime.

Convex can fence the control plane, but it cannot transactionally roll back a tmux paste or forcibly stop a partitioned process. If partition-proof single-runtime existence becomes a product requirement, the system also needs expiring owner leases and runtime-enforced fencing. This design promises control-plane delivery fencing, not an impossible distributed-process guarantee.

### 15.7 Runtime driver boundary

Agent-specific logic belongs behind a driver interface:

```ts
interface RuntimeDriver {
  start(
    target: ExecutionTargetSpec,
    configuration: RuntimeConfiguration,
    operationId: string,
  ): Promise<RuntimeHandle>;
  inspect(record: ExecutionRecord): Promise<"alive" | "missing" | "unknown">;
  adopt(
    target: ExecutionTargetSpec,
    operationId: string,
  ): Promise<RuntimeHandle | null>;
  deliver(
    binding: ReadyBinding,
    permit: StartedDeliveryPermit,
    delivery: Delivery,
  ): Promise<DeliveryResult>;
  stop(binding: ReadyBinding): Promise<void>;
}
```

The coordinator selects a driver from the strict requested agent descriptor. A driver never selects another driver.

A static/structural guard should prevent direct tmux or app-server injection outside the fenced driver boundary once migration is complete.

### 15.8 Mixed-version daemon compatibility

The binding and claim protocol carries a schema version plus required capabilities such as `single-flight-binding`, `delivery-permit-v1`, and `strict-agent-routing`. Once a conversation is epoch-fenced, only a daemon advertising every required capability may claim or deliver it. Legacy claim endpoints refuse those conversations rather than treating absent epoch fields as permissive defaults.

Capability gating prevents new legacy claims; it cannot revoke an external side effect already held by old code. Protocol activation therefore uses a quiescence state machine:

```text
legacy -> legacy-quiescing -> fenced
```

Entering `legacy-quiescing` stops new legacy claims and wake events but does not yet create a fenced epoch. The owning device supervisor must terminate the legacy daemon process and its in-flight start/delivery workers, then launch an upgraded daemon with a new boot ID. The upgraded daemon handshakes that boot ID, proves there is no server-side legacy claim, and inspects/adopts or quarantines any surviving runtime before Convex may atomically enter `fenced`. If process termination or runtime disposition cannot be proven, the conversation remains visibly legacy/quiescing; the server does not assume that a lease timeout physically stopped an old worker.

During rollout, legacy daemons may continue servicing explicitly legacy conversations only. New conversations may use the fenced protocol after the owner is upgraded; existing conversations cross the quiescence gate one at a time and never flip back while old work is pending. Mixed-version tests pause an old daemon after it has observed a message or `start_session`, attempt activation, and prove activation is refused until that exact daemon boot is terminated. They also prove an old daemon, delayed webhook, or stale event cannot claim, inject into, or terminally update an already fenced conversation.

---

## 16. Governing invariants

### Local state

1. Protected state is opened, persisted, and dispatched only for one verified principal.
2. Every authoritative durable local update passes through the typed apply boundary.
3. Partial omission never means deletion, membership loss, or revocation.
4. Complete-view omission has only the domain meaning declared by its contract.
5. Canonical fields accept only their declared source and a non-stale entity version.
6. View membership, entity deletion, and access revocation are different transitions.
7. Server tombstones and pending local commands never share a representation.
8. A durable optimistic effect is visible only after its command journal transaction succeeds.
9. Command acknowledgment names the command; it is not inferred from value equality.
10. A command is never dispatched under another principal.
11. Disk, memory, and cross-window mirrors advance by committed local transaction sequence.
12. Storage failure is visible and changes advertised capability; it is never swallowed as success.
13. Client wall-clock time is never authoritative ordering.

### Server contracts

14. Every untrusted scope argument is authorized before use.
15. Snapshot/list and by-ID lookup agree on their declared domain, authorization, projection, and version.
16. Scope membership has an explicit lifecycle independent of entity changes.
17. An ordered tail cannot claim correctness without a strict cursor and gap-free bootstrap proof.

### Execution

18. Convex is the only authority that creates or advances an execution epoch.
19. A conversation has at most one ready binding for an execution epoch.
20. The execution target and runtime configuration are immutable within an epoch in the initial protocol.
21. Delivery consumes a binding and permit; it never chooses an agent independently.
22. A ready binding's actual agent equals its requested agent; an intentional family change creates a new spec and epoch.
23. Message claims and external delivery are fenced by epoch, configuration revision, owner device, daemon boot, and runtime ID.
24. One conversation-global slot and server-issued sequence preserve message order across epoch changes.
25. Late registrations and stale permits are idempotent no-ops.
26. Failure or ambiguity cannot trigger a silent cross-agent fallback.

---

## 17. Implementation sequence

The security prerequisites are immediate. After that, the local-state and runtime tracks can proceed independently.

### Phase 0 — Contain security and establish baselines

- Audit every public protected-table read/write, eliminate public fail-open `unscoped` access, fix arbitrary team/project scope reads, and add adversarial access tests.
- Remove cached-presence-as-authorization behavior from public/shared routes.
- Stop protected hydration and outbox drain before principal resolution.
- Ship the bridge stamps for new legacy commands, then define and implement the legacy outbox quarantine path.
- Measure cached first paint, local write latency, disk writes, Convex reads, wake recovery, and current store sizes.
- Add deterministic reproductions for the Codex/Claude race and principal-switch cache exposure.

Exit condition: known authorization gaps are closed and no old global outbox can dispatch under an unverified principal.

### Track A1 — Execution coordinator containment

- Extract a testable coordinator and runtime driver boundary.
- Publish the in-flight binding before the first await.
- Route start and delivery through the same single-flight operation.
- Remove generic cross-agent delivery fallback.
- Strictly parse agent identifiers.

Exit condition: the original race cannot cross agent families under every deterministic interleaving.

### Track A2 — Durable binding and fencing

- Persist the execution target/configuration, actual binding, owner device, operation ID, successor request, and epoch.
- Assign a strict server conversation sequence and fence the conversation-global delivery slot, pending-message claim, and terminal writes.
- Implement crash adoption/quarantine and reconfiguration transitions.
- Define driver-specific idempotency or ambiguity behavior.
- Gate mixed-version activation on termination of the legacy daemon boot and an upgraded-owner quiescence handshake.

Exit condition: restart, device move, reconfigure, and stale workers cannot authorize one `deliveryId` across epochs.

### Track B1 — Principal store v2

- Introduce the launcher/principal-store split.
- Add atomic open, switch, lock, purge, and scope-revocation operations.
- Add web multi-window local commit sequencing.
- Replace native blob writes with a transactional adapter or explicitly gate unsupported durability.
- Quarantine and resolve the legacy store.

Migration itself is an idempotent state machine:

```text
detected -> writes-fenced -> safe-data-copied
         -> v2-namespace-committed -> legacy-purged -> complete
```

Crashing and repeating any stage must be harmless. New code never dual-writes protected data back into the global store.

Exit condition: account switching and logout cannot render or dispatch another principal's protected state, even transiently.

### Track B2 — Typed materializer in shadow

- Implement pure transition functions and adapter transactions.
- Introduce source epochs, view membership, explicit access state, and canonical/view-owned projection separation.
- Materialize buckets and bucket assignments into a shadow v2 view while the old store still renders; compare contract-aware digests.
- Repeat shadow materialization for comments as a complete conversation-scoped view.

Exit condition: v2 shadow membership/projections equal the authoritative contracts for both slices, and stale/principal/storage fault tests pass. Writable product reads have not cut over yet.

### Track B3 — Durable commands and reference cutover

- Introduce the principal-scoped command journal.
- Add server command receipts/idempotency.
- Move bucket and comment create/update/delete flows through audited command contracts.
- Implement acknowledgment, rejection, rollback, coalescing, and degraded-storage behavior.
- Satisfy the universal slice cutover gate in Section 20 for each view and every command that can affect it.
- Cut buckets/assignments over as one complete principal view and immediately disable their old inbound writer and dispatch path.
- Cut comments over by conversation scope and disable their old inbound writer and dispatch path.
- Move one must-deliver user-message flow through the command contract as a separate durability proof; do not otherwise redesign message-window synchronization in this slice.

Exit condition: deletion, empty results, access loss, optimistic commands, and rejection converge for the reference slices without their old crawl/feed/pending paths; fault injection neither loses acknowledged local intent nor duplicates a non-idempotent server effect.

### Track B4 — Collection conformance

For each remaining collection:

1. define its authoritative domain and access result;
2. separate canonical fields from joined/operational projection;
3. select its inbound (`complete`, `segment`, or proven `delta`), storage (`canonical` or `projection`), and lifecycle (`global`, `demand`, or `prefetch`) axes independently;
4. run the same contract suite;
5. migrate behind a feature flag; and
6. delete the old correctness path after shadow equality.

For a paginated complete snapshot, pages write into a staging generation. Only a successfully completed, internally consistent crawl may atomically replace live view membership. A failed or interrupted crawl remains non-authoritative and cannot prune the active view.

Plans are the likely first canonical replicated candidate only after stripping liveness and fixing access parity. Inbox, tasks, and documents remain query-owned until their contracts are normalized.

### Track B5 — Optional ordered tail

Only begin if a measured offline-completeness requirement cannot be met by complete reactive views or scoped snapshots. Produce a separate cursor/bootstrap RFC and proof before client implementation.

### Final phase — Remove repair machinery

Delete superseded feed branches, crawls, ghost sweeps, timers, tombstones, pending-field merge logic, and raw dispatch paths slice by slice. Do not leave two correctness systems active indefinitely.

---

## 18. Validation plan

### 18.1 Authorization and principal isolation

Test:

- arbitrary foreign `team_id`, `project_id`, conversation ID, and entity ID;
- list/by-ID equivalence for owner, member, assignee, assigned session owner, removed member, and guest;
- logout while queries and persistence writes are in flight;
- account A -> logout -> guest route -> account B;
- frozen account-A tab resuming after account B has taken over;
- offline boot with matching and mismatching stored credential bindings;
- scope removal while rows are open in several views; and
- bridge-stamped legacy migration plus opaque untagged quarantine/export/abandon/purge;
- revocation of the last surviving grant while a related command is queued and while it is sending; and
- proof that revocation retires the overlay and purges protected base content without dispatching the blocked command.

The test oracle inspects disk as well as rendered state.

### 18.2 Pure local transition properties

Generate histories covering:

- duplicate complete results;
- old source epoch after scope switch;
- older entity version after newer version;
- partial omission;
- bounded page/window replacement and overlap;
- complete membership removal;
- explicit authoritative entity deletion;
- access revocation with another surviving grant;
- command plus unrelated authoritative update;
- command acknowledgment, rejection, and ABA values;
- delete with pending local command; and
- principal switch.

For paginated snapshots, crash or fail on every page and mutate the server concurrently. No incomplete staging generation may become authoritative or prune live membership.

Required properties include:

```text
apply(e, apply(e, state)) == apply(e, state)

stale(event, state) => apply(event, state) == state

caughtUp(view) && noPending(view)
  => normalize(local(view)) == normalize(server(view))
```

Retain every generated failing seed as a regression.

### 18.3 Persistence adapter contract

Run the same suite against web IndexedDB and native SQLite:

- crash before, during, and after each transaction step;
- disk-full and permission failures;
- schema upgrade interruption;
- command ordering and enumeration;
- scope purge atomicity;
- multi-window concurrent commits;
- missed broadcast recovery;
- hydration from the last complete commit; and
- storage-unavailable degraded mode.

### 18.4 Multi-client convergence

Run two or more clients with:

- concurrent edits;
- offline edits and reconnect;
- membership add/remove;
- entity scope move;
- hard delete;
- filtered view changes;
- sleep/wake and stalled subscriptions; and
- old/new client overlap during rollout.

Compare normalized local state with authoritative server views after catch-up.

### 18.5 Runtime interleavings

The harness must pause between:

- binding claim;
- durable `starting` write;
- external runtime creation;
- binding registration;
- pending-message observation;
- delivery-permit claim;
- delivery fence validation;
- external delivery effect; and
- delivered acknowledgment.

One mandatory schedule pauses a worker immediately after `delivery-started` wins, requests an epoch advance, and releases the worker only after proving the replacement epoch and every later message remained blocked. A second schedule crashes there and verifies that timeout becomes `ambiguous`, never `failed-before-effect`.

Cover message-first, start-first, simultaneous, concurrent claims, restart, start failure, driver unavailable, turn failure, reconfigure, owner-device move, stale worker, discovered legacy runtime, late epoch-N completion after epoch N+1, and crash after effect/before acknowledgment.

Parameterize over the strict agent registry and explicit wire aliases.

### 18.6 Performance

Before implementation, record numeric baselines and approve budgets for:

- cached first paint;
- selector/render latency;
- durable local command commit;
- IndexedDB/SQLite write volume;
- Convex reads and bandwidth;
- reconnect catch-up;
- multi-window propagation; and
- memory and disk growth.

The design must preserve no-network local reads and incremental persistence. A correctness abstraction that forces global rewrites or materially worsens first paint does not pass.

---

## 19. Observability and operations

Expose a development sync inspector containing no protected payload content:

- active principal-store fingerprint;
- principal gate, epoch, and server-verification state;
- storage health and schema version;
- legacy migration stage and quarantined entry count;
- active view contracts, epochs, access states, and last accepted revision/sequence;
- pending command IDs, types, ages, and lifecycle states;
- rejected stale payload counts;
- local commit sequence and cross-window lag;
- current execution binding, epoch, driver, owner device, and state; and
- last structured failure or re-bootstrap reason.

Production metrics should measure convergence delay, re-bootstrap frequency, command age, storage failures, stale payload rejection, scope purges, binding failures, and ambiguous runtime deliveries without logging user content.

Zero-tolerance signals are cross-principal hydrate/render/dispatch, automatic replay of unattributed legacy intent, unauthorized server rows, accepted-command loss, failed revocation purge, an older revision winning, and unexplained settled shadow divergence.

Timers may nudge transport liveness. Correctness must remain recoverable from durable metadata when a timer, focus event, or broadcast is missed.

---

## 20. Rollout and compatibility

1. Security fixes ship independently and immediately.
2. Existing response shapes remain immutable for supported old clients. Access envelopes, revisions, grant keys, and command receipts ship through versioned v2 query/command endpoints or an explicit negotiated protocol; an old array response cannot acquire those semantics additively.
3. V1 endpoints remain only for old-client compatibility, receive the same immediate authorization fixes, and never feed the v2 materializer. Remove them after the supported-client floor has moved past them and telemetry shows no remaining callers.
4. Principal store v2 uses a new database namespace and never writes back into the legacy store.
5. Each migrated view runs in shadow comparison before becoming the rendered source.
6. Shadow comparison uses the exact view contract and reports domain-aware differences rather than comparing global tables.
7. Feature flags are per view/command and per client platform.
8. Rollback stops new application but preserves the v2 store and command journal for recovery; it does not replay them through old unscoped dispatch. A writable slice may return to v1 rendering only after its v2 journal is resolved, or while its v2 dispatcher remains active and authoritative, so rollback cannot strand or duplicate accepted intent.
9. A legacy mechanism is removed only after the new contract owns its invariant and fault tests pass without it.

Every slice has the same cutover gate:

- its view, command, authorization, persistence, and mixed-version contract suites pass;
- principal switch, revocation, stale callback, crash, and storage-failure fault injection pass on every supported adapter;
- rollback has been rehearsed without sending v2 commands through a v1 dispatcher;
- measured first-paint, local-commit, write-volume, and Convex-read budgets are approved; and
- shadow comparison has no unexplained settled divergence for seven consecutive production days per supported platform/release channel, with low-volume paths supplemented by at least 10,000 deterministic randomized transitions.

The clock resets after a semantic contract change or unexplained divergence. A green happy-path shadow sample is not a cutover argument.

Compatibility branches must have an owner and removal date. “Temporary” dual correctness paths are not a stable architecture.

---

## 21. Rejected approaches and red flags

Stop and redesign if an implementation introduces any of the following:

- one global protected database or outbox;
- hydration based only on token presence;
- cached row presence treated as authorization;
- a hook choosing `isDelta` or deletion behavior ad hoc;
- omission from a page or window treated as deletion;
- client code rebuilding team, assignment, privacy, or comment-access graphs;
- server tombstones stored as pending local intent;
- acknowledgment inferred only from matching values;
- `Date.now()` described as a strict commit cursor;
- a generic feed hook with per-entity branches;
- raw Zustand state changes paired with a separate unjournaled dispatch;
- swallowed storage failures;
- native and web adapters sharing an API but not transactional semantics;
- a new correctness timer without a durable recovery invariant;
- a runtime fallback choosing another agent family; or
- a second runtime registry that delivery treats as authoritative.

The architecture is succeeding only if feature code shrinks and repair code is deleted.

---

## 22. Decisions made by this document

1. Convex remains authoritative; the local database remains the UI read model.
2. Protected local state is principal-scoped and fail-closed across principal transitions.
3. Explicit logout purges that principal's protected cached data before navigation; authenticated account switching fences and closes the old namespace before opening another.
4. Canonical entities and view membership are separate.
5. Complete views and deltas use different typed operations.
6. Deletion, membership removal, revocation, and pending local delete intent are separate facts.
7. Joined and time-derived fields are view-owned or operational unless canonically versioned.
8. Durable optimistic effects are journaled before publication.
9. Durable commands require idempotency and explicit receipts.
10. Storage adapters must provide real transaction semantics or declare reduced capability.
11. Complete reactive views are preferred over a generic ordered tail.
12. The existing change feed is best-effort repair, not a correctness proof.
13. Inbox and other relational projections remain query-owned.
14. Runtime binding is modeled by a durable execution epoch and one coordinator.
15. Delivery never independently chooses an agent, and one delivery ID is never authorized across epochs.

---

## 23. Remaining design reviews before each implementation slice

These are bounded implementation choices, not permission to weaken the invariants:

1. The exact stable principal-binding representation supported by the current Convex auth library for safe offline boot.
2. The concrete v2 web schema and whether native uses direct `expo-sqlite` tables or another transactional engine.
3. The canonical entity-version format for each entity admitted to shared canonical storage.
4. Server command-receipt retention and compaction policy.
5. Multi-window commit notification mechanism and recovery batching.
6. The first measured collection, if any, that truly requires an ordered offline tail.
7. Driver-specific runtime idempotency and ambiguous-delivery recovery.

Each choice needs a small ADR or contract test before its slice begins. None requires reopening the overall architecture.

---

## 24. Definition of done

This initiative is complete when:

- arbitrary client scope identifiers cannot bypass server authorization;
- no protected row, message, cursor, or command can cross principals;
- logout purges protected local state, while account switching and access revocation fence, close, or purge their exact scopes correctly;
- the legacy global cache is no longer read or written and unattributed commands are never automatically replayed;
- feature code declares views and commands without implementing synchronization mechanics;
- all authoritative persistent updates use the typed apply boundary;
- static/development guards prevent migrated code from bypassing apply, command, persistence, and delivery boundaries;
- complete views, partial results, deltas, removals, and revocations have distinct enforced semantics;
- stale sources and older entity versions cannot win;
- durable commands survive crash/reconnect without silent loss or duplicate non-idempotent effects;
- web and native pass the same advertised persistence contract;
- migrated views equal their authoritative server views after catch-up;
- the Codex/Claude race and every cross-agent equivalent are impossible under deterministic interleaving;
- one delivery ID cannot cross execution epochs or owner-device fences;
- superseded crawls, sweeps, feed branches, pending merge rules, and unjournaled dispatch paths are deleted; and
- cached first paint, local read performance, and offline interaction remain first-class product behavior.

The final system should be explainable in one paragraph:

> Convex owns authoritative facts and access. Each authorized server view updates one principal's local materialized state through a typed transaction that knows whether it is replacing a complete view or applying a proven delta. Local commands are durably journaled and projected optimistically until an explicit server receipt reconciles them. UI code reads reactive local selectors. Separately, one execution coordinator binds each conversation epoch to exactly one requested runtime family, and delivery consumes that binding rather than guessing.

---

## 25. Code map for the first implementation pass

The following files are the primary current boundaries to replace or wrap:

- [`packages/web/store/inboxStore.ts`](../../packages/web/store/inboxStore.ts) — normalized state, hydration, sync application, pending state;
- [`packages/web/store/syncProtocol.ts`](../../packages/web/store/syncProtocol.ts) — current value-based pending merge;
- [`packages/web/store/mutativeMiddleware.ts`](../../packages/web/store/mutativeMiddleware.ts) — optimistic actions and current outbox;
- [`packages/web/store/idbCache.ts`](../../packages/web/store/idbCache.ts) — global web persistence;
- [`packages/web/store/idbCache.native.ts`](../../packages/web/store/idbCache.native.ts) — native KV persistence;
- [`packages/web/store/clientSyncRegistry.ts`](../../packages/web/store/clientSyncRegistry.ts) — currently conflated persistence/local-first/dispatch capabilities;
- [`packages/web/hooks/useSyncChangeFeed.ts`](../../packages/web/hooks/useSyncChangeFeed.ts) — best-effort timestamp catch-up;
- [`packages/web/hooks/useSyncBuckets.ts`](../../packages/web/hooks/useSyncBuckets.ts) — first complete-view candidate;
- [`packages/web/hooks/useConversationComments.ts`](../../packages/web/hooks/useConversationComments.ts) — first scoped complete-view candidate;
- [`packages/convex/convex/changeLog.ts`](../../packages/convex/convex/changeLog.ts) and [`changeFeed.ts`](../../packages/convex/convex/changeFeed.ts) — current non-strict invalidation feed;
- [`packages/convex/convex/data.ts`](../../packages/convex/convex/data.ts) — current scoped/unscoped data gateway requiring fail-closed separation;
- [`packages/convex/convex/lib/access.ts`](../../packages/convex/convex/lib/access.ts) — canonical access seed requiring domain parity;
- [`packages/convex/convex/pendingMessages.ts`](../../packages/convex/convex/pendingMessages.ts) — current message claim boundary requiring epoch permits;
- [`packages/cli/src/daemon.ts`](../../packages/cli/src/daemon.ts) — current duplicated runtime resolution and fallback paths; and
- [`packages/shared/contracts/agentClients.ts`](../../packages/shared/contracts/agentClients.ts) — shared agent registry and currently permissive normalization.

The first code change after approval should add failing security and deterministic interleaving tests, not a broad synchronization subsystem.
