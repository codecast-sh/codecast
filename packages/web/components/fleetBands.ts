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
  classifySession,
  isSessionHardBlocked,
  isAgentActive,
} from "../store/inboxStore";
import { isLivenessStale } from "@codecast/shared/contracts";
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
  if (isSessionHardBlocked(s, opts.queued) || !!s.session_error) return "needsYou";
  const { idle } = classifySession(s);
  if (!idle) {
    // "Active" per status, but the liveness TTL says the agent went silent:
    // a quietly dead worker is the user's to revive, not a running one.
    return isLivenessStale(s, opts.now) ? "needsYou" : "running";
  }
  // Idle, but the agent's own pinned state still declares it blocked — the
  // agent said "your move" in words; a stale declaration no longer counts.
  const ts = threadStateView(s, s.message_count ?? 0, opts.now);
  if (ts?.status === "blocked" && ts.freshness !== "stale") return "needsYou";
  return "finished";
}

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
  cat: Pick<CategorizedSessions, "pinned" | "needsInput" | "working" | "newSessions">,
  opts: FleetBandOpts,
): FleetBands {
  const out: FleetBands = { needsYou: [], running: [], finished: [] };
  for (const s of [...cat.pinned, ...cat.needsInput, ...cat.working]) {
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
    const model = formatModel(s.model ?? undefined) || s.agent_type || "agent";
    const age = compactAge(now - (s.updated_at ?? now));
    return { text: `${model} · ${s.message_count} msgs · ${age === "just now" ? "<1m" : age}`, tone: "green" };
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
