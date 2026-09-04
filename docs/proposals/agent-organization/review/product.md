# Product review — Agent Organization

Reviewed the brief and sections 1, 2, 7 and 9 for pl-519 / ct-48816. These are proposals, including passages called “locked.” Cross-referenced sections were not reviewed; code claims are not independently verified.

The valuable product is a project lead that carries context, resolves routine blockers and verifies delivery. Durable identity, explicit authority and visible escalation support that. A three-level organization is an unproven expansion. Ship one useful lead before optimizing an org chart. Fewer visible cards can mean less oversight without less work.

## 1. Deliver something in the first ten minutes

Sections 1 and 7 promise that creating a lead will “run the project's plans,” but setup asks for persona, model and grants before showing value. Replace “Commission a lead” with **“Add project lead.”** Start from the project page with its existing work selected; keep model and detailed permissions under Advanced.

Proposed ten-minute acceptance scenario, not a delivery claim:

- Minutes 0–2: confirm project, responsible human, allowed work and spending limit. Copy: **“Review this project and propose the next step. Starting workers requires your approval.”**
- Minutes 2–6: inspect accessible active work; return a linked brief covering the intended outcome, latest verified result, unresolved blocker and recommended next action. Say **“I could not verify…”** where evidence is absent.
- Minutes 6–10: resolve one existing routine blocker with evidence, or present one executable proposal with acceptance criteria. Copy: **“Ready: investigate the missing fixture. Owner: Ashot. One worker. Success: reproduce the failure and identify its cause. Approve and start / Edit / Leave as proposal.”**

Pass only when a person can understand and authorize the next step without opening multiple session transcripts. An empty project should produce a useful intake draft; inaccessible or stale data must produce an explicit limitation. No org setup, forced plan creation or automatic fleet adoption is necessary.

## 2. Make scope and responsibility unambiguous

Section 2 overloads scope with access, reporting, execution authority and billing. Keep these visibly separate: **“Project: Mail · Human owner: Ashot · Coordinated by: Mail lead · Paid by: [account].”** Project membership must not itself authorize a lead to direct somebody's session or read private evidence.

Specify precedence when a task's project disagrees with its plan's project, when subtasks disagree with parents, and when a task moves during execution. Prefer rejecting conflicting filing, with **“This task belongs to the plan's project. Move the plan or remove the task from it.”** A move must preview the new coordinator and access consequences without silently widening authority.

The human may be outside the agent hierarchy, but cannot be absent from the responsibility model. The session owner and daemon host are not necessarily the accountable project owner or authorized approver. Require a named human owner and explicit approval rights. If nobody eligible is available: **“Waiting for an authorized owner. No approval has been granted.”** Never fall back silently to whoever hosts the lead.

Resolve the protected-action contradiction: section 2 lets taste work proceed by default; section 9 exempts purchases within grants. Distinguish reversible drafts from committing a protected action, and approved compute consumption from new purchases. Copy: **“Drafting may continue. Applying this change requires your approval.”** A keyword filter on questions cannot protect actions that never generate a question. Require authorization at the action boundary; test omitted and misleading classifications.

Section 7's “Who” column replaces an assignee with a running session. Preserve **Owner**; show **Working session** and **Reviewer** separately. A lead coordinates, a worker executes, a reviewer verifies, and the named human remains accountable. Task completion must not imply release approval. Explain what happens to an existing assignee when a lead adopts work; do not silently reassign it.

## 3. Turn chat into approved work intake

Section 7 supports mentions and digests but omits the main integration: a conversation becoming work. “A chat line is never a control” should prohibit implicit authority changes, not prevent a structured approval card within chat.

For “@mail-lead can we fix duplicate notifications?”, reply in that thread:

**“Proposed task: Prevent duplicate notifications. Project: Mail. Human owner: Maya. Deliverable: reproduce, fix and verify one notification per event. Scope: code and tests; no deployment. Start one worker within [explicit limit]? Approve and start / Edit proposal / Dismiss.”**

Before approval, this is only a proposal: no active task, assignment or worker. Show existing related work first. Approval must come from an authorized human and record the approver, exact proposal version and originating message. Edits invalidate earlier approval; repeated clicks create one task and one launch. Quotes, reactions, bot messages and another participant's “looks good” are not approval. A declined or failed launch stays visible in the thread.

After approval: **“Approved by Maya. Tracked in ct-123. Next update: after reproduction.”** Link task to source thread and thread to task; keep subsequent discussion attached rather than making duplicate tasks. Include private-thread and cross-project intake tests.

## 4. Measure verified outcomes, not managed activity

Section 2 says a role “cannot be wrong” in the computed picture. Rows can contain incorrect claims, stale status and missing evidence. Replace with **“Counts reflect recorded state; completion requires verification.”**

Use an outcome ledger: agreed acceptance criterion, artifact or change, verification method and result, verifier, checked revision/time, unresolved concern. Example: **“Duplicate-event replay passes on revision abc123. Production behavior not checked. Reviewed by Mail lead.”** Label **Reported complete**, **Verified against criteria**, and **Accepted by owner** distinctly; reserve human acceptance for work that requires it. A lead must not certify its own implementation without another review path.

Lead digests should lead with delivered outcomes, new evidence, risks and decisions. “On track” needs a target and supporting evidence; otherwise show **“Delivery date not yet supported.”** Use human review time, blocker age, time to accepted outcome, reopened work and total cost per comparable outcome. Keep task counts as navigation. Splitting eleven tasks into thirty must not improve the success score.

Overrides are not a sufficient quality measure: unnoticed errors produce no override. Sample answered decisions and completed work independently. Override UX must explain downstream consequences: **“Change this decision and pause affected work for reassessment. Completed actions may need repair.”** A second message alone does not undo work.

## 5. Evidence links must preserve privacy

Section 9 explicitly delays scoped reads until after chat membership. Reverse that order. A workspace-readable fact can still be inappropriate for a narrower channel; derived summaries, titles, counts and previews can leak it too.

Authorize evidence on every open and before including any excerpt in a digest or notification. Link to existing access-controlled artifacts; do not publish private transcripts into shareable reports. Store the checked revision and time so a changing link does not masquerade as the evidence originally reviewed. Revoked access must remove cached previews across windows and mobile.

When relevant to an authorized viewer, use **“Evidence unavailable to you. Ask the owner for an approved summary.”** Where even existence is private, omit it entirely. A lead's access does not transfer to a teammate, specialist or chat audience. Test mixed-visibility tasks, private originating threads, revoked membership and deleted evidence before chat rollout.

## 6. Avoid creating management work

“Role / engagement / hand / seat / grant / tenancy” is unnecessary onboarding vocabulary. Use lead, worker, permissions and session. “Hands may decide nothing” creates needless escalations: workers should resolve reversible implementation details within approved acceptance criteria; leads handle coordination and unresolved ambiguity.

Defer plan leads, automatic commissioning at eight tasks, mandatory standups, layered recommendations and the large lifecycle toolbar. Put **Pause coordination**, **Review permissions** and **Open conversation** first; move maintenance controls into a menu. Show **“No workers yet. Choose approved work to start.”**, not a CLI instruction. Retain one project update stream with digest filtering rather than another mandatory reporting destination.

Measure coordination turns, review latency and total cost against direct execution and simple automated routing. Wake leads for changed decisions or outcomes, not every comment. Pause idle leads automatically; do not manufacture work to justify them. A second management layer needs evidence that it removes a real bottleneck.

Cross-project specialists need a supported consultation path without a second manager. Keep one execution owner; request a bounded review with explicit input access, deliverable, deadline and cost allocation. Copy: **“Request security review from the shared specialist. Share these artifacts only.”** The specialist returns evidence to the task; it cannot reassign work or inherit the caller's workspace access. Defer cross-workspace execution, not ordinary collaboration between projects.

Handoff must survive an abrupt crash, not rely solely on the departing lead writing a document. Reconstruct approved scope, ownership, pending decisions, active work, evidence and next actions from durable records. Preserve original spawn provenance; section 2's proposed repointing erases who actually launched work. Test replacement without duplicate actions, lost approvals or lost wakes. Do not expire workers or release worktrees while unaccepted artifacts or unresolved concerns remain.

## 7. Keep oversight reachable, including on mobile

Coalesce routine updates, not distinct human obligations. Deduplicate notifications across chat, inbox and push; immediately surface required approval, failed supervision and expiring commitments to the responsible person. Let people choose a digest schedule. **“No action requested. Two results await verification; four decisions are with leads.”** is more honest than “Nothing needs you.” Never require users to keep workers folded to make the metric look good.

Mobile approval needs the exact action, owner, evidence, consequence and current version—not merely a recommendation chain. Bring evidence access, take-over and **Pause new work** into the first supervised release. Distinguish stopping new dispatch from stopping running work. Offline copy: **“Not submitted. Reconnect to review the current request.”** Optimistic paint must never imply that authority was granted. Deferring complex grant editing is reasonable; withholding emergency oversight is not.

## 8. Replace speculative targets with testable milestones

Sections 1/9 give no reproducible evidence here for 14 daily cards, hundreds of weekly undeclared sessions or load 300+. The dated 22-card/46-load snapshot is not a comparable baseline; 24 in-progress tasks does not establish 24 bound sessions. Mark these as reported observations pending source queries.

The under-five queue goal, 50/80% reduction, 30-minute SLA, under-10% overrides over 30 samples, 15% manager spend, 20% cost premium, eight-task trigger, medians ×1.5 budgets and four-week schedule are hypotheses, not validated thresholds. Missing decision classes mean unknown historical protected share, not zero. High escalation can reflect risky work, not insufficient permissions. Machine load cannot establish managerial value without matched workload and hardware.

Use three delivery gates:

1. **Useful observer:** ten-minute project brief; source links, ownership and privacy verified; no autonomous execution.
2. **Supervised project lead:** approved intake through verified result; bounded dispatch, durable handoff, mobile oversight and failure recovery tested before hiding workers. Include multiple humans, stale clients and denied access.
3. **Optional delegation:** add plan leads only after comparable work shows reduced human effort without worse correctness or total cost. Rollback restores human routing and visibility while preserving tasks and evidence.

Section 9 currently folds workers before settle handling, tests refill before lifecycle ships, tests plan caps before plan leads, and requires a doctor using later-phase data. Repair those dependencies. Spending estimates must state freshness and in-flight exposure; admission checks alone do not guarantee a hard total-cost ceiling.

## Top 8 corrections

1. Make the first deliverable an evidence-backed project brief and one actionable next step.
2. Preserve named human ownership independently of host, assignee and coordinator.
3. Add versioned, explicit chat approval before work starts.
4. Define completion through acceptance evidence; abandon cost-per-task as the adoption gate.
5. Ship scoped reads and audience-safe evidence before chat or inbox suppression.
6. Simplify vocabulary and controls; defer automatic hierarchy and compulsory reporting.
7. Specify specialist consultation, crash handoff and mobile intervention before scaling.
8. Replace asserted targets and calendar phases with measured, reversible delivery gates.
