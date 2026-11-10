import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"
import { modernFocusRing } from "./styles"
import "./button.css"

// THE button. Every action on the site is one of these: a filled face for
// the one thing a surface is for (default, cyan, or an accent tone when the
// action has a colour of its own: violet for calls, red for stop and delete,
// green for approve, amber for triggers, orange for turning on something consequential, yellow for guests), outline or secondary beside it,
// ghost for the quiet rest. The faces are drawn in button.css; a call site
// picks a variant and a size and never a fill, a text colour or a shadow.
//
// The Modern style (the `modern:` classes and button.css's .modern-style
// block) keeps every variant and size and redraws them on the primitive
// tokens: a flat accent fill with its label worked out from the tint, a white
// outline face, 6px corners, the 28 / 32 / 36px control heights and the one
// focus ring. `primary` and `danger` (Modern's names for `default` and
// `destructive`), `md`, `icon-lg` and `icon-xs` are aliases and additions; the
// names call sites use are unchanged.
const tone = (name: string) => `cc-btn-fill cc-btn-tone cc-btn-${name}`
// The label on a filled face in Modern is the ink button.css works out from
// the tint (Classic's text-* class stays for Classic).
const MODERN_INK = "modern:text-[color:var(--btn-ink)]"
const MODERN_BASE = `modern:rounded-control ${modernFocusRing}`

const buttonVariants = cva(
  // Joined, not merged: tailwind-merge reads `outline` as a width and would
  // drop it beside `outline-2`, and buttonVariants() is also used raw.
  `cc-btn inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 ${MODERN_BASE}`,
  {
    variants: {
      variant: {
        // Filled faces, toned and lit in button.css; the label colour stays here.
        default: `cc-btn-fill cc-btn-primary text-primary-foreground ${MODERN_INK}`,
        primary: `cc-btn-fill cc-btn-primary text-primary-foreground ${MODERN_INK}`,
        destructive: `cc-btn-fill cc-btn-destructive text-destructive-foreground ${MODERN_INK}`,
        danger: `cc-btn-fill cc-btn-destructive text-destructive-foreground ${MODERN_INK}`,
        // Modern: a white face on the hairline (the border is already the
        // theme's hairline, and the hover the theme's alt surface).
        outline:
          "cc-btn-outline border border-input bg-background hover:bg-accent hover:text-accent-foreground modern:bg-sol-card",
        secondary:
          "cc-btn-secondary bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline modern:text-sol-cyan",
        // The settings surface's primary action. Its cyan is the fixed accent
        // (button.css), not the theme's, so the fixed dark base03 text keeps
        // its contrast in every theme.
        // In Modern it is the theme's accent, as the primary is, with the label
        // worked out from it.
        cyan: `cc-btn-fill cc-btn-cyan text-sol-base03 ${MODERN_INK}`,
        violet: tone("violet"),
        red: tone("red"),
        green: tone("green"),
        blue: tone("blue"),
        amber: tone("amber"),
        orange: tone("orange"),
        yellow: tone("yellow"),
      },
      // Modern: sm 28, md (default) 32, lg 36; icons square at those heights
      // with a 16px glyph; icon-xs (24) is the floor for anything pressable.
      size: {
        default: "h-9 px-4 py-2 modern:h-control-md modern:px-3",
        md: "h-9 px-4 py-2 modern:h-control-md modern:px-3",
        sm: "h-8 rounded-md px-3 text-xs modern:h-control-sm modern:px-2.5",
        // Inline in a row of text, a banner or a card footer.
        xs: "h-7 gap-1.5 rounded-md px-2.5 text-xs [&_svg]:size-3.5",
        lg: "h-10 rounded-md px-8 modern:h-control-lg modern:px-4",
        icon: "h-9 w-9 modern:size-control-md",
        "icon-sm": "h-7 w-7 [&_svg]:size-3.5 modern:[&_svg]:size-4",
        "icon-lg": "h-10 w-10 modern:size-control-lg",
        "icon-xs": "h-6 w-6 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
