// Small pieces every Memory view draws the same way.

import type { ReactNode } from "react";
import type { MemoryIndexBudget, MemoryNote } from "@codecast/shared/memory";
import { REACH, TYPE_TONE, formatBytes, toneCss, typeKey } from "./memoryView";

/** An inline link to a memory, tinted by its type; a broken one is wavy. */
export function MemoryLinkChip({ note, children, onOpen }: { note: MemoryNote | undefined; children: ReactNode; onOpen: (file: string) => void }) {
  if (!note) {
    return (
      <span className="underline decoration-wavy decoration-sol-red/70 underline-offset-2 text-sol-text-muted" title="No memory by this name">
        {children}
      </span>
    );
  }
  const color = toneCss(TYPE_TONE[typeKey(note.type)]);
  return (
    // A span, not a button: Chrome lays a button out as inline-block even with
    // display:inline, so a long link jumps to its own line instead of wrapping.
    <span
      role="link"
      tabIndex={0}
      onClick={() => onOpen(note.file)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(note.file)}
      title={note.file}
      className="cursor-pointer text-sol-text underline underline-offset-2 rounded-sm hover:bg-sol-bg-highlight transition-colors [box-decoration-break:clone]"
      style={{ textDecorationColor: `color-mix(in srgb, ${color} 70%, transparent)` }}
    >
      {children}
    </span>
  );
}

export function ReachBadge({ reach }: { reach: MemoryNote["reach"] }) {
  const { label, why, tone } = REACH[reach];
  const color = toneCss(tone);
  return (
    <span
      title={why}
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[11px] whitespace-nowrap"
      style={{ borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, color }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

export function TypeBadge({ type }: { type: string }) {
  const color = toneCss(TYPE_TONE[typeKey(type)]);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-muted whitespace-nowrap">
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {type}
    </span>
  );
}

/** MEMORY.md against its load budget: how full, and how much never loads. */
export function BudgetMeter({ budget, className = "" }: { budget: MemoryIndexBudget; className?: string }) {
  const over = budget.cutAt !== null;
  const scale = Math.max(budget.bytes, budget.maxBytes);
  const lost = over ? budget.lines - budget.cutAt! + 1 : 0;
  return (
    <div className={`text-[11px] ${className}`}>
      <div className="flex justify-between gap-2 whitespace-nowrap text-sol-text-dim">
        <span>MEMORY.md</span>
        <span className={over ? "text-sol-red" : "text-sol-text-muted"}>
          {formatBytes(budget.bytes)} / {formatBytes(budget.maxBytes)}
        </span>
      </div>
      <div className="relative h-1.5 my-1 rounded-full bg-sol-bg-highlight overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-sol-text-muted/70" style={{ width: `${(Math.min(budget.bytes, budget.maxBytes) / scale) * 100}%` }} />
        {over && (
          <div
            className="absolute inset-y-0 right-0"
            style={{
              width: `${((budget.bytes - budget.maxBytes) / scale) * 100}%`,
              background: "repeating-linear-gradient(-45deg, var(--sol-red) 0 2px, transparent 2px 4px)",
            }}
          />
        )}
      </div>
      <div className="flex justify-between gap-2 whitespace-nowrap text-sol-text-dim">
        <span>{budget.lines} lines</span>
        <span className={over ? "text-sol-red" : ""}>{over ? `${lost} line${lost === 1 ? "" : "s"} never load` : `${formatBytes(budget.maxBytes - budget.bytes)} left`}</span>
      </div>
    </div>
  );
}
