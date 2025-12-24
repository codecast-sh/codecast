import * as React from "react"

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

export function Switch({ checked, onCheckedChange, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`
        relative inline-flex h-5 w-9 items-center rounded-full transition-colors
        ${checked ? "bg-sol-cyan" : "bg-sol-bg-alt"}
        ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
        ${className || ""}
      `}
    >
      <span
        className={`
          inline-block h-4 w-4 transform rounded-full bg-sol-bg transition-transform
          ${checked ? "translate-x-5" : "translate-x-0.5"}
        `}
      />
    </button>
  )
}
