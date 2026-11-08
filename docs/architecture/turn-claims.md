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
| First mid-turn status of a turn (`thinking`, `working`, `compacting`, `permission_blocked`) | Opened, with `attempts: 0`. A claim already open keeps its attempts: the continue a resume sends is the same turn going on. |
| More tool calls in the turn | Nothing written. |
| Turn ends: Stop hook settle (`idle`, `waiting`, a verdict), SDK result, `stopped` | Released. |
| A session coming up (`connected`, `starting`, `resuming`) or a session boundary (SessionStart landing a resume at its prompt) | Unchanged. |
| A person interrupts (Escape) | Claude Code fires no Stop, so the claim stays; the recovery pass reads the transcript's tail and releases it as `interrupted`. An SDK interrupt ends in a result and releases at once. |
| A kill from the inbox, an agent switch, an SDK start that fell back to tmux | Released: the kill through the lifecycle check, the SDK stops directly (`releaseConversation`). |
| Daemon exit, host death, reboot | Kept. That is the point of the claim. |

The writer is `handleStatusData`, the one sink both backends feed: tmux hook
posts, the hook's spool replayed after a daemon restart, and SDK host activity.
So a turn that started while the daemon was down opens its claim when the
spool replays, in order, and a Stop spooled behind it releases it again.
The launch token fence runs first, so a stale launch cannot open or release
anything.

## Recovery pass

`TurnClaimRecovery` runs one pass at a time. It runs 15 seconds after boot
(once the spool replay and the SDK reattach have finished), when an SDK host
that held a claim goes away, and on every watchdog tick. For each claim:

1. A resume queued in the last 10 minutes may still be starting: wait.
2. The conversation now runs on another machine (a move): release. The server
   already queued that machine's continue (`queueMoveContinue`).
3. Is the agent process there? Live or unverifiable: keep, and never start a
   second process beside it.
   - SDK: the host's pid (`ClaudeSdkBackend.hostVerdict`). A start, attach or
     resume in progress answers unverifiable.
   - Pane: the watchdog's own rule (`staleSessionVerdictFromProbe`): exited
     only when the process lookup answered and found nothing, and the session's
     last sign of life is older than 30 minutes or from before this boot. A
     process lookup can miss a live agent, so a fresh claim is never trusted to
     a single miss. `findSessionProcess` also finds `cc-resume-*` panes, so an
     auto-resumed copy counts as alive.
   - A status that lands while the pass looks also means alive.
4. Released without a resume: lifecycle unknown, killed or dismissed,
   interrupted by the person, parked on a usage limit (the account recovery
   chain owns it), or silent for 12 hours. A pane session is marked completed
   and reported stopped, as the watchdog did before.
5. Attempts spent (3, `MAX_TURN_RESUME_ATTEMPTS`): release, report stopped,
   and set the session error: "Codecast restarted this session 3 times after
   its agent process died mid-turn, and it died again each time, so it stopped
   trying. The conversation is intact; send a message to continue."
6. Otherwise: bump `attempts` on disk (fsynced) **before** queueing the
   continue, then queue it. A crash between the two still spends the attempt,
   so a session that kills the daemon on resume cannot loop. A queue write that
   failed gives the attempt back; a machine with recovery off releases.

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

On this machine only: `~/.codecast/turn-claims.json`, one atomic, fsynced
write when a claim opens, is released or spends an attempt. The failure modes
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
- **Non-Claude panes** (Codex TUI, Grok, Cursor) get claims whenever their
  hooks report mid-turn statuses through the same sink; agents with no status
  hook have no claims and no mid-turn resume.
