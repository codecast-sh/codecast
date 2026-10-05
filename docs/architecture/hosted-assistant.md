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

## Mail and calendar go through Whisk

Decided 2026-10-05. Codecast never holds Gmail or Calendar tokens. Whisk
(`~/src/mail`, whisk.email) is the family's mail and calendar engine, and its
Google verification (project `mailones`, `gmail.modify`, CASA assessment due
Nov 29 2026) is the only one the product needs. A person connects mail from
codecast through `whisk.email/connect`; Whisk mints a revocable app token,
codecast stores it encrypted and calls the same Whisk functions the `whisk`
CLI calls. Codecast keeps Google sign-in with basic scopes only. Whisk's
design tokens live in `@platform/design`, and the simple lane is built on
them so the lane and Whisk read as one product; Whisk remains a complete app
on its own.

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
owner. Running turns per person are capped by the plan's `concurrent_turns`;
a turn past the cap waits as `queued` and starts when one of theirs ends.

How the engine (`assistant/turns.ts`, `assistant/history.ts`) does it:

- **Lease** is `leaseTurn`, called by `wake` and at the end of every turn. It
  reserves the plan's `turn_ceiling_usd`, or whatever room is left above
  `MIN_TURN_USD`. The run's ceiling is the whole reservation: a paid tool
  (search_web) reserves its own estimate through `ctx.remainingUsd` and
  `ctx.charge` before it spends. The lease also schedules `expire` for the deadline plus a
  margin: a turn whose action died is ended there and charged the cost it
  recorded as it went (`record` keeps `cost_usd` current).
- **Input.** `begin` writes queued pending rows into the transcript as the
  person's rows and marks them delivered. A pending row that answers a
  decision (client id `decisionAnswerClientId(id)`, or the web's tagged
  "Decision:" text) is a wake only: it is marked delivered and never
  written, because the decision row is the answer.
- **Approval.** One call is asked at a time, as `<tool label>?` with Approve,
  Always allow and Decline, and `context_md` showing every argument exactly
  as written (short values in code spans, long text whole and fenced, so
  markdown in a value cannot change what the card shows). The turn parks as
  `waiting` with `pending_call`. The next turn reads the decision row. Only
  an answer the owner gave in person runs the call. A dismissal, a withdrawal
  or anyone else's answer declines it.
- **Always allow** is decided per tool in one map (`turns.allowScope`) that
  both the card and the gate read. A tool that stays inside the person's own
  account (`write_doc`, `recall`, drafts, archive, label) gets a tool-wide
  rule. A tool that reaches other people gets a rule matched to exactly those
  people, each read as the address the tool really delivers to
  (`gmail.deliveredAddress`: the angle-addr that ends a `send_mail`
  recipient, a plain address for a calendar guest). A call with any entry
  that is not exactly one such address is never offered and always asked.
  The rule covers the recipients of `send_mail`, the guests of a
  `create_event` that sends no invitation (or "no one"), and the guests
  `update_event` adds when it emails nobody and removes no one. It is never offered for
  `fetch_page` (a page the model chose can carry data out in its address),
  `schedule_routine` (its prompt later reads as the person's own words),
  `replace_doc` (the old text is not kept and the doc may be shared by link,
  so the person sees each new text first), a `create_event` or
  `update_event` that emails the guests, an `update_event` that removes a
  guest, or any tool the map does not list.
  The gate applies an allow rule only when it covers exactly what the call's
  scope would write; refuse rules always apply.
- **Input around a card.** If the person writes again after the card went
  up, the card is withdrawn and the call (and the rest of its batch) is
  answered as not run. A routine firing while the card is open does not
  count as the person moving on. Input that arrived before the card, or from
  a routine meanwhile, waits for the answer, and the turn that carries the
  answer out takes no new input: the answered call's result follows its
  message, the rest of its batch goes through the gate and may be asked in
  turn, and the waiting input gets the turn after. The stuck-message sweep
  does not wake a conversation whose input waits on an open card
  (`input.hostedInputWaits`).
- **Unanswered calls** the harness will not recover (an older message's, or
  one with the person's words after it) are answered as not run
  (`history.strandedCalls`), since the API refuses a call with no result.
- **Ends.** `done` sets work state `done`. `approval` sets
  `permission_blocked`. `time` continues in a new turn, up to
  `MAX_TIME_CONTINUATIONS` in a row; past that, or when the continuation
  cannot start (a safety stop), it writes a plain line and sets `idle`. `budget` and `error` write one plain
  assistant line saying what happened and what to do, and set `idle`. The
  engine is the conversation's only status writer; the status projection
  from message writes skips hosted rows. Every ending that stops short goes
  through `turns.stopTurn` (end and settle, then the line and `idle`). A
  conversation deleted while a turn runs makes transcript writes no-ops
  (`history.writeRows` returns false), so the run stops and the ending still
  settles the hold, whether it comes from `begin`, `finish` or the lease
  sweep.

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

- **Mail and calendar seam.** The mail tools (`mail.ts`) are written against
  a `Mailbox` and the calendar tools (`calendar.ts`) against a `Calendar`:
  the few thread and event verbs any engine offers. The tool definitions,
  their wording, their risk and the gate rules live there and do not depend
  on the engine. `gmail.ts` (`gmailMailbox`) and `googleCalendar.ts`
  (`googleCalendar`) are today's implementations over Google tokens. Moving
  to Whisk (above, ct-57102) adds a Whisk `Mailbox` and `Calendar` and swaps
  them in `toolsFor`; nothing new should be built on the Google-token path.
- **Gmail** (`gmail.ts`): what a connection allows is `googleCapabilities`,
  the same rule the Connections screen shows. `search_mail` and `read_thread`
  need any confirmed connection; `draft_reply`, `create_draft`, `archive` and
  `label` need gmail.modify; `send_mail` needs gmail.send (or modify). Drafts
  are risk `read`; send, archive and label are `write`. A reply answers the
  thread's last sent message, never a draft in it, and each recipient entry
  must be exactly one address. A `send_mail` reply goes out under the
  thread's own subject (mail engines file a reply into its thread only when
  the subject matches), so a reworded subject is refused. `read_thread` marks a draft in a thread
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
  to four pages and stops its search where reading stopped. In
  `update_event` a new start alone moves the event and keeps its length, a
  new end alone keeps its start, and an all-day event changes time only with
  both edges given; edges keep the event's own time zone.
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
  shared by link, directly or through a plan that lists it or its project;
  `write_doc` an append to a doc shared by link, or the body doc of a plan
  shared by link (`replace_doc` asks, so it still works); `remember` a memory
  doc shared by link. Text read from mail or the web cannot leave through a
  tool that never asks. `remember` also asks whenever any row in front of the
  model, earlier turns' history included, called a mail, calendar or web tool
  (`index.readOutsideContent`), so a fact steered by an email or page never
  enters lasting memory unseen. `write_doc` refuses to append to the memory
  doc, which leaves `remember` and the approved `replace_doc` as the only ways
  to change it. Memory is one personal doc, "What I know about you",
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
  message (`typedUrls`; a prefix of one can name another host). Every other
  URL asks. A search's sources do not count: the model writes the query
  after reading private content, so whoever controls the indexed pages
  controls which URLs come back. A fetched page's own links do not count
  either, or a page linking on to /a ... /z would let the model spell the
  person's data out one followed link at a time.
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
read fresh for every event, so delivery order never moves a plan back. Two
deliveries can read in one order and commit in the other, so each read is
stamped when it returns (`wallets.subscription_read_at`): an older read of the
same subscription is skipped, and a subscription the wallet holds as ended
(`canceled`, `incomplete_expired`) never maps back to live. A plan
change on a paid-up subscription counts for the rest of the period only
(`proratedCap`, floored at zero, not at the usage, so going down and back up
mints nothing); a new subscription buys its period whole. A renewal that is
failing (`past_due`) keeps the plan's name but rolls into the free allowance
until the payment lands. So does every period that ends after the last one
Stripe confirmed paid (`wallets.paid_through`, set by `invoice.paid` and by a
subscription paid in full): a period opens at its boundary before Stripe
charges the renewal, and its paid allowance arrives with `invoice.paid`, so a
renewal that is never paid, or whose events stop arriving, grants nothing. A
plan granted by hand has no `paid_through` and keeps its allowance. A second live subscription for the same person is
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
  lane is set. `lanePref.ts` holds `laneOf`, `LANE_HOME`, `writeLane` and
  the settings switch's words, with no router in it, so the full app and
  the phone use them without loading the lane; `useSetLane.ts` is the web
  gesture that writes the preference and moves the view.
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
  the person to `/simple/plan?billing=done|topup|canceled` (`BILLING_RETURN`
  in `@codecast/shared/contracts/assistant`, which the server's return URLs,
  the lane's plan path and the return note all read). `useBillingReturn`
  reads the parameter once, takes it off the URL, and says the payment is on
  its way until the wallet shows it.
  `useBilling().manage()` opens the billing portal (`billing.openPortal`)
  through the same redirect; the plan screen shows "Manage billing" when
  billing is available and `WalletSummary.billing_account` is true. A
  negative `topup_usd` is shown as money owed. With billing unavailable the
  plan screen says card payments are not open yet. `useBilling(open)` takes
  the opener (the web leaves for the page; the phone opens it in the
  browser), and `usePlanFigures` is the screen's figures for both.

How the phone lane is wired (`packages/mobile`):

- **Routes.** `app/(simple)/simple/(lane)` holds the five tabs at the web's
  own addresses (`/simple`, `/simple/approvals`, ...), and
  `app/(simple)/simple/c/[id]` a conversation above them, so `LANE_PATHS`
  and `conversationPath` from `lane.ts` route on the phone unchanged, and
  `lib/linkRoutes.ts` opens any `/simple` link in the app.
- **Which lane.** `components/simple/laneRoute.ts useLaneLanding`, mounted
  in the root AuthGate, sends a lane person to `/simple` when they arrive
  at the tabs (at launch or coming back to them). Only a gesture on this
  phone (`moveToLane`: Settings, Appearance, or the lane's "Open the full
  app") moves the view at once; a flip made on another device never pulls
  the phone out of what it is showing. After sign-in, `landAfterSignIn`
  lands on the home of the person's lane and puts the link they came from
  on top of it.
- **From outside.** A push, a deep link and a tapped codecast link all
  open through `lib/laneOpen.ts laneRouteFor`: for a lane person a
  conversation opens in the lane (unless its row is known to be a coding
  session) and a decision opens in its lane conversation, or on the lane's
  approvals while the decision is not in the store yet. A push tapped on a
  killed app, or a link that launched it, arrives before the cache is read
  back, so each entry waits for `clientStateInitialized` (`laneKnown`, at
  most 3 seconds) before choosing. Links are routed synchronously, so a
  conversation or decision link stops at `app/open/[...to]`, which waits
  and then replaces itself with the right screen.
- **Shared rules and words.** The lane's sections, row sublines, draft and
  step folds, home's ideas and counts, and each page's rules live in
  `lane.ts` (`LANE_SECTIONS`, `conversationSubline`, `draftIsLong`,
  `visibleSteps`, `HOME_IDEAS`, `homeView`, `planCard`, `meterLegend`,
  `topupLabel`, `workedTimes`, `connectionControls`), every fixed line the
  pages say is `LANE_COPY`, and a conversation screen's model is
  `useLane.ts useLaneConversation(id, onRealId)`; each platform keeps its
  scrolling and views. The answer controls' own words are
  `lib/decisionAnswer.ts ANSWER_WORDS`, shared with the web's
  `DecisionAnswerControls`. A pick-several, ranking or form approval answers in
  place in its conversation through `components/decisions/AnswerControls`
  (shared with the decision screen, drawn in the lane's colours, Feather
  icons and shrinking press, without option numbers) and
  elsewhere points to the conversation, as on the web.
- **Store.** `StoreSyncBridge` is mounted once in the root AuthGate, so both
  lanes read one replica. Every screen reads the web lane's own hooks and
  model (`useLane.ts`, `lane.ts`, `startConversation.ts`, `useLaneGoogle.ts`,
  `connectionWords.ts`, `usePlanFigures.ts`, `billing.ts`); only the views
  are native.
- **Look.** Bricolage Grotesque ships as four static faces under
  `assets/fonts`; the lane layout loads them and provides them through
  `constants/fonts.ts FaceContext`, which the Themed `Text` reads, so every
  unstyled word in the lane, markdown included, is set in it.
  `components/simple/laneTheme.ts` derives simple.css's tokens from the app
  palette, including the deepened `tideSolid` behind words (yes buttons,
  send) and `sunSolid` behind the approvals badge (simple.css
  `--sl-sun-solid`), so both read at about 5:1.
- **Google and Stripe.** A Google connect must finish in a signed-in browser
  session (the confirm token), so Connect opens the web Connections page in
  the browser; the phone's screen updates when the connection lands.
  Checkout and the portal open in the browser and return to the web plan
  page.

How onboarding is wired (`packages/web/app/welcome/`):

- **Screens.** `onboarding.ts welcomeStep` picks the screen: signed out is
  sign in; signed in is connect unless Google is already connected, the
  person chose "Not now" (`?step=start`), or the deployment cannot connect
  Google (`googleOAuth.connectAvailable`), and then it is the first ask. A
  move between screens is one view transition (`page.tsx moveTo`), skipped
  for reduced motion or a hidden tab.
- **Sign in** is `AuthProviderButtons` with the lane's own classes and words
  (`classFor`, `labelFor`), Google first when `auth.signInProviders` offers
  it, and email through `/signup` or `/login` with `return_to=/welcome`.
- **The promise** follows what the deployment can do:
  `components/simple/assistantPromise.ts` words the sign in line and the
  entry links once, and promises mail and calendar only where
  `googleOAuth.connectAvailable` is true. Where it is false, the first ask
  says once that email and calendar are on their way.
- **Connect** reads `useLaneGoogle(LANE_PATHS.welcome)`, the same hook the
  Connections screen uses, and renders the same `Service` rows with
  `connectionWords`. Google's consent screen opens in the same tab (a tab
  opened after the URL is minted is outside the tap, and phone browsers
  block it) and returns to /welcome, which mounts `ConnectNotice`. The
  desktop app still hands it to the system browser. `useLaneGoogle().known`
  waits for both the connection and what its grant allows, and a failed
  read counts as answered, so no screen waits on it for good.
- **First ask** is `lane.ts firstAsks(can)` from what the grant allows, and
  starts through `startConversationWith`, then lands in `/simple/c/<id>`.
  Every first ask works as tapped: none names a person the asker may not
  know. Signed in, the page mounts `LaneSync` (the lane's store wiring) so
  these writes go out. Acting on any screen (connect, Not now, an ask)
  writes `ui.lane = "simple"` (`lanePref.writeLane`).
- **Ways in.** The signup page and the marketing home page each carry one
  "Don't write code?" line to /welcome. Both import the lane's paths from
  `components/simple/lanePaths.ts`, which imports nothing, so the public
  pages never load the store.

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
