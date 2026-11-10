import { memo } from "react";
import { ChevronDown } from "lucide-react";
import { LogoIcon } from "../../Logo";
import { formatRunDuration } from "../../../lib/workflowRun";

// Compact feed: a whole collapsed assistant turn shown as one line — Claude
// glyph, the first sentence of the reply, how long the agent worked (prompt to
// last reply) and a count of what's inside. Click
// anywhere to expand the turn to full.
export const CompactTurnCard = memo(function CompactTurnCard({ preview, messageCount, toolCount, workedMs = 0, onExpand }: { preview: string; messageCount: number; toolCount: number; workedMs?: number; onExpand: () => void }) {
  const bits: string[] = [];
  if (workedMs >= 1000) bits.push(`Worked ${formatRunDuration(0, workedMs)}`);
  if (messageCount > 1) bits.push(`${messageCount} messages`);
  if (toolCount > 0) bits.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
  return (
    <button
      data-cc-compact-turn
      onClick={onExpand}
      className="group/turn not-prose w-full flex items-center gap-2.5 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 hover:bg-sol-bg-alt/70 hover:border-sol-cyan/40 pl-2.5 pr-3 py-2 text-left transition-colors"
      title="Expand this turn"
    >
      <LogoIcon size={15} className="shrink-0 opacity-80" />
      <span className="flex-1 min-w-0 truncate text-[13px] text-sol-text-secondary">{preview || "Worked on the task"}</span>
      {bits.length > 0 && <span className="shrink-0 text-meta text-sol-text-dim/70 tabular-nums">{bits.join(" · ")}</span>}
      <ChevronDown className="w-3.5 h-3.5 shrink-0 text-sol-text-dim/60 group-hover/turn:text-sol-cyan transition-colors" />
    </button>
  );
});
