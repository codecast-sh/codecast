// Unified comment/entry timeline shared by docs and plans — the `entries`
// array agents append from the CLI (progress/decision/discovery/reference/
// blocker/note). Newest first, one glyph per entry type. Extracted from the
// near-identical blocks in app/plans/[id]/page.tsx and PlanDetailPanel (whose
// sol-accent-* classes were undefined tokens, so its glyphs rendered unstyled).
import { Clock } from "lucide-react";

export type TimelineEntry = {
  type?: string;
  timestamp: number;
  content: string;
  rationale?: string;
  path_or_url?: string;
};

const TYPE_STYLES: Record<string, string> = {
  progress: "text-sol-blue",
  decision: "text-sol-yellow",
  discovery: "text-sol-green",
  reference: "text-sol-cyan",
  blocker: "text-sol-red",
  note: "text-sol-text-dim",
};

const TYPE_ICONS: Record<string, string> = {
  progress: "↳",
  decision: "◆",
  discovery: "★",
  reference: "→",
  blocker: "!",
  note: "·",
};

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EntryTimeline({
  entries,
  className = "mb-6",
}: {
  entries?: TimelineEntry[] | null;
  className?: string;
}) {
  if (!entries?.length) return null;
  return (
    <div className={className}>
      <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
        <Clock className="w-4 h-4 text-sol-text-dim" />
        Comments ({entries.length})
      </h2>
      <div className="space-y-2">
        {[...entries].reverse().map((entry, i) => (
          <div key={i} className="flex items-start gap-2 text-sm">
            <span className={`text-xs mt-0.5 ${TYPE_STYLES[entry.type ?? "note"] || TYPE_STYLES.note}`}>
              {TYPE_ICONS[entry.type ?? "note"] || "·"}
            </span>
            <span className="text-[11px] text-sol-text-dim tabular-nums whitespace-nowrap mt-0.5">
              {formatTimestamp(entry.timestamp)}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-sol-text-muted">{entry.content}</span>
              {entry.rationale && (
                <p className="text-xs text-sol-text-dim mt-0.5">{entry.rationale}</p>
              )}
              {entry.path_or_url && (
                <p className="text-xs text-sol-text-dim font-mono mt-0.5">→ {entry.path_or_url}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
