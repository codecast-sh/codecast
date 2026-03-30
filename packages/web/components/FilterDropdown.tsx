import { useState, useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { ChevronDown, Check } from "lucide-react";

export function FilterDropdown({
  label,
  icon,
  value,
  options,
  onChange,
  multi,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  options: { key: string; label: string; icon?: any; color?: string }[];
  onChange: (v: string) => void;
  multi?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = multi ? new Set(value ? value.split(",") : []) : null;
  const active = multi ? null : options.find((o) => o.key === value);

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleClick = (key: string) => {
    if (!multi) { onChange(key); setOpen(false); return; }
    if (key === "") { onChange(""); return; }
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange([...next].join(","));
  };

  const isSelected = (key: string) => multi ? selected!.has(key) : key === value;
  const hasValue = multi ? selected!.size > 0 : !!value;
  const buttonLabel = multi && selected!.size > 0
    ? `${label} (${selected!.size})`
    : active && value ? active.label : label;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border transition-colors ${
          hasValue
            ? "border-sol-cyan/30 text-sol-cyan bg-sol-cyan/5"
            : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
        }`}
      >
        {icon}
        <span>{buttonLabel}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-44 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] py-1 max-h-64 overflow-y-auto">
          {options.map((opt) => {
            const OptIcon = opt.icon;
            const sel = opt.key === "" ? !hasValue : isSelected(opt.key);
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
        </div>
      )}
    </div>
  );
}
