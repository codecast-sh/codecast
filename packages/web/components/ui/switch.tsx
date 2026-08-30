import * as React from "react"

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
        ${checked ? "bg-sol-cyan" : "bg-sol-bg-alt"}
        ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
        ${className || ""}
      `}
    >
      <span
        className={`
          inline-block h-3.5 w-3.5 transform rounded-full bg-sol-bg transition-transform
          ${checked ? "translate-x-[19px]" : "translate-x-[3px]"}
        `}
      />
    </button>
  )
}
