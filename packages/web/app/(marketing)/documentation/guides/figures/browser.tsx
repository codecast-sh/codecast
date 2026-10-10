"use client";

import { CastTabStrip } from "../../../features/browser/Sections";

/**
 * Figures for the browser guide, drawn with the browser feature page's own
 * pieces: the person's tabs beside the red Cast group of agent tabs.
 */

/** Your tabs stay yours; each agent session works in one background tab inside the Cast group. */
export function CastTabsFigure() {
  return (
    <div className="p-3 sm:p-5">
      <CastTabStrip />
    </div>
  );
}
