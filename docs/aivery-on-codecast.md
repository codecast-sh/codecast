# Aivery on Codecast — an open framework for "tag an agent into your work"

> Status: design / discussion. Author: derived from a deep read of Anthropic's
> Claude Tag, Union's Aivery ops agent, and codecast's actual code (file:line
> references throughout). Nothing here is built yet.

## The one-sentence thesis

Anthropic's **Claude Tag** lets you `@Claude` into a Slack channel and it does real
work under its own identity, remembers context, follows up on its own, and links its
GitHub commits back to the thread that started them. Union already built that — the
hard way, a year early — as **Aivery**, a co-founder persona that lives in Slack, is
woken by events, keeps its own memory, and commands a remote Claude Code machine to do
the actual code work. **Codecast already owns every expensive piece of that machine.**
So the open-source product is not "port Aivery's framework." It is: keep Aivery's three
genuinely original patterns — the persona, the event→wake autonomy bridge, and the
brain/hands split — and run them on codecast, which already provides sessions, memory,
scheduling, shareable audit links, and multi-machine hands.

## What Claude Tag actually is (the spec we are matching)

From Anthropic's support article, the properties that matter:

- **Tag-to-act.** You `@mention` it in a channel (or DM it, or use a side panel) and it
  takes on real work using the org's tools and the shared context around it.
- **Its own identity.** It posts as itself, not as the human who summoned it. In channels
  it works under the org's identity/tools; in DMs under your personal account.
- **Persistent memory, scoped.** Context is kept per channel and per workspace; admins can
  view/edit/delete it. Memory respects channel boundaries.
- **Acts on its own.** It follows up without being re-prompted — posts when a job finishes,
  tags you when a thread stalls, runs standing/scheduled work.
- **Traceable.** Commits and PRs show the Claude GitHub App as author with a link back to
  the Slack thread that started them. An audit view lists every scheduled and one-time task.
- **Governed.** Org-wide and per-channel spend caps; role-based access; "work that would go
  over a limit is declined, never silently cut short."

That is the target surface. Every property above has a codecast-native home (below).

## What Aivery is (the thing we are extracting patterns from)

Aivery lives in `~/src/union-mobile/outreach/backend`. It has four moving parts plus a
persona:

1. **A declarative agent + tool spec.** `AgentDefinition = { model, buildSystemPrompt(ctx),
   tools[], maxSteps, maxCostUsd, enableMemory }`. A tool is `{ name, description, zod schema,
   execute(input, ctx) }` with three sharp touches: `contextOutput` (a slim version fed back
   to the model while the full output is stored for audit), `isTerminal` (a tool that ends the
   run), and a per-tool `timeoutMs`.
2. **A runner loop** (`runAgent`, ~1100 lines): insert an `agent_run`, build a 3-layer context
   budget, assemble the system prompt, then loop ≤ `maxSteps` calling the model with tools,
   executing each tool call with a timeout, persisting every step to `agent_steps`, stopping on
   a terminal tool or a no-tool text answer. Guarded by cost cap, wall-clock cap, external-cancel
   check, and per-agent budget billing.
3. **The autonomy bridge** (the most valuable idea). Everything that happens writes an
   **activity** (scoped global/contact/match/issue/slack-channel). `dispatchActivityTriggers`
   matches each new activity against trigger rules agents register (event type + scope filter +
   data condition) and enqueues a run. A job fails, a CC session goes idle, an email arrives →
   the right agent wakes with the right scope. It also handles dedup windows, burst-coalescing
   (six rapid texts → one run), and XOR routing (exactly one agent answers each message).
4. **Memory + context engineering.** A 3-layer budget (recent raw / lightly compressed / heavily
   compressed), hourly compression, `zoom_in` to re-expand a compressed chunk, and an editable
   per-agent memory table.

- **The persona** is a co-founder system prompt (own the business, two levers, peer-not-assistant).
- **The surfaces** are all just triggers into the same loop: `@mention`/DM/bot-thread (Slack webhook
  → enqueue), a ~3h scheduled check-in, CI failure, an admin web chat (SSE-streamed), AgentWatch
  spotlights.
- **The hands** are the remote Claude Code machine: `create_cc_session` / `send_to_cc_session` /
  `start_claude_session(branch→auto-PR)` hit a bespoke "intern" HTTP service that runs Claude Code
  in tmux worktrees on a remote box; when a session goes idle it calls back a webhook → writes an
  activity → the trigger bridge re-wakes Aivery with the output. Fully async, event-driven.

## The reframe: codecast already owns the expensive parts

| Aivery built by hand | What it does | Codecast equivalent (with evidence) |
|---|---|---|
| The "intern" service (tmux + worktrees + HTTP + idle webhook) | Spawn / steer / wake remote Claude Code sessions | `cast spawn` → `POST /cli/spawn` → `createSessionFromCli` (`spawn.ts:32`) → `daemon_commands` start_session → daemon tmux spawn (`daemon.ts:1888`). Multi-machine, multi-agent (claude/codex/cursor/gemini). |
| `send_to_cc_session` + idle re-wake | Deliver a follow-up to a running OR dormant session | `cast send` → `POST /cli/messages/send` → `pending_messages` → `deliverMessage()` (`daemon.ts:10828`): injects to a live pane, or **auto-resumes a dormant session from Convex JSONL**. |
| `runAgent` while-loop + `agent_steps` | The agentic loop | **No port needed.** A codecast session *is* the loop — Claude Code runs tools to completion, goes idle, can be re-woken. |
| `agent_runs` + activity feed + admin web chat | Audit / inspect / share a run | Session sync + `conversations.share_token` → `/share/<token>` guest URL + `cast link <id> [line]` (`#msg-<uuid>` anchors) + the web/desktop/mobile dashboard. |
| `dispatchActivityTriggers` (event → enqueue run) | Wake an agent on an event | `agent_tasks.event_filter` → `matchTaskTriggers` (`agentTasks.ts:519`) → patches `run_at=now()` → `TaskScheduler` (30s poll) spawns/injects. **Event-type-neutral string match** — see Gap C. |
| `agent_memories` + 3-layer context | Persistent scoped memory | The session's `CLAUDE.md` + the per-project memory dir (`MEMORY.md` index + one-fact files) + `cast task`/`plan`/`doc` persistence. |
| `AGENT_BUDGET_MAP` / `maxCostUsd` | Spend governance | `agent_tasks.max_runtime_ms` exists; per-run cost caps do **not** — see Gap D. |

The pattern: **the two hardest things Union built from scratch (the remote-session service and
the run audit/share surface) are exactly what codecast already does, and does better** —
multi-machine, multi-agent, with a real dashboard and guest-shareable links.

## The architecture: brain + hands, both just codecast sessions

Aivery splits into a **brain** (the ops agent, woken repeatedly) and **hands** (fresh CC sessions
it spawns for code work, whose completion wakes the brain). That split maps onto codecast and tells
us where the loop lives.

The grounding surfaced a reframe that *strengthens* the long-lived model rather than arguing against
it. Notice Aivery is itself **not** a long-lived conversation: every wake (`runAgent`) assembles a
*fresh* context from durable stores — activity log, memory table, task roster — runs to completion, and
discards the transcript. It had to be stateless: Postgres + pg-boss gave it nowhere to keep a living
conversation, so it faked persistence with side-stores. **Codecast has exactly the substrate Aivery
lacked — a real, resumable session — so it can build the thing Aivery could only imitate. And a
standing, never-ending agent member is precisely the primitive codecast does not have today** (every
session is currently an ephemeral, human-owned unit of work). That gap is the product opportunity.

So the brain is **one long-lived codecast session per persona** — owned by the Aivery service user,
never marked complete, woken by events via `cast send` (auto-resume brings it up when dormant) — and
the hands stay ephemeral. The two hard parts of "long-lived" both have native answers:

- **Context growth** → Claude Code already auto-compacts, which bounds the live transcript; the
  per-project memory dir + `CLAUDE.md` carry durable memory across compactions (the same memory
  machinery codecast already runs). A session can live indefinitely without its context ballooning.
- **Concurrency + channel boundary** → the brain delegates parallel and code work to ephemeral hands and
  stays free to coordinate; a busy deployment runs **one resident per channel** (shared identity, separate
  sessions are the parallelism), which also gives Claude Tag's per-channel memory boundary for free.

```
                    Slack mention / DM / thread
                              │
        ┌─────────────────────▼─────────────────────┐
        │  Slack adapter  (NEW: /api/webhooks/slack) │
        │  verify HMAC → storeWebhookEvent(            │
        │     event_type:"slack_message", …)          │
        └─────────────────────┬─────────────────────┘
                              │ reuses existing fire path
                    matchTaskTriggers (agentTasks.ts:519)
                              │
        ┌─────────────────────▼─────────────────────┐
        │  PERSISTENT PERSONA SESSION  ("the brain") │
        │  one long-lived codecast session per       │
        │  persona (optionally one per channel).     │
        │  Never completes; auto-resumes when woken. │
        │  - persona = a project skill / CLAUDE.md   │
        │  - woken by `cast send` (auto-resume)      │
        │  - durable memory = project memory dir +   │
        │    CLAUDE.md, surviving compaction         │
        │  - tools = the `cast` CLI it already has   │
        └───────┬───────────────────────┬───────────┘
                │ post back              │ delegate code work
                │ (Slack tool)           │ `cast spawn …`  ("the hands")
                ▼                        ▼
          Slack thread          fresh worktree session →
          (as the bot)          goes idle → trigger bridge
                                 re-wakes the brain with output
```

Why **a long-lived persona + ephemeral hands**:

- It is the primitive codecast lacks and the one thing this whole effort adds: a standing agent member
  with a living conversation, durable memory, and an inbox presence — not a one-shot task session.
- The persona's "tools" are *free*: any codecast session has `cast` on its PATH, so `cast spawn` /
  `cast send` / `cast read` / `cast sessions` ARE `create_cc_session` and friends. No custom tool layer.
- "Follow up on its own" falls out of the same bridge: a spawned hand goes idle → (Gap C) an internal
  event → `cast send` wakes the persona → it reads the result and posts to Slack.

## Integrating with codecast's existing system

A grounding pass against the real lifecycle code answered the load-bearing question — *will codecast's
own garbage-collection kill a session that is supposed to sit dormant for days?* — and the answer is
**almost no**. The long-lived primitive is close to native; the work is small and named.

### What already works (reuse, no change)

- **Waking a dormant persona.** `cast send`'s auto-resume path (`deliverMessage`, `daemon.ts`) already
  materializes a dormant session from Convex JSONL, spins a process, and injects the message. The wake
  mechanism *is* the existing message-delivery path.
- **Hosting on an always-on machine.** `owner_device_id` + `claimConversationForStart` (`devices.ts:605`)
  already pin a session to one daemon — a remote/cloud daemon owns the persona, local daemons skip
  delivery, and ownership self-heals if the host drops. Point the persona at the headless m1 or a cloud daemon.
- **Bot identity (Gap A collapses to one row).** A synthetic `users` row ("Aivery", name + avatar, no login)
  renders as its own member because `resolveSessionAuthor` / `isForeignSession` (`liveEntities.ts`) key the
  author chip off `user_id`. No schema or rendering change to show "Aivery" with its avatar. Add it to the
  team via `team_memberships` (which references a normal `users` id) and it appears in the team feed.
- **Standing presence in the inbox.** Pinning (`is_pinned` / `inbox_pinned_at`) gives a stable top slot
  *and* exempts the session from the idle→needs-input reclassification churn — the work-state logic carries
  `AND NOT pinned` throughout (`inboxStore.ts`). A pinned persona sits at the top as "available" without
  thrashing buckets on every heartbeat.
- **Never auto-completes server-side.** `conversations.status` stays "active" indefinitely unless explicitly
  marked; server reaping (`reapStaleManagedSessions`, `managedSessions.ts:942`) only deletes a housekeeping
  registry row, never the conversation.

### The one real lifecycle change (net-new, surgical)

The **daemon watchdog** is the single thing that would kill a dormant persona: `shouldMarkSessionCompleted`
(`daemon.ts:12399`) marks a session "completed" after 10 min (idle/stopped) or 30 min (working) when it finds
no live process — it checks only liveness, never intent. A persona that is *deliberately* dormant trips it.

Fix: a conversation flag (`persistent: true`, or `auto_completion_disabled`) and one guard at
`daemon.ts:12406` — `if (persistent) return false;`. That is the entire lifecycle change. Deliberately we do
**not** fake a heartbeat to keep it "green": a dormant persona is honestly dormant (available, not working),
and pinning keeps it stable without the lie. It goes live only when an event actually wakes it.

### Wake routing (net-new, small)

Triggers must wake the *persona's* conversation, not spawn a new one. The existing event→trigger bridge
(`matchTaskTriggers`) spawns or injects-to-originating; the new piece is an "inject into THIS standing
session" target plus a `(surface → persona conversation_id)` map. The primitive is `cast send <persona_conv>`;
the registry is what knows which persona owns which channel.

### Persona injection (Gap B — ship-now path needs no new seam)

The spawn path (`createSessionFromCli`, `daemon_commands.args`) carries `model`/`effort` but no system prompt.

- **Ship now:** package the persona as a **project-scoped skill** (`.claude/skills/aivery/SKILL.md`) — codecast
  already discovers and syncs `.claude/skills/*.md` per session (`daemon.ts:744` `readAvailableSkills`), and a
  skill body *is* a system prompt. Or put it in the project's `CLAUDE.md`. The persona adopts on start.
- **Clean seam (later):** thread an optional `append_system_prompt` (or `agent: "aivery"`) through
  `createSessionFromCli` → `daemon_commands.args` → the daemon's `claude …` invocation as
  `--append-system-prompt`. The natural home for a future `.claude/agents/<name>.md` registry shaped like
  Aivery's `AgentDefinition`.

### Internal events as triggers (Gap C — the most valuable lift from Union)

Today the trigger matcher fires only on **external GitHub webhooks**. Aivery's bridge fires on *any* activity,
crucially when a spawned hand goes idle — that is how a finished hand re-wakes the brain.

- **Ship now (no backend change):** the brain tells each hand, by persona instruction, to run
  `cast send <persona> "done: …"` as its last step. Zero infra; how a human would wire it; but an LLM honor
  system with no structured payload.
- **Productized:** emit an internal `session_idle` event into the same `storeWebhookEvent` path so a persona can
  register `event_filter: { event_type:"session_idle", … }` and be woken — generalizing codecast's GitHub-only
  bridge into Aivery's any-event one. **Carry over Aivery's dedup window** when wiring this: naive event→wake
  double-fired and sent the same introduction 3× (the bug that forced `dispatchActivityTriggers`'s dedup +
  burst-coalescing). Reproduce that protection or reproduce that bug.

### Identity ⇄ spend, and governance (Gaps A-spend + D)

The synthetic Aivery user needs **its own Claude credentials** — every `cast spawn` it issues bills somewhere.
Decide this *with* identity, not after: a dedicated API key / subscription seat for the bot, so its spend is
attributable and cap-able. For v1 (single dogfooding team), `max_runtime_ms` plus a per-persona daily session
ceiling suffices; the per-channel cost cap, threshold alerts, and "decline, never silently truncate" behavior
are required before any multi-tenant exposure. Bake decline-not-truncate into the *persona's instructions* even
before it is enforced in code — the agent should escalate rather than ship half a job.

## Build phases

**Phase 0 — Persona as a session, by hand (proves the loop, zero new code).**
Create the Aivery service user; start one session in a chosen project with the persona as a project skill /
`CLAUDE.md`; manually `cast send` it a task; confirm it uses `cast spawn` for code work and the hand
`cast send`s its result back. Validates brain+hands end-to-end with nothing built. (The session may still be
watchdog-reaped after idle — that's what Phase 1 fixes.)

**Phase 1 — Make it actually persistent (the enabler for everything else).**
Add the `persistent` conversation flag + the one-line watchdog exemption (`daemon.ts:12406`); pin the persona
(`inbox_pinned_at`) so it holds a stable inbox slot; host it on an always-on daemon via `owner_device_id`; give
the Aivery user its own Claude credentials. After this, a dormant persona survives indefinitely and wakes on
`cast send`. Small, surgical, mostly reuse.

**Phase 2 — Slack adapter (the one new HTTP surface).**
`/api/webhooks/slack` httpAction in `packages/convex/convex/http.ts` (mirror the GitHub handler's HMAC verify
at `http.ts:207`) → `storeWebhookEvent({ event_type:"slack_message", action:"mention"|"dm"|"thread", … })`.
A `(channel → persona conversation_id)` map; mention → `cast send` the persona via existing delivery; a Slack
Web API post-back the persona calls to reply *as the bot*.

**Phase 3 — Internal `session_idle` trigger (Gap C, productized).**
Route daemon idle detection into `storeWebhookEvent` / `matchTaskTriggers` so the persona wakes on hand
completion without the by-hand `cast send` convention — the general autonomy bridge. Carry over Aivery's dedup
window.

**Phase 4 — Persona seam + agent registry (Gap B, productized).**
`append_system_prompt` through spawn→daemon; optional `.claude/agents/<name>.md` shaped like Aivery's
`AgentDefinition`. Ship Aivery as the reference persona. Makes N personas trivial — deploy one until a second
overlaps a surface (then, and only then, build routing).

**Phase 5 — Identity polish + governance.**
`users.is_bot` + metadata + no-self-notify; per-channel cost cap with decline-not-truncate, threshold alerts —
required before any multi-tenant / public exposure.

## Resolved positions

1. **Long-lived persona, not a stateless dispatcher.** A standing agent member with a living conversation is the
   primitive codecast lacks and the whole point; Aivery is stateless only because it had no session substrate to
   keep one in. Context growth is bounded by compaction + the memory dir; concurrency by delegating to ephemeral
   hands and (for busy deployments) one resident per channel.
2. **Codecast is the home; Slack is adapter #1.** The core is an agent that lives in codecast — sessions, memory,
   shareable audit links — woken through a pluggable comms surface. Slack is the first producer; the in-app `@agent`
   is a trivial second one. The shareable audit link is the differentiator over Claude Tag's closed Slack pipe.
3. **Build the seam for N personas, deploy one.** Persona = a named markdown definition + a channel→persona map.
   Don't build which-persona-claims-this arbitration until a second persona actually overlaps a surface.
4. **A persona (standing member) is a different axis from a subagent type (transient role).** Explore / implementer /
   reviewer / critic are roles inside an orchestration; a persona has identity, memory, and a comms surface. The
   persona registry is new, not a rename of the subagent-type registry.
5. **Identity and spend are one decision.** The bot's own Claude credentials are decided with its identity, because
   they gate governance.

## What this is NOT

Not a port of Union's Drizzle/Postgres/pg-boss runner — that loop is replaced by Claude Code. Not a new agent
engine — codecast's session is the engine. The deliverable is thin: a persistence flag, a Slack producer, one
internal trigger event, a persona seam, and a bot identity — layered on a spine codecast already ships. The one
genuinely new *primitive* is the long-lived agent member, and the grounding shows it costs a single flag plus reuse.
