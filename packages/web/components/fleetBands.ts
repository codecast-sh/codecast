// Pure band logic for the fleet board (FleetBoard.tsx): which band a session
// tile lands in, the one metadata line it shows, and the running progress cue.
// Extracted so the classification stays unit-testable under `bun test` without
// React/DOM, mirroring workingStatus.ts.
//
// The bands are a stricter read of the inbox buckets, tuned for supervision:
//   NEEDS YOU  a concrete blocker — an open question, a permission prompt, an
//              API/auth error, a dead or silently-stalled agent, or a declared
//              "Blocked:" thread state. NOT every finished turn (the inbox
//              needs-input bucket counts those; a board of 30 agents where
//              every completed run screams for attention is a board that lies).
//   RUNNING    genuinely making progress right now (or a send in flight).
//   FINISHED   ran to completion, nothing asked — idle with messages.

import {
  type InboxSession,
  type CategorizedSessions,
  categorizeSessions,
  classifySession,
  isAgentActive,
  getProjectName,
} from "../store/inboxStore";
import { isLivenessStale, THREAD_STATE_STALE_MSGS } from "@codecast/shared/contracts";
import { makeCollectionSig } from "../store/wakeSig";
import { threadStateView, compactAge } from "../lib/threadState";
import { sessionCardSummary } from "../lib/sessionSummary";
import { formatModel } from "../lib/conversationProcessor";

export type FleetBand = "needsYou" | "running" | "finished";

export interface FleetBandOpts {
  /** Client-queued sends (store.sessionsWithQueuedMessages). */
  queued: Set<string>;
  /** Optimistic outbox sends (sessionsWithPendingSend). */
  pendingSendIds: ReadonlySet<string>;
  /** Coarse clock (useCoarseNow) — never Date.now() in render. */
  now: number;
}

const inFlight = (s: InboxSession, opts: FleetBandOpts) =>
  opts.queued.has(s._id) || opts.pendingSendIds.has(s._id);

export function fleetBandFor(s: InboxSession, opts: FleetBandOpts): FleetBand {
  // A message on its way to the agent reads as running, whatever the stale
  // status claims — same precedence isSessionWaitingForInput gives in-flight.
  if (inFlight(s, opts)) return "running";
  // Concrete blockers only. Deliberately NOT isSessionHardBlocked: its "dead
  // agent with output" arm counts every cleanly finished session ("stopped" +
  // idle is the NORMAL end state of a run), which floods this band and makes
  // it lie. A mid-task death (stopped while NOT idle) still lands here, via
  // the liveness-stale check below.
  const hasOutput = (s.message_count ?? 0) > 0;
  if (s.session_error) return "needsYou";
  if (s.awaiting_input) return "needsYou";
  if (s.pending_api_error && hasOutput) return "needsYou";
  if (s.agent_status === "permission_blocked" && hasOutput) return "needsYou";
  const { idle } = classifySession(s);
  if (!idle) {
    // "Active" per status, but the liveness TTL says the agent went silent
    // (or the daemon marked it unresponsive): a quietly dead worker is the
    // user's to revive, not a running one.
    return isLivenessStale(s, opts.now) || s.is_unresponsive ? "needsYou" : "running";
  }
  // Idle, but the agent's own pinned state still declares it blocked — the
  // agent said "your move" in words. (A stale declaration has no view, so it
  // no longer counts.)
  const ts = threadStateView(s, s.message_count ?? 0, opts.now);
  if (ts?.status === "blocked") return "needsYou";
  return "finished";
}

export interface FleetCountOpts extends FleetBandOpts {
  /** Server-authoritative personal live set (store.liveInboxIds). Covers the
   *  viewer's own sessions across every project and machine. */
  liveInboxIds: Set<string>;
  /** The team subscription's active set (store.teamInboxIds). Empty outside
   *  team scope — where teammate rows lingering in the cache have frozen
   *  liveness and must not be counted at all. */
  teamInboxIds: ReadonlySet<string>;
  currentSessionId?: string | null;
  reviveRequestedAt?: Record<string, number>;
}

/**
 * The rows a fleet COUNT may consider at all: exactly the set the inbox/board
 * renders, never the raw session cache. The cache deliberately holds 30 days
 * of rows plus everything the user set aside, and counting it raw made the
 * presence card disagree with every surface next to it — stashed/dismissed
 * agents counted as "working", while a needs-input row older than an ad-hoc
 * recency window (but still in the inbox) silently dropped out.
 *
 * categorizeSessions applies the hiding rules in one place (stashed/dismissed/
 * killed rows, orphan subagents, non-blocked anchors, never-engaged blanks,
 * rows aged out of the server's inbox window), so this can never drift from
 * the board. The old-row partition runs against the union of the personal and
 * team live sets: own rows survive via liveInboxIds, teammates' via
 * teamInboxIds — each windowed by its own subscription.
 *
 * The row list is the same union splitFleetBands bands, including just-spawned
 * blanks with a live agent or a send in flight.
 */
export function fleetCountedSessions(
  sessions: Record<string, InboxSession>,
  opts: FleetCountOpts,
): InboxSession[] {
  const windowIds = opts.teamInboxIds.size
    ? new Set<string>([...opts.liveInboxIds, ...opts.teamInboxIds])
    : opts.liveInboxIds;
  const cat = categorizeSessions(sessions, opts.queued, opts.pendingSendIds, {
    currentSessionId: opts.currentSessionId,
    liveInboxIds: windowIds,
    reviveRequestedAt: opts.reviveRequestedAt,
  });
  return [
    ...cat.pinned,
    ...cat.needsInput,
    ...cat.done,
    ...cat.dormant,
    ...cat.working,
    ...cat.newSessions.filter((s) => isAgentActive(s) || inFlight(s, opts)),
  ];
}

/**
 * A wake signature over exactly what `fleetBandFor` and the fleet summary
 * BRANCH ON — nothing else.
 *
 * It lives here, beside the function it projects, because the two must be
 * edited together: a new branch in `fleetBandFor` that is not signed here is a
 * band that silently stops updating, and that failure is invisible.
 *
 * Deliberately absent, and this is the whole point:
 *
 *   `updated_at` and `last_heartbeat` — they move every second on every live
 *   session. `isLivenessStale` reads `updated_at`, so staleness IS partly a
 *   function of it, but staleness is a TIME transition, not a field change:
 *   pair this signature with a coarse clock (useCoarseNow), which is what
 *   `useFleetSummaries` does. Folding `updated_at` in would defeat the entire
 *   signature and re-render every subscriber on every tick — the bug that
 *   pegged the inbox sidebar at ~70% idle main-thread.
 *
 *   The raw `message_count` — it streams token by token during a run. The band
 *   only ever asks two questions of it: is there ANY output, and has the
 *   pinned thread state gone stale from messages piling up since it was
 *   written. Both are thresholds, so both are folded to a bit and a burst of
 *   200 streamed messages costs one signature change instead of 200.
 */
export function fleetSessionSig(s: InboxSession): string {
  const messagesSince =
    s.thread_state_msg_count == null
      ? null
      : Math.max(0, (s.message_count ?? 0) - s.thread_state_msg_count);
  return [
    s._id,
    // Whose fleet this counts toward, and what the "· fixing auth" tail says.
    s.user_id ?? "",
    s.title ?? "",
    s.session_id ?? "",
    // The band's own inputs.
    s.agent_status ?? "",
    s.is_idle ? 1 : 0,
    // Liveness overlay field; not on the base row type (teamSessionsLiveness
    // merges it in), and the fleet filter branches on it.
    (s as any).is_live ? 1 : 0,
    s.inbox_killed_at ? 1 : 0,
    // Visibility inputs of fleetCountedSessions: setting a row aside, pinning
    // it, or an anchor flipping in/out of hard-blocked all change which rows
    // the fleet counts, and must wake subscribers between coarse ticks.
    s.inbox_dismissed_at ? 1 : 0,
    s.inbox_stashed_at ? 1 : 0,
    s.is_pinned ? 1 : 0,
    (s as any).is_anchor ? 1 : 0,
    s.awaiting_input ? 1 : 0,
    s.session_error ? 1 : 0,
    s.pending_api_error ? 1 : 0,
    s.is_unresponsive ? 1 : 0,
    s.has_pending ? 1 : 0,
    // Thresholds, not counts (see above).
    (s.message_count ?? 0) > 0 ? 1 : 0,
    messagesSince != null && messagesSince >= THREAD_STATE_STALE_MSGS ? 1 : 0,
    // The pinned state: whether there is one, when it was written (every
    // rewrite stamps a new timestamp, so this stands in for the text), and the
    // declared status the "blocked" branch and the quote line both read.
    s.thread_state ? 1 : 0,
    s.thread_state_at ?? 0,
    s.thread_state_status ?? "",
  ].join("\x1f");
}

/** The same signature over the whole session map, memoized by the map ref —
 *  what an always-mounted fleet surface subscribes to instead of `s.sessions`. */
export const fleetSessionsWakeSig = makeCollectionSig<InboxSession>(fleetSessionSig);

export interface FleetBands {
  needsYou: InboxSession[];
  running: InboxSession[];
  finished: InboxSession[];
}

/**
 * Split the visible inbox rows into board bands. Callers hand in the
 * categorizeSessions output so every hiding rule (dismissed, stashed, killed,
 * orphan subagents, old rows) stays decided in exactly one place.
 */
export function splitFleetBands(
  cat: Pick<CategorizedSessions, "pinned" | "needsInput" | "working" | "newSessions"> &
    Partial<Pick<CategorizedSessions, "done" | "dormant">>,
  opts: FleetBandOpts,
): FleetBands {
  const out: FleetBands = { needsYou: [], running: [], finished: [] };
  for (const s of [...cat.pinned, ...cat.needsInput, ...(cat.done ?? []), ...(cat.dormant ?? []), ...cat.working]) {
    out[fleetBandFor(s, opts)].push(s);
  }
  // Blanks: a just-spawned worker (agent starting, or a first send in flight)
  // belongs on the board as RUNNING; a never-engaged pre-warm stub does not.
  for (const s of cat.newSessions) {
    if (isAgentActive(s) || inFlight(s, opts)) out.running.push(s);
  }
  // Longest-waiting first: the tile you've kept blocked the longest leads.
  out.needsYou.sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0));
  // Stable order (creation time), NOT last-activity: running tiles must not
  // reshuffle on every coarse tick or the board is unscannable.
  out.running.sort(
    (a, b) => ((b.started_at ?? b.updated_at ?? 0) - (a.started_at ?? a.updated_at ?? 0)) || a._id.localeCompare(b._id),
  );
  out.finished.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return out;
}

export type FleetTileTone = "amber" | "red" | "green" | "dim";

const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").trim();

/**
 * The tile's context line — what tells two similarly-titled sessions apart:
 * which repo, which model, how big the run is. Same fields the rail's card
 * header shows, compressed to one dim line.
 */
export function fleetTileContext(s: InboxSession): string {
  const parts: string[] = [];
  const proj = getProjectName(s.git_root ?? undefined, s.project_path ?? undefined);
  if (proj && proj !== "unknown") parts.push(s.worktree_name ? `${proj}/${s.worktree_name}` : proj);
  const model = formatModel(s.model ?? undefined);
  if (model) parts.push(model);
  if ((s.message_count ?? 0) > 0) parts.push(`${s.message_count} msgs`);
  return parts.join(" · ");
}

/**
 * What the agent is ABOUT — the strongest disambiguator after the title.
 * idle_summary / first subtitle bullet, or the agent's own pinned state line.
 */
export function fleetTileSummary(s: InboxSession, now: number): string {
  const ts = threadStateView(s, s.message_count ?? 0, now);
  return ts?.cardLine || sessionCardSummary(s);
}

/** Live agent status worth naming on a running tile ("thinking", "compacting"). */
const RUNNING_STATUS_LABEL: Record<string, string> = {
  thinking: "thinking",
  compacting: "compacting",
  waiting: "waiting on tasks",
  starting: "starting",
  resuming: "resuming",
};

/**
 * The tile's single metadata line. For NEEDS YOU it is the actual blocker —
 * the agent's declared "Blocked:" line, the question summary, the error — in
 * that order of specificity; generic labels only when the row carries nothing
 * better. That specificity is what makes the top band scannable.
 */
export function fleetTileMeta(
  s: InboxSession,
  band: FleetBand,
  now: number,
): { text: string; tone: FleetTileTone } {
  if (band === "needsYou") {
    if (s.session_error) return { text: `error · ${firstLine(s.session_error)}`, tone: "red" };
    if (s.pending_api_error) {
      const kind = s.pending_api_error_kind;
      if (kind === "limit") return { text: "rate limited · usage limit", tone: "red" };
      if (kind === "auth") return { text: "needs sign-in", tone: "red" };
      if (kind === "connection") return { text: "connection dropped", tone: "red" };
      if (kind === "fatal") return { text: "api error · send continue", tone: "red" };
      return { text: "api error · retrying", tone: "red" };
    }
    const ts = threadStateView(s, s.message_count ?? 0, now);
    const blocker = (ts?.status === "blocked" ? ts.cardLine : "") || sessionCardSummary(s);
    if (s.agent_status === "permission_blocked") {
      return { text: blocker ? `permission: ${blocker}` : "permission needed", tone: "amber" };
    }
    if (s.awaiting_input) {
      return { text: blocker ? `asks: ${blocker}` : "waiting for your answer", tone: "amber" };
    }
    if (s.agent_status === "stopped") return { text: "agent stopped", tone: "amber" };
    if (isLivenessStale(s, now) && !classifySession(s).idle) {
      return { text: `went quiet ${compactAge(now - (s.updated_at ?? now))} ago`, tone: "amber" };
    }
    return { text: blocker || "needs your attention", tone: "amber" };
  }
  if (band === "running") {
    if ((s.message_count ?? 0) === 0) return { text: "starting", tone: "green" };
    const age = compactAge(now - (s.updated_at ?? now));
    const status = RUNNING_STATUS_LABEL[s.agent_status ?? ""] ?? "working";
    return { text: `${status} · ${age === "just now" ? "<1m" : age}`, tone: "green" };
  }
  const age = compactAge(now - (s.updated_at ?? now));
  return { text: age === "just now" ? "finished just now" : `finished · ${age} ago`, tone: "dim" };
}

/**
 * Progress cue for a running tile, 0..1. Workflow runs report real progress
 * (agents done / total); for everything else the honest cue is recency — full
 * right after activity, draining across 15 quiet minutes, so a stalling agent
 * visibly fades instead of pretending motion.
 */
export function fleetProgress(s: InboxSession, now: number): number {
  const total = s.workflow_run_agents_total;
  if (total && total > 0) return Math.min(1, Math.max(0, (s.workflow_run_agents_done ?? 0) / total));
  const elapsed = Math.max(0, now - (s.updated_at ?? now));
  return Math.max(0.05, Math.min(1, 1 - elapsed / (15 * 60_000)));
}
