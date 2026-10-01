# Full Codex Cloud support in codecast

*Proposal, 2026-09-29. Research: OpenAI docs and changelog, the `openai/codex` source at `94d642d8b40e` (release `rust-v0.159.1`), the chatgpt.com web client, community clients, and live read-only calls on Ashot's Pro account.*

## The short version

"Codex in the cloud" is now three different things, and full support means covering the first two:

| | **Codex Cloud** (chatgpt.com/codex) | **OpenAI Agents API** | Codex Remote |
|---|---|---|---|
| What it is | Tasks on OpenAI VMs against GitHub repos, on the person's ChatGPT plan | A managed Codex harness in the cloud, called with an API key | ChatGPT drives the person's own computer |
| Who uses it | Every Plus / Pro / Business / Enterprise Codex user | Developers building on the API | Mobile users |
| API | **Private** (`chatgpt.com/backend-api/wham`), used by OpenAI's own CLI | **Public beta** since 2026-09-10: sessions, follow-ups, cancel, SSE, webhooks | Not cloud; out of scope |
| Billing | Plan limits (5h and weekly windows) | API rates for the model, plus tool and container time | n/a |
| Stability | Can change without notice | Versioned, documented | n/a |

**Recommendation: build both, on one shared "cloud agent" core extracted from the Cursor Cloud work.**

- **Codex Cloud (plan)** is what users actually have and use. It's the flagship lane: sync every task, start from the composer, follow-ups, cancel, best-of-N attempts as branches, PRs, and apply-locally.
- **Agents API** is the durable lane. It's public and has live streaming, so it gets the same UX from an OpenAI key the person already has in Provider Keys, with no private-API risk.

The private-API risk is contained in the design:
- one adapter,
- contract tests on recorded fixtures,
- a daily live canary that turns the lane off with a clear banner if OpenAI changes something.

## What the research established

### Codex Cloud (plan): the private API, fully mapped

Base URL `https://chatgpt.com/backend-api/wham`. Auth is the ChatGPT login `codex login` stores in `~/.codex/auth.json`: `Authorization: Bearer <access_token>` and `ChatGPT-Account-ID`. API keys are refused by design (`learn.chatgpt.com/docs/auth`).

| Capability | Endpoint | Evidence |
|---|---|---|
| List tasks (paged) | `GET /tasks/list?limit&cursor&task_filter=current&environment_id` | CLI source, verified live |
| Task detail (current turns, PR, diff, branch) | `GET /tasks/{id}` | CLI source, verified live |
| Every turn, with the full work log | `GET /tasks/{id}/turns` → `turn_mapping` | verified live (209 to 255 work-log messages per attempt) |
| One turn / its logs | `GET /tasks/{id}/turns/{turn}` · `…/logs` | web client |
| Best-of-N attempts | `GET /tasks/{id}/turns/{turn}/sibling_turns` | CLI source |
| **Create task** | `POST /tasks` `{new_task:{environment_id, branch, run_environment_in_qa_mode}, input_items, metadata:{best_of_n:1..4}}` | CLI source (used by `codex cloud exec`) |
| **Follow-up** | `POST /tasks` `{follow_up:{task_id, turn_id, run_environment_in_qa_mode}, input_items}` | web client `createFollowUpTask`; community auto-coder uses it in production |
| **Cancel** | `POST /tasks/{id}/cancel` (turn-level cancel is deprecated) | web client |
| Archive / recover / mark read / viewed | `POST /tasks/{id}/archive` · `/recover` · `/mark_read` · `/turns/{turn}/viewed` | web client |
| Create / update PR | `POST /tasks/{id}/turns/{turn}/pr` · `PATCH …/pr/{pr_id}` | web client |
| Diff | in the turn's `output_items` (`pr.output_diff` / `output_diff`) | CLI source, verified live |
| Environments | `GET /environments` · `GET /environments/by-repo/github/{owner}/{repo}` | CLI source, verified live |
| Plan usage | `GET /usage` (windows, plan, per-model availability) | verified live |
| Live progress | **none**: the web app itself polls a running task (react-query, up to 30 min) | web client |

Ask mode is `run_environment_in_qa_mode: true`, inferred from the field name. The official CLI always sends `false`.

### Two generations of Codex Cloud

- **Legacy (container, setup scripts)** is what the `/wham/tasks` API and the CLI serve today. It still runs Code Review and the GitHub and Linear `@codex` integrations. OpenAI says it will be deprecated.
- **New (announced at DevDay today, 2026-09-29)** uses reusable, *published* VM environments. Each task gets an isolated VM, its state is kept for 7 days, and tasks continue on web, mobile and desktop.
  - Every turn in the API already carries `app_server_events` / `thread_events` fields, which are empty on legacy tasks. The likely reading is that new tasks run the Codex app-server in the VM and record its events there.
  - If so, codecast's existing Codex app-server parser renders them with little new code. **This is the first spike** (see Phase 0).
  - Ashot's account has no new-style environment yet: `/wham/machines` is empty and the only environment is `wham-public/wham-universal`.

### Agents API: the public lane (verified in the docs)

All calls use `OpenAI-Beta: agents=v1` and `Authorization: Bearer $OPENAI_API_KEY`.

| Capability | Endpoint |
|---|---|
| Create a session and stream its first turn | `POST /v1/agents/sessions {agent:{model, instructions, tools, mcp}, environment:{type:"openai_hosted", setup_commands, container_size}, input, stream:true}` |
| Follow-up (steers the turn if it's busy) | `POST /v1/agents/sessions/{id}/events` `agent.session.input.message` |
| Cancel the active turn | same, with `agent.session.input.cancel` |
| List / get / items / delete | `GET /v1/agents/sessions` · `GET …/{id}` · `GET …/{id}/items` · `DELETE …/{id}` |
| Progress | SSE events (`turn.completed|failed|cancelled`, `idle`, `requires_action`) and webhooks |

Environments can be OpenAI-hosted, self-hosted through `codex exec-server`, or a partner sandbox (Daytona, E2B, Modal, Vercel, Cloudflare and others). Its sessions do **not** appear in chatgpt.com/codex and don't use the plan.

### Integrations

- `@codex` on GitHub PRs and issues, GitLab (beta), Linear (assign or mention) and Slack/Teams all start legacy Codex Cloud tasks.
- None of them offers a webhook to third parties. These tasks show up in `/wham/tasks/list`, so the mirror picks them up with everything else.

### Auth, terms and limits

- **Token handling.** Refresh tokens rotate (`POST auth.openai.com/oauth/token`, client `app_EMoamEEZ73f0CkXaXp7hrann`). If codecast refreshed the token while a `codex` TUI was open, that TUI would be logged out.
  - So codecast **only reads** `auth.json`, never refreshes it, and shows a "sign in to Codex" card when the token is expired. This is the same rule the Claude Code cloud mirror follows.
- **Terms.** OpenAI has published no statement allowing or forbidding third-party use of the Codex login against `/wham`.
  - Its new "Sign in with ChatGPT, plan usage" program, launched today, covers model calls only, not cloud tasks.
  - Community tools doing this are tolerated today. The lane is opt-in for that reason.
- **Enterprise.** Codex Cloud is off by default and gated by RBAC. One reported 403 on `/wham/tasks/list` for an Enterprise user (openai/codex#12651). This needs a clear "not enabled for your workspace" state.
- **Usage.** Cloud tasks count against the plan's 5-hour and weekly windows. `/wham/usage` exposes them, so the codecast usage chip can show Codex Cloud headroom.

## The design

### 1. One cloud-agent core, three sources

The Cursor Cloud work already has every generic piece. It's extracted into `cloudAgents/` with a small per-provider adapter:

| Core (shared) | Adapter (per provider) |
|---|---|
| Mirror watcher: poll the list, persist a merged per-task event log, render a transcript file, emit it into the transcript pipeline, format version, startup announce, own-vs-imported filter | `list()`, `readTask()` → turns/events |
| Neutral mirror transcript: records with stable ids and fixed timestamps, `turn_ended`, tool calls with results, task notices; one parser | `render(turn)` → records |
| Sessions registry: start / deliver / interrupt, held messages with reasons, setup-failure cards | `create`, `followUp`, `cancel`, `archive`, setup checks |
| Header chip, branch → `git_branch`, key/login status, the Sync-page switch (`CLOUD_SESSION_SOURCES`) | URLs, labels |

Sources: `cursor` (done), `codex_cloud` (plan, `/wham`), `codex_api` (Agents API). The web composer's "run in the cloud" switch, the model half-filter and the Connect dialog pattern are reused as they are.

### 2. Codex Cloud (plan) lane: every capability

| Capability | How |
|---|---|
| **Sync** every task (including `@codex` tasks from GitHub, Linear and Slack) | Poll `/tasks/list` every 30s while any task is pending, 5 min otherwise, and read changed tasks with `/turns`. Legacy work logs render tool calls (shell commands and outputs) and messages. New-VM tasks render through the app-server parser once confirmed. |
| **Start** from the composer | Codex + "run in the cloud" → environment picker, auto-picked from the repo's GitHub remote the way the CLI does it (`/environments/by-repo`), plus an attempts picker (1 to 4). `POST /tasks`. |
| **Ask mode** | Toggle, `run_environment_in_qa_mode: true`. |
| **Follow-ups** | `POST /tasks {follow_up}`. A message sent while the agent is busy is held and delivered when the turn ends (same mechanism as Cursor). |
| **Interrupt** | Escape → `POST /tasks/{id}/cancel`. |
| **Best-of-N attempts** | Each attempt is a branch of the conversation, using codecast's fork chips (attempt 1 is the task's own session). A message sent on a branch continues that attempt (`follow_up` from its last turn). |
| **PR** | Header action "Create draft PR" (`POST …/pr`, draft, `add_codex_tag: false`), which returns the PR the branch already opened instead of opening a second. Existing PR state shows via `git_branch` and codecast's PR linking. |
| **Apply locally** | Header action: `git apply` of the branch's recorded diff at the root of the session's checkout, refused when local changes touch the same files, and reported in the thread. Not `codex cloud apply`: its `--attempt n` counts only the current turn's attempts, and running the Codex CLI may refresh the login codecast only reads. |
| **Kill / archive** | Kill cancels the active turn. "Archive" (reversible) is separate. |
| **Usage** | The usage chip shows Codex Cloud windows from `/wham/usage`. |

**Setup, guided in the web** (same shape as Connect Cursor):
- **Not signed in** → a "Sign in to Codex" dialog. The daemon runs `codex login` (browser OAuth) in a pane, using the flow the Claude sign-in already uses. The dialog shows the account and plan when it completes.
- **Token expired** → the same dialog, stating that codecast never refreshes the login itself.
- **No environment for this repo** → a card linking to chatgpt.com/codex environment setup, re-checked on the next send.
- **Codex Cloud disabled for the workspace** (403) → a card naming the admin permission ("Use Codex in the cloud").

### 3. Agents API lane

- A Provider Keys entry that already exists (OpenAI), verified on save like the Cursor key.
- Composer: Codex + "run in the cloud" → a choice between **your ChatGPT plan** (Codex Cloud) and an **OpenAI API key** (Agents API), with cost wording on each.
- Sessions stream over SSE into the same mirror, with real-time progress instead of polling. Follow-ups and cancel go through events. Webhooks are optional later, for when the laptop is asleep.

### 4. Risk containment for the private lane

- **One adapter file.** Every private call goes through `codexCloudApi.ts`, which sends the official CLI's headers (`User-Agent: codex_cli_rs/<ver> … (codex_cloud_tasks_*)`).
- **Contract tests** on recorded, scrubbed payloads for list, task, turns (legacy and new), follow-up, cancel and error shapes.
- **Daily live canary** (a trigger): read-only list + task read. If a shape breaks, the lane turns itself off for that machine with a banner ("Codex Cloud changed; syncing paused, codecast is updating"). Nothing guesses at a changed schema.
- **Opt-in:** off until the person turns on "Sync Codex Cloud tasks" (a new `CLOUD_SESSION_SOURCES` entry) or starts one from the composer.
- **No token refresh, no scraping, no browser automation.**

## Phases

| Phase | Scope | Verification |
|---|---|---|
| **0. Spikes** (½ day) | (a) Create one new-style environment and one task; capture its `/turns` shape and `app_server_events`. (b) One follow-up via `POST /tasks {follow_up}` without the web's anti-abuse headers. (c) Cancel and archive live. (d) Ask mode. | Recorded fixtures for each; go/no-go per capability |
| **1. Core extraction** | Move Cursor Cloud's mirror, sessions and UI into `cloudAgents/` behind adapters; Cursor keeps working unchanged | Existing Cursor Cloud tests + e2e rerun |
| **2. Codex Cloud sync** | Mirror, both transcript generations, header chip, branch, Sync switch, usage chip, sign-in dialog, expired/403 cards | Ashot's past tasks import correctly; a new task started on chatgpt.com appears within 30s |
| **3. Codex Cloud drive** | Start (environment + attempts + ask), follow-ups, held-while-busy, cancel, attempts as branches, Create PR, Apply locally, archive | Browser e2e: start on `ashot/wetrip`, follow-up, cancel, best-of-2, apply |
| **4. Agents API lane** | OpenAI key verification, session create/stream/follow-up/cancel into the same mirror | Browser e2e on an API key |
| **5. Hardening** | Canary trigger, kill switch, docs/README, Enterprise 403 path | Canary run + forced-failure test |

## Decisions for Ashot

1. **Opt-in for the private lane.** On by default for people who already use `codex login`, or off until they turn it on? The recommendation is off until they turn it on, or they start a cloud task from codecast.
2. **Phase 0 costs.** It uses a few Codex Cloud tasks on your plan and creates one new environment on `ashot/wetrip`. OK?
3. **Agents API.** Build it now, alongside Codex Cloud, or after Phases 2 and 3 have shipped?

## Sources

- Docs:
  - https://learn.chatgpt.com/docs/environments/cloud-environments
  - https://learn.chatgpt.com/docs/cloud
  - https://learn.chatgpt.com/docs/auth
  - https://learn.chatgpt.com/docs/pricing
  - https://learn.chatgpt.com/docs/codex-sdk
  - https://learn.chatgpt.com/docs/third-party/github
  - https://learn.chatgpt.com/docs/third-party/linear
- Agents API:
  - https://developers.openai.com/api/docs/guides/agents-api/overview
  - https://developers.openai.com/api/docs/guides/agents-api/sessions
- Source: https://github.com/openai/codex (`codex-rs/cloud-tasks`, `cloud-tasks-client`, `backend-client`, `login`), commit `94d642d8b40e`
- Community:
  - https://github.com/kitamura-tetsuo/auto-coder (follow-ups in production)
  - https://github.com/B4PT0R/codex-backend-sdk
  - https://github.com/shoyu-ramen/codex-chats-mcp
- Issues:
  - https://github.com/openai/codex/issues/12651 (Enterprise 403)
  - https://github.com/openai/codex/issues/46174 (status inconsistency)
- DevDay coverage: https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/
