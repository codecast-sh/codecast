import { cn, relTimeShort } from "@/lib/utils";
import { useInboxStore } from "../store/inboxStore";
import { type LivenessState } from "../lib/liveness";
export type { LivenessState };

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

interface LivePulseHaloProps {
  children: React.ReactNode;
  className?: string;
}

/** Live-session halo around a status glyph. The glyph keeps showing the item's
 * status; the green ring expanding from behind it says an agent is working on
 * it right now. Use this instead of swapping the glyph for a LivenessDot —
 * replacing the glyph hides the status while a session runs. */
export function LivePulseHalo({ children, className }: LivePulseHaloProps) {
  return (
    <span className={cn("relative inline-flex items-center justify-center flex-shrink-0", className)}>
      {/* Rings sit just outside the glyph's own stroke: a resting ring so
          "live" reads between pulses, and a ripple that expands from it. */}
      <span aria-hidden className="absolute -inset-0.5 rounded-full border border-sol-green/50" />
      <span aria-hidden className="absolute -inset-0.5 rounded-full border-2 border-sol-green animate-ping opacity-60" />
      <span className="relative inline-flex">{children}</span>
    </span>
  );
}

interface ActiveSessionBadgeProps {
  // _id is the Convex conversation _id and is what the side panel keys off of.
  // session_id (the chat session string) is kept for back-compat with older callers.
  // started_by = who owns/started the session (shown for non-live "origin"
  // sessions, which may belong to a teammate). last_message_at = recency of the
  // last message, rendered as a compact relative age.
  session: { _id?: string; session_id: string; title?: string; agent_status?: string; agent_type?: string; started_by?: string; last_message_at?: number };
  compact?: boolean;
  // Non-live linked session (e.g. the session a task originated from). Renders a
  // dimmed, un-pulsed badge so it reads as history, not a running agent.
  dormant?: boolean;
  className?: string;
}

export function ActiveSessionBadge({ session, compact, dormant, className }: ActiveSessionBadgeProps) {
  const { _id, session_id, agent_status, agent_type, title, started_by, last_message_at } = session;
  const isBlocked = !dormant && agent_status === "permission_blocked";
  const isIdle = !dormant && (agent_status === "idle" || agent_status === "stopped");
  const state: LivenessState = dormant ? "dormant" : isBlocked ? "blocked" : isIdle ? "idle" : "active";
  const badgeClass = dormant || isIdle
    ? "bg-sol-bg-alt text-sol-text-dim hover:bg-sol-bg-highlight"
    : isBlocked
      ? "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25"
      : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25";
  // First-name token keeps the badge tight ("Ashot Petrosian" -> "Ashot"); the
  // full name lives in the tooltip.
  const shortBy = started_by ? started_by.split(/\s+/)[0] : undefined;
  // Status word is only a fallback for when we don't know who started the
  // session — live/idle/blocked is conveyed by the dot's color regardless.
  const statusLabel = isBlocked ? "blocked" : isIdle ? "idle"
    : agent_type === "codex" ? "codex" : agent_type === "cursor" ? "cursor" : agent_type === "gemini" ? "gemini"
    : dormant ? "session" : "live";
  const rel = last_message_at ? relTimeShort(last_message_at) : undefined;
  // Always lead with "who started it" ("ashot · 3m"); fall back to the status
  // word when the owner is unknown. Live vs dormant is shown by the dot.
  const lead = shortBy || statusLabel;
  const label = rel ? `${lead} · ${rel}` : lead;

  const content = (
    <>
      <LivenessDot state={state} size="xs" />
      <span className="truncate">{label}</span>
    </>
  );

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const store = useInboxStore.getState();
    const targetId = _id || session_id;
    store.openSidePanel(targetId);
  };

  const tooltip = [
    title || (dormant ? "Originating session" : "Active session"),
    started_by ? `started by ${started_by}` : null,
    rel ? `last message ${rel} ago` : null,
  ].filter(Boolean).join(" · ");

  return (
    <button
      onClick={handleClick}
      className={cn(
        "inline-flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0 max-w-[160px]",
        compact ? "px-1.5 py-0.5 rounded-full text-[9px]" : "px-1.5 py-0.5 rounded-full text-[10px]",
        badgeClass,
        className,
      )}
      title={tooltip}
    >
      {content}
    </button>
  );
}
