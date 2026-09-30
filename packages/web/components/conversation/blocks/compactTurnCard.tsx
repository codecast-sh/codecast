import { memo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { LogoIcon } from "../../Logo";

// Compact feed: a whole collapsed assistant turn shown as one line — Claude
// glyph, the first sentence of the reply, and a count of what's inside. Click
// anywhere to expand the turn to full.
// `steps`: the turn's reply is shown right below, so the card is only the
// work before it: a slim toggle, no preview that would read as a second reply.
export const CompactTurnCard = memo(function CompactTurnCard({ preview, messageCount, toolCount, onExpand, variant = "card" }: { preview: string; messageCount: number; toolCount: number; onExpand: () => void; variant?: "card" | "steps" }) {
  const bits: string[] = [];
  if (variant === "steps") {
    if (messageCount > 1) bits.push(`${messageCount - 1} earlier ${messageCount - 1 === 1 ? "message" : "messages"}`);
  } else if (messageCount > 1) bits.push(`${messageCount} messages`);
  if (toolCount > 0) bits.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
  if (variant === "steps") {
    return (
      <button
        data-cc-compact-turn="steps"
        onClick={onExpand}
        className="group/turn not-prose mb-1.5 inline-flex items-center gap-1 rounded-md border border-dashed border-sol-border/70 px-2 py-0.5 text-[11px] text-sol-text-dim tabular-nums hover:border-sol-cyan/40 hover:text-sol-text-secondary transition-colors"
        title="Show the work before this reply"
      >
        <ChevronRight className="w-3 h-3 shrink-0 opacity-70 group-hover/turn:text-sol-cyan" />
        {bits.join(" · ")}
      </button>
    );
  }
  return (
    <button
      data-cc-compact-turn
      onClick={onExpand}
      className="group/turn not-prose w-full flex items-center gap-2.5 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 hover:bg-sol-bg-alt/70 hover:border-sol-cyan/40 pl-2.5 pr-3 py-2 text-left transition-colors"
      title="Expand this turn"
    >
      <LogoIcon size={15} className="shrink-0 opacity-80" />
      <span className="flex-1 min-w-0 truncate text-[13px] text-sol-text-secondary">{preview || "Worked on the task"}</span>
      {bits.length > 0 && <span className="shrink-0 text-[10.5px] text-sol-text-dim/70 tabular-nums">{bits.join(" · ")}</span>}
      <ChevronDown className="w-3.5 h-3.5 shrink-0 text-sol-text-dim/60 group-hover/turn:text-sol-cyan transition-colors" />
    </button>
  );
});
