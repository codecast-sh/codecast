"use client";
/**
 * The parts every activity timeline shares: day grouping, the vertical rail,
 * a row hung off it with an icon disc, and the way a task status reads. The
 * project Timeline tab and the task page's Activity section are both built
 * from these, so an event looks the same wherever it is told.
 */
import type { ReactNode } from "react";
import { Circle } from "lucide-react";
import { formatDateFull, relTimeShort } from "../../lib/utils";
import { STATUS_COLOR, STATUS_ICON } from "../../lib/timelineRail";

export function StatusWord({ status }: { status?: string }) {
  if (!status) return null;
  const Icon = STATUS_ICON[status];
  return (
    <span className={`inline-flex items-center gap-1 ${STATUS_COLOR[status] ?? "text-sol-text-muted"}`}>
      {Icon && <Icon className="w-3 h-3" />}
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** One day: its label, then the rail every event of that day hangs off. */
export function RailDay({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[11px] font-medium text-sol-text-dim uppercase tracking-wider px-1 pb-2">{label}</div>
      <div className="border-l border-sol-border/25 ml-2.5 space-y-0.5">{children}</div>
    </div>
  );
}

/**
 * One event on the rail. `clock` prints the time of day, which is what a row
 * needs once a day label already sits above it; the default is the short
 * relative age. Either way the full date is one hover away.
 */
export function RailRow({
  icon: Icon,
  color,
  ts,
  card = false,
  clock = false,
  children,
}: {
  icon: typeof Circle;
  color: string;
  ts: number;
  card?: boolean;
  clock?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative flex items-start gap-2.5 pl-4 py-1">
      <span
        className={`absolute -left-[9px] ${card ? "top-2" : "top-1.5"} w-[17px] h-[17px] rounded-full bg-sol-bg-alt border border-sol-border/30 flex items-center justify-center`}
      >
        <Icon className={`w-2.5 h-2.5 ${color}`} />
      </span>
      <div className={`flex-1 min-w-0 flex items-baseline gap-2 text-xs ${card ? "" : "leading-relaxed"}`}>{children}</div>
      <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0 pt-0.5" title={formatDateFull(ts)}>
        {clock ? new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : relTimeShort(ts)}
      </span>
    </div>
  );
}

/** A row that brings its own disc (ExternalEventRow): pulled onto the rail line. */
export function RailBare({ children }: { children: ReactNode }) {
  return <div className="relative -ml-[13px] py-0.5">{children}</div>;
}
