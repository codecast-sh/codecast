import { useCallback, useRef, useState } from "react";
import { TeamIcon, TEAM_ICONS, TEAM_COLORS, colorBgClassMap, type TeamIconName, type TeamColorName } from "../TeamIcon";
import { TeamCrest } from "./TeamCrest";
import { cn } from "../../lib/utils";

export interface TeamIdentity {
  icon: TeamIconName;
  color: TeamColorName;
}

interface TeamIdentityPickerProps {
  value: TeamIdentity;
  onChange: (next: TeamIdentity) => void;
  /** Team name for the live preview. When set, the preview renders the crest and name as the switcher and sidebar show them. */
  previewName?: string;
  disabled?: boolean;
  className?: string;
}

const ICON_COLUMNS = 6;

function moveIndex(key: string, index: number, length: number, columns: number): number | null {
  switch (key) {
    case "ArrowRight": return (index + 1) % length;
    case "ArrowLeft": return (index - 1 + length) % length;
    case "ArrowDown": return Math.min(index + columns, length - 1);
    case "ArrowUp": return Math.max(index - columns, 0);
    case "Home": return 0;
    case "End": return length - 1;
    default: return null;
  }
}

/** Icon grid plus color swatches, with an optional live crest preview. Controlled. */
export function TeamIdentityPicker({ value, onChange, previewName, disabled, className }: TeamIdentityPickerProps) {
  const [focusIcon, setFocusIcon] = useState<number>(() => Math.max(0, TEAM_ICONS.indexOf(value.icon)));
  const iconRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onIconKey = useCallback((e: React.KeyboardEvent, index: number) => {
    const next = moveIndex(e.key, index, TEAM_ICONS.length, ICON_COLUMNS);
    if (next == null) return;
    e.preventDefault();
    setFocusIcon(next);
    iconRefs.current[next]?.focus();
  }, []);

  const onSwatchKey = useCallback((e: React.KeyboardEvent, index: number) => {
    const next = moveIndex(e.key, index, TEAM_COLORS.length, TEAM_COLORS.length);
    if (next == null) return;
    e.preventDefault();
    swatchRefs.current[next]?.focus();
  }, []);

  const selectedIcon = TEAM_ICONS.indexOf(value.icon);

  return (
    <div className={cn("flex items-start gap-6", className)}>
      {previewName !== undefined && (
        <div className="flex flex-col items-center gap-3 shrink-0" aria-live="polite">
          <TeamCrest icon={value.icon} color={value.color} size="lg" />
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-sol-bg-alt text-sm max-w-[160px]">
            <TeamIcon icon={value.icon} color={value.color} className="w-4 h-4 shrink-0" />
            <span className="text-sol-text font-medium truncate">{previewName.trim() || "Team name"}</span>
          </div>
        </div>
      )}
      <div className="flex-1 min-w-0 space-y-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-sol-text-dim mb-1.5">Icon</div>
          <div
            role="radiogroup"
            aria-label="Team icon"
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${ICON_COLUMNS}, max-content)` }}
          >
            {TEAM_ICONS.map((icon, i) => {
              const selected = icon === value.icon;
              const tabbable = selectedIcon >= 0 ? i === selectedIcon : i === focusIcon;
              return (
                <button
                  key={icon}
                  ref={(el) => { iconRefs.current[i] = el; }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={icon}
                  tabIndex={tabbable ? 0 : -1}
                  disabled={disabled}
                  onFocus={() => setFocusIcon(i)}
                  onKeyDown={(e) => onIconKey(e, i)}
                  onClick={() => onChange({ ...value, icon })}
                  className={cn(
                    "p-1.5 rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan",
                    selected ? "bg-sol-base02 ring-1 ring-sol-base01" : "hover:bg-sol-base02/50",
                    disabled && "opacity-50",
                  )}
                >
                  <TeamIcon
                    icon={icon}
                    color={selected ? value.color : undefined}
                    className={cn("w-4 h-4", !selected && "text-sol-base1")}
                  />
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-sol-text-dim mb-1.5">Color</div>
          <div role="radiogroup" aria-label="Team color" className="flex gap-2">
            {TEAM_COLORS.map((color, i) => {
              const selected = color === value.color;
              return (
                <button
                  key={color}
                  ref={(el) => { swatchRefs.current[i] = el; }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={color}
                  tabIndex={selected ? 0 : -1}
                  disabled={disabled}
                  onKeyDown={(e) => onSwatchKey(e, i)}
                  onClick={() => onChange({ ...value, color })}
                  className={cn(
                    "w-7 h-7 rounded-full transition-all outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-sol-bg focus-visible:ring-sol-text",
                    colorBgClassMap[color],
                    selected ? "ring-2 ring-offset-2 ring-offset-sol-bg ring-sol-base1 scale-110" : "hover:scale-105",
                    disabled && "opacity-50",
                  )}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
