"use client"

import { useTheme } from "../ThemeProvider"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-sol-bg-alt group-[.toaster]:text-sol-text group-[.toaster]:border-sol-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-lg group-[.toaster]:text-sm group-[.toaster]:font-mono",
          description: "group-[.toast]:text-sol-text-muted",
          actionButton:
            "group-[.toast]:bg-sol-yellow group-[.toast]:text-sol-bg",
          cancelButton:
            "group-[.toast]:bg-sol-bg-highlight group-[.toast]:text-sol-text-muted",
          success:
            "group-[.toaster]:!bg-sol-bg-alt group-[.toaster]:!text-sol-green group-[.toaster]:!border-sol-green/30",
          error:
            "group-[.toaster]:!bg-sol-bg-alt group-[.toaster]:!text-sol-red group-[.toaster]:!border-sol-red/30",
          info:
            "group-[.toaster]:!bg-sol-bg-alt group-[.toaster]:!text-sol-blue group-[.toaster]:!border-sol-blue/30",
          warning:
            "group-[.toaster]:!bg-sol-bg-alt group-[.toaster]:!text-sol-orange group-[.toaster]:!border-sol-orange/30",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
