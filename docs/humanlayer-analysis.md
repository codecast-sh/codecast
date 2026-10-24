# HumanLayer and codecast: two ways to run a team's coding agents

> **Status (2026-10-24):** Research note, mostly acted on. Read at HumanLayer commit `2f66a45b`, one day after the code was open-sourced. The eleven adopted items below were built in plan pl-946 and their backend deployed on 2026-10-24; seat billing waits on a price and Stripe setup.

## What HumanLayer is now

HumanLayer started in 2024 as an SDK for human approval of agent tool calls, then became CodeLayer, a Go daemon with a Tauri app. On 2026-10-22 it open-sourced its current product, codename Riptide, as one squashed commit of 6,665 files under Apache 2.0. The README describes it in one line: it "runs coding agents (Claude Code, Codex, OpenCode, Pi) on your machines and lets your team steer them from one place: tasks, sessions, plans, and reviews, synced between a desktop app, a web app, and a daemon on each host."

That is codecast's product description too. The overlap is close enough that most features have a direct counterpart, which makes the differences easy to see.

The codebase is about 650k lines of TypeScript in a Bun and Turborepo monorepo:

| Part | What it is | Size |
|---|---|---|
| `riptide-ui` | The app: React, TanStack Router, TanStack DB | 187k lines |
| `riptide-api` | oRPC + Hono API on Postgres via Drizzle | 141k lines |
| `riptide-daemon` | Runs agent sessions on a host, Effect v4 | 85k lines |
| `packages/ui` | Shared components, artifact viewer, diff review | 68k lines |
| `riptide-cloud` | Org admin, billing, metrics dashboards | 28k lines |
| `riptide-electric-proxy` | Auth proxy in front of Electric SQL | 14k lines |
| `riptide-electron`, `riptide-native` | Desktop shells (moving from Tauri to Electron) | 19k lines |
| Plugins | Mirror Claude Code, OpenCode and Pi sessions; RPI skills | 18k lines |

## The choice that explains most differences

HumanLayer **owns the agent process**. The daemon runs Claude Code through the Claude Agent SDK in-process, and its two other agents (`codelayer`, `fold`) are its own agent loops calling model APIs directly. Every tool call, permission request and token arrives as a typed callback.

Codecast **drives the real CLI the user would run**, in tmux, and learns what the agent is doing from transcripts, hooks and the terminal pane. A codecast session is the user's own Claude Code or Codex, visible in a terminal and resumable by hand.

From that one choice:

- HumanLayer answers a permission request by returning `{behavior: "deny", message}` from `canUseTool`. Codecast presses Escape in a pane.
- HumanLayer streams tokens to the UI because the SDK hands them over. Codecast shows output when transcript lines land.
- Codecast launches eight agent CLIs (Claude, Codex, Cursor, OpenCode, Pi, Grok, Muse, Gemini) with the user's own config, plugins and login. HumanLayer launches Claude plus its own loops, and only mirrors OpenCode and Pi through plugins.
- Codecast mirrors every transcript on a machine with nothing installed in the agent. HumanLayer needs a plugin per harness.

Neither is wrong. The useful question is which of HumanLayer's typed control points codecast can get without giving up the real CLI, and most of them turn out to be reachable through Claude Code's hooks.

## Side by side

| | HumanLayer | codecast |
|---|---|---|
| Source of truth | Postgres | Convex |
| Client sync | Electric SQL shapes into in-memory TanStack DB | Convex queries feeding a local-first store persisted in IndexedDB, plus a per-scope sync log |
| Write confirmation | Mutation returns a Postgres txid; client awaits it in the collection, 10 s, then rolls back | Durable outbox, field locks retired by value echo or sync-log position |
| Daemon commands | The session `status` column (`resuming`, `interrupt_requested`) | `daemon_commands` rows with device targeting, TTL and a per-process lease |
| Privacy | Browser shapes are org-wide; every member's client receives every session row and the UI filters | Per-row access stamps evaluated at read time; a row can be routed to a team and readable only by its owner |
| Agents launched | Claude (SDK), two in-house loops | Eight real CLIs |
| Usage limits | Session waits for the window to reset | Multiple accounts, switch to the one with most headroom, switch ahead at 95%, resume at reset |
| Workflow | Research, Plan, Implement as phases; kanban columns from session labels | Tasks, plans, DOT workflows, flows (Check, Review, Decide, Ship), decisions queue |
| Review | One polished loop: comment on documents and diffs, send to the agent as one message | Several separate models (quote batch, conversation comments, code line threads, review notes, page comments) |
| Phone | Responsive web | Native Expo app |
| Desktop daemon | Bundled in the app, exits when the app quits | Independent under launchd/systemd with a watchdog; survives the app |
| Billing | Free to 3 members, then per seat (Stripe, WorkOS seat sync) | Hosted assistant wallet only; team product free |

## Where HumanLayer is ahead

### Steering a running agent

**Approvals are decisions, not keystrokes.** The daemon's `canUseTool` callback checks a whitelist, then the rules this session already granted, then creates an `approvals` row and waits for it to move to `approved` or `denied`. Deny carries the reviewer's comment as the message the model reads. "Approve and don't ask again" applies Claude's own permission suggestions (for example `Bash(bun test:*)`) as `updatedPermissions`, so the rule lives in Claude Code itself. The UI refuses Deny until a reason is typed, and offers bypass mode after five manual approvals in a row. Codecast presses Enter or Escape in the pane, carries no reason, and has only a broad Allow All.

**The send button states what it will do.** It reads Interrupt, Interrupt & Send, Queue or Send depending on whether a turn is running and whether there is text. "Interrupt and send" is one server intent: the message row is marked `deliver_on_interrupt` and the session moves to `interrupt_requested` in the same write. If subagents are running, interrupting lists them first.

**Pending approvals cannot be folded away.** Working blocks and subagent groups holding an approval refuse to collapse, and `A` jumps to the oldest pending approval.

### The review loop

This is HumanLayer's most finished piece. An agent writes a document (research, plan, PRD) into a task folder; a person reads it with the keyboard and comments; the comments go back to the agent as one message.

- **Anchors survive edits.** A comment stores the block's text, its neighbours' text and an offset. On every render it re-finds the block anywhere in the document, then tries whitespace-normalised and scored matches, refuses to guess between duplicates, and otherwise marks the thread outdated next to a surviving neighbour.
- **Typed verdicts.** `a` approves the focused block, `d` marks it for deletion, `z` undoes. Most plan feedback is "yes" or "cut this", and this makes a 200-line plan reviewable in a minute.
- **Delivery has explicit outcomes.** The button knows from the session's state whether it will send, queue or copy. Send-and-resolve resolves exactly the threads it sent, and if that half fails the toast offers "Resolve sent comments". A failed send never silently falls back to the clipboard.
- **Diffs since your last review.** Marking a file reviewed stores the version you saw; the next look diffs from it, with "X of Y changed lines reviewed" and an All / To review switch.
- **Failing checks go to the agent with one press**, per check or all at once, with a prompt that says how to fetch the logs.

Codecast has most of these pieces, often with more reach (a shared queue across people, a shepherd session that owns a PR until it merges, decisions as a queue), but spread over five comment stores and three send paths. A reviewer cannot tell which of their comments the agent has seen.

### Knowing who wrote the code

**Commit trailers through git's own config.** The session environment carries `GIT_CONFIG_COUNT` entries that register an additive commit hook (git 2.54 and later) or a `core.hooksPath` trampoline that chains to the repo's hooks. Every commit from the agent's process tree gets a trailer, whatever the command shape, and the stamp expires after 7 days so a leaked environment cannot stamp forever. Codecast rewrites literal `git commit` in a Bash command, so `make commit` or a script escapes it.

**Line overlap for commits nobody stamped.** An authorship journal holds hashes of every line an agent wrote. A commit without a trailer is attributed by overlap. They measured the naive rule (any matching line) at a 61% false positive rate on 784 real commits, because `}` and common imports collide everywhere, and replaced it with: at least 10 matching lines, or at least 3 that make up 25% of the commit. The algorithm version is stored on every row. Human commits are redacted to counts before upload.

**PR links have a strength.** A session that only had the branch checked out is `observed`; one whose commit is on the branch is `committed`. A stronger link replaces a weaker one, never the reverse, and only `committed` counts in metrics.

**Cost per shipped thing.** The admin metrics divide spend by output per bucket (cost per merged PR, per commit, per 1,000 changed lines, by model, person, task and stage). Two rules are written into the code: unit cost is the sum of cost over the sum of the denominator per bucket, never a mean of per-row ratios ("on real data reads ~150x too high"), and a session's model is the one with the most spend over its whole history, on both sides of the ratio. Who may see per-person spend is an org setting that defaults to admins only and fails closed.

### Daemon robustness

- **Stuck states have deadlines.** A server job marks a session lost per status (running silent 10 minutes, launching 2 minutes, resuming 60 seconds, interrupt not acknowledged in 30 seconds) and writes a plain warning onto it. A session inside a long Bash call is exempt until that call's own timeout passes. A daemon silent for 120 seconds is set offline, and in the same transaction its running sessions fail, its interrupt requests become interrupted, and its pending approvals are denied.
- **Live working-tree diffs during a turn.** A PostToolUse hook on Write, Edit and Bash requests a capture; one runs at a time per workspace and a burst of 40 edits costs at most two. Captures use a shadow git repo with alternates (nothing copied), a candidate index published only on success, and explicit `.env*` exclusion.
- **Per-host update state.** The heartbeat reports whether the install can update itself and how it was installed; the host row holds `update_requested_version`, `update_state` (requested, installing, failed) and the stderr tail of a failure. The request clears itself when the reported version matches.
- **A typed start handshake.** The daemon prints one JSON line (`daemon_ready`, `daemon_already_running`, `auth_failure`); the desktop waits for it with a 45 second timeout, and an auth failure stops restarts and asks the user to sign in.
- **Agent preflight.** Before first use the desktop resolves `claude` from the login shell's PATH, checks a minimum version and runs `claude -p hi --model haiku` with a 30 second timeout, classifying not found, timed out, auth failed or smoke failed.

### Engineering practice

- **A Stop hook that refuses a red turn.** It runs typecheck and lint when the agent tries to stop and exits 2 on failure.
- **A hook that blocks `bun test | tail`**, pointing the agent at the spooled output file instead of re-running a slow suite to filter it differently.
- **Silent-on-success checks.** A 50-line wrapper prints one line on green and everything on red, so a full `check` costs four lines of context.
- **Lint rules written for agents.** An "anti-slop" oxlint plugin bans conditional spreads, `as unknown as` chains, ternaries deeper than two and `object` parameters, with messages that name the fix. About 70 Effect rules are promoted to error once their pattern is cleaned up, so the cleanup cannot regress.
- **Conditional blocks in CLAUDE.md.** Most guidance sits inside `<important if="changes touch packages/db/src/tables">`, so the unconditional part stays short. `AGENTS.md` is a symlink.
- **A full stack per worktree.** `devstack` gives each worktree its own Postgres, Electric, object store, 18 allocated ports, HTTPS routes and a seeded org, from a plan/apply CLI with a dry run.
- **Learning tests** that pin how Stripe, WorkOS and Claude Code actually behave, run locally.
- **Derived release versions.** Version is a committed base plus the count of first-parent commits since the base changed. No bump commits, and the same commit gets the same version everywhere.

### Research that cannot see the goal

The Research-Plan-Implement plugin has one idea worth more than the rest of it. A first session turns the ticket into 2 to 8 questions about how the code works, written so they do not leak what will be built ("NO 'HOW WOULD WE XYZ' - ONLY 'HOW DOES IT WORK'"). A second session answers them and is forbidden to read the ticket. The research document states what exists, with no recommendations. An agent that knows what it wants to build reads the code selectively and reports what supports its plan; separating the two stops that.

Two smaller rules from the same plugin: design questions are written open and only a person may close one, with the rejected options kept; and implementation outlines are vertical slices ("User can create the simplest version of the thing end-to-end"), each with its own automated and manual verification, never "add all types, then all endpoints, then the UI".

## Where codecast is ahead

- **The agent is the user's own CLI.** Eight agents, the user's config and plugins, a real terminal that shows the agent's own tmux pane, local or relayed from another machine.
- **Privacy inside a team.** HumanLayer moved its browser sync from per-user ACL shapes to org-wide shapes, so a private session's rows reach every org member's browser and the UI filters them. Codecast evaluates an access stamp per row per caller and prunes on revocation.
- **Local-first.** Codecast paints from IndexedDB on boot, keeps working on a flaky network with a durable outbox, and runs one set of subscriptions per origin across all windows. HumanLayer holds everything in memory and re-syncs on reload; a failed write is rolled back, not retried.
- **Daemon command delivery.** Leased, device-targeted command rows with TTLs, against an unconditional status write that two daemons with the same host id could both act on.
- **Usage limits.** Multiple accounts and automatic switching, against waiting for the reset.
- **Agents keep working without the app.** launchd/systemd supervision with a watchdog that recovers after sleep. HumanLayer's desktop daemon exits when the app quits and retries once after a crash.
- **Shared-checkout landing.** `cast ship checkout` commits each session's files separately from a tree where several agents are still working. HumanLayer assumes one worktree per task.
- **Turn history.** Every turn is a restorable commit on `refs/codecast/wip/<conv>`; HumanLayer keeps only the current diff.
- **Cloud hosts and live migration** of running sessions between machines.
- **Handoff.** A brief with goal, decisions, verification and next steps, against pasting up to 200,000 characters of transcript into the next agent.
- **Prompt evals on real moments.** `./evals` grades production prompts against frozen moments and claims a win only on a separated result. HumanLayer's evals are fixture tests for its small helper prompts; the large RPI skill prompts have none.
- **Architecture rules as tests.** 87 guard tests (feed subscriptions, bundle graph, doc references, boot order) check data flow and ownership, which lint cannot.
- **Shared typecheck.** One `tsc --watch` per tree serves every session. HumanLayer's Stop hook runs a full turbo typecheck per stop.
- **Breadth.** Decisions queue, PR shepherd, team chat, calls with transcripts, published pages, mods, two-way Linear and GitHub issue sync, a native phone app, desktop notifications that read back what macOS actually drew (HumanLayer's Electron shell has none yet), and an updater that works on macOS 26, where HumanLayer's `electron-updater` path (Squirrel.Mac) does not.

## What codecast is not copying, and why

- **Running Claude through the SDK.** It would turn the user's interactive Claude into a hidden subprocess. The typed control points come through hooks instead.
- **In-house agent loops.** Thousands of lines re-implementing Codex and others against provider APIs, chasing upstream features forever. `codex app-server` gives Codex's own behaviour.
- **Electric, Postgres, or org-wide shapes.** A second sync system for one path, and the org-wide shapes break private-inside-a-team.
- **The session status column as the command bus.** No lease, TTL, claim or result field.
- **Phase labels as task status, and the RPI pipeline in the schema.** It works when every task runs one fixed pipeline. Codecast tasks come from people, roles, triggers and meetings, and flows already express pipelines without naming skills in the server.
- **A second, forked "minimalist" UI.** Two interfaces to maintain, with features in only one. The ideas worth taking (one side panel, "what needs you") fit the existing zen and lane modes.
- **An app-owned daemon, one daemon per org, a packaged renderer.** Each contradicts agents that run at 3 am with no window open, one login across teams, and web deploys many times a day.
- **Final-answer templates the agent must reproduce verbatim**, and a typewriter buffer that delays streamed text on purpose.

## What codecast is adopting

Built in plan pl-946:

1. Permissions answered through Claude Code's `PermissionRequest` hook with a real decision: deny with a reason the model reads, "allow and don't ask again" with the exact rule, pending permissions expired when a device goes offline, never folded away, and a key to jump to the oldest.
2. A send button that states its action, and "Stop & send" as one gesture, with a confirm when subagents are running.
3. PR page: send failing checks to the agent, observed vs committed PR links, auto-merge and update branch, and a head-sha guard on merge.
4. Diffs since your last review with reviewed-lines progress. (Mid-turn snapshots after Bash were left out: web diffs come from tool calls, and Bash edit capture was removed on purpose after it produced 26 MB of false diffs.)
5. Host health: per-host update state, an auth-failed state, `cast doctor --agents`, login shell PATH for the daemon, heartbeat timeouts.
6. Commit attribution by line overlap with HumanLayer's measured gate and a versioned method.
7. A tracked stop: a stop no machine acted on within 30 seconds shows "Stop not delivered" with a retry, and Escape now goes only to the machine running the session. (Launch, resume and silent-session deadlines already existed.)
8. Verdict keys on review blocks, worked-for durations on turn cards, hover that cannot steal keyboard focus.
9. A multi-identity access matrix test and a team setting for who sees per-person spend. Building it found two real leaks: any signed-in user could read anyone's spend and activity, and the team projects list showed private-in-team projects to teammates. Both are fixed.
10. Seat billing for teams: free to 3 seats (members plus pending invites), then per seat with a trial and seat sync on membership changes. Off until a per-seat Stripe price is configured.
11. Vertical-slice decomposition in `orchestrate` and `cast-plan`, a goal-blind `cast-research` skill, design forks as decisions, a PR body shape, strict test stubs, learning tests, and desktop quit hygiene.

Worth doing next, not started:

- One review model: durable comments with a delivered stamp, send-and-resolve, prose anchors that survive edits (needs a decision first; it changes the data model).
- Cost per merged PR, commit and 1,000 lines, by model.
- Derived release versions, desktop releases cut in CI with a packaged-app verifier, a beta desktop channel installable beside stable, the CLI bundled in the desktop app.
- A local Convex backend per worktree, so backend changes can be tested end to end without touching production.
- A Stop hook that refuses a red turn, scoped to files the session touched.
- Conditional blocks in CLAUDE.md, measured with `./evals` before keeping.
- Token-level streaming on a side channel outside Convex.
- Commit trailers through `GIT_CONFIG_COUNT` once git 2.54 is common (this machine runs 2.50).
- Access requests on shared links that lead to an invite.
- A Claude Code engine-API plugin that replaces tmux typing for sessions the user started themselves, once that API is stable.

The detailed area reports behind this note (daemon, sync, UI, API and AI, practices, desktop), with file paths in both codebases, are in `~/src/_ext/hl-analysis/`.
