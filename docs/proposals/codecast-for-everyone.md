# Codecast for people who don't code

Status: proposal, 2026-10-02. Nothing here is built yet.

## The idea

Today codecast is a window onto coding agents that people run on their own
machines with their own Claude or OpenAI accounts. That excludes almost
everyone: no terminal, no repo, no agent subscription, no machine left on.

This initiative removes all three requirements. A person signs up with Google,
connects the services their life runs on (mail, calendar, messages, files),
and gets an agent that works for them in the cloud. We run the harness, we pay
for the tokens, and the plan they're on decides how much work it can do. The
codecast surfaces they see are the ones that already work for engineers (an
inbox of work, approvals, routines, published pages), renamed and simplified
for someone who has never heard the word "session".

The product sits in the personal assistant space: things like "deal with my
inbox every morning", "find a time with these three people", "keep a running
doc of my kid's school emails", "research flights and hold the best two",
"text me when the contractor replies".

## What we already have

The most important finding: most of the hard pieces exist, split between
codecast and Averil (`~/src/eaiden`). This initiative is mostly an assembly
and extraction job, not a build.

| Piece | Where it lives today | State |
| --- | --- | --- |
| A watchable, steerable inbox of agent work, tasks, approvals (`cast decide`), routines (triggers), published pages | codecast web, mobile, desktop | Production, built for engineers |
| Cloud machine running the codecast daemon, sessions sync back like local ones | codecast cloud hosts (`hosts/create.ts`, `cloud/prepare.ts`, `convex/cloud.ts`) | Works, but each host is an EC2 instance in the engineer's own AWS account, and placing a session on it needs their laptop online |
| Browser and desktop control on a Linux host | `cast browser`, `cast computer` Linux provider | Works, built for one person per machine |
| pi as a supported client | `contracts/agentClients.ts` (pi entry), `parser.ts` `parsePiSessionFile` | Production, but only as a local CLI in tmux: messages are typed into its TUI, and the parser drops pi's per-message cost |
| Bring-your-own provider keys, encrypted to the device and passed to pi and opencode | `contracts/providerKeys.ts`, `providerKeyLaunch.ts` | Production; no path where codecast pays |
| Gmail connector with encrypted tokens, incremental send scope | `convex/googleOAuth.ts` | Built, but nothing reads the tokens: no agent can use it yet. Google sign-in is off in codecast (on in Whisk via the same `@platform/auth`) |
| Server-side model calls on our own key | `convex/lib/anthropic.ts` (titles, summaries, ask) | Production; single calls, no agent loop |
| Agent definitions (named agents, model choice, tool sets) as Convex rows | codecast agent definitions (jx75060) | Production |
| Per-person cloud box with session lifecycle, idle by tool activity, Linux user per person, proven isolation | Averil `packages/box` | Production on Fly |
| Per-person computer: headed Chrome on a volume, live view from a phone, takeover | Averil `packages/browser`, `packages/computer` | Production, being hardened (PLAN-COMPUTER) |
| Trust ladder: every gated tool call judged mechanically, unmapped actions refused | Averil `packages/core/src/ladder` | Production |
| Wallet: per-person period cap, cost reserved before a run in the same SQL statement that checks the cap, trued up after | Averil `gauntlet/reservation.ts`, `jobs/budget.ts` | Production |
| Credential broker: the agent holds a worthless stand-in, a proxy injects the real token per request and scrubs it from the reply | Averil PLAN-SUITE | Designed, partly built |
| Sealed OAuth tokens (Google refresh tokens encrypted at rest) | Averil `users.refresh_token_sealed` | Production |
| Channels: text the assistant over iMessage (Linq), SMS, Telegram, email; a Mac relay for reading/sending a person's own iMessages | Averil gateway adapters, desktop app | Production |
| Gmail engine: multi-tenant mirror, labels, lanes, drafts, send, a CLI that takes a per-user token from env | Whisk (`~/src/mail`) | Production; tokens stored in plaintext |
| Shared auth, push, analytics, local-first engine, rate limits | `@platform/*` | Production |
| Billing, plans, Stripe, wallet | nowhere in codecast, Whisk or `@platform` | Missing (Averil has a wallet, no Stripe) |
| A harness we control and meter ourselves | nowhere (Averil drives opencode; codecast launches third-party CLIs) | Missing |

What blocks a person with no machine today, concretely: every session start
(`enqueueStartSession` in `convex/devices.ts`) becomes a command for a daemon
on some device. With no device, the command sits untargeted until its lease
expires and nothing runs. Every empty state tells the person to install the
CLI. So the one new piece of infrastructure the whole initiative hangs on is a
**runner that executes sessions without a device** and writes their events
into Convex directly.

## The decision that shapes everything: Averil

Averil already is a cloud personal assistant for non-technical people. Building
"codecast for everyone" next to it, without deciding how the two relate,
means building the box, the wallet, the ladder, the vault and the connectors
twice and then watching them drift.

Three ways to resolve it:

1. **One runtime, two products (recommended).** Extract the runtime
   (harness, box, wallet, ladder, broker, connectors) into `@platform`
   packages that both products consume. Averil stays the assistant that lives
   in your texts. Codecast becomes the place you see, steer and share the
   work: a desk, not a chat thread. A person could use either or both against
   the same account and the same agent.
2. **Codecast absorbs Averil.** Averil becomes the consumer face of codecast
   (its thread is a codecast session, its jobs are codecast tasks, its app is
   a codecast mode). One product, one brand, the most reuse, the biggest
   migration.
3. **Codecast stays a developer tool; this initiative is Averil's.** Cheapest,
   but leaves codecast's work surfaces (tasks, triggers, decisions, pages,
   teams) unused by the audience that would benefit most from them.

Why 1: it gets the reuse without forcing a brand merge before either product
has found its shape. And the seam is natural: Averil's strength is the
conversation and the trust model; codecast's is visibility, multiplayer and
structure over many pieces of work. If they converge later, option 2 is a
much smaller step from 1 than from today.

## Architecture

```
  person (web / mobile / text)
          │
  codecast app ── Convex (sessions, tasks, triggers, decisions, wallet ledger)
          │
  runner fleet ──────────────── per-person workspace (volume: files, memory)
   │  harness (pi fork)                 │
   │   ├─ model router ── Anthropic / OpenAI / others, on our keys
   │   ├─ tool gate ───── trust ladder (allow / ask / refuse)
   │   └─ meter ───────── per-message cost → wallet
   │
   ├─ broker ── connectors (Gmail, Calendar, Drive, Notion, ...) with sealed tokens
   └─ computer (on demand) ── headed Chrome + desktop, live view, takeover
```

### The harness: fork pi

pi (`badlogic/pi-mono`, MIT) is the right base, and better for this than
Averil's choice of opencode or the Claude Agent SDK:

- **Provider-neutral with cost built in.** `pi-ai` speaks Anthropic, OpenAI,
  Google, Bedrock, OpenRouter and more through one API and reports a dollar
  cost per message. Metering and a model router are the core of a free tier,
  and both come almost for free.
- **Embeddable.** `createAgentSession()` runs the loop in-process from Node, or
  `--mode rpc` over stdio. We can run many sessions per runner process instead
  of one CLI per session.
- **Small and hookable.** Four default tools, no MCP, no permission prompts.
  Extensions can intercept every tool call, which is exactly the seam the
  trust ladder needs (Averil gets the same seam from opencode's permission
  routes).
- **Codecast already reads its transcripts and writes its session files**
  (`parser.ts`, `jsonlGenerator.ts`), so moving a session between a
  developer's local pi and the hosted harness works from day one. The parser
  needs one change: read pi's per-message `usage.cost` into `usage_totals`,
  which today is Claude-only.

**Fork shape: a soft fork.** Depend on upstream `pi-ai` and `pi-agent-core` as
pinned packages and take their provider updates. Own the outer layer: a new
`@platform/agent` package with our system prompt, our tools (connectors,
codecast verbs, browser, computer), the ladder hook, the meter, and a session
store that writes to codecast directly rather than to `~/.pi`. A hard fork of
the whole monorepo would cost us every provider fix upstream ships.

Then point Averil at the same harness when its opencode box is due for work,
so there is one harness for both products. That is a later step and not on
this initiative's critical path.

**Considered and not chosen:** Anthropic's Managed Agents hosts both the loop
and a sandbox, and its vaults inject credentials at egress the way our broker
does. It would get us running fastest, but it ties every token to one
provider (no cheap-model routing for the free tier), puts the workspace where
our browser and computer can't share it, and makes the harness something we
rent rather than shape. Worth keeping as the fallback if running a fleet turns
out to be the bottleneck.

### Where it runs

Most assistant work is a model calling connector APIs and writing a doc. It
needs no machine of its own. So the runtime has two tiers:

- **Runner fleet (everyone).** Shared, stateless runner processes host pi
  sessions for many people. Each person has a persistent workspace (a folder
  on a volume or object storage, mounted per run) and runs as their own OS
  user, Averil's proven isolation. This is what makes a free tier affordable.
- **Personal computer (paid, on demand).** When a task needs a real browser or
  desktop app, the person's own machine wakes: Averil's Fly design, 2GB so it
  suspends, about 3s to answer when suspended, sleeps after 10 idle minutes.
  Averil priced this at roughly $2 to $4 a month for light use and plans dense
  Hetzner hosts at about a thousand people.

The codecast daemon is not needed in the runner. The runner is a new kind of
device that Convex routes to when the session's agent is the hosted one: it
claims `start_session` commands and pending messages through the same
`daemon_commands` and `pendingMessages` rails a laptop uses, but drives pi
in-process instead of typing into tmux. That keeps one start path and one
message path for every backend. On a personal computer the ordinary daemon
runs, which gives `cast browser`, `cast computer` and a terminal for free.

The existing cloud hosts are the wrong base for this: they live in the
user's AWS account and need a laptop to place work. Provisioning moves to our
side (Averil's Fly machines interface: create, wake, sleep, address), and the
server wakes a person's computer itself.

### Identity and connectors

One identity, one consent flow, and the agent never holds a key.

- **Sign in with Google is also the first connector.** Codecast needs Google
  sign-in turned on (`@platform/auth` already supports it). Sign-in asks for profile
  only; the very next screen asks for mail and calendar with a plain sentence
  about why. Most people's useful life is in those two. Apple and email-code
  sign-in exist for people who won't use Google.
- **Every connector token is sealed** in our database (codecast's
  `googleOAuth.ts` and `oauthConnectors.ts` already encrypt theirs) and reaches the agent only
  through the broker: tools and CLIs see a stand-in, the broker injects the real
  token per request, checks the ladder, scrubs the reply, and logs the call to
  the person's activity. This is Averil's PLAN-SUITE design; it moves to
  `@platform`.
- **Mail is Whisk.** Whisk already mirrors Gmail per user, sorts it, drafts in
  the person's voice, and takes a per-user token from the environment for
  agents. It becomes the mail connector rather than something we rebuild. Its
  Gmail tokens must be sealed before any public user touches it.
- **Long tail:** curated connectors we write or review (Calendar, Drive, Notion,
  Slack, Todoist, banks later), then the person's own browser session in their
  computer for everything else. No open skill marketplace; OpenClaw's took
  hundreds of malicious skills in two months.
- **iMessage splits in two.** Talking *to* the assistant over iMessage needs no
  Mac: Averil's Linq number already does it. Reading and sending *as* the
  person needs their Mac running the Averil desktop app as a relay. Most
  non-technical people want the first; offer the second as an add-on.

**Critical path item: Google verification.** `gmail.modify` is a restricted
scope. Serving the public needs Google's verification plus a CASA security
assessment, which takes weeks to months and has a yearly cost. Until it
passes we're capped at 100 test users. Start this first, in parallel with
everything else, under one Google project shared by codecast, Whisk and
Averil so it's done once.

### Plans, metering and the wallet

We pay for tokens, so every run is spend, and the wallet is the core of the
business, not a billing afterthought.

- **Meter:** the harness reports cost per model call (`pi-ai` usage); the
  runner writes it to a ledger row per run in Convex. Compute for personal
  computers is metered by awake minutes at a fixed rate.
- **Wallet:** port Averil's reservation model. A run reserves its worst case
  in the same write that checks the cap, so concurrent runs can't overspend,
  and gives back the difference when it ends. Crossing a job's cap asks
  (a `cast decide` card) instead of killing the work.
- **Model router:** routine steps (triage, classification, summarizing) go to
  Haiku-class models; real work to Sonnet-class; hard reasoning to Opus only on
  paid plans. Effort is tuned per route. This is the main lever on cost per
  task.
- **Billing:** Stripe subscriptions plus top-up credits. Nothing exists for
  this in codecast or `@platform`, so it is a new `@platform/billing` package
  that Averil can share.

Rough economics at current prices (Sonnet 5.5 $2 in / $10 out per million
tokens, Haiku 4.5 $1 / $5, cache reads $0.10 to $0.20): a typical assistant
task with 10 to 20 model calls over a cached 20K to 40K context costs about
$0.05 on Haiku and $0.20 to $0.50 on Sonnet. These are estimates; Averil's
ledger has real per-job costs and should replace them before prices are set.

A starting shape, all numbers to be set from that data:

| | Free | Plus | Pro |
| --- | --- | --- | --- |
| Monthly usage included | small (tens of tasks) | most people's month | heavy use |
| Models | fast models | Sonnet-class | Opus for hard work |
| Routines (scheduled work) | a few, daily at most | many | many, frequent |
| Connectors | mail, calendar | all curated | all, plus Mac relay |
| Personal computer (browser) | no | yes, sleeps when idle | yes, longer awake |
| Over the limit | waits for next month | asks, then top-up | asks, then top-up |

Developers keep bringing their own subscription and machine exactly as today;
this is an addition, not a replacement.

Free tiers with compute attract abuse. Require a verified phone number for the
free tier, a card for anything that wakes a computer, and keep per-person
concurrency at one or two runs.

### Safety

An agent that reads a stranger's email and can send mail as you is a prompt
injection target by construction. The defenses, all of which exist in Averil:

- Every write (send, delete, buy, share, post) goes through the ladder: allowed
  by a rule the person set, or asked as an approval, or refused.
- Inbound content is data, never instructions; the harness marks it as such.
- Tokens never enter the agent's environment (broker).
- One OS user per person on shared runners; one machine per person for
  browsers, since DevTools and VNC ports are unauthenticated on loopback.

## The experience

The person never sees a repo, a terminal, a model name, a session id or the
word "agent" unless they go looking. The codecast primitives stay; their names
and defaults change.

| Codecast today | What they see |
| --- | --- |
| Session | A conversation, or a job ("Planning the Lisbon trip") |
| Inbox of sessions | Home: what's done, what's waiting on you, what's running |
| `cast decide` | An approval card: "Send this reply to Dana?" with the draft |
| Trigger | A routine: "Every weekday at 8, tidy my inbox" |
| Task | A to-do the assistant tracks, or one it gives you |
| Published page | A report or itinerary you can open and share |
| Team | Household or small team sharing an assistant |

**Onboarding, three screens:** sign in with Google, connect mail and calendar,
then the assistant does one useful thing immediately from what it can see
("Here are the three emails that need you this week, and two I can answer for
you"). Plan choice comes after the first value, not before.

**Mobile first.** Most of this audience lives on the phone. The codecast
mobile app gets a simple mode; texting the assistant (Averil's channels)
covers people who never open an app.

**One app, two modes.** A workspace setting decides which surfaces appear.
Simple mode hides code, diffs, terminals, worktrees, devices and agent pickers.
An engineer can flip their own workspace to see what their family sees.

## Phases

Each phase ships something usable and de-risks the next.

0. **Decide and start the slow clocks (week 1).** Settle the Averil
   relationship. Start Google verification and CASA. Pull real per-job costs
   from Averil's ledger to set plan numbers.
1. **Managed harness for existing users.** Build `@platform/agent` (pi soft
   fork, meter, ladder hook, codecast session store), the runner as a
   machine-free device on the existing command and message rails, and pi
   cost in `usage_totals`.
   Ship it to current codecast users as a new backend, "Codecast agent", that
   needs no account and no machine, on a capped trial budget. This proves the
   harness, the runner and the meter on people who will report bugs well.
2. **Wallet and billing.** Port the reservation wallet, build
   `@platform/billing` on Stripe, plan limits, top-ups, the over-cap approval.
3. **Identity and connectors.** Extract the broker and sealed-token store to
   `@platform`, wire Google sign-in plus incremental mail and calendar consent,
   make Whisk the mail connector with sealed tokens, add Calendar and Drive.
4. **Simple mode and onboarding.** The renamed surfaces, the three-screen
   onboarding, mobile first, Averil channels for texting the assistant.
5. **Personal computer.** Per-person machines for paid plans, using Averil's
   computer and codecast's Linux browser stack, with live view and takeover.

Phase 1 and the Google verification run in parallel from the start; phase 3
cannot open to the public until verification passes.

## Open questions for you

1. Averil: one runtime two products, merge, or leave it to Averil?
2. Price points and how generous the free tier is, once real costs are in.
3. Whether the free tier gets any scheduled routines (they cost money while
   nobody is watching, but they're the main thing that makes an assistant feel
   alive).
4. Brand: is the non-technical product still called codecast?
