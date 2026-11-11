import { useState } from "react";
import { Brain, Radar, Terminal } from "lucide-react";
import { formatFullTimestamp, formatRelativeTime } from "../../../lib/conversationFormat";

// Rows that record something that happened, in the Modern style's one row
// anatomy (ModernRow.tsx names the parts, app/globals.css "MODERN · ROWS"
// draws them): a 16px glyph, a verb, the object, a quiet result at the right
// and a chevron when the row opens onto a tinted panel. The Classic blocks
// branch here only under useIsModernStyle, so Classic draws what it drew.

/** The head of a row that opens: a real button, its chevron from aria-expanded. */
function OpenableHead({ open, onToggle, children }: { open: boolean; onToggle?: () => void; children: React.ReactNode }) {
  if (!onToggle) return <div data-cc-row-head>{children}</div>;
  return (
    <button type="button" data-cc-row-head aria-expanded={open} onClick={onToggle} className="w-full text-left">
      {children}
    </button>
  );
}

/** The agent's reasoning: one quiet line (its first words), the rest a click away. */
export function ModernThinking({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const lines = content.split("\n");
  const first = lines.find((l) => l.trim())?.trim() ?? "";
  const long = lines.length > 1 || content.length > 120;
  return (
    <div data-cc-row="thinking">
      <OpenableHead open={open} onToggle={long ? () => setOpen((v) => !v) : undefined}>
        <Brain data-cc-row-icon aria-hidden className="w-4 h-4 shrink-0" strokeWidth={1.75} />
        <span data-cc-row-verb>Thought</span>
        {!open && <span data-cc-row-text>{first}</span>}
      </OpenableHead>
      {open && (
        <div data-cc-row-detail className="px-3.5 py-2.5 text-ui leading-5 text-sol-text-muted whitespace-pre-wrap break-words">
          {content}
        </div>
      )}
    </div>
  );
}

/**
 * A Monitor watch or a background command: what it runs, how it stands
 * ("running", "done", "exit 1"), how many events it reported. The status is a
 * word, never a pulse: a row draws no animation. Open, the panel holds the
 * whole command and the last event.
 */
export function ModernMonitorRow({ background, description, command, status, tone, events, lastEvent, lastEventAt, persistent, title }: {
  background: boolean;
  description?: string;
  command?: string;
  status: string;
  tone: "live" | "error" | "quiet";
  events: number;
  lastEvent?: string;
  lastEventAt?: number;
  persistent?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const firstLine = (command ?? "").split("\n").find((l) => l.trim()) ?? "";
  const Icon = background ? Terminal : Radar;
  const openable = !!command || !!lastEvent;
  return (
    <div data-cc-row="monitor" data-cc-row-tone={tone === "error" ? "error" : undefined}>
      <OpenableHead open={open} onToggle={openable ? () => setOpen((v) => !v) : undefined}>
        <Icon data-cc-row-icon aria-hidden className="w-4 h-4 shrink-0" strokeWidth={1.75} />
        <span data-cc-row-verb>{background ? "Background" : "Monitor"}</span>
        {description ? <span data-cc-row-text>{description}</span> : firstLine ? <span data-cc-row-object className="font-mono">{firstLine}</span> : null}
        {persistent && <span data-cc-row-tag>persistent</span>}
        <span data-cc-row-meta title={title}>
          {events > 0 && `${events} event${events === 1 ? "" : "s"} · `}
          <span className={tone === "live" ? "text-sol-green" : tone === "error" ? "text-sol-red" : undefined}>{status}</span>
        </span>
      </OpenableHead>
      {open && (
        <div data-cc-row-detail className="px-3.5 py-2.5 space-y-2">
          {command && <pre className="font-mono text-meta leading-5 text-sol-text-secondary whitespace-pre-wrap break-words">{command}</pre>}
          {lastEvent && (
            <div className="flex items-baseline gap-2 min-w-0 text-meta">
              <span className="min-w-0 flex-1 font-mono text-sol-text-muted break-words">{lastEvent}</span>
              {lastEventAt !== undefined && (
                <span className="shrink-0 tabular-nums text-sol-text-dim" title={formatFullTimestamp(lastEventAt)}>{formatRelativeTime(lastEventAt)}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
