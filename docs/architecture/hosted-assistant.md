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
| Billing | `~/src/platform/packages/billing/**`, `convex/billing.ts`, its route in `convex/http.ts` | Stripe over fetch (no SDK), checkout, portal, signed webhook. Prices and limits come from the `PLANS` catalog (see Plans); `@platform/billing` takes them as input and holds none of its own. Env-gated: no keys means plans are granted by hand and the upgrade button says so. |
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
  A dismissal delivers nothing, so `settleResolution` wakes the conversation
  directly. Only the owner is asked (`routeFor`) and only the owner may
  answer or dismiss (`hostedAnswerRefusal`).
- **Hosted stays hosted.** A conversation's `agent_type` never crosses
  between `codecast` and a local agent (`agentTypeChangeRefusal`, enforced in
  the change-tracked db every mutation writes through), so a transcript that
  holds mail and web content never resumes as a local agent with a shell.
- **Work state.** The live state is `managed_sessions.agent_status`; add an
  internal twin of `managedSessions.updateAgentStatus` for the engine. Inbox
  classification treats a conversation with no live daemon as unresponsive
  (`inboxFilters.ts` `daemonAlive`); a `codecast` conversation is never
  unresponsive for that reason.

## The tools

`toolsFor(ctx, userId, conversationId, { google?, fetch? })` in
`convex/assistant/tools/index.ts` returns the turn's tools, a `note` for the
system prompt naming what the person has not connected or allowed, and a
`gate(rows)` for the run. Every tool acts as the conversation's owner only.
On a deployment with no Google OAuth client (`googleConfigured()` is false)
no Google tool is offered and the note says mail and calendar are not
available there, rather than offering a connect flow that cannot work.

- **Gmail** (`gmail.ts`): what a connection allows is `googleCapabilities`,
  the same rule the Connections screen shows. `search_mail` and `read_thread`
  need any confirmed connection; `draft_reply`, `create_draft`, `archive` and
  `label` need gmail.modify; `send_mail` needs gmail.send (or modify). Drafts
  are risk `read`; send, archive and label are `write`. A reply answers the
  thread's last sent message, never a draft in it, and each recipient entry
  must be exactly one address. `read_thread` marks a draft in a thread
  "Draft (not sent)", keeps the newest messages whole within
  `THREAD_MAX_CHARS` (under the fence's cap, which cuts a block's end),
  shortens older ones to sender, date and snippet, and leaves out the
  earliest once even those do not fit, saying how many. `search_mail` reads
  its threads five at a time and skips, and counts, any it cannot read.
- **Calendar** (`calendar.ts`, calendar.events): `list_events`,
  `find_free_time` (`read`), `create_event`, `update_event` (`write`).
  `create_event` derives the event id from the call id, so a create that lands
  twice is one event. All-day events cover their day in the calendar's own
  zone. `list_events` says when more events follow; `find_free_time` reads up
  to four pages and stops its search where reading stopped.
- **Codecast** (`codecast.ts` over the internal functions in `workspace.ts`):
  `list_tasks`, `create_task`, `update_task`, `read_doc`, `write_doc` (create
  or append), `remember`, `recall`, `list_routines`, `cancel_routine` are
  `read`. `replace_doc` is `write`, since docs keep no old versions, and
  `schedule_routine` is `write`, since it spends usage later unattended. They
  run the web's own write paths (`tasks.createTaskAs` / `updateTaskAs`,
  `docs.createDocAs` / `updateDocAs`, `agentTasks.insertTask`) and touch only
  rows keyed to the person's own workspace (`user:<id>`), never a team's.
  `list_tasks` shows what the person's board shows (`isActiveTask`,
  `isOnHumanBoard`). The `read` tools that change a row refuse one someone
  else can see (`workspace.publicCopy`): `update_task` a task synced with a
  GitHub or Linear issue, whose every change is pushed to the issue, or one
  shared by link; `write_doc` an append to a doc shared by link (`replace_doc`
  asks, so it still works); `remember` a memory doc shared by link. Text read
  from mail or the web cannot leave through a tool that never asks. Memory is one personal doc, "What I know about you",
  found by its `source_file` among the person's own docs
  (`docs.ownDocsBySourceFile`); archiving it makes the assistant forget, and
  the next `remember` starts a fresh doc. Routines are triggers on this
  conversation, `once` or `recurring`, at least an hour apart and within the
  plan's rules.
- **Web** (`web.ts`): `fetch_page` (public hosts on every redirect hop,
  1 MB, text only) and `search_web` (one Messages API call on the
  deployment key with the web_search server tool, offered only when the key
  is set, at most five a turn). A request to a URL the model chose can carry
  the person's data out, so `fetch_page` is `write`; the turn's `gate` lets it
  run without asking only for a URL the person wrote whole in their own
  message (`typedUrls`; a prefix of one can name another host), or one a
  search returned this turn as a source. A fetched page's own links
  never count, or a page linking on to /a ... /z would let the model spell
  the person's data out one followed link at a time.
  `search_web` reports its cost through the tool context's `charge`, an estimate when the call
  ends before its usage is read; the turn charges it and counts it toward the
  run's ceiling.

Google tokens are fetched inside each call (`google.ts`, shared per scope for
the turn, and a 401 refreshes once) and never enter arguments, results or
logs. Mail, calendar, web pages and the person's stored text (tasks, docs,
memory) declare a `source`, so the harness fences them as untrusted.

## Plans

One catalog, `PLANS` in `packages/shared/contracts/assistant.ts`
(`@codecast/shared/contracts/assistant`, read through `planOf`), holds every
number so pricing is a one-line change. The prices are codecast's product,
not the shared platform's, so `@platform/billing` carries only the Stripe
mechanics and receives a plan's price and id from its caller. The routine
limits are enforced on every path that arms a routine on a hosted
conversation (`convex/assistant/routines.ts`, rule `routineRefusal`): arming
counts every other armed hosted routine the person has. The dispatcher
rechecks each routine as it fires, counting only older ones, so a routine
armed past a plan that shrank pauses newest first. Only the conversation's
owner may set a routine on it, and every plan runs routines on a schedule,
never on events: an event's frame carries text written by outsiders (issue
and comment titles) into a message sent as the owner, and nothing bounds how
often it fires. Admitting event routines later needs the turn engine to treat
the frame's "What fired this run" block as untrusted input first.

| | free | plus | pro |
| --- | --- | --- | --- |
| Price | $0 | $20/mo | $60/mo |
| Usage included | $2/mo | $12/mo | $40/mo |
| Default model | Haiku 4.5 | Sonnet 5.5 | Sonnet 5.5, Opus 5.5 for hard work |
| Routines | 3, at most daily | 25 | unlimited |
| Concurrent turns | 1 | 2 | 3 |

A top-up buys usage at the same margin a plan keeps: each dollar paid
before tax credits `TOPUP.usage_usd_per_usd` ($0.60) to the top-up balance,
in the amounts `TOPUP.amounts_usd` lists. A refund or dispute takes the same
share back, even when the credit is already spent: the balance then goes
below zero, and that debt is paid once (`repayDebt`, a `repay` ledger row),
from the allowance still left now, then from each new period's allowance
before it gives room, or by the next top-up.

These are starting values pending the founder's call; nothing else in the
code hardcodes them.

Billing (`convex/billing.ts`) maps each subscription as Stripe holds it now,
read fresh for every event, so delivery order never moves a plan back. A plan
change on a paid-up subscription counts for the rest of the period only
(`proratedCap`, floored at zero, not at the usage, so going down and back up
mints nothing); a new subscription buys its period whole. A renewal that is
failing (`past_due`) keeps the plan's name but rolls into the free allowance
until the payment lands. A second live subscription for the same person is
refunded, then canceled.

Because the wallet grants a plan's allowance the moment a period opens and
the person spends it as they go, Stripe must never hand back money for time
whose allowance may be spent. Billing opens only with
`STRIPE_PORTAL_CONFIGURATION` set, and every portal session reads that
configuration first (products expanded) and refuses it unless:

- plan changes use `proration_behavior=always_invoice`, so an upgrade is paid at once;
- `schedule_at_period_end` holds a `decreasing_item_amount` change, so a downgrade waits for the period's end;
- cancel is off or `mode=at_period_end`, since an immediate cancel credits unused time a resubscribe would turn into a fresh allowance;
- `billing_cycle_anchor` is not `now`;
- every plan's price is on offer.

Each top-up checkout first reads `STRIPE_PRICE_TOPUP` and sells nothing
unless it is an active one-off $1.00 USD price, so "Pay $25" charges $25.

Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PLUS`,
`STRIPE_PRICE_PRO`, `STRIPE_PRICE_TOPUP` (a $1.00 unit price; a top-up of N
dollars buys N of it) and `STRIPE_PORTAL_CONFIGURATION`. The webhook
(`/api/webhooks/stripe`) needs only the two secrets, and listens for
checkout.session.completed and async_payment_succeeded,
customer.subscription.created, updated and deleted, invoice.paid,
charge.refunded and charge.dispute.created.

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

How the web lane is wired (`packages/web/components/simple/`):

- **Shell.** `src/layouts/SimpleShell.tsx` mounts `DashboardSyncEffects`
  with `windowEffects={false}`: the same feeders and dispatch as the full
  app, without call rings, chat toasts or mods. `/simple` and `/welcome` are
  NON_TAB prefixes. `DashboardShell` sends `/inbox` to `/simple` when the
  lane is set. `lanePref.ts` holds `laneOf` and `useSetLane` for the full
  app to use without loading the lane.
- **Reads.** Conversations are `sessions` rows with a hosted `agent_type`;
  approvals are pending `sessionDecisions` on them; routines are
  `agentTasks` whose `originating_conversation_id` is one of them.
- **Steps.** `lane.ts stepText` folds each tool call into one line. A tool
  result (or call) carrying `summary`, a plain past-tense sentence, is shown
  as written; otherwise the name is matched against a small vocabulary
  (mail, calendar, web, to-dos, notes, routines) and then spelled out.
- **Approvals.** The card shows `question`, then `context_md` as the draft,
  then every option as a button (first is the yes, a label starting with
  Decline/No/Don't is quiet). Answers go through `answerDecision`.
- **Billing.** `billing.ts useBilling` reads `billing.billingAvailable`
  (a `BillingStatus`: `available`, the priced `plans`, and whether a
  `topup` can be bought) and calls `billing.startCheckout` with `{ plan }`
  or `{ topup_usd }`. It gets back a `BillingRedirect` (`{ ok: true, url,
  via }` or `{ ok: false, code, error }`) and opens `url`; Stripe returns
  the person to `/simple/plan?billing=done|topup|canceled`.
  `useBilling().manage()` opens the billing portal (`billing.openPortal`)
  through the same redirect; the plan screen shows "Manage billing" when
  billing is available and `WalletSummary.billing_account` is true. A
  negative `topup_usd` is shown as money owed. With billing unavailable the
  plan screen says card payments are not open yet.

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
