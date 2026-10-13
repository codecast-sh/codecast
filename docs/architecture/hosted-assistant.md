# The hosted assistant and hosted mode

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

## Revised 2026-10-05: hosted mode inside codecast, and a platform core

The founder's direction, which supersedes the separate lane built first
("History: the simple lane" below):

1. **A platform core.** Everything Averil and codecast can reasonably share
   lives in `@platform`: the harness (`agent`), billing, design tokens
   (`design`), and a new `assistant` package with the storage-free parts of
   the assistant: plan types, wallet arithmetic, approval-rule matching, the
   system prompt builder, and the Whisk mail and calendar tools and web tools
   over an injected transport. Codecast's Convex code keeps only storage and
   wiring. Averil adopts the core on its own schedule.
2. **No separate shell.** Codecast itself gains a hosted, minimal mode: the
   same power dashboard (inbox, conversations, tasks, docs, routines,
   questions, pages, teams) for general-purpose work, with our inference as
   the default and developer-only surfaces hidden. It is the existing Minimal
   style and Simple view taken further, not a different product. The
   `/simple` routes redirect into the main app and the lane's duplicated
   components (its own transcript, conversation row, shell) are retired;
   the parts worth keeping (step wording, plan page, connections copy,
   onboarding) move into the main app.
3. **Packaged end to end, and funnelled.** Codecast.sh routes a
   non-developer from the marketing page through `/welcome` (sign in, connect
   mail and calendar through Whisk, first useful result) into the main app
   in hosted mode. A signed-in person with no machine is offered the hosted
   assistant instead of only "install the CLI".

### The mode

- One preference, `client_state.ui.lane` (already exists; one home): `"simple"`
  means hosted mode, anything else the developer default. `/welcome` sets
  it; settings and the command palette switch it.
- One central registry of developer-only surfaces (`lib/surfaces.ts` or
  similar, one `useSurface(name)` hook) consulted by every gated place:
  sidebar rows (changes, projects, repo, files, line, ops, windows), shell
  banners (setup prompt, CLI offline, tmux missing, device setup, resource
  pressure), the terminal dock and split, diff layouts, PR, worktree and git
  chips, machine chips, model and effort pickers, the settings "Machines"
  group, and the install-CLI empty state. No scattered `if (lane)` checks.
- Hosted mode implies the Minimal style and Simple view, condensed
  transcript density, and general-purpose words where the developer words
  would confuse ("conversation", not "session"; "assistant", not "agent").
- The hosted assistant is a pickable agent everywhere (a picker list that
  includes it, separate from the daemon's local-only registry), allowed as a
  pin, and the default agent in hosted mode through a default-agent
  preference that replaces today's hard-coded `"claude_code"` defaults.
  When the agent is hosted, compose skips device, cloud placement, project
  and model pickers.
- Plan and usage become a Settings section in the Account group, with a
  quiet usage meter in the shell; mail and calendar through Whisk become a
  row on the Integrations page; approvals are the existing questions page
  and inline decision cards; routines are the existing triggers.
- Mobile follows the same mode in its existing tabs rather than a separate
  route group.

### The fold (built 2026-10-06)

The web lane is retired; hosted mode is the main app.

- **Plan and usage.** Settings > Plan (`app/settings/plan/page.tsx`, section
  `plan` in `lib/settingsSections.ts`) is built from the lane's plan rules
  and hooks (`usePlanFigures`, `useBilling`, `useBillingReturn`).
  `BILLING_RETURN.path` is `/settings/plan`, so Stripe returns open the modal
  on Plan with `?billing=` carried over. In hosted mode the sidebar's foot
  shows a quiet meter (`components/plan/UsageMeter.tsx ShellUsageMeter`,
  reading `usePlanMeter`; its wallet feeder runs only in the sync host window).
- **Mail and calendar.** Integrations leads with an "Assistant" section
  holding the "Mail and calendar (Whisk)" row
  (`components/integrations/WhiskCard.tsx`, on `useLaneMail`).
  `WHISK_RETURN_PATHS[0]` is `/settings/integrations`; `/welcome` and
  `/inbox` stay, and `/simple/connections` stays for links already out
  there (the phone's Connect opens `/settings/integrations`).
- **Transcript.** The step wording moved to `@platform/assistant/steps`
  (`stepText`, `visibleSteps`, `stepCount`). A step says how it came out
  (`stepOutcome`: done, pending, declined, not run, failed), read through
  `@platform/agent/outcome`'s `toolResultOutcome`, which is built from the
  same builders the run writes its refusals with, so rewording one keeps the
  receipts right. A hosted conversation's condensed receipt says its steps
  in those words (`lib/hostedReceipt.ts`, wired in `CondensedToolsGroup`).
  Approvals are the existing decision cards, and their question is the
  step's own words (`stepAsk`: "Update a note?"), so the card and the receipt
  name an action one way. A hosted conversation never shows machine status:
  no Disconnected pill (`sessionDisconnected`), no "Session idle" line and no
  unresponsive banner (`sessionLooksAbandoned`).
- **Plan wording.** Dollars are only money the person pays (plan prices, the
  top-up buttons). Work is a share of their month (`lane.ts monthShare`):
  the meter, the ledger, extra credit, history, and a top-up's note ("About
  half a month on Plus"). A plan's allowance reads as a multiple of Free's.
- **Routes.** `/simple/*` is one redirect route (`components/LaneRedirect.tsx`,
  rule in `lib/laneRedirect.ts`): home to `/inbox`, a conversation to
  `/conversation/:id`, approvals to `/questions`, routines to `/triggers`,
  connections and plan to their settings sections, query and fragment kept.
  `/simple` stays a NON_TAB prefix so the router, not a tab, runs it.
  `/welcome` lands on the main app's pages.
- **The phone** has no lane of its own either: hosted mode lives in its
  tabs ("How hosted mode is wired on the phone" below).

### Polish round 2 (2026-10-06)

- **Colour.** The `sol` accent utilities read class-only variables
  (`--sol-class-*` in globals.css :root, Solarized hex in every theme, so
  developer mode paints as before); `html.hosted-mode.minimal-style` maps
  them to the family's accent, ok, danger and star, and the cool hues to
  muted ink.
- **Surfaces added.** `triggers.fleetChrome` (the routines page's counts,
  timeline, chips and health rails; hosted rows read "Every day at 9:00 AM"
  through `hostedSchedule.ts describeHostedCadence`), `mods.sidebar`,
  `settings.devIntegrations` (`AppDescriptor.developerOnly` services and Ops
  sources; `hostedTagline` words the rest).
- **Titles.** `promptTitle` is the first sentence cut at a word near 48
  characters; every surface names a conversation through
  `lib/sessionCard.ts sessionCardTitle` (palette, recents, lists).
  `components/PageHeading.tsx` is the one page title, set in the reading
  face in hosted mode (routines, approvals, list pages).
- **Stops.** `lib/hostedNotice.ts` reads a transcript's last notice; an
  inbox row says "Stopped" from it. Try again folds into the same turn on
  screen (`ConversationView` isRetryBubble / isRetriedNotice) and the live
  notice counts the attempts. `assistant/incidents.ts thinkingAvailable`
  tells /welcome and the composer before anyone types that no provider can
  serve. A used-up month holds Send with the reset date (`useAllowanceOut`),
  and no pitch names a plan while `billing.ts useUpgradesOpen` is false.
- **Approvals in a transcript.** A plain yes or no answer is not drawn again
  under the step's receipt, which already says it
  (`approvalAnswerAddsToReceipt`).
- **Palette.** In hosted mode the Ask row leads only when nothing here
  matches; otherwise it is last and Cmd+Enter asks. "new" or "create" leads
  with the Create group (`queryAsksToCreate`). The empty palette is New
  conversation, this conversation's actions behind one row, five recent
  places, then the pages.

### Polish round 4 (2026-10-06)

- **Gates fail closed.** Connect is offered only on `available === true`
  (`useLaneMail`), and asks only once `useThinkingAvailable()` is true; both
  questions count as "no" when the function is missing or silent past
  `GATE_DEADLINE_MS`. A connect failure reads as one plain line
  (`lane.ts plainConnectError`, `MAIL_CONNECT_CLOSED`), never an exception's text.
- **The funnel is two steps.** `/welcome` is sign in, then Start
  (`onboarding.ts welcomeStep`, `WELCOME_TRAIL`). Connect is a side screen at
  `?step=connect`, opened from Start's "Connect it". Unconnected first asks
  need nothing connected (`firstAsks`), and a routine is offered under the
  first finished answer (`HostedNotice.tsx RoutineOfferChip`, `offersRoutine`).
- **One scope.** `lib/assistantScope.ts` is the Assistant/Everything rule for
  the inbox, its badge (`useNeedsInputCount`), Approvals and its rail count
  (`useScopedDecisionQueue`), Routines, the panel's next-routine line, the
  palette's conversations and recents. `components/AssistantScopeSwitch.tsx`
  is the one switch, with `MoreInEverything` under each scoped list.
- **Couldn't finish.** A hosted conversation that ended on a stop leaves the
  person's turn for its own section with one Try again, and stays out of the
  badge (`lib/hostedNotice.ts splitHostedStops`, `hostedStopsSig`, `lastAskOf`).
  It is a presentation split of the needs-input bucket, so the placement
  digest still matches the server.
- **Addresses.** `/approvals`, `/plan`, `/mail` and `/integrations` redirect
  to their pages (`lib/laneRedirect.ts PAGE_ALIASES`); `/routines` goes to
  `/triggers` in hosted mode only (`app/workflows/entry.tsx`). A cold load on
  any shell page other than the inbox restores no conversation
  (`inboxStore.ts bootLinkTarget`).
- **Settings.** In hosted mode the Machines group folds into one "Developer
  settings" row that switches to developer mode.

### Polish round 5 (2026-10-06)

- **Approvals in the conversation.** A hosted conversation's own approval is
  `components/conversation/HostedApprovalCard.tsx` at the end of the
  transcript: the question, the plan (`approvalContext`: "What I'll do" as a
  quoted, escaped paragraph, and one "When" line from `plainSchedule`), and
  Yes / Not now (`APPROVAL_BUTTONS`, display only; the stored labels stay
  `APPROVAL_ANSWERS`). The yes says what it does (`turns.ts approveWords`).
  No header pill, no red status line, no docked strip.
- **One wait.** `HostedStatusLine` says "Thinking…" (or the step in flight)
  with no stopwatch; "Getting started…" only before the first reply.
- **Honest outages.** `THINKING_DOWN` promises nothing later. While an
  incident is open, `assistant/incidents.ts probe` pings the provider (2, 4,
  8, then every 15 minutes) and closes it on success. Try again reads "Back
  soon" meanwhile. `connectionNote` says mail is coming soon while
  `whiskConnectOpen()` is false, the same gate every Connect reads.
- **Prompt.** Offer only what the tools can do, ask for place before
  place-bound plans, a first answer fits one screen, an hour without AM or
  PM is the waking one. `replyAsksPerson` (a question anywhere in the last
  paragraph) settles a turn as the person's and sets the composer to "Reply…".
- **Scope everywhere.** The bell (count as a dot, list, `MoreInEverything`),
  the palette's server search (scoped, deduped against recents), header
  pins, and boot restore (`restorableIn`) follow the Assistant scope. The
  inbox folds to Your turn, Working on it, Done newest first
  (`hostedStatusSections`, shared with the keyboard walk).
- **Words and rows.** Tasks and Docs are To-dos and Notes (`MODE_PAGES`);
  Approvals stays on the rail (`rail.questionsOnlyWhenWaiting`); the user
  menu filters pages through `showsPage`; Routines starts empty from
  `routineExamples`. Entering hosted mode switches to Personal (`setLane`).

## Mail and calendar go through Whisk

Decided 2026-10-05, built the same day. Codecast never holds Gmail or
Calendar tokens. Whisk (`~/src/mail`, whisk.email) is the family's mail and
calendar engine, and its Google verification (project `mailones`,
`gmail.modify`, CASA assessment due Nov 29 2026) is the only one the product
needs. A person connects mail from
codecast through `whisk.email/connect`; Whisk mints a revocable app token,
codecast stores it encrypted and calls the same Whisk functions the `whisk`
CLI calls. Codecast keeps Google sign-in with basic scopes only. Whisk's
design tokens live in `@platform/design`, and hosted mode and `/welcome` are
built on them so codecast and Whisk read as one family; Whisk remains a
complete app on its own.

How it is wired:

- **Connect** (`convex/whisk.ts`). `getConnectUrl` signs a state (the person
  and the page to return to, one of `WHISK_RETURN_PATHS`: Settings >
  Integrations, `/welcome`, `/inbox`, or the retired `/simple/connections`
  for links already out there) with
  `WHISK_APP_SECRET_CODECAST` and sends the browser to
  `whisk.email/connect?app=codecast&return=<codecast>/connect/whisk&state=`.
  Whisk returns to `/connect/whisk` (`app/connect/whisk/page.tsx`, the one
  return URL Whisk registers for codecast) with `whisk_code` and the state.
  That page calls `finishConnect` from the signed-in session: the state must
  verify (30 minutes, room to sign in to Whisk on the way) and name the
  caller, or nothing is spent; then the code is traded server to server at
  Whisk's `POST /apps/token`, with the state, and the app token is stored.
  Whisk stores a hash of the state with the code and redeems the code only
  with that state, so a code that leaks cannot be traded here by another
  person under their own state. A return that lands in a browser not signed
  in to codecast (the desktop app opens Connect in the system browser) is
  held in that tab (`lib/returnStash.ts`, as Slack's return is), sends the
  person to `/login?reason=whisk&return_to=/connect/whisk`, and finishes when
  sign-in comes back. It lands on that page with `?whisk=connected` or
  `?whisk=error&reason=<code>`, the `?<provider>=` shape every connector
  uses: `ConnectNotice` reads it through `useConnectorReturn` with `whisk` as
  an extra provider, so the reason goes through the connectors' reason
  table. The connect and disconnect gestures are `useConnectGesture`
  (`lib/integrations.ts`), the machinery the Apps page's connections use.
- **Storage.** One personal `app_installations` row, provider `whisk`
  (`connectionRowFor`), the token sealed with googleOAuth's AES-GCM helpers
  under a key HKDF-derived from the app secret (its own info string). The
  row keeps the grant's scopes, the person's Whisk address and the mailboxes
  it reaches. A reconnect replaces the row and ends the earlier token at
  Whisk; `disconnect` deletes the row and ends the token there too.
- **Calls** (`convex/lib/whisk.ts whiskHttpCall`). Convex's HTTP API on
  `WHISK_CONVEX_URL`, the token added to each call's args, Whisk's thrown
  sentence unwrapped, and a revoked token read as "connect again".
  `whiskAccessFor` gives a turn a caller bound to the token and what its
  scopes allow (`whiskAbilities`). Env: `WHISK_APP_SECRET_CODECAST`,
  `WHISK_CONVEX_URL`, optional `WHISK_SITE_URL` and `WHISK_WEB_URL`; with
  either required one unset, mail and calendar are unavailable, said plainly.
- **Connect is switched on separately.** `whisk.connectAvailable` (every
  Connect button, /welcome's connect step) answers true only with
  `WHISK_CONNECT_OPEN=1` on top of the settings (`lib/whisk.ts
  whiskConnectOpen`), because a deployment can hold Whisk's secrets before
  Whisk serves its `/connect` page and code exchange. Set it once that ships
  (the mail repo's `convex/connect.ts` and `AppConnect`). A connect returns
  to the origin it started on when that is the site, a subdomain of it, or
  localhost (`whiskReturnBase`, `getConnectUrl`'s `origin`); Whisk's own
  return list (`WHISK_APP_RETURN_URLS_CODECAST`) must allow it too.
- **One product.** Every thread a tool shows carries its Whisk link (the
  `whisk link` format, `whiskThreadLink`), drafts the assistant saves are
  Whisk drafts, and the Integrations row "Mail and calendar (Whisk)" carries an
  Open Whisk button.

## Pieces and who owns which files

Parallel implementers own disjoint files. Shared files (schema, registry,
routes) are edited only by the stage named here.

| Piece | Files | Notes |
| --- | --- | --- |
| Harness `@platform/agent` | `~/src/platform/packages/agent/**`, vendored by `scripts/vendor-platform.sh` | Runtime-neutral. pi-agent-core loop, tool definitions with a risk level, the gate, the meter, the model router, history conversion. Tested on pi-ai's faux provider. |
| Foundation | `convex/schema.ts`, `packages/shared/contracts/agentClients.ts`, `packages/shared/contracts/assistant.ts` (new) | All new tables, the `codecast` agent client entry, shared types (plans, risk levels, tool names). Lands first; nothing else edits these files. |
| Turn engine | `convex/assistant/turns.ts`, `convex/assistant/history.ts`, `convex/assistant/entry.ts` | Lease, run, stream, persist, continue, hooks from the composer, triggers and decisions. |
| Assistant tools | `convex/assistant/tools/*.ts` | Mail and calendar (through Whisk), codecast verbs (tasks, docs, routines, approvals), web fetch and search. |
| Wallet | `convex/wallet.ts`, `convex/lib/wallet.ts` | Period budget, reservation in the same mutation that checks the cap, true-up, ledger, queries for the UI. |
| Billing | `~/src/platform/packages/billing/**`, `convex/billing.ts`, its route in `convex/http.ts` | Stripe over fetch (no SDK), checkout, portal, signed webhook. Prices and limits come from the `PLANS` catalog (see Plans); `@platform/billing` takes them as input and holds none of its own. Env-gated: no keys means plans are granted by hand and the upgrade button says so. |
| Google identity and connectors | `convex/auth.ts`, `platform/packages/auth` web provider list, `components/AuthProviderButtons.tsx`, `convex/googleOAuth.ts` | Google sign-in (env-gated on `AUTH_GOOGLE_ID`), Calendar scope, an internal token getter the tools call. |
| pi cost | `packages/cli/src/parser.ts` | Read pi's per-message `usage.cost` into `usage_totals`. |
| Hosted mode (web) | `packages/web/lib/surfaceRules.ts` and `lib/surfaces.ts` (the registry and `MODE_WORDS`), `packages/web/components/simple/**` (hosted wording, plan rules, connect, billing), `app/settings/plan/page.tsx` | Inside the main app's DashboardLayout; gated through the registry, never a separate shell. |
| Onboarding | `packages/web/app/welcome/**` | Two steps, sign in and start, with connect as a side screen (`?step=connect`). |
| Hosted mode (mobile) | `packages/mobile/components/hosted/**`, the tabs, `app/session/[id].tsx` | The same mode in the phone's tabs. |

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
   `wake` is scheduled, so it waits behind Convex's scheduler, which on prod
   ran 1 to 4 minutes late (2026-10-07). So the person's client, once a write
   that gives a hosted conversation input lands (`lib/hostedKick.ts`, wrapped
   around the store's dispatch: a send, a hosted create, a release, a retry),
   calls the public action `entry.kick`, which takes the same lease and runs
   the turn in that action (`turns.ts runTurn`), then the conversation's next
   turn when input arrived meanwhile, while time allows (`KICK_CHAIN_MS`).
   The scheduled wake and run stay the fallback: `begin` claims a turn
   (`run_claimed_at`), so whichever runner begins first runs it and the other
   stands down. Measured on prod: first token 1.8 to 2.6 s after a send with
   the kick, 43 to 220 s without.
2. **Lease.** A mutation inserts a `running` turn only if none is running for
   the conversation; otherwise it leaves the new input queued and the
   running turn picks it up before it stops.
3. **Reserve.** The same mutation reserves the turn's ceiling from the
   wallet. No room: the turn ends at once with reason `budget`, and the
   person sees why and what to do. A card this turn would have taken up ends
   the way `begin` ends it (`turns.settleParked`: the answer is read, a card
   still up is withdrawn when the person moved on, an Always allow still
   writes its rule), and its call is answered as not run right after the
   call's message, so it never runs later on a stale answer.
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
  person's rows and marks them delivered. It first refuses a conversation
  safety-blocked since its lease: the turn ends before the run starts.
  The model reads text only, so `enqueuePendingMessage` refuses an image
  sent to a hosted conversation with a plain error rather than drop it. A pending row that answers a
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
  (`mail.deliveredAddress`: the angle-addr that ends a `send_mail`
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
  scope would write; refuse rules always apply. While content the person did
  not write is anywhere in the rows the model reads (`ToolSet.readOutside`,
  the same check `remember` uses, over the whole replayed history), an allow
  rule never waives a call that reaches other people: a mail from an address
  the person always allows could otherwise steer the model into sending that
  address their private mail with no card. Rules for calls that stay in the
  account, or that reach no one, still apply. Always allow writes a rule
  once; the same answer given again writes nothing.
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

`toolsFor(ctx, userId, conversationId, { whisk?, fetch? })` in
`convex/assistant/tools/index.ts` returns the turn's tools, a `note` for the
system prompt naming what the person has not connected or allowed, and a
`gate(rows)` for the run. Every tool acts as the conversation's owner only.
On a deployment that cannot reach Whisk (`whiskConfigured()` is false) no
mail or calendar tool is offered and the note says they are not available
there, rather than offering a connect flow that cannot work.

The mail, calendar and web tools, the Whisk transport, the approval rules,
the system prompt and the wallet arithmetic live in `@platform/assistant`
(`~/src/platform/packages/assistant`, its README maps the modules); the file
names below are its `src/`. Codecast keeps storage and wiring:
`tools/web.ts` binds the web tools to `lib/publicFetch` and `lib/anthropic`,
`tools/index.ts` joins every tool's Always allow narrowing into
`ALLOW_SCOPES`, `turns.ts` binds `withRules` and `systemPrompt` to it, and
`lib/wallet.ts` binds `walletRules` to `PLAN_CATALOG`.

- **Mail and calendar seam.** The mail tools (`mail.ts`) are written against
  a `Mailbox` and the calendar tools (`calendar.ts`) against a `Calendar`:
  the few thread and event verbs any engine offers. The tool definitions,
  their wording, their risk and the gate rules live there and do not depend
  on the engine. `whiskEngine.ts` (`whiskMailbox`, `whiskCalendar`) is the engine:
  each verb is a Whisk function the `whisk` CLI calls (`search:runFullSearch`,
  `sync:threadsByIds`, `sync:threadMessages`, `sync:listLabels`,
  `sync:getAccount`, `calendar/read:listCalendars`, `calendar/read:listEvents`,
  `ai/actions:draftReply`, `ai/actions:summarizeThread`, and `dispatch:dispatch`
  with `saveDraft`, `sendMessage`, `applyThreadOps`, `createEvent`,
  `updateEvent`). Tests use `fakeWhisk` (`@platform/assistant/testkit`).
- **Mail** (`mail.ts` over Whisk): what a connection allows is
  `whiskAbilities(scopes)`, the rule the Connections screen shows too.
  `search_mail`, `read_thread` and `summarize_thread` need `mail.read`;
  `suggest_reply` (Whisk's reply in the person's voice, returned as text and
  saved nowhere), `draft_reply`, `create_draft`, `archive` and `label` need
  read, draft and organize; `send_mail` needs read and send. Reads, summaries,
  suggestions and drafts are risk `read`; send, archive and label are
  `write`. Whisk keeps several mailboxes for a person: a thread is read,
  answered, archived and labelled in the mailbox that holds it, and new mail
  goes from the main one (Whisk lists it first). Every thread shown carries
  "Open in Whisk: <link>". A thread may be named by one of its messages'
  ids: Whisk answers with the thread's row, and every verb, a reply's
  `thread_gmail_id` included, uses that row's own id and mailbox. A reply answers the thread's last sent message,
  never a draft in it (`replyEnvelopeFor`), and each recipient entry must be
  exactly one address (`recipient`). A `send_mail` reply goes out under the
  thread's own subject (mail engines file a reply into its thread only when
  the subject matches), so a reworded subject is refused. `subject` is always
  required, so the approval card shows the subject that goes out. Sends,
  drafts and events carry a key from the call id (`callKey`), Whisk's
  `client_id`, so a call that lands twice is one message. A label must
  already exist in that mailbox. Whisk's own refusals (its hourly AI budget,
  a revoked token) reach the model as Whisk words them. `read_thread` marks a
  draft in a thread "Draft (not sent)", keeps the newest messages whole within
  `THREAD_MAX_CHARS` (under the fence's cap, which cuts a block's end),
  shortens older ones to sender, date and snippet, and leaves out the
  earliest once even those do not fit, saying how many.
- **Calendar** (`calendar.ts`, calendar.events): `list_events`,
  `find_free_time` (`read`), `create_event`, `update_event` (`write`).
  `create_event` derives the event id from the call id, so a create that lands
  twice is one event. All-day events cover their day in the calendar's own
  zone. `list_events` says when more events follow; `find_free_time` reads up
  to four pages and stops its search where reading stopped. In
  `update_event` a new start alone moves the event and keeps its length, a
  new end alone keeps its start, and an all-day event changes time only with
  both edges given; edges keep the event's own time zone. Whisk mirrors each
  calendar only for a window (14 days back to 62 days ahead of its last full
  sync, `window_start`/`window_end` on `listCalendars`), so an engine reports
  the span it can read (`EventRead.seen`; `mirroredSpan` falls back to those
  constants for a row without them). Outside it `list_events` says the
  events are unknown, never that there are none, and `find_free_time` calls
  nothing free there. The calendar is read once per turn and read again after
  a create or an update, so a later verb in the turn sees the change.
- **Codecast** (`codecast.ts` over the internal functions in `workspace.ts`):
  `list_tasks`, `create_task`, `update_task`, `read_doc`, `write_doc` (create
  or append), `remember`, `recall`, `list_routines`, `cancel_routine` are
  `read`. `replace_doc` is `write`, since docs keep no old versions, and
  `schedule_routine` is `write`, since it spends usage later unattended. A
  routine on days of the week takes `days` and a clock `time` (and
  `starts_on` only for a later start), never a date: the server finds the
  first day in the person's zone (`@platform/assistant` `firstCadenceRun`,
  which the approval card reads too). Asked for a date, Haiku counted
  "every Saturday" a day late in every sample (0/32; 48/48 with this shape,
  2026-10-07). `first_run` is for once and for repeats within a day. They
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
  model, earlier turns' history included, called a tool whose result can hold
  text the person did not write or approve: mail, calendar, web, `list_tasks`
  and `read_doc` (a task can be a synced issue, and a doc can hold a line the
  assistant added while mail was in view). Only `recall` and `list_routines`
  are left out (`codecast.PERSON_APPROVED_TOOLS`, `index.readOutsideContent`),
  so a fact steered by an email or page never enters lasting memory unseen,
  not even by way of a task or doc. `write_doc` refuses to append to the memory
  doc, which leaves `remember` and the approved `replace_doc` as the only ways
  to change it. Memory is one personal doc, "What I know about you",
  found by its `source_file` among the person's own docs
  (`docs.ownDocsBySourceFile`); archiving it makes the assistant forget, and
  the next `remember` starts a fresh doc. Routines are triggers on this
  conversation, `once` or `recurring`, at least an hour apart and within the
  plan's rules. Both rules live in `routineRefusal`
  (`ROUTINE_MIN_INTERVAL_MS` holds on every plan; a plan's own floor can only
  raise it), and any interval at all makes a routine recurring, so one too
  short is refused rather than run once.
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

The Whisk app token lives inside the turn's call closure (`whiskAccessFor`)
and never enters arguments, results or logs. Mail, calendar, web pages and the person's stored text (tasks, docs,
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
| Default model | Haiku 5.5 | Sonnet 5.5 | Sonnet 5.5, Opus 5.5 for hard work |
| Routines | 3, at most daily | 25 | unlimited |
| Concurrent turns | 1 | 2 | 3 |

### Who the Free plan serves

Every new wallet starts on Free with a month of our tokens, so the turn
engine gates Free turns (`convex/assistant/freeGate.ts`, read in
`leaseTurn` before a turn reserves anything). A turn a paid plan or bought
credit pays for is never gated.

- **A proven address.** Apple, Google and GitHub sign-ins prove the email
  (`emailProven`, lib/workDomain). A password account does not, so its first
  Free turn stops on a `verify` notice, the stop mails a six digit code
  (`lib/emailProof.ts`, shared with team discovery), and the notice carries a
  code field. Entering it (`assistant.entry.confirmEmailProof`) proves the
  address and picks the stopped ask up by itself (`resumeAfterNotice`, the
  same path the engine's own outage retry takes).
- **One Free month per mailbox.** `assistant_free_mailboxes` records which
  account a mailbox's Free month serves, claimed by its first Free turn.
  On consumer mail providers a +tag (and on Gmail, dots) names the same
  mailbox (`freeMailbox`); a company address stays whole. A second account
  on an alias stops on a `limit` notice.
- **A daily ceiling.** `assistant_free_days` sums what Free turns spent per
  UTC day. Past `FREE_DAILY_CEILING_USD` ($25, overridden by the deployment's
  `HOSTED_FREE_DAILY_USD`) new Free turns stop on a `limit` notice until the
  next UTC day, and the operator is alerted once that day
  (`incidents.alertFreeCeiling`: the error log, and Sentry when `SENTRY_DSN`
  is set).

No per-IP cap: a self-hosted Convex function sees a rotating internal proxy
address, so an IP key bounds nothing; the mailbox is the unit of abuse.

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

## How hosted mode is wired

Hosted mode is the main app with `client_state.ui.lane === "simple"`
("Revised 2026-10-05" above). The separate lane that came first is retired
("History: the simple lane" below). What it built and still runs, now in
the main app:

- **Reads.** A hosted conversation is a `sessions` row with a hosted
  `agent_type` (`isHostedAgentType`; `HOSTED_AGENT_TYPE` is `"codecast"`);
  its approvals are pending `sessionDecisions` on it; its routines are
  `agentTasks` anchored to a hosted conversation (`hosted_home`,
  `originating_conversation_id`).
- **The preference.** `components/simple/lanePref.ts` holds `laneOf`,
  `writeLane`, `isHostedUi` and the switch's words (`LANE_SWITCH`), with no
  router in it, so the web and the phone share it. Writing goes through the
  store's `setLane`, which also moves the person to Personal.
- **Look.** Hosted mode and `/welcome` are Whisk's siblings.
  `@platform/design` (`~/src/platform/packages/design`) is the one home of
  the family's palette (light and dark), faces (Instrument Sans for the
  interface, Newsreader for reading and titles, Fragment Mono for counts),
  shape and motion: `src/tokens.ts`, rendered by its build into `tokens.css`
  as `--pd-*` properties (dark under `:root[data-theme="dark"], :root.dark`,
  so both apps' theme switches reach it). Whisk's `--m-*` and codecast's
  `--sl-*` are names for those tokens, never their own values.
  `components/simple/laneLook.ts` imports the sheet and
  `@platform/design/fonts` (bundled from fontsource as Whisk bundles them);
  `ThemeProvider`, `/welcome` and `/connect/whisk` load it. The `--sl-*`
  names say what a colour means, one name per meaning: `--sl-accent` (with
  `-wash`, `-line`, and `--sl-on-solid` for text on a fill) for what needs
  the person and the yes, `--sl-working` for the assistant at work,
  `--sl-mark` for quiet ornament, `--sl-wash` for neutral fills, `--sl-ok`
  for done; `--pd-*` appears only in their alias block
  (`components/simple/simple.css`). Shape is the family's two radii
  (`--sl-radius-sm` = `--pd-radius`, `--sl-radius` = `--pd-radius-lg`), and
  motion its one curve (`--sl-ease` = `--pd-t-ease`; the phone's
  `HOSTED_EASE` uses the same control points). Vermilion is spent on what
  needs the person and on the yes; what the assistant writes is set in
  Newsreader. In the main app, `html.hosted-mode.minimal-style` maps the
  `sol` accents onto the family ("Polish round 2").
- **Boot.** A cold load of `/welcome` opens on the family's paper with the
  ring mark, never the developer splash. `plugins/laneBoot.ts` injects the
  `--pd-*` sheet (`tokensStyleTag()` from `@platform/design/vite`) and an
  inline copy of `components/simple/laneBoot.ts` into index.html's head,
  which flags `<html data-lane>` on the pages in `LANE_PAGES` (`/welcome`
  alone) and swaps the marketing title for `LANE_BOOT_TITLE` until
  `useLaneDocumentTitle` replaces it.
- **Billing.** `billing.ts useBilling` reads `billing.billingAvailable`
  (a `BillingStatus`: `available`, the priced `plans`, and whether a
  `topup` can be bought) and calls `billing.startCheckout` with `{ plan }`
  or `{ topup_usd }`. It gets back a `BillingRedirect` (`{ ok: true, url,
  via }` or `{ ok: false, code, error }`) and opens `url`; Stripe returns
  the person to `/settings/plan?billing=done|topup|canceled` (`BILLING_RETURN`
  in `@codecast/shared/contracts/assistant`, which the server's return URLs,
  the plan page and the return note all read). `useBillingReturn` (web
  only: it uses the web's router, and `billing.ts` is shared with the phone)
  reads the parameter once, takes it off the URL, and says the payment is on
  its way until the wallet shows it. `useBilling().manage()` opens the
  billing portal (`billing.openPortal`) through the same redirect; the plan
  page shows "Manage billing" when billing is available and
  `WalletSummary.billing_account` is true. A negative `topup_usd` is shown
  as money owed. With billing unavailable the plan page says card payments
  are not open yet. `useBilling(open)` takes the opener (the web leaves for
  the page; the phone opens it in the browser), and `usePlanFigures` is the
  page's figures for both.

How hosted mode is wired on the phone (`packages/mobile`, built 2026-10-06):

- **One mode, one registry.** The phone reads the web's own registry and
  words (`lib/surfaces.ts`: `useSurface`, `useHostedMode`, `useModeWords`),
  through the shared store, so a surface's rule is one line for both. The
  Appearance switch writes `client_state.ui.lane` (`lanePref.writeLane`) and
  nothing moves the view: the tabs change in place.
- **Inbox.** The new conversation sheet starts on the default agent
  (`useDefaultAgentType`; the hosted assistant in hosted mode or with no
  machine) and lists the hosted assistant among the pinned agents
  (`usePinnedPickerOptions`), and always: the phone has no palette to reach
  it from. With the assistant picked it is just the first
  ask (`components/hosted/AssistantStart.tsx`): the intro, starters and a
  composer, sent through `startHostedConversation`, with no machine, folder,
  model or context rows; where only the assistant can answer, the agent row
  is not offered. An empty inbox in hosted mode shows the same intro
  (`empty.installCli`), with its starters and the new conversation button as
  the only ways in, and project chips follow `gitChips`.
- **A hosted conversation** is the session screen (`app/session/[id].tsx
  SessionScreen`), the same one every conversation opens in, so it keeps
  rename, share, search, the message navigator, deep links to a message
  (`?message=`) and focus after a create (`?focus=1`). The screen reads the
  row's agent (`isHostedAgentType`) and drops what a conversation with no
  machine has no use for: the model, device and context chips, slash command
  pills, image attach and stop. What a mode hides on any conversation comes
  from the registry, as on the web: `conversation.internals` (Restart, Copy
  Resume Command, Expand/Collapse Messages, the token chip) and `diff` (View
  Diff), so a local session opened in hosted mode hides them too. Each
  tool call reads as one plain line in `@platform/assistant/steps` wording
  with a mark for how it came out (`components/hosted/Steps.tsx HostedStep`,
  the phone's counterpart of the web's `lib/hostedReceipt.ts`); nothing
  opens to the raw call. The approvals it waits on sit at the foot of the
  transcript with the actual draft (`components/hosted/ApprovalCard.tsx`,
  the one hosted part of the screen; a long draft folds through the shared
  `CollapsibleBody`; the decision screen's `AnswerControls` for a
  pick-several, ranking or form), and the reply box says what the web's
  says after the same exchange (`lib/hostedComposer.ts`). "Getting
  started…", then "Thinking…", shows in the composer while the turn runs
  (`useLane.ts useConversationWorking`, over `lane.ts conversationState`: a
  turn's own "done" ends it at once, without the idle grace a daemon's
  status needs).
  A push tapped on a closed app lands before the cache is read back, so the
  route holds a bare header until the row is known or the cache is read
  (`SessionDetailScreen`): the screen never opens as a developer session and
  then changes under the person.
  An approval's answer is consumed by the turn and never written to the
  transcript (`convex/assistant/input.ts`), so the bubble the store paints
  for it has no echo. Both halves of that live in the shared store path, for
  the web and the phone alike: `mergeUnconfirmedMessages(…, hosted)`
  (`hooks/useConversationMessages.ts`) places it where the card was, in the
  order answers were given, instead of trailing everything said later, and
  `reconcilePendingSendForSession` settles it the moment the row moves past
  the stamp it was sent at, so the inbox row stops reading as working. The
  minute coverage pass (`usePendingMessageCoverage`, mounted in
  `StoreSyncBridge` as on the web) is the backstop. The phone draws it as a
  quiet note only when it says more than the step does (`lane.ts
  answerNote`, the web's `approvalAnswerAddsToReceipt`).
- **Inbox rows and words.** In hosted mode a row is its title, its time and
  one quiet line (`inbox.rowInternals` hides the status word, the summary
  bullets, the caret line and the agent, model and message count): where it
  stands while live (`conversationState`), else the pinned state line, else
  what the person asked. Stash and Kill read "Set aside" and "Close
  conversation" (`MODE_WORDS`: `stash`, `kill`, `killAsk`, `stashed`,
  `killed`, …), and the two folded lists show only once something is in one.
  Alerts name the assistant by its display name and word its events
  "replied" and "needs your OK" (`lib/notificationTypes.ts
  notificationAgentName`, `notificationTypeLabel`, shared with the web bell).
- **Time zone.** `StoreSyncBridge` mounts the web's `useAdoptTimezone`, so a
  phone-only account's profile takes the phone's zone and the assistant
  places "8am" on the person's clock. The approval card says a time and a
  repeat in plain words (`@platform/assistant approvalContext`, given the
  profile's zone by `turns.ts askApproval`).
- **Dispatch is wired once, at the root** (`StoreSyncBridge`). A screen must
  not call `useEnsureDispatch`: the binding is one slot with an owner, so a
  screen that binds rejects the writes in flight and, on closing, leaves
  every later write parked. The session screen no longer does.
- **Tasks** gains a routines segment, named by mode ("Triggers" or
  "Routines"), listing every armed trigger in the shared roster order
  (`triggerTasks.ts compareTriggerRoster`) with pause, open and cancel
  (`components/hosted/Routines.tsx`). An armed trigger is cancelled, never
  deleted: `triggerTasks.ts triggerEndVerb` is the one rule for the phone's
  list, the inbox dock and the web triggers page, and `triggerEndWords` names
  it in the mode's noun. A row says its schedule in the web routine row's
  words (`lane.ts routineSchedule` over `hostedSchedule.ts
  describeHostedCadence` and `hostedNextWords`), reading the routine's
  wall-clock `cadence`: "Weekdays at 8:00 AM. Tomorrow". An empty list in hosted mode shows the web's routine
  examples (`hostedSchedule.ts routineExamples`); each opens the inbox's new
  conversation sheet with the ask typed in (`/(tabs)/inbox?ask=`). Each
  segment is the phone's view of a web page (`SEGMENT_PAGES`), so the
  registry's page rule (`SurfaceMode.showsPage`) decides which show: hosted
  mode has no Plans.
- **Settings** has an Assistant group: Plan (`components/hosted/PlanPage.tsx`,
  the web plan page's sections over `usePlanFigures`, `useBilling`, checkout
  and portal in the browser) and Mail and calendar
  (`components/hosted/MailPage.tsx`, `useLaneMail`; Connect opens the web's
  `/settings/integrations`, where the signed-in session finishes it). The
  Accounts and Devices rows follow `settings.machines`.
- **Look.** Hosted mode wears the family look, as the web's does ("Mobile
  polish round 1" below); `components/hosted/hostedTheme.ts` names each
  colour by meaning over `constants/Theme` (the yes, what waits on the
  person). The assistant wears the codecast mark (`AgentLogoSvg`,
  `@codecast/shared/render/codecastMark`, shared with the web's `Logo`).
- **Old addresses.** `/simple/...` links go where the web sends them
  (`lib/laneRedirect.ts`) and on to the phone's screen (`lib/linkRoutes.ts
  PAGE_ROUTES`): home to the inbox, approvals to `/decisions`, routines to
  the Tasks tab's routines segment (`?segment=routines`, which the tab
  reads), plan and connections to their settings pages. The web's short
  page names (`/approvals`, `/plan`, `/mail`, `/integrations`, `/routines`)
  resolve through the same alias table (`pageAliasTarget`).

How onboarding is wired (`packages/web/app/welcome/`):

- **Screens.** `onboarding.ts welcomeStep` picks the screen: signed out is
  sign in; signed in is connect unless mail is already connected, the
  person chose "Not now" (`?step=start`), or the deployment cannot connect
  mail (`whisk.connectAvailable`), and then it is the first ask. A
  move between screens is one view transition (`page.tsx moveTo`), skipped
  for reduced motion or a hidden tab.
- **Sign in** is `AuthProviderButtons` with the lane's own classes and words
  (`classFor`, `labelFor`), ordered for someone who does not write code:
  Google first when `auth.signInProviders` offers it; without it Apple and a
  "Continue with email" button lead and GitHub sits quietly last. Email never
  leaves the page: `/welcome?email=signup|signin` shows `EmailStep.tsx`, the
  form in /welcome's look, running the same flow as `/signup` and `/login`
  (`hooks/useEmailAuth.ts`: `useEmailAuth` and, for a mailed code,
  `useEmailCode`).
- **The promise** follows what the deployment can do:
  `components/simple/assistantPromise.ts` words the sign in line and the
  entry links once, and promises mail and calendar only where
  `whisk.connectAvailable` is true. Where it is false, /welcome's first
  ask and the Connections card both say `MAIL_COMING`. `useLaneMailAbilities`
  decides once what an unanswered question means (a failed one counts as
  able), and every signed-in surface reads `available` from it, /welcome
  included. `connectionControls` offers Connect only on an explicit yes, and
  until the deployment answers Connections shows neither Connect nor the
  coming line. The sign in line ends on the same ask-before-acting promise
  as every other screen.
- **The ask-before-acting promise** is worded once in
  `components/simple/askFirst.ts`, a leaf with no imports so the lane (web
  and phone) and the public pages share it: `askFirst(act)` frames it and
  `ASK_FIRST` is the mail and calendar wording that sign in and Connect say.
  `askFirstFor(can)`, in the same file, names only what the person's mail
  connection can change, so a lane with no mail says "I always ask before I act
  for you." Home's and Connections' ledes and the sign in line all end on
  it. `lane.test.ts` fails if a surface drifts from it.
- **Connect** reads `useLaneMail(LANE_PATHS.welcome)`, the same hook the
  Connections screen uses, and renders the same `Service` rows with
  `connectionWords`. Every line it shares with Connections comes from one
  place: `LANE_COPY.connections`, `disconnectNote`, and `ASK_FIRST`. Whisk's
  approval screen opens in the same tab (a tab opened after the URL is
  minted is outside the tap, and phone browsers block it) and comes back
  through /connect/whisk to /welcome, which mounts `ConnectNotice`. The
  desktop app hands it to the system browser. `useLaneMail().known` waits
  for the connection (one read, `whisk.connection`, with its grant) and, for
  someone not connected, whether the deployment can connect mail; a failed
  read counts as answered, so no screen waits on it for good.
- **First ask** is `lane.ts firstAsks(can)` from what the grant allows. It
  starts through `lib/startHostedConversation.ts startHostedConversation`
  and lands in the conversation (`lanePaths.ts hostedConversationPath`,
  `/conversation/<id>`). Every first ask works as tapped: none names a
  person the asker may not know. Signed in, the page mounts `LaneSync` (the
  store wiring) so these writes go out. Acting on any screen (connect, Not
  now, an ask) writes `ui.lane = "simple"` (`lanePref.writeLane`). A signed
  in person who already has a hosted conversation and opens a bare
  `/welcome` goes to the inbox; a conversation the page itself just started
  does not count, so the first ask lands in its conversation (`SignedIn`'s
  `asked` ref, `welcome.mount.test.tsx`).
- **Ways in.** The marketing home page carries one link to /welcome twice:
  as a quiet line in its first screen, under the install command
  (`compact`, location `landing_top`), and as a pill under its developer
  buttons (`landing_hero`). Signup carries the pill above its form. All are
  `components/simple/AssistantWayIn.tsx`: "Don't write code?" and
  `assistantInvite`. It imports only `lanePaths.ts`, `assistantPromise.ts`
  and analytics, so the public pages never load the store. A click sends
  `assistant_path_clicked` with its location.
- **First run in the inbox.** `store/firstRunState.ts firstRun` is the one
  reading of it, pure over store state so the store's create path shares it
  (`lib/firstRun.ts` re-exports it with the `useFirstRun` hook): "yes" when no CLI has ever checked in (`cliNeverConnected`) and the
  person has no conversation. A composer's unsent stub is not a
  conversation, and an empty cold cache is "unknown" until the sessions
  floor has been cut (`inboxFloorStamped`), so someone who only uses the
  assistant never sees the card on a new device. On "yes" the home shows
  `EmptyState variant="onboarding"` whichever home is chosen (board or
  feed). In developer mode the card offers two starts, worded so each reader
  knows which is theirs: "Ask the Codecast assistant", which opens the
  composer on the hosted assistant (`openCompose(undefined, { agentType })`,
  the `ComposeContext.agentType` a caller passes to start on a given agent),
  and "Connect your coding tools", marked for developers (the install
  command, or one click in the desktop app). The choice sends
  `first_run_start_chosen`. In hosted mode only the assistant start shows
  (surface `empty.installCli`).
- **A first message to the assistant joins hosted mode.** When the first
  conversation of someone with no machine is created on the hosted assistant,
  the store's `createSessionFromStub` sets `ui.lane` to "simple", so the
  inbox card and /welcome end in the same product. That function is the one
  create every way in reaches (the composer, Ctrl+N, the palette's "Ask the
  Codecast assistant", the context composer, the self-heal), so no caller
  joins on its own. Opening the composer and closing it changes nothing.
- **Nothing covers the first run or the first reply.** The device permissions
  dialog and the inbox tour wait until `firstRun` is "no", so the dialog
  opens once a developer-mode person has a conversation, and neither opens
  unasked in hosted mode (surfaces `banner.deviceSetup`, `tour.agentInbox`).
  In hosted mode the first reply is also free of developer chrome: the
  native app strip and the Defer, Stash, Kill row are developer surfaces
  (`banner.nativeApp`, `triageBar`), and the notification nudge waits until
  news has actually gone unshown (`decideNotificationNudge`'s
  `onlyAfterMiss`), in the mode's own words (`MODE_WORDS.notificationsOff`
  and its two siblings). The conversation menu drops its working parts (the
  short id, resume commands, the model and agent panel, token counts:
  surface `conversation.internals`) and reads "Conversation", the top bar
  holds no "Create Team" for an account with no team (`topbar.createTeam`;
  Settings' Team page keeps the way in), and the folded lists under the
  inbox read "Set aside" and "Closed", with "Closed" drawn only once it
  holds something. A window with no tab opens exactly one, so no tab strip
  shows over a first conversation.
- **A forgotten password stays in /welcome.** `/welcome?email=reset` asks for
  the address, then the mailed code and a new password, and signs the person
  in (`EmailStep`'s reset mode). The flow is `useResetRequest` and
  `useResetConfirm` in `hooks/useEmailAuth.ts`, which `/forgot-password` and
  `/reset-password` run too.

### Polish round 6 (2026-10-06)

- **Titles.** A hosted conversation is named from its first full answer:
  `assistant/turns.ts finish` calls `titleGeneration.ts titleAfterHostedAnswer`
  while no title pass has written a subtitle. The message-2 milestone fires
  while the reply is still streaming, and its 5-minute floor used to leave the
  ask itself as the title for good.
- **Approval card.** What Yes does sits under the plan, above both buttons.
  `answerDecision` returns its dispatch, so a refused answer re-enables the card
  with `APPROVAL_REFUSED`. The plan box fades at its cut while more is below
  (`useOverflows`, `clipFade`).
- **Inbox row.** A wait for an OK says "Needs your OK" once, after the title.

### Polish round 7 (2026-10-07)

- **Approvals settle.** A hosted conversation asks only through its decision
  row: `lib/decisionQueue.ts sessionHasOpenQuestion` and the server's
  `conversations.ts ownAsk` leave hosted rows out, since their
  permission_blocked status lags an answer. The queue is `buildDecisionQueue`
  (`hooks/useDecisionQueue.ts`), tested in
  `store/__tests__/hostedApprovalSettles.test.ts`. The "Getting the card
  ready" line shows only while the transcript ends on the parked call.
- **Drafts.** A new conversation with nothing sent is a draft
  (`inboxStore.ts isUnsentConversation`) in its own quiet line under Done,
  never under Working on it. Put away reads Archived.
- **Routines.** `schedule_routine` takes a `summary` written to the person;
  the card shows it in place of the instruction (`@platform/assistant`
  `approvalContext`) and it is the routine's `display_summary`. The first run
  reads from today everywhere (`relativeDay`, `firstRunWords`: "tomorrow,
  Thursday, at 8:00 AM"); the tool result carries it and `ROUTINE_SHOWS_UP`
  (where it arrives), and the yes on the card says where it arrives.
- **Sendable text.** The prompt puts text to send in the reply as a quote;
  `lib/sendableText.ts` finds it and a hosted answer offers Copy under it.
  A note's header leads with a labelled Copy in hosted mode.
- **Mail search.** A query with no letter or digit is refused, and a search
  that finds nothing names the mailboxes it looked in and says it is not an
  empty mailbox (`mail.ts noMatch`). Receipts drop wildcard tokens.
- **Gates by mode, not style.** Layouts and the palette's docked composer and
  Layouts group (`actions.fleet`), Workspaces (`nav.projects`), the running
  agents pill (`machineChips`), a conversation's message count and duration
  (`conversation.internals`), Agent features and Capabilities
  (`pages.devTools`) and the Chrome extension block (now `developer`).

### Polish round 8 (2026-10-07)

- **Reach, not promise.** Integrations lists in hosted mode only services
  whose descriptor says `assistantReaches` (`appDescriptors.ts`); today that
  is none, so the page is the Whisk row. `developerOnly` and `hostedTagline`
  are gone.
- **Wallet.** Send is held only when the allowance and the extra credit are
  both spent (`lane.ts meterOut`, the `full` of `usePlanMeter`); a spent
  allowance with credit reads "Allowance used, on extra credit". With top-ups
  closed the held line offers "See your plan" (`TopUpLink`).
  `TYPICAL_REQUEST_USD` is $0.005, the rounded-up mean of 76 charged prod
  turns, so Free says about 400 everyday requests.
- **Approvals.** After an answer the card holds its place as one settled line
  read from the store's answered decision row (`HostedApprovalSettled`,
  `ConversationView parkedCallAt`). A routine's question names it without a
  colon (`set up the routine "X"`), its summary is the card's own paragraph,
  and the yes says when it starts from today, that it runs until paused on
  Routines, and where it arrives (`turns.ts approveWords` with the person's
  zone).
- **Steps in flight** read in the present progressive (`@platform/assistant
  stepOngoing`: "Searching the web for ..."); "Waiting for your go-ahead to"
  only while the conversation is parked (`HostedAskingContext` into the
  receipt). The status line says "Writing..." once reply text streams.
- **Lists.** To-dos follow the Assistant scope (`assistantScope.ts
  isAssistantTask`: no project or plan, made by hand or in an assistant
  conversation; `create_task` now stamps `created_from_conversation`) and on
  Personal start ungrouped, newest first (`hostedPersonalView`). Saved views
  that arrange by person or agents are hidden in hosted mode and start
  collapsed (`savedViews.ts fitsHostedMode`). Routines say "Next: today at
  8:00 AM", hide a row's second line when it has no summary, and show search
  and kind filters only from six routines. Notes drop the sync badge and call
  hidden agent docs "notes from coding agents".
- **Rail.** Unread is a neutral dot and a 600 title, read titles muted; the
  accent stays for rows waiting on the person. Drafts drop the dot and chip,
  the working dot is ink with a soft pulse, Done shows six then "Show N
  more", and Archived lines up with Done. The scope switch shows only when
  Everything adds rows. Hosted rows take their name from the conversation
  row the header reads.
- **Chrome.** `transcriptNav` hides the minimap, jump to top and progress
  rail; the empty palette leads with the Create group; the compose sheet
  offers chips (a routine among them), a plain close when docking is off,
  and no Escape hint (`escapeCloses`); the conversation hint reads "Esc for
  shortcuts"; an answered conversation's composer says "Reply, or ask a
  follow-up". The phone's + is a ghost button. List selection and inline
  links use the family accent and ink (`data-list-row-state`,
  `data-cc-inline-link`).
- **Funnel.** `/pricing` through the assistant's door sets its hero and
  assistant section in the family faces and takes the mail promise from
  `assistantPromise`; the home page scopes "never resells tokens" to coding
  agents.

### Polish round 9 (2026-10-07)

- **One name.** `conversationTitle.ts ownTitle` prefers `title` over
  `short_title`, so the rail, header, tabs and palette name a hosted
  conversation the same way whichever store home fed the row. Hosted titles
  come from their own prompt (`titleGeneration.ts buildHostedTitlePrompt`,
  chosen by `agent_type` in `selectTitleInput`): everyday words, no
  "session", "task" or "setup". Measured on 8 hosted freezes (tag
  `hosted-title`): 48/48 pass, mean 0.95 against 0.73 for the developer
  prompt (separated, p=0.004 for the first variant).
- **Approvals.** A hosted conversation's card renders in the transcript's
  tail item (`ConversationView hostedTailCard`), not docked above the
  composer; while it shows, the receipt leaves out the step waiting on it
  (`HostedCardShownContext`, `hostedReceipt cardShown`), and the plan drops a
  "When" line the summary already says (`HostedApprovalCard planForCard`).
  After a no the composer says "Tell me what to change"
  (`decisionQueue.ts hostedDeclinedSince`); a lagging permission_blocked
  status shows "Thinking…" once the card is answered. Approvals' empty state
  says the answer ("You said no: set up the routine ...",
  `answerSaid`, `questionAsStatement`). Yes on a routine is worded once,
  `routineYesWords` (shared contracts), for the engine and the marketing still.
- **Lists.** A hosted list header (`GenericListView`) shows its views,
  search, filter and display only from six items, or while one is in use;
  To-dos add through the quick-add row, Notes through "New note"
  (`createLabel`). Hosted Notes leave role docs out (`isOnNotesShelf`) and
  drop the coding-agents footer. `fitsHostedMode` also refuses sort by
  person, any `source`, and workflow statuses.
- **Search.** `/search` and the top bar follow the Assistant scope; the page
  hides operators and team segments behind `search.internals`. Snippets drop
  machine wrappers (`searchHighlight.tsx stripSnippetMarkup`). The palette
  scopes favorites, leaves drafts and visited rows out of recents, never
  folds same-name conversations, and gives Cmd+Enter one owner row.
- **Rail.** A just-sent stub is Working on it from the first frame
  (`pendingSendIdsOf`); unread titles are 600 in ink and read ones muted at
  the span; the needs-input section is "Your move".
- **Funnel.** `HostedWordmark` is the one hosted wordmark (rail, /welcome,
  the assistant-door nav `MarketingNav door="assistant"`). Pricing through
  that door sits on the family paper and says each thing once.

### Polish round 10 (2026-10-07)

- **Routines deliver.** A hosted routine's frame is its instruction alone
  (`triggerLifecycle.ts triggerRunFrame`, `hosted_home`), drawn in the
  transcript as one line, "Routine · Morning to-do review · 8:01 AM"
  (`triggerRunBlock.tsx HostedRoutineRunLine`). A routine never parks its
  hosted conversation: each run's answer files as done or needs_input
  (projection v20, `inboxProjection.ts` and `dormancy.ts triggerMayPark`),
  and hosted mode has no "Scheduled for later" (`hostedStatusSections`).
  Next runs read one way everywhere, "Next: tomorrow at 8:00 AM"
  (`hostedSchedule.ts plainNextRun`, the rail footer through
  `firstRunWords`); stopped routines read "Stopped · Never ran" or
  "Finished Oct 3" (`plainEndedWords`), and History drops the success bar.
- **Where it arrives.** `ROUTINE_SHOWS_UP` promises only the inbox; the card
  says when this device's notifications are off and offers to turn them on
  (`RoutineNotifyLine`).
- **One rule for to-dos.** `isAssistantTask` lives in `@codecast/shared/tasks`;
  `list_tasks` reads it, so the assistant and the To-dos page agree.
- **Search finds your own work.** The palette and /search match the store's
  tasks and docs over the mention index (`universalSearch.ts searchIndexOf`,
  `matchRoutines`); `webMentionList` fills personal rows first. /search shows
  To-dos, Notes and Routines groups in hosted mode (`search/ObjectMatches`).
- **Calmer waits and words.** The budget line offers only what Plan can do
  (`billing.ts billingStatus`) and a routine firing while the allowance is out
  repeats it once. A decision answer is never the sticky prompt. Opening a
  hosted conversation shows a transcript skeleton (`TranscriptSkeleton`). An
  auth blip returns to the page it left (`lib/authReturn.ts`), and /welcome
  sends someone with conversations to their inbox.
- **Rail and receipts.** One step that made one thing is one line with a live
  link and state (`HostedMadeLine`); same-name rows get a muted day or time
  (`sameNameSuffix.ts`); "Needs your OK" is a dot and "OK?". Pages is a
  developer surface (`nav.pages`). The selected nav row is a filled pill,
  group labels are tracked mono, and send is one ink disc in the app and on
  /welcome.

- **One route guard.** A page the mode hides redirects from the shell
  (`DashboardLayout`, `surfaceRules.ts hiddenPageRedirect`, read through the
  same `showsPage` as the rail and palette): `/routines` and `/workflows` go
  to Routines, `/plans` and goals to To-dos, a Machines settings page to
  Settings, anything else to the inbox.
- **The assistant's door is a page of its own.** `/?for=assistant` ends after
  For everyone with `EveryoneFooter` (Pricing, Privacy, a link for
  developers); no install strip follows it.
- **Sources.** search_web's source list has one owner both ways,
  `@platform/assistant/sources` (`formatSources`, `parseSources`,
  dependency free for the browser); the receipt reads it
  (`hostedReceipt searchedSources`, one per site, up to four) and
  `HostedSources` draws the line under the search step, open or closed.
- **Rail.** Rows carry no rule of their own; the accent is on unread rows'
  times only; on hover the time yields its slot to the actions and the star
  shows only when set; a row is named by its title and time. A followed row
  clears its sticky heading (`lib/rowScroll.ts`, `scroll-mt-8`), the hosted
  rail has no scroll anchoring, an opened New row stays in New until you leave
  it, and a list with rows drops "More in Everything" (the header tab says it).
- **Words and waits.** One connection sentence (`HostedConnection.tsx`) for the
  status line, a bubble not yet sent (keeping Cancel) and the sidebar foot.
  While a turn runs with an empty box the send disc is a Stop square
  (`ComposerSendButton stop`). The meter counts requests left
  (`planWords requestsLeftWords`), the share used is its tooltip.
- **Transcript.** Reply headings are body size; narration before a step is
  in the interface face at the receipt's size; a hosted reply has no icon
  foot; a note card's table keeps figures tight and shows two columns on a
  narrow card (`numericColumns`).
- **Lists and search.** `x` checks a hosted to-do off with Undo
  (`GenericListView onToggleItem`); high and urgent show as an accent mark
  and `p` is no longer gated; the keyboard cursor takes the selected fill.
  Notes rows show the time the list is sorted by. A kind word matches from
  three letters. /search counts each group under its own heading and shows a
  conversation hit as one snippet until selected.
- **Funnel and home.** /welcome's Start offers "Use Whisk for mail now"
  beside the mail promise; the phone home lists New under Your move
  (`useNewResults`), keeps a run time on one line and lets starters wrap to
  three lines. Hosted pages load on idle (`lib/hostedPreload.ts`) and an
  in-shell load shows the page's own header skeleton (`RouteFallback path`).
- The flagship starter's two failures on 2026-10-06 were Anthropic's "credit
  balance is too low" (turns g98dee87..., g98f1ysx...), which the incident
  probe already covers.

### Mobile polish round 1 (2026-10-07)

The phone's hosted mode, brought to the polished web's parity in its own
tabs. Checked on an iOS simulator signed in as the App Review account, in
both themes, and in developer mode, which is unchanged.

- **One look switch.** `constants/Theme.ts` carries a look beside the
  scheme (`Look`: `classic` or `family`, `setActiveLook`, `useActiveLook`,
  `paletteFor`). The family palette is `@platform/design` PALETTE under the
  app's names, mapped as the web's `html.hosted-mode.minimal-style` block
  maps `--sol-*`. `Theme`, `themedStyles` (whose builder now also gets the
  look) and `useActiveScheme` follow it, so every screen repaints on a mode
  switch. The root (`app/_layout.tsx useLookFromMode`) sets it from
  `useHostedMode`.
- **Faces.** `constants/fonts.ts` adds `Sans` (Instrument Sans) and `Serif`
  (Newsreader), bundled in `assets/fonts` and loaded the first time the
  family look turns on. Unnamed text takes the look's interface face; a
  style naming a face keeps its group (code stays mono); nested text
  inherits its parent's group (`components/Themed.tsx InheritedFace`), so a
  bold run in a reply stays in the reading face. Nav-level faces go through
  `uiFace` / `useMonoFace`; page titles through `pageTitleFace` (the
  reading face, as the web's `PageHeading`).
- **Inbox.** The Assistant scope (`hostedOnlyInbox`) folds the list into
  the web rail's sections (`hostedStatusSections` with `splitHostedStops`:
  Your move with its accent dot, Couldn't finish, Working on it, New,
  Earlier or Done, Drafts), headings in sentence case. A row is named by
  `lib/hostedRowTitle.ts` (moved out of the web card so both read it), its
  time is `hostedRowTime`, same-name rows get `sameNameSuffixes`, unread is
  an ink dot and a 600 title with the accent on its time, working is an ink
  pulse. The + is an ink disc.
- **Conversation.** In the family look the person's words are a quiet note
  and the reply a 17px letter in Newsreader, narration before a step is in
  the interface face; no name and time headers; the title is in the reading
  face and the metadata strip folds away. The sticky prompt and the reply
  suggestion follow their surfaces. Send is the web's ring, then ink disc
  (`hostedTheme.ts sendDisc`). A step that made one thing is the web's made
  line, and a note it wrote is the web's note card (`components/hosted/
  Steps.tsx`, over `lib/madeLine.ts`, moved out of `HostedMadeLine`).
- **Approvals** are the web's card (`lib/hostedApproval.ts`: `planForCard`,
  `yesWords`, `isHostedApproval`, now shared): Yes in the accent, Not now,
  Always allow as a quiet third, what Yes does above the buttons.
- **Compose sheet.** "What's next?" over up to three starters from the
  web's one pool (`components/simple/starterPool.ts`, moved out of
  `AssistantIntro`), in the web's starter rows; no label strip.
- **Lists and chrome.** The Tasks tab says To-dos and Notes
  (`modePageLabel`), follows the Assistant scope (`isAssistantTask`,
  `isOnNotesShelf` with `isAssistantDoc`), shows its filter from six items,
  and says "Nothing open right now" over finished to-dos. Alerts keep
  unread neutral; settings group labels are sentence case and switches use
  the family's ok green.

### Mobile polish round 2 (2026-10-07)

Checked on the simulator as the App Review account, in both themes, and in
developer mode, which is unchanged.

- **Stop notices.** A hosted turn's stop is the web's notice on the phone
  (`components/hosted/Notice.tsx`): the live one an outlined card with its
  move (Try again, Keep going, Open Plan), a stop later turns moved past one
  quiet line without "You can ask me to try again", and a retried turn
  folds as on the web (`foldHostedRetries`). The move and the words are one
  rule in `lib/hostedNotice.ts` (`noticeMove`, `noticeWords`, `NOTICE_TONE`,
  from which the web's `NOTICE_DOT` derives); the web's `actionFor` reads
  `noticeMove`.
- **Transcript top.** A 24pt fade under the title while anything sits above
  the visible window; never at the top, so the first line is never dimmed.
- **Tabs.** Chat steps out of the tab bar in hosted mode while the personal
  workspace is active (it has no rooms). Alerts carries a quiet accent dot
  instead of a count, as the web bell does. Alerts and Settings title their
  pages on the left in the reading face, like Inbox and To-dos.
- **To-dos and Notes.** A hosted to-do row is the web's TaskRow: ink circle
  or check, the accent mark for high and urgent with every row keeping its
  slot, a capitalised title, no ids, labels or plans, and "Done Sep 16" on a
  closed one. Headings are the inbox's (sentence case, quiet count). A note
  row is the web's DocRow (`lib/hostedNoteRow.ts hostedNoteLines`, shared),
  with no type heading or tag. The switcher hides for a hosted person with no
  team, and the header holds its height on Routines so the frame never jumps.
- **Alerts rows.** The assistant wears the web's AssistantMark (an ink disc,
  `AgentLogoSvg` in the family look), no coloured type badge, the event word
  in muted ink, the rail's times, and the inbox's title rule
  (`sessionCardTitle`) for a hosted conversation.
- **Smaller.** The Plan row says `meterWords` ("About 300 requests left this
  month"), the web meter's rule now shared in `lane.ts`; the inbox's search
  is the rail's bordered field and its header magnifier goes in hosted mode;
  the compose sheet closes with a thin stroke. `sentenceCase` leaves a first
  word already cased inside ("iMessage") as written, on both platforms.

### Mobile polish round 3 (2026-10-07)

The conversation pieces web rounds 9 and 10 added, now on the phone, checked
live on the simulator as the App Review account (a real turn: a web search,
its routine offer, the approval card answered Not now, and a Stop), in both
themes, and in developer mode, which is unchanged.

- **Stop.** While a hosted turn runs and the box is empty, send is a Stop
  disc that calls the store's `stopHostedTurn`, as the web's visible Stop.
- **A used-up month.** The session composer's placeholder is the held
  sentence and send waits (`useAllowanceOut`). The new conversation sheet
  reads the web's `useHostedAskGate`: starters greyed, one centred sentence
  with "See your plan" (the sheet closes first; the phone sells no credit),
  send held. The composer's expand control now needs typed text, since a
  long placeholder wraps too.
- **A dropped link.** `hooks/useLinkDown.ts` reads the socket
  (`useWsConnected`) past the web's grace and says `hostedConnectionWords`
  in the composer's status slot and on a waiting bubble.
- **Sources** under a hosted message's steps (`Steps.tsx HostedSources`,
  over `hostedReceipt searchedSources`).
- **Chips under the last reply** (`components/hosted/ReplyChips.tsx`): the
  mail chip (Use Whisk for mail now, Connect, or Reconnect) and the routine
  offer. Their rules moved to `web/lib/hostedOffers.ts` (`offersMailConnect`,
  `routineOffer`), re-exported from `HostedNotice.tsx`.
- **Approval card.** One answer per card (`web/hooks/useOneAnswer.ts`, moved
  out of `HostedApprovalCard`, with `APPROVAL_REFUSED`), the routine notify
  line from push permission (`ROUTINE_NOTIFY_OFF`, now shared with the web's
  `RoutineNotifyLine`), and the settled and pending lines in the card's place
  from `hostedApprovalState`. The open step reads the same state, so it no
  longer says "Waiting for your go-ahead" over "You said not now".
- **"5-in-1" read as initiative in-1** in the phone's markdown, which bounded
  ids with `\b`. The shared bounds are `BARE_ID_BEFORE` / `BARE_ID_AFTER`
  (`shared/entities`), used by `bareEntityIdRegex` and the phone's tokenizer;
  `shared/entities/bareIds.test.ts` holds it.
- **Lists and settings.** The hosted to-do circle checks a to-do off or
  reopens it (`updateTask`); To-dos' + is the inbox's ink disc and opens "New
  to-do" (what to do and notes, the compose sheet's header, Add); both lists
  leave room under the last row for the +. Note and to-do times use the
  rail's style. Settings rows draw Feather strokes in the family look
  (`SettingsUI RowIcon`), "Sign out" is sentence case, and the Mail row says
  "Coming soon" while connecting is closed. The Mail page matches the web's
  Whisk card (future-tense note, Use Whisk for mail now, Reconnect, "Coming
  soon" said once). The Notifications tab is named as its page in hosted
  mode. The transcript's jump arrows are solid sheet discs in the family look.

## History: the simple lane

Phase one (2026-10-04 to 05) shipped hosted mode as a separate shell: a
`/simple` route tree under its own `src/layouts/SimpleShell.tsx`, its own
home, conversation, approvals, routines, connections and plan screens in
`components/simple`, and a `(simple)` route group on the phone. The
founder's direction of 2026-10-05 retired it, and "The fold" (2026-10-06)
removed it: the shell, its routes and its duplicate transcript and rows are
gone. What survives is listed above (plan rules and wording, step wording,
connections copy, onboarding, the family look, billing). `/simple/...`
addresses still resolve through `lib/laneRedirect.ts`, and many shared
modules keep `lane` in their names (`components/simple/`, `useLaneMail`,
`ui.lane`). Do not rebuild a separate shell: a hosted surface is a main-app
surface gated through `lib/surfaces.ts`.

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
- End to end: real turns on prod with the deployment's key, driven in the
  browser from a fresh signup through the main app in hosted mode, with
  screenshots. Use a throwaway account on an origin the founder is not
  signed in on (`http://127.0.0.1:3200` against the local dev server; sign
  out from the user menu's Sign out), with no machine and no mail.

### Fresh-signup pass (2026-10-07)

Two throwaway email accounts (prefix `claude8+fresh` at almostcandid.com),
no machine, no mail, Free plan, 1440 wide.

| Step | What happened | Evidence |
| --- | --- | --- |
| Marketing page, signed out | "Don't write code?" card on the first screen, "For everyone" in the nav. The card goes to `/welcome`. | [marketing](https://convex.codecast.sh/api/storage/34b87081-cb42-4615-acbb-e928314ee818) |
| `/welcome` sign in | Apple, then "Continue with email", then GitHub quietly. No Google on this deployment. | [welcome](https://convex.codecast.sh/api/storage/3eebdae2-f386-46e3-905d-13586b0be1d7) |
| Email sign-up | The form stays in /welcome's look (`?email=signup`). No mailed code was asked for. | [sign-up](https://convex.codecast.sh/api/storage/cf30553d-731c-4e8d-b035-b6945f88ff6f) |
| Start | "What can I take off your plate?", three asks, a composer, "Mail and calendar are coming soon. Use Whisk for mail now." | [start](https://convex.codecast.sh/api/storage/c3b468dd-2152-4f44-8b54-026a8f17f5af) |
| First ask (account A, typed) | "Check current prices for the three best rated robot vacuums for a small apartment". The answer came in 11 s from one web search, with sources, titled "Robot vacuums compared", and a "Do this every week?" offer underneath. The shell was in hosted mode (Inbox, Approvals, To-dos, Notes, Routines, usage meter). Turn `g988yh1gq6rvm4de8qs0mash4d8fvh8t`, $0.035, Haiku. | [answer](https://convex.codecast.sh/api/storage/d5ab42b0-f8c6-4e30-987b-03eb7b89c838) |
| Routine offer, then approval | Tapping the offer sent "Do this for me every week." The assistant asked: Set up the routine "Weekly robot vacuum price check"? It showed the plan and the When line, with Yes and Not now. Approvals showed 1 and the inbox row read "OK?". Turn `g981h2h01wfnqw01x84p4sk53s8fv6dq` (waiting on the call). | [approval](https://convex.codecast.sh/api/storage/50f4a11c-eed9-43f5-b402-71c90116922c) |
| Not now | The receipt reads "Didn't set up the routine ... (you said not now)", then a one-line acknowledgement. The Approvals count cleared and Routines stayed empty (it shows its examples). Turn `g9852a0rn0mfht39wr9c489gqs8fv4kk`. | [not now](https://convex.codecast.sh/api/storage/825ea3a9-1596-419a-9555-f12ec1a1e490), [routines](https://convex.codecast.sh/api/storage/bef73385-41e0-41d8-b15d-bd105b8a9417) |
| First ask (account B, a starter tapped on a bare `/welcome`) | Landed straight in `/conversation/<id>` about 2 s after the tap, with no stop at `/inbox` (the fix below). It drafted the note in the reading face, with Copy. Conversation `jx74j39q11sp1rpz2df455d8f98fvh82`, turn `g98bv7zethm0ep4qh99kyb03bd8ftgfe`. | [answer](https://convex.codecast.sh/api/storage/0fec3feb-e00d-4454-b90e-02a2a3ee8038) |
| Stop | A follow-up research ask, stopped after its first search. The transcript reads "Stopped. I won't do anything more on this." and the composer returns to "Reply, or ask a follow-up". Turn `g9860mr1s94fyv28sh1rtfjehn8ftkfb`, stored as `done` (the schema has no separate stopped reason). | [stop](https://convex.codecast.sh/api/storage/6c850d63-f53d-4a11-b3b9-d6e568910560) |

Found and fixed in this pass:

- **The first ask from a bare `/welcome` landed on the inbox.** `SignedIn`
  sent anyone with a hosted conversation to `/inbox`. The conversation the
  page had just started counted, and it synced inside the 260 ms send-off,
  so a brand-new person saw an empty home. A conversation started by the
  page no longer counts as a return. The regression test is in
  `welcome.mount.test.tsx`.

Seen and left open:

- The user menu opens clipped by the sidebar's right edge in hosted mode
  ([menu](https://convex.codecast.sh/api/storage/33bdcf25-0e33-42e8-9f2f-b95a76c4d9b9)).
- After the Not now, the inbox row still read "Working on it" 30 seconds
  later; it had settled when I next looked, a few minutes on.
- One web-search answer cost about 11 times `TYPICAL_REQUEST_USD`, so the
  meter's "requests left" is an everyday-request figure, not a count of
  research asks.
- Not driven here: Google sign-in (not offered on this deployment), the
  mailed-code step, Whisk connect (closed: `WHISK_CONNECT_OPEN` is unset),
  a Yes on an approval, and the phone. The pass below drives the code step,
  a Yes, and a routine firing.

### Free gate and routine pass (2026-10-07)

A throwaway password account (`claude8+gate1791400546` at almostcandid.com),
no machine, no mail, Free plan, 1440 wide, on `http://127.0.0.1:3200`
against prod. Conversation `jx7d3ckk45qjrrqpd1te7gnwbd8fvn7s`.

| Step | What happened | Evidence |
| --- | --- | --- |
| Sign-up and first ask | No code at sign-up (`AUTH_EMAIL_VERIFICATION` is unset). The first ask stopped on the `verify` notice with a code field, and the code arrived by mail within seconds. Turn `g981ctq1w7yhxdnmhxyaj25qh18fvrb6`, reason `budget`, $0, nothing reserved. | [verify](https://convex.codecast.sh/api/storage/e3e3b5ab-d8a5-4555-91df-b70684c64cb8) |
| Wrong code, then the right one | "That code is not right" under the field. The mailed code proved the address and the ask ran by itself: a note drafted and saved, no retyping. Turn `g98cjtarxp9ykyg9xf5hxda7sn8fvcj2`. The mailbox claim and the day's Free spend rows were written. | [answer](https://convex.codecast.sh/api/storage/123fef62-63eb-44b5-9ba7-7bddf6f1f88c) |
| A once routine, Yes | "In 3 minutes, remind me once to drink a glass of water": the approval card, Yes, "Set up the routine Drink water · Done" (turn `g980sch7sj79d8h2q5rhj87f498ftb4m` asked, the next ran it). It fired on its own as "Routine · Drink water", and the conversation came back to the top of Inbox as New with the count on the rail. | [fired](https://convex.codecast.sh/api/storage/e37395d3-4362-486e-99f6-04445a252019) |
| A daily routine, Yes, then cancel | "Every day at 9am, send me one short gardening tip": card, Yes, Routines listed it ("Every day at 9:00 AM, Next: tomorrow"). "Please cancel the daily gardening tip routine" stopped it without asking ("Stopped a routine", "Cancelled."), and the card's receipt now reads Stopped. | turns `g980ekqg6aesv5t6ay8q9g0xy58fvnx2`, `g98aj7mam5sc07cpsw57bpc88d8fvt5y` |

Found in this pass and still open:

- **"In 3 minutes" is guessed from the hour.** The system prompt names only
  the person's date and hour (it changes at most hourly, for the prompt
  cache), so the model wrote `first_run` as 3:03 PM at 3:19 PM. The card
  showed a past time, the reply promised 3:03, and the routine fired at once.
  A relative time needs the server to count it (an `in_minutes` field on
  `schedule_routine` that the card and `approvalContext` also read), or the
  prompt to carry the minute.
- The bell's Notifications popover opens clipped by the sidebar's right
  edge, like the user menu, and held nothing for the routine run while the
  conversation was open.
- The sidebar's usage line ("About 300 requests left this month") runs under
  the bell and settings icons at 1440 wide.
- Not driven: the phone from a fresh signup (the phone's `verify` notice
  ships in the JS bundle; an older binary shows the line without the field),
  Google sign-in, and Whisk.

### Before opening Whisk connect (`WHISK_CONNECT_OPEN`)

Only fake-Whisk tests cover the mail path. On a throwaway non-founder
account, before the gate opens: connect Whisk from Settings > Integrations;
ask for a catch-up and check it reads real threads; ask for a reply and check
it lands as a Whisk draft; ask to send it and check the approval card names
the recipient, that Not now sends nothing, and that Yes sends exactly that
draft. Record the turn ids here. Keep the fail-closed gates as they are.
