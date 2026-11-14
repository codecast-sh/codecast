import { useRef } from "react";
import { AlignLeft, ChevronsDownUp, EyeOff, Video, VideoOff, type LucideIcon } from "lucide-react";

// The small controls RoomThread's header and rows wear: the working mark, the
// spoken-words density switch, the segmented radio both it and the call
// stage's view switch use, and an agent's video avatar toggle.

export type Density = "folded" | "full" | "hidden";

// ── Spoken words ───────────────────────────────────────────────────────────

/** Three breathing dots (team chat's typing mark): an agent mid-turn. Hidden
 *  from assistive tech; the words beside them say it. */
export function WorkingDots({ className = "", title }: { className?: string; title?: string }) {
  return (
    <span className={`ch-typing-dots ${className}`} title={title} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

// ── How much of the spoken words to show ───────────────────────────────────

const DENSITIES: Array<{ key: Density; icon: LucideIcon; label: string; hint: string }> = [
  { key: "folded", icon: ChevronsDownUp, label: "folded", hint: "Spoken words folded into passages; the newest stays open while the call is live" },
  { key: "full", icon: AlignLeft, label: "full", hint: "Every spoken word, open" },
  { key: "hidden", icon: EyeOff, label: "hidden", hint: "Only typed lines and agent answers" },
];

export function DensityControl({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  return (
    <span className="rt-density-group">
      <span className="rt-density-label" aria-hidden="true">
        words
      </span>
      <SegmentedRadio label="Spoken words" options={DENSITIES} value={value} onChange={onChange} />
    </span>
  );
}

// ── A control with a few positions ─────────────────────────────────────────

/** One radiogroup of small buttons, the live one raised: the thread's words
 *  control and the stage's view control are both this. One tab stop for the
 *  group; the arrow keys move the check, the radio way. Icons alone by
 *  default (the option's label becomes the button's name); `labels` writes
 *  the label beside the icon. */
export function SegmentedRadio<K extends string>({
  label,
  options,
  value,
  onChange,
  labels = false,
  iconClass = "h-3 w-3",
  className,
}: {
  /** The group's name for assistive tech, and the prefix of each option's name when icons stand alone. */
  label: string;
  options: ReadonlyArray<{ key: K; icon: LucideIcon; label: string; hint: string }>;
  value: K;
  onChange: (next: K) => void;
  labels?: boolean;
  iconClass?: string;
  className?: string;
}) {
  const groupRef = useRef<HTMLSpanElement>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.key === value);
    const next = options[(i + step + options.length) % options.length];
    onChange(next.key);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-value="${next.key}"]`)?.focus();
  };
  return (
    <span ref={groupRef} role="radiogroup" aria-label={label} className={`rt-seg ${className ?? ""}`} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          data-value={o.key}
          aria-checked={value === o.key}
          aria-label={labels ? undefined : `${label} ${o.label}`}
          tabIndex={value === o.key ? 0 : -1}
          title={o.hint}
          onClick={() => onChange(o.key)}
          className={`rt-seg-btn${labels ? " rt-seg-btn-labeled" : ""}`}
        >
          <o.icon className={iconClass} />
          {labels && <span className="rt-seg-word">{o.label}</span>}
        </button>
      ))}
    </span>
  );
}

/** An agent's video avatar in the call, on or off. Off, the agent stays in
 *  the room and answers in the chat. */
export function AgentFaceToggle({ on, name, onChange }: { on: boolean; name: string; onChange: (face: boolean) => void }) {
  const Icon = on ? Video : VideoOff;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={`rounded p-1 transition-colors hover:text-sol-text ${on ? "text-sol-violet" : "text-sol-text-dim"}`}
      title={on ? `Turn off ${name}'s video avatar` : `Bring ${name} in on video`}
      aria-label={on ? `Turn off ${name}'s video avatar` : `Bring ${name} in on video`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
