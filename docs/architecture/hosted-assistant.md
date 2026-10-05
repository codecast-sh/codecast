# The hosted assistant and the simple lane

Plan pl-840. The product story is `docs/proposals/codecast-for-everyone.md`;
this is the build spec every implementer works from. Where this file and the
proposal disagree, this file wins.

## What changes from the proposal

The proposal put hosted sessions on a fleet of runner machines. Phase one
needs none: the assistant's work is a model calling connector APIs and
codecast's own verbs, and none of that needs a filesystem. So **a hosted
turn is a Convex action**. pi's agent loop and its Anthropic provider bundle
for a browser-style runtime with no Node built-ins (measured 2026-10-04:
`@mariozechner/pi-agent-core` + `pi-ai` 0.73.1, 5 MB, only
`@opentelemetry/api` left external and never loaded), so they run in the
default Convex runtime, which is the only one our self-hosted deployment uses.

Machines come back later for work that genuinely needs one (a browser, a
shell): the personal computer, a separate phase.

## Pieces and who owns which files

Parallel implementers own disjoint files. Shared files (schema, registry,
routes) are edited only by the stage named here.

| Piece | Files | Notes |
| --- | --- | --- |
| Harness `@platform/agent` | `~/src/platform/packages/agent/**`, vendored by `scripts/vendor-platform.sh` | Runtime-neutral. pi-agent-core loop, tool definitions with a risk level, the gate, the meter, the model router, history conversion. Tested on pi-ai's faux provider. |
| Foundation | `convex/schema.ts`, `packages/shared/contracts/agentClients.ts`, `packages/shared/contracts/assistant.ts` (new) | All new tables, the `codecast` agent client entry, shared types (plans, risk levels, tool names). Lands first; nothing else edits these files. |
| Turn engine | `convex/assistant/turns.ts`, `convex/assistant/history.ts`, `convex/assistant/entry.ts` | Lease, run, stream, persist, continue, hooks from the composer, triggers and decisions. |
| Assistant tools | `convex/assistant/tools/*.ts` | Gmail, Calendar, codecast verbs (tasks, docs, routines, approvals), web fetch and search. |
| Wallet | `convex/wallet.ts`, `convex/lib/wallet.ts` | Period budget, reservation in the same mutation that checks the cap, true-up, ledger, queries for the UI. |
| Billing | `~/src/platform/packages/billing/**`, `convex/billing.ts`, its route in `convex/http.ts` | Plan catalog, Stripe over fetch (no SDK), checkout, portal, signed webhook. Env-gated: no keys means plans are granted by hand and the upgrade button says so. |
| Google identity and connectors | `convex/auth.ts`, `platform/packages/auth` web provider list, `components/AuthProviderButtons.tsx`, `convex/googleOAuth.ts` | Google sign-in (env-gated on `AUTH_GOOGLE_ID`), Calendar scope, an internal token getter the tools call. |
| pi cost | `packages/cli/src/parser.ts` | Read pi's per-message `usage.cost` into `usage_totals`. |
| Simple lane (web) | `packages/web/src/layouts/SimpleShell.tsx`, `packages/web/app/simple/**`, `packages/web/components/simple/**`, route manifest entries | Its own layout, not DashboardLayout. Reads the store. |
| Onboarding | `packages/web/app/welcome/**` | Three screens: sign in, connect, first useful thing. |
| Simple lane (mobile) | `packages/mobile/app/(simple)/**` | Same surfaces, phone first. |

## Data model

New tables (foundation stage writes all of them):

- `assistant_turns`: one row per run of the loop. `conversation_id`,
  `user_id`, `status` (`queued | running | waiting | done | failed`),
  `reason` (why it stopped: `done | approval | budget | time | error`),
  `model`, `cost_reserved_usd`, `cost_usd`, `input_tokens`, `output_tokens`,
  `started_at`, `ended_at`, `error`, `continues` (the turn this one resumes),
  `pending_call` (the tool call waiting on an approval). Index by
  conversation and status.
- `assistant_rules`: what the person has allowed. `user_id`, `tool`,
  `decision` (`allow | ask | refuse`), optional `match` (a recipient, a
  calendar), `created_at`. The gate reads these; "Always allow" on an
  approval writes one.
- `wallets`: one per user. `plan` (`free | plus | pro`), `period_start`,
  `period_end`, `period_cap_usd`, `period_cost_usd`, `period_reserved_usd`,
  `topup_usd`, `stripe_customer_id`, `stripe_subscription_id`,
  `subscription_status`.
- `wallet_ledger`: `user_id`, `kind` (`reserve | release | charge | grant |
  topup | period_reset`), `amount_usd`, `turn_id`, `conversation_id`,
  `model`, `at`.

A hosted conversation is an ordinary `conversations` row with
`agent_type: "codecast"`. No device ever claims it.

## The turn

1. **Something wakes the conversation**: the person sends a message, a
   routine (trigger) fires into it, or an approval is answered. Each path
   calls one function, `assistant/entry.ts: wake(conversationId, cause)`.
2. **Lease.** A mutation inserts a `running` turn only if none is running for
   the conversation; otherwise it leaves the new input queued and the
   running turn picks it up before it stops.
3. **Reserve.** The same mutation reserves the turn's ceiling from the
   wallet. No room: the turn ends at once with reason `budget`, and the
   person sees why and what to do.
4. **Run** (internal action). Load history, convert to pi messages, build the
   tool set for this user (only connectors they have), run the loop with the
   reservation as its cost ceiling and an 8 minute deadline. Stream text into
   one assistant message row, throttled. Each tool call and result becomes a
   message the existing transcript renders.
5. **Gate.** Before a tool runs: reads always run; writes check
   `assistant_rules`, default `ask`. `ask` writes a decision on the
   conversation (Approve, Always allow, Decline, with the exact draft or
   event shown), marks the conversation needs input, and ends the turn with
   reason `approval`. The answer wakes a new turn that executes or declines
   the call and continues.
6. **Finish.** Charge actual cost, release the rest, write the ledger, set the
   conversation's work state, and if new input arrived meanwhile, wake again.

Untrusted content (mail bodies, web pages, event descriptions) enters tool
results wrapped and labelled as data. Tools act only as the conversation's
owner. One running turn per user at a time on the free plan, two on paid.

## Where it plugs into existing code

All paths under `packages/convex/convex` unless noted. Mapped 2026-10-04.

- **Creating a hosted conversation.** `createQuickSession`
  (`conversations.ts:~1511`) always ends in `enqueueStartSession`, which hands
  the row to a daemon. The hosted path is a new mutation in
  `assistant/entry.ts` that performs the same insert (privacy via
  `resolveCreationPrivacy`, `team_id`, `short_id`, `status: "active"`),
  leaves `owner_device_id` unset, never enqueues a daemon command, and inserts
  the `managed_sessions` row the inbox reads status from. Factor the shared
  insert into one helper both call; do not copy it.
- **`agent_type`** is a closed union in `schema.ts` (`conversations`), and the
  registry (`packages/shared/contracts/agentClients.ts`) needs the `codecast`
  id widened through `AgentClientId`, `ConvexAgentType`, `CONVEX_BY_ID` and
  `fromConvexAgentType`. Its descriptor declares a hosted transport so
  daemon-only paths skip it, and no binary.
- **Writing messages.** `messages:addMessages` (`messages.ts:~1885`) is public
  and owner-checked. Factor its handler body into a helper and expose it
  through an internal mutation for the turn engine, keeping its side effects
  (pending echo settle, `projectAgentStatusOnAddMessages`, `rollUpUsage`).
  Streaming is a rewrite with the same `message_uuid`; send `usage` only on
  the final write of a message, with a unique `api_message_id`.
- **The wake hook.** Every producer of input (composer through
  `dispatch.sendMessage`, `sendMessageToSession`, the CLI send route,
  routines through `dispatchCloudTriggers`, decision answers through
  `sessionDecisions.deliverAnswer`) goes through `enqueuePendingMessage`
  (`pendingMessages.ts:~324`). One branch there, after the insert and skipping
  `held` rows: if the conversation is `codecast`, schedule
  `internal.assistant.entry.wake`. The turn consumes pending rows and marks
  them delivered.
- **Routines.** `cloudTriggerConversation` (`agentTasks.ts:~837`) gates the
  server-side trigger path to cloud hosts; extend it to return `codecast`
  rows, and exclude `codecast` rows from the daemon's `getDueTasks` so no
  daemon double-fires them.
- **Approvals** are `session_decisions` (`sessionDecisions.ts`, `askCore`).
  The engine creates a blocking decision through `askCore` and ends its turn;
  `deliverAnswer` enqueues the answer as a pending message, which wakes it.
- **Work state.** The live state is `managed_sessions.agent_status`; add an
  internal twin of `managedSessions.updateAgentStatus` for the engine. Inbox
  classification treats a conversation with no live daemon as unresponsive
  (`inboxFilters.ts` `daemonAlive`); a `codecast` conversation is never
  unresponsive for that reason.

## Plans

One catalog in `@platform/billing`, all numbers in one place so pricing is a
one-line change:

| | free | plus | pro |
| --- | --- | --- | --- |
| Price | $0 | $20/mo | $60/mo |
| Usage included | $2/mo | $12/mo | $40/mo |
| Default model | Haiku 4.5 | Sonnet 5.5 | Sonnet 5.5, Opus 5.5 for hard work |
| Routines | 3, at most daily | 25 | unlimited |
| Concurrent turns | 1 | 2 | 3 |

These are starting values pending the founder's call; nothing else in the
code hardcodes them.

## The simple lane

A person in the simple lane never sees a repo, a terminal, a device, a model
picker or the word "session". Same store, same data, different shell.

- **Home**: what needs you (approvals), what's happening (running turns,
  today's routines), what's done (recent conversations). One composer:
  "What can I take off your plate?"
- **Conversation**: the transcript, with tool steps folded into plain lines
  ("Read 12 emails from this week", "Drafted a reply to Dana"), approvals as
  cards with the actual draft, and the composer.
- **Approvals**: every open approval, oldest first.
- **Routines**: plain sentences with a schedule, pause and delete.
- **Connections**: Google (mail, calendar), with what each lets the assistant
  do, and disconnect.
- **Plan**: usage this period as a meter, plan, upgrade, top-up.

The lane is a per-user preference (`client_state.ui.lane`). New accounts
that sign up without the CLI land in it; anyone can switch from settings.

## Working in this tree

- The main checkout carries other sessions' uncommitted work. Never revert,
  reformat or "clean up" a change you did not make; edit around it.
- `scripts/gated-push.ts` is running: a green typecheck of `convex/` pushes it
  to prod within seconds. Every save under `convex/` must be deployable on its
  own: new tables and optional fields only, no renamed or removed public
  functions, no half-written module left on disk.
- Typecheck with `cast check <cli|web|convex>`, test single files with
  `bun test <file>`. The machine runs at very high load; never start a
  whole-suite run or a raw `tsc`.
- `@platform/*` packages are edited in `~/src/platform` and mirrored with
  `scripts/vendor-platform.sh`; one vendor run at a time.

## Verification

- Harness: unit tests on the faux provider (tool calls, gate pause and
  resume, cost metering, budget stop, history round trip).
- Turn engine, wallet, billing: `convex-test` with the faux provider; a
  concurrency test that four reservations against a nearly full wallet let
  exactly the ones that fit through; webhook signature tests.
- End to end: a real turn on prod with the deployment's key, driven from the
  simple lane in the browser, with screenshots.
