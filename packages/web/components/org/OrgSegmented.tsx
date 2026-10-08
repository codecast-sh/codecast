"use client";
// The Org screen's one segmented control: Read | Map over the company, and
// Conversation | Company when the screen stacks. A thin tray, the picked
// segment filled; a segment can carry a violet count (what waits on you).
import { cn } from "../../lib/utils";

export type OrgSegment<K extends string> = { key: K; label: string; title?: string; count?: number };

export function OrgSegmented<K extends string>({ value, onChange, items, label, data, className }: {
  value: K;
  onChange: (key: K) => void;
  items: readonly OrgSegment<K>[];
  /** The tablist's accessible name. */
  label: string;
  /** Names the data attributes: `data-<data>` on the tray carries the value, `data-<data>-pick` each segment's key. */
  data: string;
  className?: string;
}) {
  return (
    <div
      className={cn("inline-flex shrink-0 gap-[2px] rounded-[7px] border p-[2px]", className)}
      style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)" }}
      role="tablist"
      aria-label={label}
      {...{ [`data-${data}`]: value }}
    >
      {items.map((it) => {
        const on = value === it.key;
        return (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={on}
            title={it.title}
            onClick={() => onChange(it.key)}
            className={cn("inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-[2px] text-[12px] transition-colors", on ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/50")}
            style={{ color: on ? "var(--sol-text)" : "var(--sol-text-muted)" }}
            {...{ [`data-${data}-pick`]: it.key }}
          >
            {it.label}
            {!!it.count && (
              <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>{it.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
