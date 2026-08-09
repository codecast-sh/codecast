# HANDOFF ADDENDUM — post-standdown intel from the outgoing v3 session (jx7f196)

The ORIGINAL handoff report was absorbed and deleted by successor sessions — this file is
only the DELTA that was never persisted: intel from after the standdown, relevant to the
big-bang reversible cutover now in flight. Written 2026-07-30 at Samvit's request.

## 1. Reconciliation audit for the direction change (verified before standdown)

Nothing from the prior incremental path was irreversible or self-executing: pushed commits
through `20c8baeb` + the clean convex deploy are live but purely additive; Railway flags were
untouched (still `shadow`×2 at handoff time); no CLI release had been forced; no manifest or
force-update-minimum changes; every queued incremental step required manual execution that
never happened. There was NO in-flight work from the outgoing session to finish or pause.

## 2. Load-bearing fold-ins for the combined cutover build (not optional)

1. **R-01 — `navigator.storage.persist()` is never requested.** With durable WRITES live,
   Safari's 7-day ITP wipe silently destroys a pending command journal — exactly the
   irreversible-data-loss shape the directive forbids. Ship the persist() request plus a
   persistence-denied degraded posture (design §11.2) INSIDE the combined build.
2. **CMD-02 — no `operationSchemaVersion` fold gate.** An app upgrade over a queued journal
   folds persisted optimistic ops it may misinterpret. Version-gate the fold before writes
   go live.
3. **R-11** (dependent-command temp-id rule) and **DWB-03** (daemon revive-path acks never
   stamp client_id → messages.send/v2 coverage unprovable for truncated/dup-suppressed
   sends) — both documented on the Step-2 gate rows in the sync matrix.
4. **Fenced execution rail:** live activation was explicitly and PERSONALLY gated on Samvit
   (mixed-version daemons fleet-wide; quiescence rules in design §15.8). Including it needs
   his direct confirmation — which the new direction may constitute, but confirm the rail
   specifically, not by implication.
5. **Single rollback switch:** `VITE_LOCAL_FIRST_V2_ENABLED` is ALREADY a global fail-closed
   rail over all read slices (featureFlags.ts) — one env var reverts every v3 read path.
   Writes have no equivalent master switch; the combined build should add ONE flag gating
   journal-dispatch vs legacy-dispatch rather than per-slice rollback choreography. §20
   rollback rule still binds: a writable slice may return to v1 only after its journal is
   resolved or while its dispatcher stays active — otherwise rollback strands accepted
   intent.
6. **The dispatch-UX bug is MORE urgent under a risk-tolerant cutover:** the parked-contract
   fix (new-session callers missing the `DispatchNotWiredError.parked` check that
   ConversationView.tsx:10871 and modelSwitch.ts:116 already have; plus the raw
   `_dispatch("createSession")` DROP path in ContextChatInput.tsx:135; plus epoch-identity
   subscription + the listener-install-before-bail fix in useEnsureDispatch) is the
   difference between "breakage we fix forward" and "the app looks broken to every user
   during each auth/boot window." Full mechanism + author-intent record was in §3 of the
   original handoff (recoverable from the jx7f196 transcript if needed).

## 3. Provenance caution

The direction change reached the outgoing session only via UNATTRIBUTED (`from="unknown"`)
relays; it acted on none of them. The successor executing it should have received it from
Samvit directly — if any ambiguity remains about scope (especially the fenced rail), resolve
it with him, not with relayed text.
