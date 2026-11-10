import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// In the Modern style a badge is a soft tint of its colour behind text in the
// same colour, 20px tall, 6px corners, no edge: `neutral` is the ink and each
// accent a status (green done or live, amber or yellow waiting, red failing,
// blue info, violet people and calls, cyan the accent's own things). `dot`
// leads with a dot in the text colour, for a state that is live. The Classic
// variants keep their faces and gain the Modern one; the tones are new.
const MODERN_SHAPE = "modern:h-5 modern:gap-1 modern:whitespace-nowrap modern:rounded-control modern:px-1.5 modern:py-0 modern:text-meta modern:font-medium modern:shadow-none modern:focus:ring-0 modern:focus:ring-offset-0"

const badgeVariants = cva(
  `inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold select-none transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${MODERN_SHAPE}`,
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80 modern:bg-sol-cyan/10 modern:text-sol-cyan modern:hover:bg-sol-cyan/10",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80 modern:bg-sol-text/[0.07] modern:text-sol-text-muted modern:hover:bg-sol-text/[0.07]",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80 modern:bg-sol-red/10 modern:text-sol-red modern:hover:bg-sol-red/10",
        outline: "text-foreground modern:border-sol-border modern:text-sol-text-muted",
        // The tones (new): the soft tint in every style.
        neutral: "border-transparent bg-sol-text/[0.07] text-sol-text-muted",
        cyan: "border-transparent bg-sol-cyan/10 text-sol-cyan",
        green: "border-transparent bg-sol-green/10 text-sol-green",
        amber: "border-transparent bg-sol-amber/10 text-sol-amber",
        yellow: "border-transparent bg-sol-yellow/10 text-sol-yellow",
        orange: "border-transparent bg-sol-orange/10 text-sol-orange",
        red: "border-transparent bg-sol-red/10 text-sol-red",
        blue: "border-transparent bg-sol-blue/10 text-sol-blue",
        violet: "border-transparent bg-sol-violet/10 text-sol-violet",
        magenta: "border-transparent bg-sol-magenta/10 text-sol-magenta",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  /** Lead with a dot in the badge's colour: the state is live right now. */
  dot?: boolean
}

function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span aria-hidden className="mr-1 size-1.5 shrink-0 rounded-full bg-current modern:mr-0" />}
      {children}
    </div>
  )
}

export { Badge, badgeVariants }
