export type StatusPillSpec = { tone: string; dot: string; label: string; short: string };

const LIVE_TONES = {
  thinking: { tone: "text-sol-violet", dot: "animate-pulse bg-sol-violet", label: "Thinking", short: "Think" },
  compacting: { tone: "text-amber-400", dot: "animate-pulse bg-amber-400", label: "Compacting", short: "Compact" },
  waiting: { tone: "text-sol-blue", dot: "animate-pulse bg-sol-blue", label: "Dormant", short: "Dormant" },
  dormant: { tone: "text-sol-blue", dot: "animate-pulse bg-sol-blue", label: "Dormant", short: "Dormant" },
  permission_blocked: { tone: "text-sol-orange", dot: "animate-pulse bg-sol-orange", label: "Needs Input", short: "Input" },
  starting: { tone: "text-sol-cyan", dot: "animate-pulse bg-sol-cyan", label: "Starting", short: "Start" },
  resuming: { tone: "text-sol-cyan", dot: "animate-pulse bg-sol-cyan", label: "Resuming", short: "Rsum" },
  connected: { tone: "text-sol-cyan", dot: "animate-pulse bg-sol-cyan", label: "Connected", short: "Conn" },
  working: { tone: "text-emerald-400", dot: "animate-pulse bg-emerald-400", label: "Working", short: "Work" },
} as const satisfies Record<string, StatusPillSpec>;

const DELIVERING: Record<string, StatusPillSpec> = {
  starting: { tone: "text-sol-cyan", dot: "bg-sol-cyan animate-pulse", label: "Starting", short: "Start" },
  resuming: { tone: "text-sol-cyan", dot: "bg-sol-cyan animate-pulse", label: "Resuming", short: "Rsum" },
  connected: { tone: "text-sol-cyan", dot: "bg-sol-cyan animate-pulse", label: "Delivering", short: "Dlvr" },
};

const DISCONNECTED: StatusPillSpec = { tone: "text-sol-text-dim/60", dot: "bg-sol-text-dim/30", label: "Disconnected", short: "Disc" };

/**
 * What the conversation header's status pill says for a daemon-reported agent
 * status. A hibernated session shows nothing here (the composer's status line
 * says so, and the daemon lifts the park on send). A disconnected session
 * shows its pending delivery or "Disconnected"; a connected one shows its live
 * status, or "Working" when there is no status but the transcript is moving.
 */
export function agentStatusPillSpec(
  agentStatus: string | undefined,
  { disconnected, live }: { disconnected: boolean; live: boolean },
): StatusPillSpec | null {
  if (agentStatus === "hibernated") return null;
  if (disconnected) return (agentStatus && DELIVERING[agentStatus]) || DISCONNECTED;
  if (agentStatus) return LIVE_TONES[agentStatus as keyof typeof LIVE_TONES] ?? null;
  return live ? LIVE_TONES.working : null;
}
