import * as React from "react"

import { modernFocusRing } from "./styles"

// Modern: the track is a wash of the ink when off, the knob a white 16px disc
// with a short shadow, and a transparent ring around the 36×20 track widens
// the press target to 28×44, so nothing is under 24px.
const MODERN_TRACK = `modern:duration-press modern:ease-ui modern:before:absolute modern:before:-inset-1 modern:before:content-[''] ${modernFocusRing}`
const MODERN_KNOB = "modern:size-4 modern:bg-sol-card modern:shadow-[0_1px_2px_rgb(0_0_0/0.2)] modern:duration-press modern:ease-ui"

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  id?: string
  "aria-label"?: string
  "aria-labelledby"?: string
}

export function Switch({ checked, onCheckedChange, disabled, className, id, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={aria["aria-label"]}
      aria-labelledby={aria["aria-labelledby"]}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`
        relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/50 focus-visible:ring-offset-1 focus-visible:ring-offset-sol-bg
        ${checked ? "bg-sol-cyan" : "bg-sol-border"}
        ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
        ${MODERN_TRACK} ${checked ? "" : "modern:bg-sol-text/20 modern:hover:bg-sol-text/25"}
        ${className || ""}
      `}
    >
      <span
        className={`
          inline-block h-3.5 w-3.5 transform rounded-full bg-sol-bg transition-transform
          ${checked ? "translate-x-[19px]" : "translate-x-[3px]"}
          ${MODERN_KNOB} ${checked ? "modern:translate-x-[18px]" : "modern:translate-x-[2px]"}
        `}
      />
    </button>
  )
}
