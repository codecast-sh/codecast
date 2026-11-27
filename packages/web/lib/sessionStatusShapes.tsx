import type { ReactNode } from "react";
import type { StatusMarkShape } from "./sessionStatus";

// The shapes of the session status marks (lib/sessionStatus), drawn by
// components/inbox/SessionStatusMark on web and components/marks on the phone.
// Marks are shapes as well as colours, and none of them moves: a list draws
// one per row, and one animating mark per row re-layers the page every frame.

/** Each mark's shapes, in a 10×10 box, painted in currentColor. */
export const STATUS_MARK_SHAPES: Record<StatusMarkShape, ReactNode> = {
  // Working: the steady dot.
  dot: <circle cx="5" cy="5" r="3.5" fill="currentColor" />,
  // Needs you: a dot held in a ring, for something waiting on you.
  ask: <><circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="5" cy="5" r="1.7" fill="currentColor" /></>,
  // Error: a filled warning triangle.
  alert: <path d="M5 1.1 9.3 8.7H.7z" fill="currentColor" stroke="currentColor" strokeWidth=".6" strokeLinejoin="round" />,
  // Starting: the working dot's ring, not yet closed.
  dashed: <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.55" />,
  // Done: a check.
  check: <path d="M1.9 5.3 4.1 7.4 8.2 2.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  // Shipping: the Ship button's rocket (lucide's, as ShipControl draws it), scaled into the box.
  rocket: (
    <g transform="scale(0.4167)" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </g>
  ),
  // Dormant: a crescent, parked until a wake.
  moon: <path d="M6.6 1.3A3.9 3.9 0 1 0 8.9 6.6 3.1 3.1 0 0 1 6.6 1.3z" fill="currentColor" />,
  // Idle: an empty ring.
  ring: <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  // Stashed: into the tray.
  aside: <path d="M5 1.2v4.6M3.1 3.9 5 5.8l1.9-1.9M1.4 6.4v2.3h7.2V6.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
  // Killed: a cross.
  cross: <path d="m2.5 2.5 5 5m0-5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
};
