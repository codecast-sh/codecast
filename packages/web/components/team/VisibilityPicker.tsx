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
  compact,
}: {
  value: TeamVisibility;
  onChange: (value: TeamVisibility) => void;
  className?: string;
  /** One row of four segments with the chosen level's line under it, for a
   *  step that carries other choices too (the setup flow's Sharing). */
  compact?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: React.KeyboardEvent, index: number) => {
    const next = moveRadioIndex(e.key, index, VISIBILITY_LEVELS.length, 1);
    if (next == null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(VISIBILITY_LEVELS[next].value);
  };

  if (compact) {
    const current = VISIBILITY_LEVELS.find((l) => l.value === value) ?? VISIBILITY_LEVELS[0];
    return (
      <div className={`tf-accent-scope ${className}`}>
        <div role="radiogroup" aria-label="What teammates see" className="grid grid-cols-4 gap-1 rounded-xl border border-sol-border p-1 max-sm:grid-cols-2">
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
                className={`tf-option flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs outline-none ${
                  selected ? "font-medium text-sol-text" : "border-transparent text-sol-text-dim hover:text-sol-text"
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {level.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 px-1 text-xs text-sol-text-dim">{current.description}</p>
      </div>
    );
  }

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
            className={`tf-option w-full rounded-xl border px-5 py-3 max-sm:px-4 text-left relative outline-none motion-safe:active:scale-[0.99] ${
              selected ? "" : "border-sol-border hover:border-sol-text-muted hover:bg-sol-bg-alt/40"
            }`}
          >
            {level.recommended && (
              <span className="tf-accent-text absolute top-3 right-4 text-mark uppercase tracking-wider font-semibold">
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
                {/* The detail line and the preview open only on the selected
                    card, so all four levels fit above the fold on short
                    viewports. Collapsed content is hidden from readers: the
                    label and description carry the choice. */}
                <div className="tf-collapse" data-open={selected} aria-hidden={!selected}>
                  <div className="min-h-0 overflow-hidden">
                    <div className="mt-2 text-xs text-sol-text-dim leading-relaxed">
                      {level.detail}
                    </div>
                    <div className="mt-2 mb-0.5 rounded-md bg-sol-bg-alt/60 border border-sol-border/50 px-3 py-1.5 text-xs text-sol-text-muted font-mono">
                      {level.preview}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
