"use client";

// /share-cursors — teammates' pointers on the sharer's own screen.
//
// The shell puts this page in a glass window exactly over what my screen
// share captures (electron shareCursors.js): a whole display, or one window's
// frame. It never takes focus or the mouse, and the capture leaves it out.
// All it does is draw what the shell sends: each cursor is a point normalized
// to the share's frame, and the window IS that frame, so the point is a plain
// fraction of the viewport. Same arrow as over a share tile (TeammateCursor).
//
// No auth and no sync: everything it shows arrives from the shell.
import { useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useDerivedSize } from "../../hooks/useDerivedSize";
import { onShareCursors, type ShareCursor } from "../../lib/desktop";
import { TeammateCursor } from "../../components/calls/ScreenCursors";

export default function ShareCursorsPage() {
  const [cursors, setCursors] = useState<ShareCursor[]>([]);
  useWatchEffect(() => onShareCursors(setCursors), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const size = useDerivedSize(rootRef, (w, h) => `${Math.round(w)}x${Math.round(h)}`, () => "0x0");
  const [w, h] = size.split("x").map(Number);
  return (
    <div ref={rootRef} className="fixed inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {cursors.map((c) => (
        <TeammateCursor key={c.id} identity={c.id} name={c.name} x={c.nx * w} y={c.ny * h} />
      ))}
    </div>
  );
}
