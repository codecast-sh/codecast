# Codex Cloud support: implementation report

> **Status (2026-10-04):** Living record of what shipped for Codex Cloud and the OpenAI Agents API (pl-798). The one open item is VM environments (ct-56164).

*Final report for plan pl-798, 2026-10-02. Proposal: [codex-cloud-support.md](codex-cloud-support.md). API facts: [codex-cloud-spike-findings.md](codex-cloud-spike-findings.md).*

## The short version

codecast now syncs and drives Codex Cloud tasks the way it already handled Cursor Cloud, and it runs OpenAI Agents API sessions as a second Codex lane. All three providers run on one shared cloud agent core, and adding a provider means writing one adapter and one registry entry.

- **Codex Cloud (ChatGPT plan):** every capability in the proposal is built and was checked live on the Pro account against a private test repository's environment. That covers sync, both transcript formats, start, ask mode, best-of-N attempts, follow-ups, cancel, draft PRs, Apply locally and archive.
- **OpenAI Agents API (API key):** create, live streaming, follow-up and cancel were checked live in Phase 4, on public repos. Later fixes were tested only by unit tests, because this Mac no longer has an OpenAI key in codecast.
- **Hardening:** every private API read goes through a shape guard. A kill switch pauses the lane when OpenAI changes something, a daily canary (tr-1254) checks the API, and there is a user guide at `/documentation/codex-cloud`. The Enterprise 403 and plan-limit 429 paths have been tested only with fixtures and synthetic tests.
- **Not done:** OpenAI's new VM environments, because the account doesn't have them yet (ct-56164). The public git history rewrite you approved in sd-348 is done.

Final state on 2026-10-02:
- Cloud agent CLI tests: 209 of 209 pass.
- `cast check`: 0 errors in all six programs (cli, web, convex, mobile, sim, evals).
- The daemon restarted at 14:30Z with all three watchers running: Cursor knows 6 agents, Codex Cloud 54, the Agents API 8.
- Codex Cloud has no test task left unarchived and no test PR left open.

## What shipped

"Live" means it was exercised in the browser at localhost:3200 against real Codex Cloud or OpenAI, using tiny "codecast test" tasks that were archived afterwards. Screenshot links are on task ct-55381, not here: this repo is public, and the screenshots show the whole inbox.

### Shared core

| Capability | Status | How verified | Evidence |
|---|---|---|---|
| One cloud agent core (watcher, mirror format, sessions, registry, polling, HTTP, streams). Cursor Cloud is its first adapter | Shipped | Live. After the move, Cursor's 6 agents re-synced with unchanged message counts and all 21 mirror files were byte-identical. In the final pass a Cursor follow-up answered "pong" | `cloudAgents/core.test.ts`, `cursor.test.ts`; ct-55376 |
| Every mirror syncs through one ingest route (`IngestJob.mirror`) | Shipped | Live. Repeated `cast restart`s added no duplicates. A re-render that drops rows now retracts them across restarts (`synced.json`); 230 stale rows of other attempts were cleaned out of two sessions | ct-55381 round 3 |

### Codex Cloud: sync

| Capability | Status | How verified | Evidence |
|---|---|---|---|
| Sign-in from the machine's own `codex login`, read-only | Shipped | Live. The Connect Codex dialog shows the account and plan, and Check again works. In the final pass `~/.codex/auth.json` still had its Sep 25 mtime, so nothing ever rewrote it. Expired-token and logged-out states are covered by tests | `codex.test.ts`; Settings, Provider Keys row |
| "Sync Codex Cloud tasks" switch, off by default; imports the last 30 days | Shipped | Live, switched off and on again; the off copy and the connected badge render | Settings, Sync |
| Rendering new-format turns (`thread_events`) through the shared `threadItemToMessage` | Shipped | Live on ask and follow-up tasks; fixtures | `turns.ask.json`, `turns.askFollowUp.json` |
| Rendering legacy work logs (commands, output, answers, file citations) | Shipped | Live on imported tasks from July and August 2025; fixture | `turns.legacy.json` |
| Working state, task titles, branch, PR and diff in the header | Shipped | Live. A running task shows Working within one poll and renders about 30s after Codex finishes. The local `main` branch no longer leaks into cloud session headers | ct-55377 |

### Codex Cloud: drive

| Capability | Status | How verified | Evidence |
|---|---|---|---|
| Start from the composer ("run in Codex Cloud"). The environment is picked automatically by repo; the task starts from the checkout's pushed branch, else the default branch | Shipped | Live, with the start notice naming the environment | session jx78xe2 |
| Ask mode | Shipped | Live. Ask tasks answer with no diff, and Create PR and Apply are disabled on them | session jx72qb5 |
| Best-of-N (1 to 4), each extra attempt as a branch of the session; Switch attempt | Shipped | Live on best-of-2 tasks. Each attempt shows its own commit, the branch map lists both attempts, and a message sent on a branch continues that attempt | sessions jx74gcf, jx78r8d |
| Follow-ups, held while a turn runs | Shipped | Live. A follow-up sent during a turn showed "waiting for Codex Cloud to finish the running turn" and was delivered right after the turn ended. It did not use up the message's retries | ct-55378 |
| Cancel (Escape or Kill) stops only that attempt's own turn | Shipped | Live. wham reports `cancelled` and the thread shows "Cancelled." | ct-55378, final walkthrough |
| Create draft PR from the header, session menu or palette | Shipped | Live: two draft PRs on a private test repo were opened, then closed with their branches deleted | ct-55381 |
| Apply locally (`git apply` of the attempt's recorded diff at the checkout root) | Shipped | Live. The diff applied uncommitted, and a second apply was refused because local changes touched the same file | ct-55381 |
| Archive and unarchive | Shipped | Live. The API flag flipped both ways, with a note in the thread | ct-55381 |
| No environment for the repo: the message is held behind a card linking the environments page, then retried | Shipped | Live (a test on codecast-sh/codecast, which has no environment; that was ct-55559, not a bug) | session jx78wf7 |

### OpenAI Agents API lane

| Capability | Status | How verified | Evidence |
|---|---|---|---|
| OpenAI key entered through the guided dialog and checked when saved | Shipped | Live. A fake key was refused in OpenAI's words, and nothing was stored | ct-55379 |
| Create a session, stream the first turn, follow-up (steers a running turn), cancel | Shipped | Live in Phase 4 on octocat/Hello-World. Not re-run on the final core because this Mac has no OpenAI key in codecast now (the daemon logs "not polling: ... need an OpenAI API key"). The unit tests pass | `openaiAgents.test.ts`, fixtures in `__fixtures__/openaiAgents` |
| Composer lanes [ChatGPT plan / API key] with a cost line, and a model list per lane | Shipped | Live, UI only in the final pass | ct-55379 |
| Private repo refused before anything is billed, with "Start on ChatGPT plan instead" | Shipped | Live. The button started a Codex Cloud task with the same message | ct-55379 |

### Hardening

| Capability | Status | How verified | Evidence |
|---|---|---|---|
| Shape guard on every wham read; errors name the field path, never a value | Shipped | Contract tests. The guard passed on 26 real tasks (both turn formats) and 3 environments | `cloudAgents/shape.ts`, `codex.contract.test.ts` |
| Kill switch: a shape break, three unexpected 4xx answers in a row, or a pass where every task read fails pauses the lane. A probe every 5 minutes resumes it, and a single broken task is set aside on its own | Shipped | Watcher tests, plus a live harness run against wham. The Settings note and the paused card were checked with a staged block | `watcher.test.ts`, ct-55380 |
| Daily live canary (tr-1254): reads one list page and mirrors one task, writing nothing. It spends nothing when the read is clean | Shipped, scheduled daily | Each exit code is held by a test. It runs as the trigger's precheck | `scripts/cloud-agent-canary.ts`, `canary.test.ts` |
| Plan limit (429): names the plan window and counts down to the reset. A send's limit holds only sends | Shipped | Fixtures and synthetic tests only; no limit was hit live | ct-55380 |
| Enterprise workspace refusal (403): the card names the "Use Codex in the cloud" setting and the RBAC role | Shipped | Fixtures and synthetic tests only; there is no Enterprise account to test with | ct-55380 |
| A create whose answer can't be read is never sent again, so it can't make duplicate tasks | Shipped | Tests | `CloudAgentUnsentError` |
| Secrets: tokens, keys and environment variables are never logged, stored or synced; key fragments are redacted from error text | Shipped | Code review and tests. The scrubbed fixtures are committed | ct-55381 round 3 |
| User guide | Shipped | Rendered in the browser; external links checked | `/documentation/codex-cloud` |

## Where the code lives

- **CLI core:** `packages/cli/src/cloudAgents/`. The pieces:
  - `types.ts`: the adapter interface and the setup and hold errors.
  - `watcher.ts`: polling, mirror files and the kill switch.
  - `transcript.ts`: the mirror format.
  - `sessions.ts`: start, deliver, interrupt and Apply.
  - `registry.ts`: the only thing the daemon calls.
  - `poll.ts`, `http.ts`, `apiError.ts` (`cloudApiVerdict`), `streams.ts`, `shape.ts` and `canary.ts`.
- **Adapters:** `cloudAgents/cursor.ts`, `cloudAgents/codex.ts` (wham), and `cloudAgents/openaiAgents.ts` (Agents API). The list the daemon loads is in `cloudAgents/index.ts`.
- **Shared contract:** `packages/shared/contracts/cloudAgents.ts`. It holds the provider specs, the launch keys, and the per-kind setup table `CLOUD_AGENT_SETUP_KIND_INFO`.
- **Web:** `packages/web/components/cloudAgents/` (connect dialogs, header chip and actions, setup cards, lanes) and `lib/useProviderKeyCommand.ts`.
- **Convex:**
  - `devices.ts`: the login and action commands and the `cloud_agent_blocks` heartbeat.
  - `conversations.ts`: `updateGitState` with `clear`, and `setCloudAgentArchived`.
- **Fixtures:** `packages/cli/src/__fixtures__/codexCloud/` and `__fixtures__/openaiAgents/`, all scrubbed.
- **Guide:** `packages/web/app/(marketing)/documentation/guides/content/codex-cloud.md`.

## What remains open

| Item | Why it is open | Tracked |
|---|---|---|
| OpenAI's new published VM environments (announced 2026-09-29) | They haven't reached the account. `/wham/machines` is empty, and the create form only offers the container type. New-format turns already render, but a user who has only VM environments may be held on "no Codex environment" until `pickEnvironment` learns where they are listed | ct-56164 |
| Live re-check of the Agents API lane on the final core | This Mac has no OpenAI key in codecast. Add one in Settings > Provider Keys, then repeat the Phase 4 run (start on the API key lane, stream, follow-up, Escape, one setup card) | ct-55381 comments |
| A mirror rewrite of a recent message can stay stale on the web after a reload | This is a gap in the shared sync layer (`OLD_ROW_EDIT_MARGIN_MS` in `messages.ts`), not in the cloud agent code | ct-56163 |
| Tasks started by `@codex` on GitHub, Linear or Slack | They come through the same task list, so they should sync like any other task, but none exist on this account to record | none |
| Not built: Agents API webhooks (so the laptop must be awake to follow a session), and Codex Cloud mark-read and viewed | Out of scope for this plan; nothing depends on them | none |
| Two Cursor Cloud sessions (jx7e1hrn, jx7fm67f) still show `main` as their branch | It can't be proven to be a stale local stamp, so it was left alone | none |

## Decisions only you can make

1. **Rewriting public git history (sd-348): done 2026-10-02.**
   - **What leaked:** commit `1bb525ff8` (2026-09-30) put early, unscrubbed Codex Cloud fixtures and spike notes on public `main`: about 430 lines of a private repository's code, an internal proxy address and a CDN host from that code, and the names of two other private repos. No keys or tokens.
   - **What was rewritten:** `git filter-repo` removed `packages/cli/src/__fixtures__/codexCloud/` and `docs/proposals/codex-cloud-spike-findings.md` from `main` (old tip `c0e2a7aed`, new tip `3250f11ca`, which restores the scrubbed versions), from tags v1.1.161, v1.1.162 and v1.1.163, and from the session snapshot refs (`refs/codecast/wip/*`) that carried them. The "Protect main branch" ruleset was disabled for the push and re-enabled right after.
   - **Guard:** `.git/hooks/pre-push` in this checkout (shared by every worktree here) refuses any push that still contains `1bb525ff8` and prints the rebase that moves a branch onto the rewritten `main`.
   - **Still on you:** GitHub keeps orphaned commits reachable by SHA until it garbage-collects them; a full purge needs a GitHub Support request naming `1bb525ff8`. Lock down the proxy whose address was in that code, since it was public for two days.
2. **Agents API and private repos.** OpenAI's sandbox can only clone public repos unless it is given a GitHub credential (an OpenAI vault holding a token). Giving it one would let the API lane work on private repos, but it means handing OpenAI a GitHub token. Today a private repo is refused before anything is billed, and the user is offered the ChatGPT plan lane instead.
3. **Which machine imports when more than one has Codex sync on.** Each machine with the switch on mirrors the whole account. Only the hosting machine places a session in a checkout, but a machine without the checkout can create a session first under a placeholder folder (`/codex-cloud/<repo>`), and Cursor Cloud behaves the same way. The choice is between keeping this and making one machine own the account-wide import.
