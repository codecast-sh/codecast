import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import "./button.css"

// Filled variants share the .sol-btn-solid finish (globals.css): lit edge,
// grounded shadow, one hover and press. The transition list replaces the
// base's transition-colors so the brighten and the press animate too.
const solid = "sol-btn-solid transition-[filter,box-shadow,transform,background-color,color]"

const buttonVariants = cva(
  "cc-btn inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
<<<<<<< Updated upstream
        default:
          `bg-primary text-primary-foreground ${solid}`,
        destructive:
          `bg-destructive text-destructive-foreground ${solid}`,
=======
        // Filled faces, toned and lit in button.css; the label colour stays here.
        default: "cc-btn-fill cc-btn-primary text-primary-foreground",
        destructive: "cc-btn-fill cc-btn-destructive text-destructive-foreground",
>>>>>>> Stashed changes
        outline:
          "cc-btn-outline border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "cc-btn-secondary bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
<<<<<<< Updated upstream
        // The settings surface's primary action. sol-cyan is a fixed accent
        // that doesn't invert between themes, so the fixed dark base03 text
        // keeps its contrast in both.
        cyan: `bg-sol-cyan text-sol-base03 ${solid}`,
=======
        // The settings surface's primary action. Its cyan is the fixed accent
        // (button.css), not the theme's, so the fixed dark base03 text keeps
        // its contrast in every theme.
        cyan: "cc-btn-fill cc-btn-cyan text-sol-base03",
>>>>>>> Stashed changes
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
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
