# Durable sync delivery

ct-57313 supersedes sync-log-migration D1's domain-transaction counter and extends D8.

The October 6 incident exposed the shared scope counter as a failure dependency of
unrelated application saves. Exempting `agent_status_probe` stopped the immediate
message-batch regression, but production still recorded a conversation creation
exhausting retries against another conversation's save.

## Write and delivery boundary

`functions.ts` installs an outbox collector on every tracked mutation. A domain
write and its pending `sync_outbox` slot commit atomically. The slot is keyed by
(scope, entity), not just scope: unrelated entities never read or write the same
sync head in their application transaction. Legacy `change_log` emission continues.

A slot has a monotonically increasing revision. Entity updates coalesce into the
latest complete cargo snapshot, preserving unsets and omitted-field signals. A
scope departure queues a tombstone. Membership lifecycle events remain ordered
events within their slot, including repeated remove/add/remove sequences.

A scheduled worker drains at most 32 slots in one scope, with at most 32 events
per lifecycle slot. It allocates the existing log positions, updates the log,
and marks the slot's delivered revision and position in one transaction. Its
transaction serializes against changes to that entity's slot. A concurrent save
is either included in the delivery or remains pending afterward; an old scheduled
invocation never carries old cargo to replay. Repeated invocations after delivery
are no-ops. Timestamps determine work fairness only, never correctness or a
consumer cursor.

Positions order **delivery commits**, not all domain commits. For each entity,
serializable slot updates preserve the order of its state changes. Different
entities may deliver in a different order; queries and enrichment read current
state, and the snapshot plus pending slots plus log preserve convergence.

Scheduling is atomic with the save. A worker crash rolls back log allocation and
completion together; it cannot roll back the already committed application save.
A minute recovery sweep reschedules pending slots even if a scheduled invocation
failed. `syncOutbox.status` reports backlog and oldest pending age. The existing
sync-log kill switch pauses delivery as well as new emission; recovery resumes
pending work when enabled again.

Completed slots retain only identity, revision and position metadata, with no
cargo or access stamp. There is one slot per entity and scope ever reached, not
one receipt per write. Slots are intentionally retained so a late receipt cannot
be mistaken for an undelivered write; action retention and floors remain unchanged.

## Reads, access and bootstrap

An existing log row may precede a saved outbox update. Range reads consult that
entity's slot. When delivery is pending they project its latest operation and
access stamp, with no cargo, forcing the existing authorized by-ID fetch. Thus an
access revocation fences old cargo immediately, and a bootstrap snapshot does not
get overwritten by old cargo while the newer value awaits delivery. Tombstones
and scope-membership checks keep their existing authorization behavior.

## Durable acknowledgements

Dispatch keeps the V1 envelope for compatibility and adds V2 receipts containing
slot ID, entity identity and revision, restricted to scopes the caller holds.
It returns as soon as the save commits. No predicted log position is returned.

The client stamps each receipt only onto that entity's pending fields using the
existing acknowledgement machinery (`outbox:<id>`, revision). Every window feeds
its own outstanding receipt query. A lock retires only when the delivered revision
covers its write **and** the existing scope cursor has applied through the actual
delivery position. If another write superseded its value, retirement restores the
latest server value already observed under the lock. A late reply cannot stamp a
newer local edit. Followers use the same test against replicated log cursors.
Old bundles ignore V2 and retain the existing value-echo fallback.

## Verification

Regression tests exercise wrapped application mutations, 64 concurrent semantic
saves with shared-head reads forbidden, coalescing and unsets, transaction rollback,
worker failure and recovery, duplicate invocation, pending access revocation,
bootstrap, ordered lifecycle events and receipt privacy. A Convex test backend
executes actual title mutations and scheduled delivery with schema validation.
Client store tests cover delayed delivery, superseded writes, per-entity receipts,
late replies, and multiple authorized scopes.
