import { useState, useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { ChevronDown, Check, X } from "lucide-react";

type FilterOption = { key: string; label: string; icon?: any; color?: string };

/** The option-button list, shared by the inline FilterDropdown popover and the
 *  "+ Filter" add-menu in GenericListView. Single-select picks-and-closes via
 *  onPicked; multi toggles in place and keeps the menu open. */
export function FilterOptionList({
  options,
  value,
  multi,
  onChange,
  onPicked,
}: {
  options: FilterOption[];
  value: string;
  multi?: boolean;
  onChange: (v: string) => void;
  onPicked?: () => void;
}) {
  const selected = multi ? new Set(value ? value.split(",") : []) : null;
  const hasValue = multi ? selected!.size > 0 : !!value;
  const isSelected = (key: string) =>
    key === "" ? !hasValue : multi ? selected!.has(key) : key === value;

  const handleClick = (key: string) => {
    if (!multi) { onChange(key); onPicked?.(); return; }
    if (key === "") { onChange(""); return; }
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange([...next].join(","));
  };

  return (
    <>
      {options.map((opt) => {
        const OptIcon = opt.icon;
        const sel = isSelected(opt.key);
        return (
          <button
            key={opt.key}
            onClick={() => handleClick(opt.key)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
              sel ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
            }`}
          >
            {OptIcon && <OptIcon className={`w-3.5 h-3.5 ${opt.color || ""}`} />}
            <span className="flex-1 text-left">{opt.label}</span>
            {sel && <Check className="w-3 h-3 text-sol-cyan" />}
          </button>
        );
      })}
    </>
  );
}

export function FilterDropdown({
  label,
  icon,
  value,
  options,
  onChange,
  multi,
  chip,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  options: FilterOption[];
  onChange: (v: string) => void;
  multi?: boolean;
  /** Chip mode: render as a removable "icon value ✕" chip when active, and
   *  nothing when empty (empty filters are added via the "+ Filter" menu). */
  chip?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = multi ? new Set(value ? value.split(",") : []) : null;
  const active = multi ? null : options.find((o) => o.key === value);
  const hasValue = multi ? selected!.size > 0 : !!value;

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Chip mode shows only once a value is set; empty filters live in the add-menu.
  if (chip && !hasValue) return null;

  const buttonLabel = multi && selected!.size > 0
    ? `${label} (${selected!.size})`
    : active && value ? active.label : label;

  const optionsPopover = open && (
    <div className="absolute top-full left-0 mt-1 w-44 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] py-1 max-h-64 overflow-y-auto">
      <FilterOptionList options={options} value={value} multi={multi} onChange={onChange} onPicked={() => setOpen(false)} />
    </div>
  );

  if (chip) {
    return (
      <div ref={ref} className="relative">
        <div className="flex items-center h-7 rounded-md border border-sol-cyan/30 bg-sol-cyan/5 text-sol-cyan text-xs">
          <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 pl-1.5 pr-1 h-full" title={`Edit ${label}`}>
            {icon}
            <span className="whitespace-nowrap">{buttonLabel}</span>
          </button>
          <button onClick={() => onChange("")} className="flex items-center pr-1.5 pl-0.5 h-full hover:text-sol-text transition-colors" title={`Remove ${label} filter`}>
            <X className="w-3 h-3 opacity-70" />
          </button>
        </div>
        {optionsPopover}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 text-xs h-7 px-1.5 rounded-md border transition-colors ${
          hasValue
            ? "border-sol-cyan/30 text-sol-cyan bg-sol-cyan/5"
            : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
        }`}
      >
        {icon}
        <span className="whitespace-nowrap">{buttonLabel}</span>
        <ChevronDown className="w-3 h-3 opacity-60 -ml-0.5 flex-shrink-0" />
      </button>
      {optionsPopover}
    </div>
  );
}
