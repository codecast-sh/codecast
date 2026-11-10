import * as React from "react"

import { cn } from "../../lib/utils"

// A placeholder block for content that has not arrived: the highlight
// surface of the theme (a step darker than the page in light, lighter in
// dark), the control radius, a slow pulse. The pulse stops under reduced
// motion. Show one only for a cold cache (`!ready && rows.length === 0`, the
// house rule): a skeleton over data the store already holds is a flash.
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      data-skeleton
      className={cn("rounded-control bg-sol-bg-highlight animate-pulse motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

/** A list still loading: `rows` lines of the given height, the last shorter,
 *  so it reads as text rather than a stack of bars. */
export function SkeletonRows({ rows = 3, className, rowClassName }: { rows?: number; className?: string; rowClassName?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn("space-y-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i === rows - 1 && rows > 1 ? "w-2/3" : "w-full", rowClassName)} />
      ))}
    </div>
  )
}
