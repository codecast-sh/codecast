import { VISIBILITY_LEVELS, type TeamVisibility } from "../../lib/team/visibilityLevels";

export type { TeamVisibility };

/** Controlled list of visibility cards. The parent owns the value.
 *  The level data lives in lib/team/visibilityLevels (single definition). */
export function VisibilityPicker({
  value,
  onChange,
  className = "",
}: {
  value: TeamVisibility;
  onChange: (value: TeamVisibility) => void;
  className?: string;
}) {
  return (
    <div className={`space-y-2.5 ${className}`}>
      {VISIBILITY_LEVELS.map((level) => {
        const selected = value === level.value;
        const Icon = level.Icon;
        return (
          <button
            key={level.value}
            type="button"
            onClick={() => onChange(level.value)}
            className={`w-full rounded-xl border px-5 py-4 text-left transition-all relative ${
              selected
                ? "border-sol-cyan bg-sol-cyan/[0.06] ring-1 ring-sol-cyan/30"
                : "border-sol-border hover:border-sol-base01 hover:bg-sol-bg-alt/40"
            }`}
          >
            {level.recommended && (
              <span className="absolute top-3 right-4 text-[10px] uppercase tracking-wider font-semibold text-sol-cyan">
                Recommended
              </span>
            )}
            <div className="flex items-start gap-4">
              <div
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                  selected
                    ? "bg-sol-cyan/15 text-sol-cyan"
                    : "bg-sol-bg-alt text-sol-base01"
                }`}
              >
                <Icon className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-sol-text">
                  {level.label}
                </div>
                <div className="mt-0.5 text-sm text-sol-base1">
                  {level.description}
                </div>
                <div className="mt-2 text-xs text-sol-text-dim leading-relaxed">
                  {level.detail}
                </div>
                <div className="mt-2 rounded-md bg-sol-bg-alt/60 border border-sol-border/50 px-3 py-1.5 text-xs text-sol-base1 font-mono">
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
