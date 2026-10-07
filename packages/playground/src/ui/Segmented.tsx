import type { ReactNode } from "react";
import { useTip } from "./Tip";
import s from "./Segmented.module.css";

export type SegmentedOption<T extends string> = { value: T; label: string; tip?: ReactNode; keyshortcuts?: string; disabled?: boolean };

/** A sunk track of options; the chosen one sits raised on surface (DESIGN 5). */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: SegmentedOption<T>[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className={s.track} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <Option key={o.value} o={o} on={o.value === value} onChange={onChange} />
      ))}
    </div>
  );
}

function Option<T extends string>({ o, on, onChange }: { o: SegmentedOption<T>; on: boolean; onChange: (v: T) => void }) {
  const { describedBy, tip } = useTip(o.tip);
  return (
    <button
      role="radio"
      aria-checked={on}
      aria-disabled={o.disabled || undefined}
      aria-keyshortcuts={o.keyshortcuts}
      {...(o.tip ? describedBy : {})}
      className={`${s.option} ${on ? s.on : ""}`}
      onClick={() => !o.disabled && onChange(o.value)}
    >
      {o.label}
      {o.tip && tip}
    </button>
  );
}
