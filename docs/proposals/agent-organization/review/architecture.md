Agent Organization architecture review — pl-519 / ct-48816

The durable-role idea is useful, but the proposed enforcement is not sufficient to support its safety claims. Ship supervised coordination first. “Locked” labels in the draft establish no authority: only explicit user decisions are binding. Everything below is a proposed replacement contract, except the source findings explicitly identified as existing.

Reviewed both requested drafts against the working checkout at HEAD `54cd65c71`, which contains substantial uncommitted work. These findings describe inspected source, not deployed behavior. No performance or cost baseline was measured.

**Existing implementation.** Anchors currently support team/user scopes, host-owned conversations and a separate display identity (`packages/convex/convex/anchors.ts:281`, `schema.ts:813`). `daily_session_cap` is declared but has no enforcement reference; the proposed role grants, `reports_to_anchor_id`, rotation epochs and `usage_daily` are absent from the inspected backend. The survey correctly identifies accounting as new work.

CLI token verification returns a user and token ID, not a session principal (`platform/packages/auth/src/convex/apiTokens.ts:49`, re-exported by Codecast). `sessionDecisions.ask` accepts a caller-supplied session ID and checks host ownership; `resolve` instead authenticates the web user (`sessionDecisions.ts:29,276`). Existing decision answer delivery is a separate client operation (`packages/web/store/inboxStore.ts:7180`), not an atomic server answer-and-deliver operation.

`AccountsHeartbeatPayload` reports account profiles and quota snapshots, not per-session cost (`packages/cli/src/ccAccounts.ts:1547`; header parsing at `:762`). Messages have optional model/token usage (`packages/convex/convex/schema.ts:979`). Missing usage is possible; account utilization cannot allocate spend among simultaneous sessions.

Native runtimes directly launch detached Claude/Codex processes (`packages/cli/src/agents/runtime.ts:283,344`); the orchestration skill also invokes native `Agent` (`packages/cli/orchestration/skills/orchestrate/SKILL.md:63`). Daemon linking is retrospective (`packages/cli/src/daemon.ts:7301`). These are not pre-launch admission controls.

**1. Authenticate execution principals; do not infer authority from attribution.**

`assertHumanActor` cannot trust an optional conversation ID, `acting_user_id`, environment variable or host credential. An agent holding the host token can omit its identity or name another host-owned session. Device identity also does not distinguish the human from software on that device.

Introduce server-issued execution capabilities bound to `{role_id, session_id, epoch, workspace, allowed_operations, expiry}`. Every managed mutation derives the actor from that capability and checks current grant, resource access and epoch in the transaction. Missing/stale capabilities fail closed. Legacy host tokens must not provide an alternative route to the same managed privilege.

Capabilities only work if agents cannot obtain stronger credentials. Managed execution therefore requires an isolated runner without the human’s configuration, browser session, production secrets or unrestricted host filesystem. Human approval uses a separately authenticated channel inaccessible to that runner; browser authentication alone is not proof of human intent when the agent controls that browser. Until this separation exists, label local orchestration cooperative, not bot-proof. Host ownership remains billing/operation metadata, never proof of agency or human presence.

**2. Enforce concrete operations, not a guessed decision class.**

An asker choosing `approach` and avoiding a keyword list can describe any forbidden action. A decision answer also cannot prevent a shell deployment or purchase performed outside Codecast. Keywords may warn; they cannot authorize.

For managed actions use a typed request with operation, target, arguments hash, policy version and expiry. The execution gateway requires matching authorization and revalidates current access immediately before execution. Human approval grants only that request; generic prose answers grant no additional capabilities. Disable unsupported privileged tools and credentials in the runner. Free-text approach/retry/split discussions remain recommendations; ambiguous, taste and protected requests reach a human. An override starts a correction request, never assumes completed external effects can be undone.

Persist answer transition, audit entry and delivery-outbox record atomically, with expected decision version and assignee epoch. Deduplicate answers by decision/version. Do not merge requests merely because normalized questions match: targets, options, access scope and policy version must also agree. Prefer no cross-session collapse in v1.

**3. Separate measured usage, estimated cost and admission reservations.**

Heartbeat deltas arrive after spending. Two sessions can pass the same remaining balance, then both overspend. Spawn/send checks also miss autonomous continuation, triggers, direct provider calls and already queued turns. A highest-known-model price is not an upper bound for an unknown model. Account subscription utilization is neither session cost nor marginal dollars billed.

Keep idempotent usage events keyed by execution/request identity and revision, recording provider, model, billing mode, pricing version, provenance and coverage. Handle cumulative counters, replay, resets and transcript edits explicitly. Missing usage stays unknown. Attribute cost to the scope and ancestor path at admission; rebinding future work must not rewrite historical charges. Preserve raw token quantities and estimates separately from authoritative charges; distinguish quota health from cost.

A hard monetary cap requires a mediated provider request with a defensible maximum charge. Before dispatch, atomically reserve that bound against every applicable budget; allow only `settled + reserved + requested <= cap`. Settle exactly once, release unused funds and retain uncertain liabilities until reconciled. Retries and tool/model calls need their own coverage. Decline before dispatch; finishing an admitted request remains covered. Providers without bounded charging or enforceable mediation cannot offer this contract. V1 should expose soft spend thresholds and hard managed-run admission counts, explicitly excluding a universal dollar guarantee.

**4. Admit execution before it exists; keep ancestor state transactional.**

Rewriting `cast plan orchestrate` through `cast spawn` closes one path, not native harness children or arbitrary subprocesses. Counting at `linkSessions` records a violation after resources are consumed. A wrap-up wake may itself consume more resources.

Managed launch must first commit an idempotent reservation and durable launch command. Count reserved, starting, running and uncertain runs against role ancestors and device capacity; heartbeat liveness alone must not free capacity. A dispatcher claims the command with a lease/fencing token, launches once per execution ID, and reconciles crashes. Expired leases do not prove the process stopped: confirm termination or retain its capacity charge. Disable native child spawning unless the adapter reserves before creation; otherwise classify that harness as observational only. Apply admission to all managed entrypoints, including triggers, refills and resumes that allocate capacity.

Daily launch counts increment in the admission transaction, never from later heartbeats. Shared ancestor reservations must serialize; an index on direct reports does not count descendants. Start with bounded ancestor walks and authoritative counters. If contention becomes material, introduce transactional quota leases, not eventually consistent admission totals. Define one budget-window timezone per policy. Child limits do not override an ancestor ceiling; raising only a child above it has no effect.

`tasks.update` permits multiple conversations to link and checks only each conversation’s current binding (`packages/convex/convex/tasks.ts:1530,1562`). That is not an exclusive task claim. Add a single active execution claim with version, claimant, lease and fencing token. Claim, task transition, capacity reservation and launch outbox commit together. Completion/reassignment validates the claim version. Separate observer/reviewer links from the executor; retries with one request ID cannot increment attempts twice.

**5. Keep provenance, reporting and authority independent through rotation.**

The draft explicitly repoints `spawned_by_conversation_id` during fill, contradicting its provenance contract. Existing `linkSpawnedBy` only fills an absent origin (`packages/convex/convex/conversations.ts:11254`). Preserve that immutable creator edge.

Use durable role IDs for reporting and derive inbox grouping from the role’s current session. Never use provenance or grouping as a stop/access grant. Record management enrollment separately from human ownership: current role sessions are themselves host-owned. Human-started sessions retain inbox placement and notification delivery; association with a managed task is not consent to remote control.

Rotation atomically advances the role epoch and current session reference. Every privileged write, claim, delivery acknowledgment and dispatch validates that epoch, not just `cast state`. Old executions cannot regain authority by resuming. Handoff is useful context, not the prerequisite for recovering a dead manager. Resolve scope from canonical work-item relationships, validate same-workspace edges, cycles and depth, and version topology changes. Denormalized reporting pointers are caches; stale pointers cannot authorize writes. Freeze active reparenting in v1.

**6. Make wakes durable events with at-least-once acknowledgment.**

`enqueuePendingMessage` deduplicates by conversation and client ID (`packages/convex/convex/pendingMessages.ts:365`). Therefore `settle:<conversation>` suppresses later independent settles; `entity:<type>:<id>` suppresses later versions. An in-row array capped at 50 lacks overflow, acknowledgment and recovery semantics.

Persist each committed event and target role using a unique identity such as `{entity_id, transition_version, event_kind, recipient_role_id}`. A transactionally checked unique key distinguishes replay from a new event. Coalescing creates a delivery batch referencing events; it does not erase them. Keep batches immutable after dispatch. Use leases, retries, backlog pagination and explicit overflow alerts instead of silent drops.

Retain events until a fenced consumer acknowledgment durably records processing. Existing delivery acknowledgments are transport machinery, not proof that the manager acted (`pendingMessages.ts:1650`). Delivery is at least once; handlers must be idempotent. Rotation reassigns unacknowledged work by role and epoch, rejecting late acknowledgments from old sessions. Decision transitions remain durable even if a wake is lost. Exhausted turn budgets queue work or escalate via a non-model notification path; “never dropped” does not mean unlimited free decision turns.

**7. Privacy must constrain inputs, summaries and destinations.**

Conversations do not have the draft’s assumed stored workspace key. Use canonical conversation access/visibility, and use stored workspace access for work items; routing `team_id` grants nothing. Existing insights already check source-conversation access and avoid assigning a private source’s routing team to generated content (`packages/convex/convex/sessionInsights.ts:235,612`). Preserve those protections.

Compute a digest only from records readable by the recipient principal within its authorized subtree. Apply the same checks to headlines, counts, costs, decisions, handoffs, notifications, search, exports and sync. A team-visible parent must not receive a private descendant summary. Restrict derived artifacts to the intersection of source audiences, or regenerate from inputs safe for the destination. Recheck visibility when queued output is delivered and invalidate cached projections after revocation. Never send a broad digest to a model and redact only its final prose. Read isolation belongs before the first role wake, not phase 3.

**8. A feasible v1 is supervised and deliberately bounded.**

Start with one human-commissioned plan lead per opted-in plan, durable role identity, explicit enrollment, task claims, read-scoped digests, event inbox and human decision queue. Reuse anchors, the pending-message rail and local-first collections, but permit dedicated execution, reservation and event records: “only one new table” is an arbitrary constraint. Keep management topology fixed during active execution. Allow manual vacancy recovery with epochs; defer automatic commissioning, recursive delegation, auto-rotation, cross-scope summaries and automatic worktree deletion.

Enable mutating coordination only for an isolated adapter satisfying the principal and admission contracts; legacy local sessions can provide observational reports and recommendations. This delivers useful coordination without pretending the entire workstation is governed. Organization pages can show future hierarchy without enabling recursive authority.

Acceptance requires adversarial integration tests for forged/omitted identities, protected-operation bypass, concurrent ancestor admissions and task claims, crash-before/after-launch recovery, duplicate/new-version wakes, acknowledgment loss, rotation races and privacy revocation. Source-pattern guards supplement those tests. Preserve local-first reads and optimistic actions, but reconcile rejected claims visibly.

Remove invented baselines, calendar promises and guaranteed inbox/load reductions. Instrument actual queue pressure, wake delay, replay count, unknown-cost coverage and overrides before proposing defaults. A 30-answer override sample is not an ablation study or safety proof. Roll out capability-by-capability behind explicit gates; migrate existing sessions as unmanaged, not silently trusted.

**Top 8 corrections**

1. Replace caller-supplied identity with isolated, scoped execution credentials.
2. Authorize typed operations; treat labels and keywords as routing hints.
3. Separate accounting from reservations; withdraw universal hard-dollar-cap claims.
4. Gate managed launches before creation; transact ancestor quotas and exclusive task claims.
5. Preserve immutable spawn origin; fence every rotating role operation by epoch.
6. Persist versioned wake events with deduplication, retry and processing acknowledgment.
7. Enforce source and destination privacy before every digest or wake reaches a model.
8. Ship supervised plan leads first; replace guessed baselines with measured rollout evidence.
