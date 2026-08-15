"use client";
/**
 * The task status glyph, Linear-style: one circle whose fill says how far
 * along the work is. Backlog is a dotted ring, unstarted an empty ring, a
 * started status is a disc filling clockwise (a team's second "started"
 * status fills more than its first), done is a solid disc with a check,
 * dropped a solid disc with an X. Color comes from the surrounding class
 * (`currentColor`), so callers style it exactly like a lucide icon.
 */
import { forwardRef, type SVGProps } from "react";
import type { TaskStatusCategory } from "@codecast/shared/tasks";

export type StatusCircleProps = Omit<SVGProps<SVGSVGElement>, "fill"> & {
  category: TaskStatusCategory;
  /** 0..1 — how much of the disc is filled. Only read for in_progress/in_review.
   *  Named `progress` because SVGProps already owns `fill` (a paint string). */
  progress?: number;
};

const R = 7;

export const StatusCircle = forwardRef<SVGSVGElement, StatusCircleProps>(function StatusCircle(
  { category, progress = 0.5, className, ...rest },
  ref,
) {
  const base = { ref, viewBox: "0 0 20 20", width: 16, height: 16, className, ...rest };
  switch (category) {
    case "backlog":
      return (
        <svg {...base}>
          <circle cx="10" cy="10" r={R} fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="1.6 2.2" strokeLinecap="round" />
        </svg>
      );
    case "open":
      return (
        <svg {...base}>
          <circle cx="10" cy="10" r={R} fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      );
    case "in_progress":
    case "in_review": {
      // Wedge drawn as a thick stroke on a half-radius circle: stroke width =
      // radius, so the dash covers the disc from center out, clockwise from 12.
      const pct = Math.max(0.05, Math.min(1, progress));
      const innerR = R / 2 - 0.4;
      const innerC = 2 * Math.PI * innerR;
      return (
        <svg {...base}>
          <circle cx="10" cy="10" r={R} fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle
            cx="10" cy="10" r={innerR}
            fill="none" stroke="currentColor" strokeWidth={innerR * 2}
            strokeDasharray={`${innerC * pct} ${innerC}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      );
    }
    case "done":
      return (
        <svg {...base}>
          <circle cx="10" cy="10" r={R + 0.8} fill="currentColor" />
          <path d="M6.6 10.4l2.2 2.2 4.6-4.8" fill="none" stroke="var(--sol-bg, #fff)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "dropped":
      return (
        <svg {...base}>
          <circle cx="10" cy="10" r={R + 0.8} fill="currentColor" />
          <path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" fill="none" stroke="var(--sol-bg, #fff)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
});
