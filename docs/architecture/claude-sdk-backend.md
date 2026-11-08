# Claude SDK backend

Codecast can run a Claude Code session through Anthropic's Agent SDK
(`@anthropic-ai/claude-agent-sdk`) instead of typing into a tmux pane. It is a
second backend beside tmux, chosen per session, and off by default.

Typing into a pane causes a class of failures codecast keeps fixing: chunked
typing and paste wrappers, `send-keys` dropping a trailing `;`, delivery
receipts that re-type messages, permission hook posts dropped by the launch
token fence, and a Working status guessed from the pane. The SDK gives
in-process callbacks for permissions, `priority: "next"` for a message sent
while a turn runs, a real interrupt, and an init message that reports the
version, account and models.

## Choosing the backend

`chooseClaudeBackend` (`packages/cli/src/claudeSdk/select.ts`), first match wins:

1. `backend: "sdk" | "tmux"` on the start_session command (the per-session switch a later track adds to the UI).
2. `CODECAST_CLAUDE_BACKEND=sdk` in the daemon's environment.
3. `claude_backend: "sdk"` in `~/.codecast/config.json`.
4. Otherwise tmux.

Before an SDK start the daemon runs `claude --version` on the binary the tmux
path would launch (cached per file) and starts tmux instead when it is older
than `MINIMUM_CLAUDE_VERSION` (2.1.248), logging why. The host checks again
against the version in Claude's initialize reply; a host that finds it too old
stops, the daemon drops the SDK binding, posts the reason as the session's
error, and the next message runs the session in tmux.

## Shape

```
daemon ──unix socket──▶ host process (`cast _claude-sdk-host <spec>`, its own launchd job)
                          └─ SDK query() ──stdio──▶ the user's claude (same binary and account as tmux)
                                                     └─ writes ~/.claude/projects/<cwd>/<session>.jsonl
daemon's transcript watcher ◀── reads the same JSONL as for a tmux session
```

| Piece | File | Job |
|---|---|---|
| Launch options | `claudeSdk/options.ts` | Turns the exact argv the tmux path builds (`buildLaunchArgs`) into SDK options, plus the launch env. |
| Session | `claudeSdk/session.ts` | One SDK query with streaming input: sends, steer, interrupt drain, permission prompts, status. |
| Host | `claudeSdk/host.ts` | The long lived process: owns the query, serves the socket, keeps state on disk. |
| Protocol | `claudeSdk/protocol.ts` | JSON lines between daemon and host. |
| Client | `claudeSdk/client.ts` | Daemon side of one host: launch, connect, reconnect, requests. |
| Backend | `claudeSdk/backend.ts` | Which conversations run on the SDK, and start / deliver / interrupt / stop / reattach. |
| Poll answers | `claudeSdk/pollAnswer.ts` | The web's AskUserQuestion and plan-card answers, read as SDK answers. |
| Daemon wiring | `daemon.ts` | Search `claudeSdkBackend`. |

### What the session keeps from Claude Code

An SDK session is meant to behave like the tmux session of the same account,
model, effort, permission mode and cwd:

- **Binary**: `pathToClaudeCodeExecutable` is the stable copy `launchBinary` picks for tmux. The SDK's bundled `claude` is never run. Claude is spawned behind the same `cast _disclaimed --` wrapper, so macOS privacy prompts name Claude.
- **Account**: the host is started under the same shell prefix the tmux launch line starts with (`launchAccountPrefix` plus the provider key file), so it runs on the same login or pinned profile. A resume asks the server for the account (`pinForResume`), as the tmux resume does, so a session moved off a spent account after a usage limit comes back on the new one.
- **Settings**: `settingSources` is left unset, so user, project and local settings load as in the terminal: CLAUDE.md files, hooks, skills, plugins, MCP servers. The system prompt is the `claude_code` preset; an agent definition's prompt is appended to it (or replaces it with `--system-prompt`), as on tmux.
- **Context injection**: codecast's stable context arrives through its SessionStart hook, which runs in SDK sessions. The launch env carries the same `CODECAST_STABLE_*`, launch token, worktree ports and cloud-host variables as the launch line.
- **Model, effort, permission mode, tool policy, session id**: parsed from the tmux argv (`parseClaudeArgs`), so the two cannot drift. Flags the parser does not know ride `extraArgs` unchanged.

### Launch hygiene (both backends)

- `MCP_TOOL_TIMEOUT` is unset on every Claude launch (`AGENT_LAUNCH_UNSET_ENV`, `agentEnv.ts`). It caps every MCP call and fails cast's long tools and a permission prompt waiting on a person.
- `CLAUDE_CODE_EFFORT_LEVEL` is unset whenever codecast passes `--effort`, on start and resume, since it would beat the flag.
- `CODECAST_CLAUDE_BACKEND` (the daemon's selector) and `CODECAST_SDK_SESSION` (the in-session marker the status hook reads) are unset on every launch, and the daemon's own start scrubs the marker too. Only an SDK host's Claude gets the marker, and never the selector, so nothing a session runs can switch a daemon it starts to the SDK backend, and a tmux pane never silences its own status hook.
- The nested session markers (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, …) are dropped and transcript persistence is pinned on, as for tmux.

## The host process

One per Claude session, started as an Interactive launchd job
(`sh.codecast.claude-sdk.<session id>.<launch>`, a label of its own per
launch so a dying host's unload of its own job never reaches the host that
replaces it; via `launchdJob.ts`), or as a detached
child where launchd cannot take a job. Its files live in
`~/.codecast/claude-sdk/`:

| File | Holds |
|---|---|
| `<id>.sock` | The socket, 0600. |
| `<id>.json` | The host's state, rewritten on every change: pid, status, pending prompts, last activity, last error. Removed when the host exits cleanly; a killed host's is cleaned up by the next resume or forget. |
| `<id>.spec.json` | The launch spec. No secrets. Removed with the state file. |
| `<id>.log` | The host's log and Claude's stderr. Removed when the conversation is forgotten. |
| `conversations.json` | The daemon's bindings: conversation → current Claude session, host id, spec, account. The one home of "this conversation runs on the SDK". |

The launchd plist is deleted as soon as the job is loaded: it carries the
daemon's environment, and launchd keeps the job without it. The host unloads
its own job when it exits.

The host exits when Claude exits (a stop, `/exit`, a crash) or on SIGTERM.
It does not exit when the daemon goes away; the daemon restarts on every CLI
update and reconnects.

### Protocol

One JSON object per line. Daemon to host (`ClientFrame`):

| op | Does |
|---|---|
| `hello` | Replies with the full state. Sent on every connect. |
| `send {id, messageId, text, images?}` | Queues a user message. `messageId` is the codecast message id; a repeat of the same messageId is acknowledged as a duplicate and not sent again. While a turn runs the message goes in with `priority: "next"`. |
| `interrupt` | Interrupts the running turn and replies once its result is written. |
| `answer {requestId, answer}` | Answers a pending prompt. Refused when it is no longer pending. |
| `annotate {requestId, cardId}` | Records the web card opened for a prompt, so a reattached daemon binds to it instead of opening another. |
| `set_model`, `set_permission_mode` | The SDK's live controls. |
| `stop` | Interrupts, closes the input, lets Claude flush and exit. |

Host to daemon (`HostFrame`): `state` (full snapshot), `reply`, `permission`
(a prompt Claude is blocked on), `permission_settled` (answered, or aborted by
an interrupt or the turn ending), `activity` (status, below), `session` (Claude
moved to a new session id), `result` (a turn ended, with its error if any),
`too_old`, `exit`.

Every frame is either a snapshot or an event the daemon can apply twice, so a
daemon that reconnects mid-prompt sends `hello`, gets the pending prompts in
the state, and carries on.

### Failure handling

- **Daemon restart**: `reattachAll` connects to every host whose pid is alive. A delivery that races the reattach shares the same attach (`ensure`).
- **One operation at a time**: a conversation's start, attach, resume and stop run in order behind one lock in the backend, so a start never races a resume into two hosts and a message that arrives while a host boots waits for it. Before the backend sees a start (worktree setup, teardown), a message for a brand-new conversation waits for the start as on tmux, and any later resume reaches the host through `autoResumeSession`.
- **Host busy**: a host is treated as gone only when its process is: a live pid whose command line is the host entry (a pid recorded before a reboot that now names another process does not count). A live host that does not answer is retried; the daemon never starts a second host for a session whose host process lives.
- **Stop**: waits until the host's process has exited, so a host started next with the same session id never shares files with it. A host that does not take the stop request is sent SIGTERM, then SIGKILL.
- **A start for a session Claude already wrote** resumes it instead of passing `--session-id` for an existing transcript.
- **Host death**: the client reports it gone, the daemon reports the session stopped, and the binding stays. The next delivery (or any automatic resume) starts a new host with `resume` on the saved session; the transcript keeps the same file. Each message's first send time is recorded in the binding (so the record survives a daemon restart). A host acknowledges a send once it is in its own queue, before Claude has taken it, so any retry of a message (its host died, the server put the row back) checks the tail of the transcript and is sent again only when Claude never got it. The host also treats a repeated message id as the same send, including one retried while Claude is still starting.
- **Up means initialized**: a start or resume succeeds only once Claude has answered initialize (180s). A Claude that never does (a stuck MCP server, a login wait) fails the start, its host is stopped, and the start falls back to tmux, rather than every delivery waiting on it.
- **Process checks** (is this pid still our host?) run `ps` asynchronously, so a loaded machine never stalls the daemon's loop on them.
- **Startup timeout**: a host that does not answer within 90s is killed (its launchd job is unloaded, or its process group killed) and the start drops its binding, so neither a late host nor a delivery queued behind the start keeps running beside the tmux fallback (the job's unload is asynchronous, so for a moment the two can overlap).
- **The resume gate** is applied inside the backend at the moment it decides to launch a new host, under the conversation's lock, so a message that queued behind a kill cannot bring the session back. A session Claude never wrote a transcript for (started, never messaged) starts fresh under the same id instead of failing to resume.

## How each codecast path treats an SDK session

### Delivery

`deliverMessageIntoSession` tries the SDK backend first (`trySdkDelivery`).
The message row is marked injected before the send, as for a started pane, and
Claude's own JSONL echo promotes it to delivered; an answer to a question or
plan card has no echo (it reaches Claude as a tool result), so it is marked
delivered at once, as the tmux path marks a menu answer. A delivery that would
bring a dead host back passes the same resume gate as any resume, so a killed
conversation stays down; refused, the message retries. A failure throws, so the
message is retried through the SDK, never pasted into a pane.
`autoResumeSession`, the one chokepoint of every automatic resume, sends an
SDK-owned session to its host after the same lifecycle and owner gates
(`resumeAllowed`), so no path can start a tmux copy of it.

Images: the daemon still downloads each attachment and writes its
`[Image /path]` tag into the text, as for tmux; the SDK path keeps that text
(so the JSONL echo matches the pending row) and also attaches each image as a
base64 image block when the API takes it inline (PNG, JPEG, GIF or WebP up to
3.5 MB). A bigger or HEIC image rides its tag alone, as on tmux, and Claude's
Read tool opens and resizes it.

### Permissions and questions

`canUseTool` holds the call in the host. The daemon builds the same
`PermissionHookInput` a PermissionRequest hook would post, opens the same card
(`openPermissionRecord`, with the card prompt shared with the hook handler as
`permissionCardPrompt`), and waits in the same `PermissionHookWaiters` the hook
waits in. The waiter's output is the hook's decision JSON, which is exactly the
shape `canUseTool` returns, so allow, deny, deny with a reason, and "remember"
(the suggested rules as `updatedPermissions`) all behave as on tmux. The card
opens before the `permission_blocked` activity reaches the status sink, so the
sink's own card path stands down (`permissionRecordPending`).

The status hook (`codecast-status.sh`) exits at once when
`CODECAST_SDK_SESSION` is set, so no PermissionRequest hook prompts twice.

EnterPlanMode and the task-list tools (TaskCreate, TaskUpdate, TaskList,
TaskGet) have no web card on either backend; tmux answers their ask through
the pane. An SDK session has no pane, so the host allows them outright: none
of them acts on the world.

AskUserQuestion and ExitPlanMode are not cards. Their tool call is already in
the transcript while Claude waits (checked in the e2e run), so the web renders
its usual question or plan card from it. The answer arrives as the usual
`__cc_poll` message; `pollAnswer.ts` reads its keys against the question
(digits pick options, a multiSelect's digits toggle until Right, free text
answers in the person's words, a pick that names no option dismisses the
question rather than leaving Claude waiting) and the plan card (starting the
plan returns the session to the mode it had before plan mode, so a bypass
session stays bypass; requesting changes sends the feedback and keeps planning). Plain text sent while a question
is open closes the question and then goes in as the person's own message, as
typing at the terminal does, so the transcript holds it and its pending row is
acknowledged. The transcript check was made on a single-question
AskUserQuestion; a multi-question form was not checked.

A card that expires (the card's own one hour bound) or could not be created
denies the call: an SDK session has no terminal dialog to fall back on, and
canUseTool would otherwise wait forever.

### Status

The host reports what the status hook would have posted, in the same
vocabulary (`SdkActivity`), and the daemon feeds it through the sink a hook
post takes (`hookStatusGate.deliver` → `handleStatusData`), launch token
included, so the settle classifier, needs-input pushes, unread, compaction
handling and heartbeat all read it as they read a tmux session:

| Hook event | SDK source | Status |
|---|---|---|
| SessionStart (startup, resume) | initialize reply | `idle`, session boundary |
| UserPromptSubmit | a send that starts a turn | `thinking` |
| PreToolUse | an assistant message with a tool call | `working` |
| PermissionRequest | `canUseTool` | `permission_blocked`, dialog, with the tool and preview |
| PreCompact | `system/status` compacting | `compacting` |
| Stop | the turn's `result` | `idle` with the turn stamp and transcript path |
| SessionStart (clear) | a result after Claude moved session | `idle`, session boundary |

Whether a turn runs comes from Claude's own `session_state_changed`
(running, idle) as well as from our sends, so a turn Claude starts itself (a
background task that finished, a hook continuation) reads as working, can be
stopped with Escape, and settles when it ends. Which of our sends are still running comes from the turn results that name
them and from Claude's per-message `command_lifecycle` events (`completed`,
`cancelled`), so a send whose turn ends without a result naming it (a local
command) still settles. A host that exits reports `stopped` and its liveness heartbeat stops; a resume starts it again. Liveness heartbeats come from the
daemon's managed-session heartbeat like a codex app-server thread's; SDK
sessions stay out of `resumeSessionCache`, so the pane health sweep, the pane
reaper and the interactive-prompt scrape never see them, and the stale-status
watchdog skips them (by conversation, so an id a `/clear` left behind is
skipped too) and the transcript reconcile never overrides a prompt they are
blocked on: their Claude has no tty for the process lookup to find, and the
host says itself when it is gone. A daemon that reattaches reports the host's
last activity from its state snapshot, so a turn that ended or a prompt that
opened while no daemon listened is filed where it stands.

### Transcripts

`persistSession` stays on and nothing is ingested from the SDK stream: Claude
writes its JSONL where it always does and the watcher syncs it. The e2e run
reads it back with the daemon's `parseSessionFile`: every prompt in order,
one file across a host kill and resume. The first user line carries
`entrypoint: "sdk-ts"`, which `detectCliFlags` does not mark `--print`, so the
session is not counted as a headless program run.

A reattached daemon that binds to an existing card marks the prompt pending as
it does for a card it opens, so the status sink never opens a second one.
A known narrow window: the card id reaches the host a moment after the card is
created. A daemon that dies inside that moment reopens the prompt on its next
start with a second card; the first stays on the web unanswered.

`/clear` moves Claude to a new session id and a new JSONL inside the same
host. The host reports it, the backend follows it (the next resume uses the
new id), and the daemon rebinds the conversation to the new session
(`bindSdkSession`), which the tmux path learns from the SessionStart hook.

## Slash commands

Checked against Claude Code 2.1.319 through the SDK (streamed messages are not
sent with `verbatimPrompts`, so Claude dispatches commands):

| Command | Through the SDK |
|---|---|
| Custom commands (`.claude/commands`) | Work (checked). |
| Skills (`/<skill>`) | Work (checked). |
| `/model <name>` | Works (checked); the next turn runs on the new model. `set_model` is also on the protocol. |
| `/compact` | Works (checked); emits the compacting status and a compact boundary. |
| `/context` | Works (checked); the answer is the turn's reply. |
| `/clear` | Works (checked); moves the session (above). |
| `/exit`, `/cost`, `/usage`, terminal UI commands (`/config`, `/login`, the `/resume` picker) | Not checked. `/exit` would end Claude and so the host; the next message resumes the session. |

## Parity matrix

| tmux-path feature | SDK status |
|---|---|
| Start in a project, worktree (`isolated`), folder remap | Works: same code before the branch. |
| Model, effort, permission mode, configured args, default params | Works: parsed from the same argv. |
| Agent definitions (tool policy, prompt) | Works: tool flags as argv, prompt appended to the preset. |
| Per-session account (`cc_account`), fleet store, provider keys | Works: same shell prefix wraps the host. |
| OAuth refresh gate (`ccLiveGate`) | Handled differently: the SDK's Claude is counted as an unstamped holder (`unstampedClaudeHolders`), attributed to the keychain login even when pinned. |
| Stable context SessionStart hook | Works: hooks load. |
| User and project hooks, CLAUDE.md, skills, MCP servers | Works (e2e: CLAUDE.md and project hooks). |
| Launch prompt carried on the command line | Handled differently: the waiting message is delivered as the first streamed user message, never as third-party pasted text. |
| Message delivery, retries, dedupe | Works: streaming input; the host dedupes by message id; the transcript is checked before a resend after host death. |
| Mid-turn messages | Better: `priority: "next"`, read at the next tool boundary. |
| Escape / interrupt, stop-and-send | Works: a real interrupt. The Escape command answers at once and the drain runs off the command queue; a stop-and-send message is released once the turn has drained. A message queued behind the turn still runs, per Claude's interrupt receipt. |
| Images | Works: image blocks plus the usual tag text. |
| Permission cards, remember, deny with reason | Works: same card and waiter. |
| AskUserQuestion, ExitPlanMode cards | Works: rendered from the transcript, answered by poll payload. "Clear context" on the plan menu keeps context. |
| Terminal dialogs scraped from the pane (trust, limit menu, `/model` picker) | Not needed: no pane; headless Claude raises none of them. |
| Status reporting, settle, needs-input | Works: hook-equivalent activity through the same sink. |
| Limits and billing errors | Works: Claude writes the same limit message to the JSONL, which the daemon's limit detection reads; the host also records the error kind. |
| set_permission_mode | Works: through the host (`setPermissionMode`), cycling as Shift+Tab does when no target is given. |
| Kill, Restart, account recycle | Works: the host stops, the binding survives (unless the kill released the session's worktree; then a Restart finds its folder as a tmux resume does), a Restart marks the conversation active again, a Restart resumes on the SDK in its own host or fails with the reason on the session (it never falls into the tmux repair, reconstitution or blank-pane paths); the resume gate keeps a killed session down. A Restart's model or effort choice is not applied to Claude, on either backend. |
| Agent switch, a new start, any other teardown | Works: every teardown except a kill drops the binding, so the next agent never shares the conversation with the old host. |
| move_to_device | Works: teardown stops the host. |
| Daemon restart | Works: hosts survive and are reattached. |
| Host or Claude crash | Works: resumed on the next message. |
| /clear | Works: rebinds to the new session. |
| fork_session | Gap: a fork of an SDK conversation starts in tmux. |
| Command queue during a slow SDK start | Gap: start_session waits for the host and Claude's initialize (seconds normally; up to about five minutes when Claude hangs at startup), and commands in the same batch wait behind it. |
| Hibernation (`max_live_sessions`) | Gap: SDK hosts are not counted toward the cap or parked; an idle host lives until stopped. |
| Turn snapshots | Works: requested from `turn_completed_at` in the status sink, which SDK activity carries. |
| Bash edit capture and other codecast hooks besides the status hook | Works: they load with the user's settings. |
| Terminal attach (watching the pane) | Gap by design: there is no pane. The transcript is the view. |

## Subscription quota

There is an unverified report that SDK and `claude -p` use draws a Claude
subscription faster than interactive use. What can be measured here:

- Every SDK turn in the recordings carried a `rate_limit_event` against the
  account's `seven_day` window with `isUsingOverage: false`: the turns counted
  against the plan, not overage. The utilization moved 0.10 to 0.21 over the
  recording session, with other sessions on the same account, so it cannot be
  attributed to these turns.
- `result.total_cost_usd` and `modelUsage` give a per-turn token count. A turn
  through the SDK sends the same system prompt and tools as the terminal (the
  `claude_code` preset, all settings sources), so its input size matches an
  interactive turn of the same session; no SDK-specific overhead showed up.
- opencode's recording of 2026-10-17 shows Claude Code rejecting an SDK turn
  with "API Error: 400 Third-party apps now draw from your extra usage, not
  your plan limits." That was a third-party product with its own entrypoint
  and isolation settings. Codecast's SDK sessions run the user's own `claude`
  with `entrypoint: "sdk-ts"` and were billed to the plan in every recorded
  turn, but the policy can change; a turn rejected this way surfaces as the
  turn's error (`turnError`) and in the transcript.

A real comparison needs the same prompt run both ways on an idle account,
reading the window's utilization before and after each; that has not been done.

## Tests

`packages/cli/src/claudeSdk/*.test.ts`. The SDK is never mocked: a fake
`claude` (`testing/fakeClaude.ts`) replays recorded real sessions
(`__fixtures__/recordings/`), so tests run the real SDK, and for the process
tests the real host as its own process. Covered: startup, a plain turn,
permission allow and deny, AskUserQuestion, mid-turn steer, interrupt drain,
a usage limit, the too-old fallback, `/clear`, a daemon that reconnects to a
pending prompt and binds to its card, and resume after the host is killed.

Recordings come from `scripts/record-claude-sdk.ts` (isolated config dir, the
keychain login in the child's env only, haiku). Every line is scrubbed as it is
written: no thinking, no account identity, no personal skill, agent, plugin or
MCP names, home paths replaced. The privacy test re-applies the scrub to every
checked-in line. `limit.jsonl` is derived from `text.jsonl` with the reply
replaced by a limit error in the shape of a real `api_error` result.

`scripts/claude-sdk-e2e.ts` runs the whole backend against the real `claude`
through launchd-started hosts from the checkout, isolated from the running
daemon, and checks eighteen behaviors end to end.

## Not yet verified

The daemon wiring (start_session, delivery, cards, status through the live
sink, reattach on a real daemon restart) is covered by unit and process tests
and by the e2e run of the backend, not by a live daemon: the e2e run drives
`ClaudeSdkBackend` directly so it never touches the running daemon. The first
live check after deploy: start a session with `backend: "sdk"` (or
`CODECAST_CLAUDE_BACKEND=sdk` on the daemon), send a message, approve a
permission card from the web, answer an AskUserQuestion, press Escape mid-turn,
restart the daemon mid-prompt, and confirm the transcript and status in the web.
