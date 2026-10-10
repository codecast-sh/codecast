import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import "./button.css"

// THE button. Every action on the site is one of these: a filled face for
// the one thing a surface is for (default, cyan, or an accent tone when the
// action has a colour of its own: violet for calls, red for stop and delete,
// green for approve, amber for triggers, yellow for guests), outline or secondary beside it,
// ghost for the quiet rest. The faces are drawn in button.css; a call site
// picks a variant and a size and never a fill, a text colour or a shadow.
const tone = (name: string) => `cc-btn-fill cc-btn-tone cc-btn-${name}`

const buttonVariants = cva(
  "cc-btn inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Filled faces, toned and lit in button.css; the label colour stays here.
        default: "cc-btn-fill cc-btn-primary text-primary-foreground",
        destructive: "cc-btn-fill cc-btn-destructive text-destructive-foreground",
        outline:
          "cc-btn-outline border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "cc-btn-secondary bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // The settings surface's primary action. Its cyan is the fixed accent
        // (button.css), not the theme's, so the fixed dark base03 text keeps
        // its contrast in every theme.
        cyan: "cc-btn-fill cc-btn-cyan text-sol-base03",
        violet: tone("violet"),
        red: tone("red"),
        green: tone("green"),
        blue: tone("blue"),
        amber: tone("amber"),
        yellow: tone("yellow"),
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        // Inline in a row of text, a banner or a card footer.
        xs: "h-7 gap-1.5 rounded-md px-2.5 text-xs [&_svg]:size-3.5",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        "icon-sm": "h-7 w-7 [&_svg]:size-3.5",
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
