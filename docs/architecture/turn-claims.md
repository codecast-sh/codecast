# Turn claims

When the agent process behind a session dies in the middle of a turn (a
machine reboot, a tmux server crash, a Claude crash, an SDK host killed),
codecast continues that turn once, with a capped number of attempts, and
leaves every other session alone. It knows which sessions were mid-turn from
a claim written when the turn started, not from heartbeats or pane scrapes.

The shape comes from opencode (`packages/core/src/session/execution.ts`,
`execution/restart.ts`, `specs/v2/session.md`: "Execution Is Process-Local",
"Recovery Boundaries Stay Explicit"). Code: `packages/cli/src/turnClaims.ts`,
wired in `daemon.ts` (search `turnClaims()`).

## Lifecycle

| Event | Claim |
|---|---|
| First mid-turn status of a turn (`thinking`, `working`, `permission_blocked`) | Opened, with `attempts: 0`. A claim already open keeps its attempts: the continue a resume sends is the same turn going on. |
| `compacting` | Unchanged. An automatic compaction runs inside a turn that is already claimed; a manual `/compact` is no turn (it ends on a boundary idle with no Stop). |
| Any status from another session of the same conversation (a `/clear` moved it on, tmux or SDK) | The old session's claim is released. |
| First status from a session after a resume was queued | Recorded as `heardAt`: the resumed process is up. |
| More tool calls in the turn | Nothing written. |
| Turn ends: the Stop hook's idle (stamped with `turn_completed_at`, whatever the settle makes of it), an SDK result, `stopped` | Released. |
| A turn that ends on an API error (a 529, "prompt too long"): Claude Code fires StopFailure, not Stop | Released by the pass, which reads the transcript's tail (`jsonlTailApiError`): the turn is over, and a continue would fail the same way. |
| A bare `idle` with no turn stamp (Claude's `idle_prompt`, e.g. a resumed session waiting at its prompt for a held continue) | Unchanged. |
| A session coming up (`connected`, `starting`, `resuming`) | Unchanged. |
| A boundary idle that is the first status after a resume (SessionStart landing the resume at its prompt) | Unchanged: the continue is on its way. |
| Any other boundary idle (an SDK turn whose session id changed, a person's own resume at the prompt) | Released. |
| A person interrupts (Escape) | Claude Code fires no Stop, so the claim stays; the recovery pass reads the transcript's tail and releases it as `interrupted`. Slash commands run after the Escape (`/model`, `/exit`) are skipped there, so they do not hide it. An SDK interrupt ends in a result and releases at once. |
| A kill, an agent switch, a restart, a move | Released in `teardownConversationBackendsLive`, which every deliberate stop goes through, before any process stops. The one restart that keeps it is delivery's restart of a pane on its own credential to carry a recovery continue (`[CC-FLEET]`): that continue is the claim's resume. An SDK start, which replaces whatever host ran the conversation, releases too, as does one that fell back to tmux. |
| Daemon exit, host death, reboot | Kept. That is the point of the claim. |

The writer is `handleStatusData`, the one sink both backends feed, applied
before its idle settle re-enters asynchronously: tmux hook
posts, the hook's spool replayed after a daemon restart, and SDK host activity.
So a turn that started while the daemon was down opens its claim when the
spool replays, in order, and a Stop spooled behind it releases it again.
Every release leaves a mark with its time (kept 3 days, the retention of an
unfinished status file). A status older than the mark never reopens the
claim (one in the same second as a Stop or a teardown is the next turn and
does; teardown marks are cut to whole seconds, the precision statuses carry), so a status file a kill left at `working` cannot bring it back through
the boot replay or the watchdog.
The launch token fence runs first, so a stale launch cannot open or release
anything.

## Recovery pass

`TurnClaimRecovery` runs one pass at a time. It runs 15 seconds after boot
(once the spool replay and the SDK reattach have finished; no pass runs before
that, so a host found dead at reattach waits for it), when an SDK host that
held a claim goes away, when the heartbeat sees a claimed pane disappear, and
on every watchdog tick. The process is asked first, so a live session costs no
server lookup. For each claim:

1. A resume was queued and the session has not reported anything since. The
   claim holds the continue's message id, and the pass asks the server where
   it stands (`pendingMessageOutcome`, shared with delivery's receipts).
   Still open (pending, or injected, failed or undeliverable, which the server
   puts back and retries): wait, however long, since another continue would
   only stack behind it; delivery's own breaker bounds those retries.
   Cancelled by a person: release, once the process is known to be gone.
   Landed, or nobody can say: the process gets 30 minutes to report;
   silence past that means the resume died before its first hook, and that
   attempt is spent.
2. The conversation now runs on another machine (a move): release. The server
   already queued that machine's continue (`queueMoveContinue`).
3. Is the agent process there? Live or unverifiable: keep, and never start a
   second process beside it.
   - SDK: the host's pid (`ClaudeSdkBackend.hostVerdict`). A start, attach or
     resume in progress answers unverifiable.
   - Pane: the watchdog's own rule (`staleSessionVerdictFromProbe`): exited
     only when the process lookup answered and found nothing, and the session's
     last sign of life is older than 30 minutes, from before this boot, or the
     daemon saw the session's tmux session disappear (the heartbeat's health
     check). That last case used to restart the session empty, landing it idle
     at its prompt with the turn lost; a session holding a claim is now handed
     to the pass instead, so it is continued under the cap. A
     process lookup can miss a live agent, so a fresh claim is never trusted to
     a single miss. `findSessionProcess` also finds `cc-resume-*` panes, so an
     auto-resumed copy counts as alive.
   - A status that lands while the pass looks also means alive.
   - Delivery bringing the session back right now (a resume or restart in
     progress), or a message already waiting for it (a person's, or this
     claim's own continue): unverifiable. Whatever delivery starts reports its
     own statuses, and another continue would only stack.
   - The opt-in warm pool skips claimed sessions: its empty resume would land
     the session idle and lose the turn.
4. A lookup that failed (the lifecycle, or the owner) is no answer: wait for
   the next pass. Silent for 24 hours (a day, so a machine that died
   overnight still continues its turns in the morning): fail visibly, with a
   session error saying the turn was left too long to restart, rather than a
   quiet completion. Only once the process is observed gone: a live pane idle
   at its prompt for days after an Escape keeps its claim, whatever one probe
   says. It comes ahead of the lookups, so a claim whose lookups keep failing
   still ends.
5. Released without a resume: the conversation no longer exists, killed or dismissed,
   interrupted by the person, parked on a usage limit (the account recovery
   chain owns it). A pane session is marked completed and reported stopped,
   as the watchdog did before. That includes a pane the heartbeat saw die:
   it is no longer restarted idle at its prompt.
6. Attempts spent: 3 for this turn (`MAX_TURN_RESUME_ATTEMPTS`), or 3 revives
   of the session in 6 hours across turns (the revive ledger
   `midWorkRevive.ts` keeps per conversation, which claim resumes also
   record, before queueing), so a session whose resumed turns end and whose
   next turn kills it again cannot loop either, nor one whose resumes land on
   new session ids. The per-turn count resets whenever delivery itself
   restarts the session (an SDK start, a stale-pane replace) or a resume lands
   on a new session id; the per-conversation budget is what bounds a crash
   loop in every case. A revive is recorded before its message is queued and
   taken back when the queue call fails or is declined. A continue still
   queued when the session fails is cancelled. A claim that goes 24 hours silent after a resume of its own fails
   the same way rather than being marked completed. Release, report stopped,
   and set the session error: "Codecast restarted this session 3 times after
   its agent process died, and it did not come back to finish, so it stopped
   trying. The conversation is intact; send a message to continue."
7. Otherwise: bump `attempts` on disk (fsynced) **before** queueing the
   continue, then queue it. A crash between the two still spends the attempt,
   so a session that kills the daemon on resume cannot loop. A queue call that
   threw keeps its attempt spent and in flight, since the server may have
   stored the message; a machine with recovery off releases.

The continue is the ordinary revive message (`MID_WORK_REVIVE_MESSAGE`)
queued on the conversation. Delivery does the resume exactly as for a typed
message: it injects into a live process if one turns up, else resumes the
session in tmux or a new SDK host. The message tells the agent that whatever
was running stopped, and that a command or tool call in flight did not finish
and was not run again. Nothing is replayed: the resume continues from the
transcript, and the agent decides what to redo.

At most three resumes a pass, behind the load governor, workflow station
hands first, the same pacing as the revive path.

## Where the claim lives

On this machine only: `~/.codecast/turn-claims.json`, one atomic write when a
claim opens, is released or spends an attempt. Only the attempt is fsynced
before its continue is queued: opens and releases run on the daemon's loop
twice a turn, and a claim lost to a power cut costs one resume, while a lost
attempt count could loop. The failure modes
decide it:

- **Daemon restart, same machine.** The agent usually keeps running (tmux
  panes and SDK hosts outlive the daemon), so the claim must survive the daemon
  and the pass must see the live process. A local file does both.
- **Machine reboot.** The process is gone and so is anything in memory. The
  file survives; every claim's last sign of life predates the boot, which is
  the one case a pane miss is believed at once.
- **Session moved to another host.** The claim is about a process here, and a
  move already continues the turn on the destination from the server side.
  The source releases its claim when the server names another owner. A claim
  stored in Convex would follow the conversation to a machine where no such
  process ever ran.
- **Cost.** Convex would add two writes per turn for every session in the
  fleet, and Convex cost is the write rate of what queries read. Nothing off
  this machine reads the claim.

## Codex app-server

Codex sessions on the app-server already carry the same claim in their own
record (`activeTurnId` and `recoveryAttempts` in `codexTurnRecovery.ts`): set
on `turn/started`, cleared on `turn/completed`, attempts bumped before the
continue, and the server's own thread status says whether the turn is still
active. They share `MAX_TURN_RESUME_ATTEMPTS`. They do not feed the status
sink, so they never get a second claim here.

## Left out

- **Finished turns that still own work** (`waiting` on a background command or
  workflow, `dormant` with a wake armed inside the process) are not turns.
  `midWorkRevive.ts` keeps reviving those from their status files with its own
  budget (3 in 6 hours).
- **Hand-run terminals** (a session last run in Ghostty or herdr) follow the
  delivery path's hand-host grace after a boot, unchanged.
- **The interrupted tool call's card.** The continue message tells the agent
  the call did not finish; nothing marks the dangling tool call itself as
  interrupted in the synced transcript, so its card shows what the transcript
  holds.
- **A pane death nobody observed waits 30 minutes**, the watchdog's existing
  rule for believing a process lookup that found nothing. A pane the
  heartbeat saw disappear, an SDK host's death, and a reboot are acted on at once.
- **A long tool call and a missed process lookup.** A 40 minute build writes
  nothing to the transcript, so past 30 minutes one process lookup that misses
  the live agent reads as an exit, the watchdog's existing exposure. Before,
  that marked the session completed; now a continue is queued. Delivery
  injects it into the live pane when its own lookup finds the agent, and the
  agent reads a restart notice it did not need. When delivery's lookup misses
  too, it auto-resumes beside the live agent: the exposure every message to
  that session already has, not one the claim adds.
- **Two narrow ways to a second continue or a stray one.** A queue call that
  threw after the server stored the message leaves no id to ask about, so 30
  minutes later the pass may queue another (the server dedupes on client id
  only within the same minute). A release lost to a power cut (releases are not fsynced) can
  bring back a finished turn after the reboot; its continue then reaches a
  session with nothing left to do.
- **A death at a permission prompt is resumed** (the turn was open), where the
  revive path left it stopped. The continue makes Claude ask again, which
  opens a fresh card.
- **Non-Claude panes** (Codex TUI, Grok, Cursor) get claims whenever their
  hooks report mid-turn statuses through the same sink; agents with no status
  hook have no claims and no mid-turn resume.
