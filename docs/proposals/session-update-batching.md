# Routine session updates: batching proposal

Status: proposal only. Tracked by pl-547 / ct-49363. Sender-identity fixes are tracked separately by ct-49362 and ct-49361.

Add `cast send --update` for routine progress. Save updates immediately, let the recipient finish its turn, and deliver a bounded group as one input. Keep each update's author, timestamp, ID and complete text. Ordinary sends keep their current delivery behavior.

## What caused the wording and unknown sender

The migration coordinator, jx70p9m, wrote “The user authorized this inline migration…” into `/tmp/codex-fleet-brief-rest.sh` on September 4, 2026 at 20:19:21 UTC. It was a generated, one-off briefing script; a search of product code, documentation and agent scripts found no template inserting that sentence.

[The actual user instruction](https://codecast.sh/conversation/jx70p9mcb2b6mmzjf1b3zw8w758dsfgc#msg-k17fdz43j4x77c5gzr36h1k0bn8dsn3x) was: “ok - i want you to switch them over to codex (inline not fork) do you have that ability? test on one and confirm it works and then drive them all to completion”. The coordinator paraphrased a real instruction. That paraphrase should not substitute for the original instruction when another session needs to establish scope.

The script sent nine briefings from detached tmux without `--from`. Its saved log contains nine “sender session not detected” warnings. Separately, `sessionIdFromEnv` did not recognize the native `CODEX_THREAD_ID`; another wake in jx77bkw explicitly reported having that variable while Cast failed to detect its sender. The exact environment of the historical tmux process was not retained, so the missing variable support is a reproduced code gap, not a claim about that vanished process's environment.

Future handoffs should state the concrete work: “Continue the existing AI-context task. Reconcile completed work before resuming. Source request: [link].” Detached scripts should carry `--from <sender>` explicitly. Preserve historical messages and logs. Do not strip arbitrary phrases from user text or relabel agent text as human input.

The local CLI now recognizes `CODEX_THREAD_ID`, uses its own-session resolver for `cast send`, and refuses a missing sender before posting. Explicit `--from` still works. The existing raw slash-command path is preserved. The collaborating session jx79k7y added a server rejection for supplied but unresolved native sender references, and fixed the separate dashboard path that mislabeled a person's input as an unknown session. It reported production verification of the named human wrapper and deployment of the server guard.

These are provenance fixes. We still cannot identify the exact trigger of the provider's safety stop. The monitor is asynchronous, so the last visible message alone does not establish cause. [OpenAI's misalignment-monitoring guidance](https://developers.openai.com/api/docs/guides/safety-checks/misalignment-monitoring).

## User-facing contract

```bash
cast send jx7c6zk --update "Typecheck passed; no remaining edits."
cast send jx7c6zk --from jx7abcd --update - <<'END'
Review finished.
The remaining issue is the retry timeout.
END

cast send jx7c6zk "I need your answer before changing the schema."
```

The sender selects the mode. Do not infer it from wording, use a model classifier, or silently change today's `cast send` default. `--update` means no immediate answer is needed. Requests, blockers requiring a reply and urgent coordination use ordinary send. Human composer input and slash commands never enter the update mailbox; reject `--update --raw`.

| Recipient state | Routine update behavior |
|---|---|
| Working or executing a tool | Save it; do not steer, interrupt or start another turn. |
| Live, idle and ready | Collect until two seconds after the oldest waiting update arrived, then deliver one batch. |
| Turn just completed successfully | Deliver after the later of that boundary and the oldest update's two-second deadline. |
| Waiting for permission, a human answer or a queued decision | Keep waiting; finishing a model turn does not resolve the human dependency. |
| Safety-stopped, failed or interrupted | Hold visibly. Updates do not clear the stop or resume the agent. |
| Offline, hibernated or killed | Save it without launching or reviving the session. Reconsider after a separately authorized wake. |
| Stashed or hidden, but still live | Process when ready while preserving its inbox placement. |
| Runtime readiness unknown | Hold until current runtime evidence establishes readiness. |

The two-second window is fixed at the first arrival; later messages cannot keep extending it. There is no timeout that turns routine traffic into an interruption. The initial defaults are proposals: at most eight updates and 16 KiB of encoded input per batch, at most 8 KiB of body per update, and a per-recipient backlog of 128 updates or 256 KiB. Check that a single update also fits after envelope encoding. Reject excess before insertion with a clear error; never truncate or silently discard accepted work. Keep exact UTF-8 text, including code and whitespace.

Normal sends bypass the mailbox and its delay. They win admission when already queued before a batch starts. Once a batch has started delivery, a later human message uses the existing input/steering behavior; we cannot retract an input already issued to the provider.

## Why a separate mailbox is necessary

Today's daemon serializes a delivery attempt, not the recipient's complete model turn. `conversationDeliveryActive` is released after `deliverMessage` returns. The app-server driver reports delivery after `turnStart` accepts input; the model may still be working. The fenced runtime's `drain` similarly loops over successive delivery receipts without waiting for turn completion.

The fenced server queue assigns a conversation sequence at enqueue and admits the first nonterminal row. Adding a “wait until idle” flag to that head would block later ordinary requests behind it. Concatenating existing pending rows is also unsafe: receipt matching, cancellation and retry currently refer to individual rows.

Use a durable update mailbox outside that FIFO. Allocate one normal delivery only when a ready runtime can start the batch. Reuse the existing fenced delivery protocol for the resulting input; do not introduce a second transport.

## Data and API changes

Add a `session_updates` table with:

- Destination conversation, target owner, authenticated sending user, resolved source conversation, source short-ID snapshot, server arrival sequence and timestamp.
- Caller request ID and immutable body. Deduplicate on authenticated sender + destination + request ID. A repeated ID with different content fails; two identical texts with different IDs remain two updates.
- State: `queued`, `batched`, `delivered`, `cancelled`, `rejected` or `ambiguous`; optional batch delivery ID and receipt/echo reference.

Add one small mailbox-head record per destination for its next arrival sequence, waiting count/bytes and oldest deadline. Index updates by destination/state/sequence, sender/request ID, and batch ID; index mailbox heads by owner and eligibility. Keep scheduling metadata separate from inbox work-state labels and from the delivery FIFO head.

The existing `pending_messages` row represents a frozen batch. Add optional batch membership IDs, a format version and an explicit routine-update origin. Its existing client/delivery ID is the batch ID. No separate per-member pending-message rows exist. Group a contiguous arrival-order prefix from the same authenticated sending user: this preserves the parent row's existing `from_user_id` semantics while combining that person's many agent sessions. Different users remain separately attributed batches. An outer batch has no invented source session; each member carries its actual source.

Expose an additive endpoint for `--update`, with a stable request ID supplied by the CLI and returned in its receipt. Require a resolved source session for this mode; do not use the legacy unverified short-ID fallback. Reuse target send-access checks. Revalidate destination access and source ownership at admission because a queued update can outlive an access change. Reject revoked members individually and leave an inspectable receipt. Do not change session ownership, clear safety state, unhide or wake a session when saving an update.

Return “queued update …; waiting for turn completion / idle window / runtime readiness” rather than “sent”. Add a payload-free status lookup and cancellation for the authenticated sender or target owner. Cancel only while `queued`; after assignment return the batch's actual state instead of pretending a member can be removed from an already frozen input.

## Scheduling and atomic admission

Begin with Codex app-server runtimes that advertise both reliable turn-readiness reporting and fenced delivery support. A generic heartbeat, “connected” status or inbox label is insufficient.

1. Record a runtime readiness generation tied to the binding epoch, daemon boot ID and thread. Successful completion advances it to ready only after final messages, safety errors and human-wait state have been reconciled. Turn start, stop, approval wait, disconnect or ownership change invalidates it. Stale callbacks cannot mark a newer turn ready.
2. A server deadline wake and a successful-turn callback both request the same drain. These are idempotent readiness checks; neither directly starts the model. Persist the deadline and use a bounded reconciliation sweep so a lost timer or restarted daemon does not strand the mailbox.
3. Under the runtime's per-conversation effect lock, prove that the exact thread is still ready. The control plane checks the current binding, readiness generation, safety state, human dependency and absence of ordinary pending work or another active delivery.
4. In one bounded transaction, choose the oldest eligible contiguous sender prefix within the limits, freeze its text/membership, create one pending delivery, obtain its normal delivery permit, and transition it to delivery-started. Consume the readiness generation in that transaction. Reuse the existing enqueue/claim/start helpers with a routine origin that preserves stash/kill semantics. This transaction is the priority boundary: an ordinary send committed first prevents batch admission.
5. Pass the started permit and frozen input through the existing coordinator, journal and driver. Return after one batch. The next successful model-turn completion, not merely the delivery receipt, allows another batch. Give each admission a stable operation key derived from the binding and readiness generation, so retrying a lost mutation response returns the same batch/permit for reconciliation.

Refactor the fenced drain entry point so ordinary work and this batch-admission path share the same effect lock; a side listener calling `turnStart` would create a race. The runtime must check its local generation immediately before dispatch too. If no effect occurred, record that through the existing before-effect failure path; if the outcome is uncertain, preserve uncertainty.

A stored idle generation from an earlier daemon boot is never reusable. On restart, first adopt and inspect the exact runtime under the existing ownership fence. If readiness cannot be established, show “waiting for runtime readiness”. Do not clear a safety stop, create a replacement agent, or resume a thread just to flush updates.

## Input format, receipts and failure handling

Encode one versioned batch envelope containing a JSON array of `{id, from, sent_at, body}` records. Escape delimiter characters in the encoded JSON so a body cannot manufacture another envelope member. Decoding must reproduce each body byte-for-byte. The concise envelope identifies routine agent updates; it must not add approval claims or instruct the recipient to ignore safeguards. Single ordinary sends retain their current format.

Render from the stored structured members, not from sender-like strings inside their bodies. Attribution describes where a message came from; it does not establish a separate agent authority model. This proposal does not turn the current caller-supplied session reference into a cryptographically authenticated agent principal.

One batch has one delivery attempt and one receipt. Atomically project that outcome to its members. Extend both fenced completion and any supported transcript-echo adoption path to use the batch relationship; do not independently content-match and acknowledge each body. “Delivered” means accepted as input, not read, understood, answered or acted on by the agent.

| Failure | Required outcome |
|---|---|
| Repeated CLI submission or duplicate scheduler callback | Return the same request/batch receipt; no extra members or delivery. |
| Crash before admission commits | Updates remain queued. |
| Crash after admission, before or during the provider call | Recover through the existing journal/fence; never create a new batch merely because a timeout elapsed. |
| RPC timeout after possible acceptance | Mark batch and members ambiguous; retain text and evidence, with no blind resend. |
| Proven failure before any effect | Terminalize the batch as rejected and release its delivery slot. Keep members, text and the reason visible. An explicit resend uses new request IDs; do not leave a retrying batch ahead of ordinary requests. |
| Safety failure after admission | Preserve the first safety evidence, batch and members; no automatic retry, account switch or wake. |
| Binding epoch changes | Reconcile the old batch's real outcome before any replacement delivery; never return ambiguous members to the free mailbox. |
| Duplicate or late transcript echo | Associate once with the batch ID, never mark a later identical update delivered. |

A repair sweep may reconcile member projections from the authoritative batch outcome. It cannot turn “unknown” into “delivered”. Existing transport ambiguity can still hold the delivery queue; bypassing the batching delay does not override that safety boundary. There is no unconditional exactly-once claim about provider effects.

## Visibility and rollout

Show one compact “5 updates waiting” indicator with the reason for waiting. Expanding it lists each sender, timestamp, body and receipt state. After delivery, show one expandable batch in the transcript with its individual members. Preserve typed-human messages as person messages. Do not generate acknowledgment messages between agents for every saved update.

All rendered mailbox/batch data goes through the existing local store. Register collections and feeders in `clientSyncRegistry.ts`, bump the cache schema, use host-gated global feeders and optimistic cancellation actions. Apply the same access filtering and cache revocation rules to previews and full bodies. Counts for queued updates must not reuse `has_pending_messages` in a way that falsely marks an offline session as actively working.

Implement in four reviewable steps:

1. **Contracts and backend:** immutable mailbox, deduplication, limits, access, status/cancel API, batch projection and routine origin. Feature remains off.
2. **Runtime:** exact readiness generation, durable deadline reconciliation, atomic batch admission, shared effect lock and receipt recovery. Enable only in an isolated Codex app-server pilot with the fenced runtime verified.
3. **CLI and visibility:** `--update`, accurate queue receipts, expandable members, web/mobile parsing and store integration. Capability mismatch returns an explicit unsupported error; never silently downgrade to ordinary send.
4. **Pilot and expansion:** first observe eligibility without delivery, then opt in selected sessions. Extend to other transports only after their turn-completion and ambiguity behavior pass the same tests.

Deploy additive backend support through `packages/convex/deploy.sh` before clients that call it. Enable by capability after the matching daemon is installed. Rolling back disables new batch admission, retains accepted updates and lets existing started attempts reconcile; it must not unpack the mailbox into an immediate-send storm.

This reuses the durable-event direction already described by pl-519 / ct-48956. It does not start that backlog task or require implementing the entire Agent Organization proposal. Runtime work must coordinate with the active delivery owner before touching `daemon.ts`, `execution/runtimeRail.ts` or `executionBindings.ts`.

## Acceptance tests and pilot evidence

Use deterministic clocks and the real mutation/driver boundary with a fake provider. Cover busy bursts, the fixed idle deadline, a turn ending before the deadline, continuously arriving updates, and one batch per model turn. Prove ordinary requests committed before admission take precedence, and a request arriving after admission cannot cause a duplicate batch.

Exercise concurrent senders, alternating authenticated users, identical bodies with distinct IDs, request-ID reuse, exact Unicode/code round trips, all size limits, cancellation races, revoked access and owner changes. Test approval waits, explicit human questions, stopped/hidden/hibernated sessions and safety failures both before and after admission.

Restart at every boundary: before commit, after permit, before provider call, after possible acceptance, after receipt and before member projection. Verify stale daemons and duplicate turn-completion events cannot send. Confirm ambiguous attempts stay visible without retries, and legacy runtimes reject batch envelopes rather than delivering members separately.

Browser verification must cover queued/held/delivered/ambiguous indicators, preserved attribution, reload persistence, optimistic cancellation, follower-window replication and mobile layout. Run the coordinated repository gate in an isolated environment before shipping.

Measure accepted updates per actual provider input, oldest eligible waiting age, hold reason, duplicate/ambiguous attempts and normal-message latency. Example acceptance: five updates from one user's sessions during a busy turn become one subsequent input with five intact members; an isolated idle update becomes eligible at two seconds. Offline or human-blocked time is reported separately from scheduling latency. A reduction in interruptions is the success measure; fewer safety flags would be an observation, not proof that batching fixed their cause.

## Verification of the sender fix

Forty-two focused tests pass across native identity, command parsing, stdin preservation and CLI-to-real-enqueue/claim/ack behavior using an in-memory database. A narrow CLI TypeScript check passes. The initial test run exposed a parameterization error in one test; that test was corrected and its command suite rerun successfully. No live agent or provider was messaged by these tests.

The CLI changes are local source changes; this session did not release or activate them. The collaborating human-attribution session verified a real recipient against the production backend and browser rendering with its changed client; its web/mobile changes remain uncommitted and still need release. Mobile was typechecked, not exercised on a device. Its backend guard is deployed. That session also reported that its deploy removed three repository indexes absent from origin/main and notified their repository owner, jx759wb; that separate integration issue is not covered by this verification. The broad repository gate remains with the existing shared-runtime coordinator; it is not claimed clean by these focused results.
