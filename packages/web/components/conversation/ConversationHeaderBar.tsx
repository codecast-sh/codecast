import type { ReactNode, Ref } from "react";
import { TooltipProvider } from "../ui/tooltip";

type StatusPillSpec = { tone: string; dot: string; label: string; short: string };

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

export function AgentStatusPill({
  agentStatus,
  disconnected = false,
  live = false,
}: {
  agentStatus: string | undefined;
  disconnected?: boolean;
  /** The transcript moved recently; stands in for a missing status. */
  live?: boolean;
}) {
  const spec = agentStatusPillSpec(agentStatus, { disconnected, live });
  if (!spec) return null;
  return (
    <span data-cc-conv-status className={`inline-flex items-center gap-1 px-1 text-[10px] flex-shrink-0 ${spec.tone}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${spec.dot}`} />
      <span className="hidden sm:inline cq-sq3">{spec.label}</span>
      <span className="sm:hidden cq-sq3">{spec.short}</span>
    </span>
  );
}

export function ConversationHeaderTitle({
  text,
  tooltip,
  onDoubleClick,
}: {
  text: ReactNode;
  tooltip?: string;
  onDoubleClick?: () => void;
}) {
  return (
    <h1 className="cc-panel__title truncate flex-1 min-w-0 cursor-default" title={tooltip} onDoubleClick={onDoubleClick}>
      {text}
    </h1>
  );
}

/**
 * The conversation header's frame, as slots. ConversationView fills every slot
 * from the live session; the marketing hero fills a few with fixture views.
 * The squeeze row sheds chip detail by container width (cq-sq* in
 * globals.css), so the order of the slots is the order they give way in.
 */
export function ConversationHeaderBar({
  headerRef,
  headRef,
  squeezeRowRef,
  className = "",
  lead,
  title,
  titlePills,
  status,
  facts,
  actions,
  end,
  strips,
  children,
}: {
  headerRef?: Ref<HTMLElement>;
  headRef?: Ref<HTMLDivElement>;
  squeezeRowRef?: Ref<HTMLDivElement>;
  className?: string;
  /** Before the title: zen exit, the caller's headerLeft, the identity face. */
  lead?: ReactNode;
  title: ReactNode;
  titlePills?: ReactNode;
  /** Usually an AgentStatusPill. */
  status?: ReactNode;
  /** The dim facts strip: agent and model, branch, task, plan, age. */
  facts?: ReactNode;
  /** The right-hand cluster: live pills, then search, share and the menu. */
  actions?: ReactNode;
  end?: ReactNode;
  /** Full-width strips under the title row, inside the measured block. */
  strips?: ReactNode;
  /** Overlays and docked panes that live inside the header element. */
  children?: ReactNode;
}) {
  return (
    <header ref={headerRef} data-sv-convhead className={`cq-container shrink-0 relative ${className}`}>
      <div>
        <div ref={headRef} className="cc-panel__head gap-2 min-w-0">
          <div ref={squeezeRowRef} className="cq-squeeze-row flex items-center gap-2 min-w-0 overflow-hidden flex-1">
            {lead}
            {title}
            {titlePills}
            {status}
            {facts ? (
              <span data-cc-facts data-cc-conv-meta data-simple-dim className="cq-sq6 flex items-center min-w-0">
                {facts}
              </span>
            ) : null}
            {actions ? (
              <TooltipProvider delayDuration={300}>
                <div data-cc-conv-actions className="flex items-center gap-1 flex-shrink-0 overflow-hidden ml-auto">
                  {actions}
                </div>
              </TooltipProvider>
            ) : null}
          </div>
          {end && <div className="flex-shrink-0">{end}</div>}
        </div>
        {strips}
      </div>
      {children}
    </header>
  );
}
