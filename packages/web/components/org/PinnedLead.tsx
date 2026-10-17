"use client";
// What the org drawer pins over a thread (a proposal, the Head of People's
// suggestions): its own scroller, capped at a share of the drawer so the
// thread keeps room, its hidden bottom fading out so the two never read as
// one run of clipped text.
import { useRef, type ReactNode } from "react";
import { useScrollEdges } from "../line/useScrollEdges";

const FADE = "linear-gradient(to bottom, #000 calc(100% - 28px), transparent)";

export function PinnedLead({ children, share = 0.55, ...data }: { children: ReactNode; /** The drawer's height it may take. */ share?: number } & Record<`data-${string}`, string | number | undefined>) {
  const ref = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(ref);
  return (
    <div
      ref={ref}
      className="overflow-y-auto px-4 pb-3 pt-3"
      style={{ maxHeight: `calc(var(--org-panel-h, 100vh) * ${share})`, background: "color-mix(in srgb, var(--sol-bg-alt) 70%, transparent)", ...(edges.bottom ? { maskImage: FADE, WebkitMaskImage: FADE } : {}) }}
      data-pinned-more={edges.bottom || undefined}
      {...data}
    >
      {children}
    </div>
  );
}
