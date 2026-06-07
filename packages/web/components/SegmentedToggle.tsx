/** A compact segmented pill group — the bordered "All / 👤 / 🤖" style control
 *  shared across list headers (source filters, the List/Board view switch, etc.).
 *  One source of truth for the container, selected/hover states, and the divider
 *  between segments, so every instance stays visually identical.
 *
 *  Each item renders its `icon` and/or `label` (icon-only, label-only, or both).
 *  `fullWidth` makes the segments share the row equally (e.g. inside a popover). */
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
}: {
  value: string;
  onChange: (key: string) => void;
  items: SegmentedItem[];
  fullWidth?: boolean;
}) {
  return (
    <div className={`flex items-center h-7 rounded-md border border-sol-border/40 overflow-hidden ${fullWidth ? "w-full" : ""}`}>
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
}
