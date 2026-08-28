import { useCallback, useRef, useState, type CSSProperties } from "react";
import { TeamIcon, TEAM_ICONS, TEAM_COLORS, colorBgClassMap, iconLabelMap, type TeamIconName, type TeamColorName } from "../TeamIcon";
import { moveRadioIndex } from "./radioNav";
import { cn } from "../../lib/utils";
import "./teamFlow.css";

export interface TeamIdentity {
  icon: TeamIconName;
  color: TeamColorName;
}

interface TeamIdentityPickerProps {
  value: TeamIdentity;
  onChange: (next: TeamIdentity) => void;
  /** Team name for the live preview. When set, the preview renders the icon and name as the switcher shows them. */
  previewName?: string;
  disabled?: boolean;
  className?: string;
}

const ICON_COLUMNS = 6;

/** Icon grid plus color swatches, with an optional live crest preview. Controlled. */
export function TeamIdentityPicker({ value, onChange, previewName, disabled, className }: TeamIdentityPickerProps) {
  const [focusIcon, setFocusIcon] = useState<number>(() => Math.max(0, TEAM_ICONS.indexOf(value.icon)));
  const iconRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrows move focus AND select, the native radio pattern. Selecting as
  // you move also drives the live crest preview, so keyboard users see
  // each candidate exactly as pointer users do on click.
  const onIconKey = useCallback((e: React.KeyboardEvent, index: number) => {
    const next = moveRadioIndex(e.key, index, TEAM_ICONS.length, ICON_COLUMNS);
    if (next == null) return;
    e.preventDefault();
    setFocusIcon(next);
    iconRefs.current[next]?.focus();
    onChange({ ...value, icon: TEAM_ICONS[next] });
  }, [onChange, value]);

  const onSwatchKey = useCallback((e: React.KeyboardEvent, index: number) => {
    const next = moveRadioIndex(e.key, index, TEAM_COLORS.length, 1);
    if (next == null) return;
    e.preventDefault();
    swatchRefs.current[next]?.focus();
    onChange({ ...value, color: TEAM_COLORS[next] });
  }, [onChange, value]);

  const selectedIcon = TEAM_ICONS.indexOf(value.icon);

  return (
    // Selection states follow the picked color itself, so the grid answers
    // the pick immediately even outside the create flow's accent scope.
    <div
      className={cn("flex items-start gap-6", className)}
      style={{ "--tf-acc": `var(--sol-${value.color})` } as CSSProperties}
    >
      {previewName !== undefined && (
        // One preview, the switcher pill. A second, bigger crest next to it
        // would compete with the crest the surrounding page already shows.
        // No aria-live: the pill mirrors the name field on every keystroke,
        // and the radios already announce icon and color changes themselves.
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-sol-bg-alt text-sm max-w-[160px] shrink-0">
          <TeamIcon icon={value.icon} color={value.color} className="w-4 h-4 shrink-0 transition-colors duration-300" />
          <span
            className={cn(
              "font-medium truncate transition-colors duration-200",
              previewName.trim() ? "text-sol-text" : "text-sol-text-dim",
            )}
          >
            {previewName.trim() || "Team name"}
          </span>
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
                  aria-label={iconLabelMap[icon]}
                  tabIndex={tabbable ? 0 : -1}
                  disabled={disabled}
                  onFocus={() => setFocusIcon(i)}
                  onKeyDown={(e) => onIconKey(e, i)}
                  onClick={() => onChange({ ...value, icon })}
                  data-selected={selected}
                  className={cn(
                    "tf-tile p-1.5 rounded-md outline-none",
                    !selected && "hover:bg-sol-base02/50",
                    disabled && "opacity-50",
                  )}
                >
                  <TeamIcon
                    icon={icon}
                    color={selected ? value.color : undefined}
                    className={cn("w-4 h-4 transition-colors", !selected && "text-sol-base1")}
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
                    "w-7 h-7 rounded-full transition-transform duration-150 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-sol-bg focus-visible:ring-sol-text",
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
