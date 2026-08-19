import { isLivenessStale } from "@codecast/shared/contracts";

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
  // "active" only if the working status is fresh — a frozen is_idle:false on an
  // aged-out row no longer counts as live (same trust check the inbox uses), so
  // it reads idle instead of pulsing green forever.
  const live = !session.is_idle && session.message_count > 0 && !isLivenessStale(session, Date.now());
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
