import { cn } from "@/lib/utils"

// Shared loading spinner: a round-capped quarter arc over a faint ring,
// colored by `currentColor` so callers tint it with a text-* class. Size via
// className (defaults to w-3.5 h-3.5). Prefer this over re-inlining the
// legacy filled-path SVG that's still scattered around the codebase.
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("w-3.5 h-3.5 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" className="opacity-20" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}
