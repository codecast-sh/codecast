import { useState, useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { ChevronDown, Check } from "lucide-react";

export function FilterDropdown({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  options: { key: string; label: string; icon?: any; color?: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = options.find((o) => o.key === value);

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border transition-colors ${
          value
            ? "border-sol-cyan/30 text-sol-cyan bg-sol-cyan/5"
            : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
        }`}
      >
        {icon}
        <span>{active && value ? active.label : label}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-44 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] py-1 max-h-64 overflow-y-auto">
          {options.map((opt) => {
            const OptIcon = opt.icon;
            return (
              <button
                key={opt.key}
                onClick={() => { onChange(opt.key); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  opt.key === value ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                }`}
              >
                {OptIcon && <OptIcon className={`w-3.5 h-3.5 ${opt.color || ""}`} />}
                <span className="flex-1 text-left">{opt.label}</span>
                {opt.key === value && <Check className="w-3 h-3 text-sol-cyan" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
