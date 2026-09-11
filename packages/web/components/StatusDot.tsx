"use client";

// The 8px status dot the top bar's chips lead with (daemon, sync, running
// agents, account usage): one colour, optionally ringed by a slow ping while
// something is in motion. One markup so the chips stay the same size and
// the ping the same rhythm.

import type { CSSProperties } from "react";

export function StatusDot({
  color,
  ping = false,
  pingDuration = "2s",
  dotStyle,
}: {
  color: string;
  ping?: boolean;
  pingDuration?: string;
  dotStyle?: CSSProperties;
}) {
  return (
    <span aria-hidden="true" className="relative flex h-2 w-2 shrink-0">
      {ping && (
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40"
          style={{ background: color, animationDuration: pingDuration }}
        />
      )}
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: color, ...dotStyle }} />
    </span>
  );
}
