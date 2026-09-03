# Issue sync: Linear and GitHub issues as tasks

A task can be backed by a Linear issue or a GitHub issue. The task is the
codecast citizen: it has a short id, a workspace, a board column, sessions and
comments like every other task. The issue is its twin on the provider. Changes
on either side land on the other. This doc is the contract for the data model,
the sync engine, the conflict policy and the echo guards.

Sections are numbered (S1, S2, ...) so code can reference them.

## S1. Data model

### S1.1 `tasks.external` (optional object)

```ts
external: {
  provider: "linear" | "github",
  id: string,            // provider primary id: Linear issue uuid, GitHub issue node_id
  identifier: string,    // human identifier: "LIN-123" or "owner/repo#482"
  url: string,           // canonical html url
  number?: number,       // GitHub issue number
  repo?: string,         // GitHub "owner/repo"
  team_key?: string,     // Linear team key ("LIN")
  team_id?: string,      // Linear team uuid
  project_id?: string,   // Linear project uuid
  source_id?: Id<"issue_sync_sources">,
  remote_updated_at: number,   // provider updatedAt of the last inbound we applied
  synced_at: number,           // when we last touched the provider in either direction
  field_ts?: Record<string, number>, // S3: last LOCAL write time per synced field
  assignee_label?: string,     // provider assignee display when unmapped to a user
  state_name?: string,         // provider state name as last seen (Linear only)
  last_error?: string,
}
```

Index on tasks: `by_external ["external.provider", "external.id"]`.

`external` is server authored. Clients never write it optimistically, so the
store's field protection never has to reconcile it. It rides the sync log like
any other task field.

### S1.2 `task_comments.external` (optional object)

```ts
external: { provider: "linear" | "github", id: string, url?: string, author?: string }
```

Index: `by_external ["external.provider", "external.id"]`. A comment with
`external` set was either pulled from the provider or pushed to it and got
its provider id back.

### S1.3 `issue_sync_sources`

One row per imported container: a Linear project, a Linear team, or a GitHub
repo. It maps to exactly one codecast project and holds the delegation
convention.

```ts
{
  provider: "linear" | "github",
  kind: "linear_project" | "linear_team" | "github_repo",
  external_id: string,        // Linear uuid or GitHub "owner/repo"
  external_key?: string,      // Linear team key when known
  name: string,
  url?: string,
  project_id: Id<"projects">,
  user_id: Id<"users">,       // who set it up; owner of imported tasks
  team_id?: Id<"teams">,      // routing
  workspace: string,          // access, via computeWorkspaceKey
  status: "active" | "paused" | "error",
  last_synced_at?: number,
  last_webhook_at?: number,
  last_error?: string,
  // delegation: which provider side signal means "hand this to an agent"
  delegate_label?: string,        // default "agent"
  delegate_assignee?: string,     // provider user id or login that means "agent"
  auto_spawn: boolean,            // spawn a session when the signal appears
  push_new_tasks: boolean,        // tasks created in the project are created on the provider
  created_at: number, updated_at: number,
}
```

Indexes: `by_project`, `by_provider_external ["provider", "external_id"]`,
`by_workspace`, `by_team_id`, `by_status`.

Access follows the workspace rules: `workspace` is the access key, `team_id`
is routing, reads go through the same predicate as tasks.

### S1.4 `linear_webhook_events`

Same shape and role as `github_webhook_events`: `delivery_id` (Linear
`webhookId` + `webhookTimestamp`), `event_type` (Issue, Comment, IssueLabel),
`action` (create, update, remove), `payload`, `processed`, `created_at`.
Index `by_delivery_id`, `by_processed`. Dedupe on delivery id makes inbound
idempotent under provider retries.

### S1.5 Health stamps on connections

`app_installations` (Linear) and `github_app_installations` gain optional
`last_webhook_at`, `last_sync_at`, `last_error`. The integrations page reads
them as health.

## S2. Field mapping

| codecast              | Linear                                   | GitHub                                |
|-----------------------|------------------------------------------|---------------------------------------|
| title                 | title                                    | title                                 |
| description           | description (markdown)                   | body (markdown)                       |
| status (category)     | state.type: triage,backlog -> backlog; unstarted -> open; started -> in_progress; completed -> done; canceled -> dropped. Team states named like "review" under started -> in_review | open -> open (in_progress if assigned to an agent session); closed+completed -> done; closed+not_planned -> dropped |
| priority              | 0 none, 1 urgent, 2 high, 3 medium, 4 low | not synced (GitHub has none)          |
| assignee              | assignee.email -> users.email / alternate_emails | assignees[0].login -> users.github_username |
| labels                | labels[].name                            | labels[].name                         |
| comments              | comments (markdown, user)                | issue comments                        |

Outbound status uses the reverse map. For Linear the target state is the
first workflow state of the team whose `type` matches; if the team has a
state whose name matches our custom status name that wins.

Unmapped assignee: keep our `assignee` unset, store the display in
`external.assignee_label`. Outbound assignee only when the user maps to a
provider user (Linear by email, GitHub by login); otherwise skip the field.

## S3. Conflict policy: last writer wins per field, by provider clock

Every inbound event carries the provider's `updatedAt` (Linear) or
`updated_at` (GitHub). Every outbound write stamps
`external.field_ts[field] = Date.now()` for each field it pushed.

An inbound field is applied only if `remote_updated_at_of_event >=
external.field_ts[field]` (missing field_ts means apply). This keeps a local
edit that has not yet reached the provider from being clobbered by a stale
event that was already in flight, and lets a genuinely newer provider edit
win. Provider clocks and ours differ by at most seconds; ties go to the
provider because the provider's value is what everyone else sees.

Fields are compared before writing. An inbound event whose mapped values
equal the task's current values is a no-op: no patch, no history row, no
outbound. This single rule is what makes the loop terminate (S4).

## S4. Echo and loop prevention

1. Inbound never calls outbound. Inbound handlers write through
   `issueSync.applyRemote` (internal mutation) which patches the task directly
   and does not schedule `pushTask`. Public task mutations (`tasks.update`,
   `webUpdate`, `addComment`, `webAddComment`, `create`, `webCreate`) are the
   only places that schedule `pushTask`.
2. Outbound causes a webhook back. That webhook maps to values equal to ours
   (S3 no-op) and stops.
3. GitHub: events whose `sender.type === "Bot"` and login matches our app
   (`codecast-sh[bot]`) are dropped at ingest.
4. Comments: outbound comment creation returns the provider comment id and
   patches it onto our `task_comments.external`. Inbound comment with a known
   external id is skipped. If the id is unknown but a comment with identical
   text and no external id was written in the last 5 minutes, that row is
   linked instead of duplicated (covers the webhook beating the patch).
5. Dedupe by delivery id on both providers.
6. Reconcile pulls (S6) use the same `applyRemote` path so they are as safe as
   webhooks.

## S5. Outbound

`issueSync.pushTask` (internal action) takes `{ task_id, fields: string[] }`,
loads the task and its connection, and issues one provider write per call:

- Linear: GraphQL `issueUpdate(id, input)` with the mapped subset; labels
  resolved to ids, created with `issueLabelCreate` when missing; assignee
  resolved by email via `users(filter: { email })`.
- GitHub: `PATCH /repos/{repo}/issues/{n}` with title, body, state,
  state_reason, labels, assignees.

`issueSync.pushComment` posts one comment (`commentCreate` or
`POST /issues/{n}/comments`) and writes the id back.

Both write `external.synced_at`, `external.field_ts`, and `last_error` on
failure. Failures are logged, never retried in a loop: the 15 minute reconcile
(S6) is the retry.

Tokens: Linear via `oauthConnectors.getAccessTokenForTeam`; GitHub via
`githubApp.getInstallationToken` for the installation covering the repo.

## S6. Inbound

Webhooks land in `/api/webhooks/linear` and `/api/webhooks/github-app`,
verify the signature, dedupe, store the raw event, and schedule the handler.

- Linear signature: HMAC SHA256 of the raw body with `LINEAR_WEBHOOK_SECRET`,
  header `Linear-Signature`, and `webhookTimestamp` within 60 seconds.
- Handler resolves the source (by `data.project.id`, `data.team.id`, or
  `repository.full_name`), then `applyRemote`:
  - Issue create -> create task in the source project (if none by external id).
  - Issue update -> field level apply per S3.
  - Issue remove / deleted -> set task `dropped` and keep the row.
  - Comment create/update -> upsert comment.
- Reconcile: cron every 15 minutes runs `issueSync.reconcileSources`, which
  for each active source pulls issues updated since `last_synced_at - 5 min`
  and applies them. It also catches webhooks that never arrived.
- Import (`issueSync.importSource`) is a full pull with `last_synced_at` unset.

Inbound writes trigger the same observers as human writes: task history rows
(`actor_type: "system"`, action `synced_from_provider`), plan progress,
subscriber notifications, and a team activity event (S8).

## S7. Issue to agent

A task with `external` becomes a session three ways:

1. Board and task page: the existing assign to agent action.
2. CLI: `cast task start <id> --spawn [--agent <type>]` calls
   `/cli/work/spawn`, which shares `spawnSessionForTask` with `assignToAgent`.
3. Automatically. When an inbound event carries the source's delegation
   signal (label equals `delegate_label`, or assignee equals
   `delegate_assignee`) and `auto_spawn` is on, `applyRemote` schedules the
   spawn once per task (guarded by `conversation_ids` being empty). Triggers
   also fire: every inbound event is normalized and handed to
   `agentTasks.matchTaskTriggers` as `issues/opened`, `issues/assigned`,
   `issues/labeled`, `issues/closed`, `issue_comment/created`, with
   `repository` set to the repo full name or the Linear team key. The CLI
   shorthands are `issue_opened`, `issue_assigned`, `issue_labeled`,
   `issue_commented`.

The spawn posts one provider comment ("Codecast session <link> picked this
up"). The session's `cast task comment` and `cast task done` go through the
public mutations, so progress and the final comment flow back through S5.

## S8. Feed events

Inbound events are recorded as `external_events` rows (owned by the git
integration work) through `internal.externalEvents.record`, with `source`
`"linear"` or `"github"`, `kind` one of `issue_opened`, `issue_assigned`,
`issue_closed`, `issue_reopened`, `issue_commented`, `issue_status`,
`issue_edited`, the `issue { provider, key, url, title }` object, `task_ids`
set to the backing task, and `dedupe_key` = `<provider>:<issue id>:<kind>:<event ts>`.
The web renders every row with `ExternalEventRow`
(`components/feed/ExternalEventRow.tsx`); issue kinds register their icon,
accent and verb through `registerExternalEventStyles` in
`lib/externalEvents.ts` so no second component exists.

## S9. Integrations page

`/settings/integrations` lists Slack, GitHub, Linear, Google and Notion from
`appDescriptors` and `appConnections.listConnections`, with connect,
disconnect, scope, who connected, health (S1.5) and what each enables. GitHub
and Linear cards carry the issue sync sources: add, pause, remove, sync now,
delegation settings. The OAuth confirm step (`confirmConnection`) runs from
this page when the callback lands with a `#confirm=` fragment.

## S10. CLI

- `cast task show/ls` print the identifier and url when `external` is set.
- `cast task start <id> --spawn`.
- `cast trigger add --on issue_opened|issue_assigned|issue_labeled|issue_commented`.
- `cast integrations ls|connect <provider>|disconnect <provider>|import <provider> <ref> [--project <ref>]|sources|sync <source>|pause <source>|remove <source>`.
