"use client";

// The one drag handle for every horizontal split (terminal split, browser
// split, bottom terminal panel, prompt view). A solid rail — alt background
// between two hairlines, with a short centered grip — so the seam is visible
// at rest and the scroll surface below reads as passing UNDER it rather than
// bleeding into the pane above. Hover/drag light it up in cyan, like the
// app's other resize affordances.
//
// It takes real layout height (no negative margins), so the pointer target
// stays comfortable without overlapping the content on either side.

import type { HTMLAttributes } from "react";

interface Props extends HTMLAttributes<HTMLDivElement> {
  /** No resize possible right now (e.g. maximized): still draws the seam,
   *  drops the resize cursor. */
  disabled?: boolean;
}

export function SplitResizeHandle({ disabled, className = "", ...rest }: Props) {
  return (
    <div
      {...rest}
      // NB: sol tokens other than cyan ignore Tailwind's `/opacity` modifier
      // (they are bare CSS vars) — hence the full tokens and color-mix here.
      className={`group relative h-[9px] flex-shrink-0 z-10 touch-none select-none bg-sol-bg-alt border-y border-sol-border hover:border-sol-cyan/60 transition-colors duration-150 ${disabled ? "" : "cursor-row-resize"} ${className}`}
    >
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[3px] w-10 rounded-full bg-[color-mix(in_srgb,var(--sol-text-dim)_55%,transparent)] group-hover:bg-sol-cyan group-active:bg-sol-cyan transition-colors duration-150" />
    </div>
  );
}
