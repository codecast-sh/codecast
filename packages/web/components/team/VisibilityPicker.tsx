import { useRef } from "react";
import { VISIBILITY_LEVELS, type TeamVisibility } from "../../lib/team/visibilityLevels";
import { moveRadioIndex } from "./radioNav";
import "./teamFlow.css";

export type { TeamVisibility };

/** Controlled list of visibility cards. The parent owns the value.
 *  The level data lives in lib/team/visibilityLevels (single definition).
 *  A real radio group: one tab stop, arrows move and select. Selection
 *  follows --team-flow-accent inside the create flow and falls back to
 *  cyan elsewhere (see .tf-accent-scope in teamFlow.css). */
export function VisibilityPicker({
  value,
  onChange,
  className = "",
}: {
  value: TeamVisibility;
  onChange: (value: TeamVisibility) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: React.KeyboardEvent, index: number) => {
    const next = moveRadioIndex(e.key, index, VISIBILITY_LEVELS.length, 1);
    if (next == null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(VISIBILITY_LEVELS[next].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label="What teammates see"
      className={`tf-accent-scope space-y-2.5 ${className}`}
    >
      {VISIBILITY_LEVELS.map((level, i) => {
        const selected = value === level.value;
        const Icon = level.Icon;
        return (
          <button
            key={level.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(level.value)}
            data-selected={selected}
            className={`tf-option w-full rounded-xl border px-5 py-4 text-left relative outline-none motion-safe:active:scale-[0.99] ${
              selected ? "" : "border-sol-border hover:border-sol-text-muted hover:bg-sol-bg-alt/40"
            }`}
          >
            {level.recommended && (
              <span className="tf-accent-text absolute top-3 right-4 text-[10px] uppercase tracking-wider font-semibold">
                Recommended
              </span>
            )}
            <div className="flex items-start gap-4">
              <div
                className={`tf-chip mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                  selected ? "" : "bg-sol-bg-alt text-sol-text-dim"
                }`}
              >
                <Icon className="w-5 h-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-sol-text">
                  {level.label}
                </div>
                <div className="mt-0.5 text-sm text-sol-text-muted">
                  {level.description}
                </div>
                <div className="mt-2 text-xs text-sol-text-dim leading-relaxed">
                  {level.detail}
                </div>
                <div className="mt-2 rounded-md bg-sol-bg-alt/60 border border-sol-border/50 px-3 py-1.5 text-xs text-sol-text-muted font-mono">
                  {level.preview}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
