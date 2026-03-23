import Link from "next/link";
import { cn } from "@/lib/utils";

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

const STATE_STYLES: Record<LivenessState, { color: string; tailwind: string; pulse: boolean }> = {
  active:       { color: "#859900", tailwind: "bg-sol-green",      pulse: true },
  idle:         { color: "#b58900", tailwind: "bg-sol-yellow",     pulse: false },
  blocked:      { color: "#cb4b16", tailwind: "bg-sol-orange",     pulse: false },
  error:        { color: "#dc322f", tailwind: "bg-sol-red",        pulse: false },
  new:          { color: "",        tailwind: "bg-sol-text-dim/30", pulse: false },
  pinned:       { color: "#d33682", tailwind: "bg-sol-magenta",    pulse: false },
  unresponsive: { color: "#cb4b16", tailwind: "bg-sol-orange",     pulse: false },
  done:         { color: "#859900", tailwind: "bg-sol-green",      pulse: false },
  dormant:      { color: "",        tailwind: "bg-sol-text-dim/30", pulse: false },
};

interface LivenessDotProps {
  state: LivenessState;
  size?: "xs" | "sm" | "md";
  className?: string;
}

const SIZE_MAP = { xs: "h-1.5 w-1.5", sm: "h-2 w-2", md: "h-2.5 w-2.5" };

export function LivenessDot({ state, size = "sm", className }: LivenessDotProps) {
  const style = STATE_STYLES[state];

  if (style.pulse) {
    return (
      <span className={cn("relative flex flex-shrink-0", SIZE_MAP[size], className)}>
        <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", style.tailwind)} />
        <span className={cn("relative inline-flex rounded-full", SIZE_MAP[size], style.tailwind)} />
      </span>
    );
  }

  return (
    <span className={cn("rounded-full flex-shrink-0", SIZE_MAP[size], style.tailwind, className)} />
  );
}

export function sessionLivenessState(session: {
  is_idle: boolean;
  message_count: number;
  is_pinned?: boolean;
  is_unresponsive?: boolean;
  session_error?: string;
}): LivenessState {
  if (session.session_error) return "error";
  if (session.is_unresponsive) return "unresponsive";
  if (session.is_pinned && session.is_idle) return "pinned";
  if (!session.is_idle && session.message_count > 0) return "active";
  if (session.is_idle && session.message_count > 0) return "idle";
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

interface ActiveSessionBadgeProps {
  session: { session_id: string; title?: string; agent_status?: string; agent_type?: string };
  compact?: boolean;
  className?: string;
}

export function ActiveSessionBadge({ session, compact, className }: ActiveSessionBadgeProps) {
  const { session_id, agent_status, agent_type, title } = session;
  const isBlocked = agent_status === "permission_blocked";
  const isIdle = agent_status === "idle" || agent_status === "stopped";
  const state: LivenessState = isBlocked ? "blocked" : isIdle ? "idle" : "active";
  const badgeClass = isBlocked
    ? "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25"
    : isIdle
      ? "bg-sol-bg-alt text-sol-text-dim hover:bg-sol-bg-highlight"
      : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25";
  const statusLabel = isBlocked ? "blocked" : isIdle ? "idle"
    : agent_type === "codex" ? "codex" : agent_type === "cursor" ? "cursor" : agent_type === "gemini" ? "gemini" : "live";

  const content = (
    <>
      <LivenessDot state={state} size="xs" />
      {statusLabel}
    </>
  );

  if (compact) {
    return (
      <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px]", badgeClass, className)}>
        {content}
      </span>
    );
  }

  return (
    <Link
      href={`/conversation/${session_id}`}
      onClick={(e) => e.stopPropagation()}
      className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] cursor-pointer transition-colors flex-shrink-0", badgeClass, className)}
      title={title || "Active session"}
    >
      {content}
    </Link>
  );
}
