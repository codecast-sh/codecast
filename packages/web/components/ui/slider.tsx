import * as React from "react"

import { cn } from "@/lib/utils"

interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  "aria-label"?: string
  /** Fires on every drag tick — keep it cheap (local state, CSS vars). */
  onValueChange: (value: number) => void
  /** Fires once when the thumb is released — the moment to persist or preview. */
  onValueCommit?: (value: number) => void
}

/** A styled native range input. Native, because the platform already ships the
 *  keyboard model (arrows, Home/End, page steps) and the a11y wiring a custom
 *  thumb would have to re-earn; the `.cc-range` class in globals.css restyles
 *  the track and thumb with sol tokens. The filled portion of the track is
 *  painted by the `--fill` custom property this component keeps in step. */
export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  disabled,
  className,
  onValueChange,
  onValueCommit,
  ...aria
}: SliderProps) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100
  const commit = () => onValueCommit?.(value)
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={aria["aria-label"]}
      onChange={(e) => onValueChange(Number(e.target.value))}
      onPointerUp={commit}
      onKeyUp={(e) => {
        if (e.key !== "Tab") commit()
      }}
      className={cn("cc-range w-full", disabled && "opacity-50", className)}
      style={{ "--fill": `${pct}%` } as React.CSSProperties}
    />
  )
}
