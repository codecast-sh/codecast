import { deriveLiveAt, type LiveFactsRow } from "@codecast/shared/contracts";

// A session row as the shared live derivation reads it (deriveLiveAt): the
// replicated facts plus the base fields the rules branch on. ONE adapter for
// the placement chokepoint, the liveness dot and the fleet bands, so no
// reader can hand the rule a different row than another.
export function liveFactsOf(s: {
  status?: string | null;
  updated_at?: number;
  message_count?: number | null;
  has_pending?: boolean | null;
  inbox_dismissed_at?: number | null;
  inbox_stashed_at?: number | null;
  agent_status?: string | null;
  agent_status_updated_at?: number | null;
  last_heartbeat?: number | null;
  daemon_alive_until?: number | null;
  producing_until?: number | null;
  last_role_is_user?: boolean | null;
  auq_open?: boolean | null;
  awaiting_input?: boolean | null;
  open_tasks?: unknown[] | null;
  open_tasks_at?: number | null;
  loop_state?: LiveFactsRow["loop_state"];
}): LiveFactsRow {
  return {
    status: s.status ?? "active",
    updated_at: s.updated_at ?? 0,
    message_count: s.message_count ?? 0,
    has_pending_messages: s.has_pending ?? null,
    inbox_dismissed_at: s.inbox_dismissed_at ?? null,
    inbox_stashed_at: s.inbox_stashed_at ?? null,
    agent_status: s.agent_status ?? null,
    agent_status_updated_at: s.agent_status_updated_at ?? null,
    last_heartbeat: s.last_heartbeat ?? null,
    daemon_alive_until: s.daemon_alive_until ?? null,
    producing_until: s.producing_until ?? null,
    last_role_is_user: s.last_role_is_user ?? null,
    auq_open: s.auq_open ?? null,
    awaiting_input: s.awaiting_input ?? null,
    open_tasks: s.open_tasks ?? null,
    open_tasks_at: s.open_tasks_at ?? null,
    loop_state: s.loop_state ?? null,
  };
}

// Settled at instant `now` by the shared rule — or retired: a killed row's
// live-looking fields are never believable, whatever they still carry.
export function sessionIdleAt(s: Parameters<typeof liveFactsOf>[0] & { inbox_killed_at?: number | null }, now: number): boolean {
  if (s.inbox_killed_at) return true;
  return deriveLiveAt(liveFactsOf(s), now).is_idle;
}

// Actively producing at instant `now`: content, not retired, not settled.
// THE test every reader of a row's live-looking fields applies — the inbox
// bucket, the pulsing dot, the status pill — so they cannot disagree (a
// needs-input card with a green "working" dot is the historical failure).
export function sessionLiveAt(s: Parameters<typeof sessionIdleAt>[0], now: number): boolean {
  return (s.message_count ?? 0) > 0 && !sessionIdleAt(s, now);
}

// Liveness classification for sessions, tasks and plans. Pure functions, kept
// out of components/LivenessDot.tsx so that module exports only components
// (a helper export next to a component breaks React Fast Refresh for the file,
// and this one has a dozen importers).

export type LivenessState =
  | "active"
  | "idle"
  | "blocked"
  | "error"
  | "new"
  | "pinned"
  | "unresponsive"
  | "done"
  | "dormant";

export function sessionLivenessState(session: {
  is_idle: boolean;
  message_count: number;
  is_pinned?: boolean;
  is_unresponsive?: boolean;
  session_error?: string;
  updated_at?: number;
  agent_status?: string | null;
  has_pending?: boolean;
  // Declared because isLivenessStale reads it: a retired row's live-looking
  // fields are never believable. Callers pass whole rows, so it already arrived
  // at runtime — spelling it out keeps the dependency from resting on
  // structural typing, and stops a hand-built literal from silently omitting it.
  inbox_killed_at?: number | null;
}): LivenessState {
  if (session.session_error) return "error";
  if (session.is_unresponsive) return "unresponsive";
  if (session.is_pinned && session.is_idle) return "pinned";
  // "active" only while the shared live rule says so at this instant: a frozen
  // is_idle:false re-derives from the row's facts (the same rule the inbox
  // bucket uses), so it reads idle instead of pulsing green forever.
  const live = sessionLiveAt(session, Date.now());
  if (live) return "active";
  if (session.message_count > 0) return "idle";
  return "new";
}

export function taskLivenessState(
  status: string,
  activeSession?: { agent_status?: string } | null,
): LivenessState {
  if (status === "done") return "done";
  if (status === "dropped") return "dormant";
  if (!activeSession) {
    if (status === "in_progress" || status === "in_review") return "idle";
    return "dormant";
  }
  const agentStatus = activeSession.agent_status;
  if (agentStatus === "permission_blocked") return "blocked";
  if (agentStatus === "idle" || agentStatus === "stopped") return "idle";
  return "active";
}

export function planLivenessState(
  status: string,
  hasActiveAgent: boolean,
): LivenessState {
  if (status === "done") return "done";
  if (status === "abandoned") return "dormant";
  if (status === "paused") return "idle";
  if (hasActiveAgent) return "active";
  if (status === "active") return "idle";
  return "dormant";
}
