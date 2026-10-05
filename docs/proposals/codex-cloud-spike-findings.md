# Codex Cloud Phase 0 spike findings (2026-09-29)

> **Status (2026-10-04):** Historical record of the Phase 0 spike for pl-798. Its findings were built into `packages/cli/src/cloudAgents/codex.ts`; the scrubbed payloads remain the test fixtures in `packages/cli/src/__fixtures__/codexCloud/`.

These are live results against `chatgpt.com/backend-api/wham` on a Pro account, using the one existing environment (`acme/example`, legacy machine `wham-public/wham-universal`). Scrubbed payloads are in `packages/cli/src/__fixtures__/codexCloud/`. Replaced with placeholders: environment ids, GitHub repository and account ids, emails, environment variables, secrets, and the repositories' source (partial_repo_snapshot contents, diffs and terminal output), since this repository is public. Kept as recorded: the task, turn and attempt ids and the repository name `acme/example` with its owner login, which the tests name and which work only with the account's own sign-in. The spike client is `/tmp/wham/w.ts`.

Every capability the proposal needs works. Details below.

## Auth and headers

Every call needs only:
- `Authorization: Bearer <tokens.access_token>`
- `ChatGPT-Account-ID: <tokens.account_id>`, both read from `~/.codex/auth.json`

The spike client also sent the CLI's `User-Agent: codex_cli_rs/<ver> (...) codex_cloud_tasks_tui`. Codecast sends instead the headers its Codex usage meter already sent to `/wham/usage` (`codexBackendHeadersFromAuth` in `codexBackendUsage.ts`: `User-Agent: codex-cli`, `OpenAI-Beta: codex-1`, `originator: Codex Desktop`), so one header builder serves every wham call. Every endpoint below was verified with them too.

The web app sends extra anti-abuse headers on create. Neither create nor follow-up needs them.

Errors seen:
- A bad token gives 401 `{"detail":"Could not parse your authentication token. Please try signing in again."}`.
- An unknown task gives 404 `{"detail":"Invalid task ID"}`.
- A validation failure gives 400 `{"error":{"message":"[pydantic errors...]","type":"invalid_request_error"}}`.

Parse `detail` and `error.message`.

## Turn content: new tasks use app-server events

Every task created today records on its assistant turn:
- `thread_events.events`: Codex **app-server v2 notifications**, the same protocol codecast already speaks in `packages/cli/src/codexAppServer.ts`.
  - Methods seen: `thread/started`, `thread/status/changed`, `turn/started`, `item/completed`, `rawResponseItem/completed`, `turn/completed`.
  - Item types seen: `userMessage`, `reasoning`, `commandExecution`, `agentMessage`.
  - `threadItemToMessage(item, ts)` in `codexAppServer.ts` converts these. Reuse it; do not write a second parser.
  - The thread was produced by cli `0.144.0-alpha.4`; its `threadSource` is `codex_web_qa` for ask mode.
- `worklog.messages`: now only the user prompt in ChatGPT message format.
- `app_server_events.events`: empty.
- `output_items`:
  - `message`: the final answer, `content[].text`.
  - `partial_repo_snapshot`.
  - `pr` in code mode: `pr_title`, `pr_message`, `output_diff.diff`, `pre_apply_patch`.

**Legacy tasks** (Aug 2025, fixture `turns.legacy.json`) have empty `thread_events`. Their whole work log sits in `worklog.messages` in ChatGPT message format:
- `author.role`, `content.content_type` (`text`, `code`, `execution_output`), and `recipient` (tool calls such as `container.exec` and `container.new_session`).
- The final answer and diff are in `output_items`.

Both formats must render.

## Progress while running

- The status sequence is `pending` → sometimes `in_progress` → `completed` / `cancelled` / `failed`.
- `thread_events` stay **empty until the turn completes**, then land all at once. There is no stream.
- While running, only `turn_status` and `latest_event` are available. For example, `latest_event` is `{"text":"Completing the task","event_type":"info"}`, and it is often null mid-run.
- So the mirror shows a working state with the latest_event text, then renders the whole turn on completion.
- Ask tasks took 30 to 60s; the best-of-2 code task took about 3.5 min.

## Endpoints verified live

| Action | Call | Result |
|---|---|---|
| Create | `POST /tasks {new_task:{environment_id, branch, run_environment_in_qa_mode}, input_items:[{type:"message",role:"user",content:[{content_type:"text",text}]}], metadata?:{best_of_n}}` | 200 `{task, user_turn, turn, rate_limit}`. The turn is `pending`; `task.id` looks like `task_e_...`, and turn ids look like `<task>~assttrn_e_...`. |
| Ask mode | `run_environment_in_qa_mode: true` | Works. `intent: "qa"`; no diff, no pr item. |
| Best of N | `metadata.best_of_n: 2` | Two assistant turns share one `previous_turn_id` (the user turn). `sibling_turn_ids` point at each other, and `attempt_placement` is 0 or 1. `/turns` returns both in `turn_mapping`. The task's `current_turn_id` is attempt 0. |
| Follow-up | `POST /tasks {follow_up:{task_id, turn_id:<assistant turn to continue>, run_environment_in_qa_mode}, input_items}` | 200. It creates a user turn plus a pending assistant turn chained via `previous_turn_id`. |
| Cancel | `POST /tasks/{id}/cancel` body `{}` | 200 `{success:true}`. The turn becomes `cancelled` with `cancellation_requested_at` set. |
| Archive / recover | `POST /tasks/{id}/archive` · `/recover` | 200. `task.archived` toggles. The list with `task_filter=archived` shows archived tasks; `current` hides them. |
| Create PR | `POST /tasks/{id}/turns/{turn_id}/pr {mode:"draft"|"auto_merge", add_codex_tag:bool}` | 200 `{success:true}`. After a few seconds, `GET /tasks/{id}/turns/{turn_id}` gives `pull_request_status: "created"` (it passes through `creating`) and `pull_request_data: {number,url,state,draft,title,...}`. The branch is named `codex/<slug>`. |
| Get PR | `GET /tasks/{id}/turns/{turn_id}/pr` | exists (web client) |
| Update PR | `PATCH /tasks/{id}/turns/{turn_id}/pr/{pr_id}` | exists (web client), untested |
| Usage | `GET /usage` | `plan_type`, `rate_limit.primary_window{used_percent, limit_window_seconds, reset_at}`, `secondary_window`, `credits`. The create response also carries `rate_limit`. |
| Environments | `GET /environments` | A list of environments. **Each carries `env_vars` and `secrets` with the user's real secrets in plain text. Never persist, log, sync or display the environment object; keep only `id`, `label`, `machine_id`, `repo_map[*].repository_full_name`, `default_branch`.** |
| By repo | `GET /environments/by-repo/github/{owner}/{repo}` | used by the CLI's auto-pick |
| Search | `GET /tasks/search?query&limit&cursor` | exists (web client) |

`/machines` returns `[]` on this account. No new-style (VM) environment exists here yet. New tasks on the legacy environment already use app-server events, so the renderer covers both generations. Re-checked 2026-10-02: still `[]`, and the account's Create environment form offers only the container type, so the VM generation stays unverified (ct-56164).

## Spike artifacts left on the account

Four small tasks on `acme/example`, each titled with "codecast spike":
- ask
- ask plus follow-up
- best-of-2
- cancelled, now archived

Draft PR acme/example#18 was closed and its branch deleted. Validators may create more small ask-mode tasks on this environment. They must close any PR they open and archive their tasks when done.

## OpenAI Agents API: facts verified live (2026-10-01)

Two tiny sessions on `gpt-5.6-terra` (both deleted). Recordings are in `packages/cli/src/__fixtures__/openaiAgents/`. The public docs cover the rest; these are what the docs leave out or what codecast relies on:

- Session ids start with `sess_`. Turns are `turn_`, items `msg_`, `rs_` and `exec_`.
- `POST /v1/agents/sessions` with `stream: true` answers `201 text/event-stream`. Its first event is `agent.session.created` with the session id. Frames carry `event:` (the type) and no `id:`.
- A follow-up or a cancel (`POST …/events`) answers `202` with an empty body.
- `last_active_at` never moves: after two turns it still equalled `created_at`. A session's `usage.total_tokens` and `status` do move, so they are what tells a listed session changed.
- A command cut off by a cancel streams as `command_execution` with `status: "incomplete"`, but the saved items list never gets it. The stream is the only record of it.
- A stream opened on an idle session sends `agent.session.environment.ready` and then stays open with nothing more. A follower has to close it itself when the turn ends.
- Items carry no timestamps; turns do (seconds). The user's message is an item of its turn (`role: "user"`, `output_index: null`).
- Error bodies are `{error: {type, code, message, param}}`. A bad key is `401 invalid_api_key`; a missing beta header is `400 invalid_beta`. A restricted key missing a scope is also a 401, with no code and "Missing scopes: ..." in the message, so only `invalid_api_key` says the key itself is bad.
- An idle sandbox is replaced, not ended: a follow-up 62 minutes after the last turn ran normally, in a fresh sandbox without the file the first turn wrote. The session's `environment.id` did not change (it encodes the session's creation time), so the idle gap between turns is the only sign. The transcript says so on a turn that starts more than an hour after the previous one ended.
- A session OpenAI deleted answers `404` ("No managed agent resource found"). The mirror then marks it gone and never reads it by id again.
- Without credentials, a sandbox's `setup_commands` can clone public GitHub repositories over HTTPS (`octocat/Hello-World` cloned fine). Private ones need a credential: a vault's `environment_variable` credential is the documented way, and it means storing the person's GitHub token at OpenAI.
