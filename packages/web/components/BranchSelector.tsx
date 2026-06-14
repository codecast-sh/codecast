import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Split } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";

type ForkChild = {
  _id: string;
  title: string;
  short_id?: string;
  started_at?: number;
  username?: string;
  parent_message_uuid?: string;
  message_count?: number;
  agent_type?: string;
  updated_at?: number;
  last_message_preview?: string;
  last_message_role?: string;
  last_user_message_at?: number;
  status?: string;
  git_branch?: string;
  fork_copied?: number;
};

// Sentinel loadingBranchId for the "main" (parent) chip, which has no fork id.
const MAIN_BRANCH = "main";

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// This branch's own size: total messages minus the history it inherited from the
// parent up to the fork point (fork_copied). Falls back to the raw count for
// legacy forks missing the cursor.
function branchSizeOf(fork: ForkChild): number {
  const total = fork.message_count ?? 0;
  if (typeof fork.fork_copied !== "number") return total;
  return Math.max(0, total - fork.fork_copied);
}

// Messages that arrived since you last left this branch. Baseline is your seen
// count (or the inherited history if you've never opened it), so a never-opened
// branch reads as fully unread and a fully-read one reads as zero.
function unreadOf(fork: ForkChild, seenCount: number | undefined, isActive: boolean): number {
  if (isActive) return 0;
  const total = fork.message_count ?? 0;
  const floor = typeof fork.fork_copied === "number" ? fork.fork_copied : 0;
  const baseline = Math.max(seenCount ?? floor, floor);
  return Math.max(0, total - baseline);
}

const Spinner = () => (
  <svg className="w-3 h-3 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
);

// Branch/fork glyph: lucide "Split" (diverging arrows). Replaces the old
// git-branch icon (vertical stroke + node) per explicit request.
const BranchIcon = ({ className }: { className?: string }) => (
  <Split className={className} />
);

export function BranchSelector({
  forkChildren,
  activeBranchId,
  onSwitchBranch,
  loadingBranchId,
  mainMessageCount,
  onFork,
}: {
  forkChildren: ForkChild[];
  activeBranchId: string | null;
  onSwitchBranch: (convId: string | null) => void;
  loadingBranchId?: string | null;
  mainMessageCount?: number;
  onFork?: () => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const seenMessageCount = useInboxStore((s) => s._seenMessageCount);

  useEffect(() => {
    if (!hoveredId || hoveredId === MAIN_BRANCH) {
      setTooltipPos(null);
      return;
    }
    const btn = buttonRefs.current[hoveredId];
    if (btn) {
      const rect = btn.getBoundingClientRect();
      setTooltipPos({ top: rect.bottom + 4, left: rect.left });
    }
  }, [hoveredId]);

  const hoveredFork = hoveredId && hoveredId !== MAIN_BRANCH ? forkChildren.find(f => f._id === hoveredId) : null;
  const hoveredUnread = hoveredFork
    ? unreadOf(hoveredFork, seenMessageCount[hoveredFork._id], activeBranchId === hoveredFork._id)
    : 0;
  const hoveredBranchSize = hoveredFork ? branchSizeOf(hoveredFork) : 0;

  return (
    <div className="mt-3 ml-8 mr-4">
      <div className="flex items-center gap-1.5 mb-1.5">
        <BranchIcon className="w-3.5 h-3.5 text-sol-cyan" />
        <span className="text-[10px] text-sol-text-dim uppercase tracking-wider font-medium">
          {forkChildren.length} branch{forkChildren.length !== 1 ? "es" : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => onSwitchBranch(null)}
          onMouseEnter={() => setHoveredId(MAIN_BRANCH)}
          onMouseLeave={() => setHoveredId(null)}
          className={`text-xs px-2.5 py-1 rounded border transition-all flex items-center gap-1.5 ${
            !activeBranchId
              ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30 font-medium"
              : hoveredId === MAIN_BRANCH
                ? "bg-sol-bg-alt text-sol-text-secondary border-sol-border"
                : "text-sol-text-dim border-sol-border/50 hover:border-sol-border"
          }`}
        >
          {loadingBranchId === MAIN_BRANCH && <Spinner />}
          <span>main</span>
          {mainMessageCount != null && mainMessageCount > 0 && (
            <span className={`text-[10px] tabular-nums ${!activeBranchId ? "text-sol-cyan/70" : "text-sol-text-dim"}`}>
              +{mainMessageCount}
            </span>
          )}
        </button>

        {forkChildren.map((fork) => {
          const isActive = activeBranchId === fork._id;
          const isLoading = loadingBranchId === fork._id;
          const label = fork.title || fork.short_id || "fork";
          const isHovered = hoveredId === fork._id;
          const branchSize = branchSizeOf(fork);
          const unread = unreadOf(fork, seenMessageCount[fork._id], isActive);
          // All-new (never opened): tint the size itself. Partially-read: keep a
          // muted size and add a "+N" unread pill so both numbers stay legible.
          const allUnread = unread > 0 && unread >= branchSize;
          const partialUnread = unread > 0 && unread < branchSize;

          return (
            <div key={fork._id} className="relative">
              <button
                ref={(el) => { buttonRefs.current[fork._id] = el; }}
                onClick={() => onSwitchBranch(fork._id)}
                onMouseEnter={() => setHoveredId(fork._id)}
                onMouseLeave={() => setHoveredId(null)}
                className={`text-xs px-2.5 py-1 rounded border transition-all flex items-center gap-1.5 max-w-[240px] ${
                  isActive
                    ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30 font-medium"
                    : isHovered
                      ? "bg-sol-bg-alt text-sol-text-secondary border-sol-border"
                      : "text-sol-text-dim border-sol-border/50 hover:border-sol-border"
                }`}
              >
                {isLoading && <Spinner />}
                {!isLoading && unread > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan flex-shrink-0" aria-hidden />
                )}
                <span className="truncate">{label}</span>
                {branchSize > 0 && (
                  <span
                    className={`text-[10px] tabular-nums flex-shrink-0 inline-flex items-center gap-0.5 ${
                      allUnread
                        ? "text-sol-cyan font-semibold"
                        : isActive ? "text-sol-cyan/70" : "text-sol-text-dim"
                    }`}
                    title={`${branchSize} message${branchSize === 1 ? "" : "s"} in this branch since the fork`}
                  >
                    <BranchIcon className="w-2.5 h-2.5 opacity-70" />
                    {branchSize}
                  </span>
                )}
                {partialUnread && (
                  <span className="text-[10px] tabular-nums flex-shrink-0 px-1 rounded-full bg-sol-cyan text-sol-bg font-semibold leading-tight">
                    +{unread}
                  </span>
                )}
              </button>
            </div>
          );
        })}

        {onFork && (
          <button
            onClick={onFork}
            className="text-xs px-2.5 py-1 rounded border border-dashed border-sol-border/60 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/50 hover:bg-sol-cyan/10 transition-all flex items-center gap-1.5"
            title="Fork the conversation from this message"
          >
            <BranchIcon className="w-3 h-3" />
            <span>Fork here</span>
          </button>
        )}
      </div>

      {hoveredFork && tooltipPos && createPortal(
        <div
          className="fixed z-[9999] px-3 py-2 rounded-lg bg-sol-bg border border-sol-border shadow-xl text-[11px] text-sol-text-secondary pointer-events-none ring-1 ring-black/5 max-w-[300px]"
          style={{ top: tooltipPos.top, left: tooltipPos.left }}
        >
          <div className="font-medium text-sol-text truncate">{hoveredFork.title || "Untitled fork"}</div>
          <div className="flex items-center gap-1.5 mt-1 text-sol-text-dim flex-wrap">
            {hoveredFork.username && <span>{hoveredFork.username}</span>}
            {hoveredFork.updated_at && (
              <>
                <span className="text-sol-border">·</span>
                <span>{relativeTime(hoveredFork.updated_at)}</span>
              </>
            )}
            {hoveredFork.status === "active" && (
              <>
                <span className="text-sol-border">·</span>
                <span className="text-sol-green">active</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-sol-text-dim flex-wrap">
            {hoveredFork.agent_type && <span className="text-sol-cyan">{hoveredFork.agent_type}</span>}
            <span className="text-sol-border">·</span>
            <span>
              <span className="text-sol-text-secondary tabular-nums">{hoveredBranchSize}</span> in branch
            </span>
            {hoveredUnread > 0 && (
              <>
                <span className="text-sol-border">·</span>
                <span className="text-sol-cyan tabular-nums">{hoveredUnread} unread</span>
              </>
            )}
            {hoveredFork.message_count != null && (
              <>
                <span className="text-sol-border">·</span>
                <span className="opacity-70 tabular-nums">{hoveredFork.message_count} total</span>
              </>
            )}
          </div>
          {hoveredFork.last_message_preview && (
            <div className="mt-1.5 pt-1.5 border-t border-sol-border/50 text-sol-text-dim line-clamp-2 whitespace-normal">
              {hoveredFork.last_message_role === "user" && <span className="text-sol-text-dim/70">You: </span>}
              {hoveredFork.last_message_preview}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
