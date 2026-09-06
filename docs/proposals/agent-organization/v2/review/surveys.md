# Primitive surveys, 5 September 2026

Two read only surveys of the codebase were run before the chapters were finalised. Their condensed pointer lists are kept here; every claim carries a file and line relative to the repository root.

## Session hierarchy

- `anchors` at `packages/convex/convex/schema.ts:821`: `scope_type` team or user, `bot_user_id`, `host_user_id`, `conversation_id`, `persona`, `project_path`, `model`, `status`, `daily_session_cap`. `anchor_channels` at `:854` maps a chat or Slack channel to an anchor; a channel with no row falls back to the team anchor.
- `packages/convex/convex/anchors.ts`: `provisionAnchor` (`:189`, mints the bot user and its team membership at `:262`), `deliverToAnchor` (`:373`, the single wake primitive), `wakeAnchor` (`:393`), `rebriefAnchor` (`:432`), `resolveAnchorForScope` (`:449`).
- Three parent pointers on `conversations`: `parent_conversation_id` (`schema.ts:413`, hidden subagent), `spawned_by_conversation_id` (`:472`, visible child, written once by `conversations.ts:11295 linkSpawnedBy`), `agent_team_name` and `agent_name` (`:478`, the coding agent's own stamps; `"team-lead"` is the only role string in the schema, `conversations.ts:11325`).
- One containment rule: `packages/convex/convex/ccAccountsShared.ts:699 nestParentIdOf`, shared by the renderer (`packages/web/components/GlobalSessionPanel.tsx:2201`), the kill cascade (`cleanup.ts:405`) and the server rollup (`packages/shared/contracts/inboxProjection.ts rollupParentIdOf`).
- `rideLeadPlacements` in `inboxProjection.ts` (projection version 6 at `:66`): a teammate takes its lead's inbox bucket. Golden and property tests require a version bump on any placement change.
- A worker's open decision lifts its parent into the questions bucket: `conversations.ts:9163 loadPendingDecisionConvIds`.
- `cast send` attribution: `pendingMessages.ts:621 performSessionSend`; bot senders skipped for auto claim at `:671`.
- `cast state`: `packages/cli/src/stateCommand.ts:221`; server `conversations.ts:10683 setThreadState`; a `blocked` pin un hides a stashed session (`:10733`).
- Work state: `packages/shared/contracts/inboxProjection.ts:156 classifyWorkState`; settle classifier `idleSummary.ts:124` may only file done or needs input.
- Triggers: `agent_tasks` at `schema.ts:2740`; `--spawn` omits `originating_conversation_id` (`agentTasks.ts:357`); `completeTaskRun` at `:704`.
- Decisions: `session_decisions` at `schema.ts:2575`; `sessionDecisions.ts:276 resolve` patches status and answer only; the answer reaches the agent as an ordinary message send.
- Labels are `inbox_buckets` and `bucket_assignments` (`schema.ts:1120`, `:1134`), personal per user.
- No field names a manager, supervisor, reporting line or agent to agent role.

## Work primitives

- Tasks at `schema.ts:3181`: acceptance criteria, verification evidence, execution status, `agent_session_id`, `conversation_ids`, `blocked_by`, `source`, `promoted`. Status categories in `packages/shared/tasks/statuses.ts:14`. Depth cap `MAX_TASK_DEPTH = 2` (`packages/shared/tasks/index.ts:331`) enforced by `tasks.ts:469 resolveParentTask`. Close guard `tasks.ts:565`. Ready rules `tasks.ts:1285`. Comment types progress, blocker, review, note (`schema.ts:3407`); decision is a plan and doc entry type, not a task comment type.
- `spawnSessionForTask` (`tasks.ts:2977`) is the one spawn for the board, `cast task start --spawn` and issue sync; it nests the worker under the session that created the task's plan through `resolveWorkerParentConversation` (`tasks.ts:65`).
- An `agent:` assignee grants no read access: `packages/convex/convex/lib/access.ts:56 isUserGrant`.
- Plans at `schema.ts:3024`: `entries[]` with decision and rationale, `join_policy`, `orchestration_metadata`; bind at `plans.ts:569`; `plans.snippet` at `:1090` and `cast plan context` at `packages/cli/src/index.ts:15341`.
- Projects at `schema.ts:2889`; `project_updates` at `:2925` with `author_kind` agent and `kind` digest; `cast project post` at `index.ts:14674`.
- Docs at `schema.ts:3445`: types plan, design, spec, investigation, handoff, note; `entries[]`; live editing through snapshots and deltas at `:3805`.
- Chat: `chat_messages` at `schema.ts:4545` with server parsed mentions and a placeholder row carrying `agent_status` and `agent_anchor_id` (`:4642`); `anchor_follow` on the thread root (`:4663`); `chat.ts:3922 replyAsAnchor` with status passed; `chat.ts:2873 sendAsAnchor`.
- Access: `workspaceKey` (`lib/access.ts:241`), `computeWorkspaceKey` (`:261`), stamp evaluators (`:78`, `:100`). `team_memberships.role` is member or admin only.
- Usage: only `messages.usage` (`schema.ts:992`) and a laptop local account store behind `runUsageCommand` (`index.ts:4503`). No per session token or dollar rollup.
- Session insights at `schema.ts:2277`: headline, what changed, outcome type, blockers, next action; `tasks.context` (`tasks.ts:1915`) folds a linked session's insight into the task.
- Web: `app/orchestration/` with `components/OrchestrationDashboard.tsx` and `FleetBoard.tsx` are the closest existing multi agent views; `DashboardLayout.tsx:203` with `HostFeeders` at `:237`.
