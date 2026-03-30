import { useState } from "react";

type ForkChild = {
  _id: string;
  title: string;
  short_id?: string;
  started_at?: number;
  username?: string;
  parent_message_uuid?: string;
  message_count?: number;
  agent_type?: string;
};

function relativeTime(ts: number): string {
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

export function BranchSelector({
  forkChildren,
  activeBranchId,
  onSwitchBranch,
  loadingBranchId,
  mainMessageCount,
}: {
  forkChildren: ForkChild[];
  activeBranchId: string | null;
  onSwitchBranch: (convId: string | null) => void;
  loadingBranchId?: string | null;
  mainMessageCount?: number;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="mt-3 ml-8 mr-4">
      <div className="flex items-center gap-1.5 mb-1.5">
        <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12M6 15a3 3 0 103 3V6a3 3 0 10-3-3m12 12a3 3 0 10-3-3V6" />
        </svg>
        <span className="text-[10px] text-sol-text-dim uppercase tracking-wider font-medium">
          {forkChildren.length} branch{forkChildren.length !== 1 ? "es" : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => onSwitchBranch(null)}
          onMouseEnter={() => setHoveredId("main")}
          onMouseLeave={() => setHoveredId(null)}
          className={`text-xs px-2.5 py-1 rounded border transition-all flex items-center gap-1.5 ${
            !activeBranchId
              ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30 font-medium"
              : hoveredId === "main"
                ? "bg-sol-bg-alt text-sol-text-secondary border-sol-border"
                : "text-sol-text-dim border-sol-border/50 hover:border-sol-border"
          }`}
        >
          <span>main</span>
          {mainMessageCount != null && (
            <span className={`text-[10px] tabular-nums ${!activeBranchId ? "text-sol-cyan/70" : "text-sol-text-dim"}`}>
              {mainMessageCount} msgs
            </span>
          )}
        </button>

        {forkChildren.map((fork) => {
          const isActive = activeBranchId === fork._id;
          const isLoading = loadingBranchId === fork._id;
          const label = fork.title || fork.short_id || "fork";
          const isHovered = hoveredId === fork._id;

          return (
            <div key={fork._id} className="relative group">
              <button
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
                {isLoading && (
                  <svg className="w-3 h-3 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                )}
                <span className="truncate">{label}</span>
                {fork.message_count != null && (
                  <span className={`text-[10px] tabular-nums flex-shrink-0 ${isActive ? "text-sol-cyan/70" : "text-sol-text-dim"}`}>
                    {fork.message_count} msgs
                  </span>
                )}
              </button>

              {isHovered && (
                <div className="absolute left-0 top-full mt-1 z-50 px-3 py-2 rounded-lg bg-sol-bg-highlight border border-sol-border shadow-xl text-[11px] text-sol-text-secondary whitespace-nowrap pointer-events-none ring-1 ring-black/5">
                  <div className="font-medium text-sol-text truncate max-w-[240px]">{fork.title || "Untitled fork"}</div>
                  <div className="flex items-center gap-2 mt-1 text-sol-text-dim">
                    {fork.username && <span>{fork.username}</span>}
                    {fork.username && fork.started_at && <span className="text-sol-border">·</span>}
                    {fork.started_at && <span>{relativeTime(fork.started_at)}</span>}
                  </div>
                  {(fork.message_count != null || fork.agent_type) && (
                    <div className="flex items-center gap-2 mt-1 text-sol-text-dim">
                      {fork.agent_type && <span className="text-sol-cyan">{fork.agent_type}</span>}
                      {fork.agent_type && fork.message_count != null && <span className="text-sol-border">·</span>}
                      {fork.message_count != null && <span>{fork.message_count} messages</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
