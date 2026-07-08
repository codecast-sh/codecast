import { useState, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useWatchEffect } from "../hooks/useWatchEffect";

/** A compact segmented pill group — the bordered "All / 👤 / 🤖" style control
 *  shared across list headers (source filters, the List/Board view switch, etc.).
 *  One source of truth for the container, selected/hover states, and the divider
 *  between segments, so every instance stays visually identical.
 *
 *  Each item renders its `icon` and/or `label` (icon-only, label-only, or both).
 *  `fullWidth` makes the segments share the row equally (e.g. inside a popover).
 *  `collapse` folds the segments into a single dropdown at tight header widths
 *  (≤620px, see .cq-seg-compact) so the toolbar stays one row. */
export interface SegmentedItem {
  key: string;
  label?: string;
  icon?: any;
  title?: string;
}

export function SegmentedToggle({
  value,
  onChange,
  items,
  fullWidth,
  collapse,
}: {
  value: string;
  onChange: (key: string) => void;
  items: SegmentedItem[];
  fullWidth?: boolean;
  collapse?: boolean;
}) {
  const segments = (
    <div className={`flex items-center h-7 rounded-md border border-sol-border/40 overflow-hidden ${collapse ? "cq-seg-full" : ""} ${fullWidth ? "w-full" : ""}`}>
      {items.map((it, i) => {
        const Icon = it.icon;
        const selected = value === it.key;
        return (
          <button
            key={it.key}
            onClick={() => onChange(it.key)}
            title={it.title}
            className={`h-full flex items-center justify-center gap-1.5 px-2.5 text-xs transition-colors ${
              fullWidth ? "flex-1" : ""
            } ${i > 0 ? "border-l border-sol-border/40" : ""} ${
              selected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
            }`}
          >
            {Icon && <Icon className="w-3.5 h-3.5" />}
            {it.label && <span>{it.label}</span>}
          </button>
        );
      })}
    </div>
  );

  if (!collapse) return segments;

  return (
    <>
      {segments}
      <SegmentedDropdown value={value} onChange={onChange} items={items} />
    </>
  );
}

/** Single-button stand-in for the segmented group, shown when the header is too
 *  tight to keep every segment on one row (see .cq-seg-compact). Surfaces the
 *  active option (its icon and/or label) and drops the full set into a popover —
 *  same pattern as the status-tab dropdown in GenericListView. */
function SegmentedDropdown({
  value,
  onChange,
  items,
}: {
  value: string;
  onChange: (key: string) => void;
  items: SegmentedItem[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = items.find((it) => it.key === value) ?? items[0];

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const ActiveIcon = active?.icon;
  return (
    <div ref={ref} className="cq-seg-compact relative flex-shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2 rounded-md border border-sol-border/40 text-xs text-sol-text hover:border-sol-border transition-colors"
        title={active?.title || active?.label}
      >
        {ActiveIcon && <ActiveIcon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-muted" />}
        {active?.label && <span className="font-medium whitespace-nowrap">{active.label}</span>}
        <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0 cq-caret" />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 w-44 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] py-1">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.key}
                onClick={() => { onChange(it.key); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                  it.key === value ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                }`}
              >
                {Icon && <Icon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />}
                <span className="flex-1">{it.label || it.title}</span>
                {it.key === value && <Check className="w-3 h-3 text-sol-cyan flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
