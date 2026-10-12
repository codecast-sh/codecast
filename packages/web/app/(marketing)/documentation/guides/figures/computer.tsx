"use client";

import { SOL } from "../../../blog/blogChrome";
import { BlockedAppsCard, ReadVsMark, RedactedCard, TwoCursors } from "../../../features/computer/Sections";
import { useStillMode } from "../../../features/computer/parts";
import "../../../features/computer/computer.css";

/**
 * Figures for the computer guide, drawn with the computer feature page's own
 * pieces: the two pointers on one desktop, what the agent does on its own
 * against what waits for the person, and the two refusals that hold whatever
 * the agent is asked.
 */

/** The person's pointer in the front window, the agent's orange one in the window behind. */
export function TwoCursorsFigure() {
  const still = useStillMode();
  return (
    <div className="p-3 sm:p-5">
      <TwoCursors still={still} />
    </div>
  );
}

/** Reading is the agent's; anything that leaves a mark waits for the person. */
export function ReadVsMarkFigure() {
  return (
    <div className="p-4 sm:p-6" style={{ backgroundColor: SOL.base02 }}>
      <ReadVsMark />
    </div>
  );
}

/** Password managers refused by name; secret fields replaced before the agent sees them. */
export function GuardrailsFigure() {
  return (
    <div className="grid grid-cols-1 gap-4 p-4 sm:p-6 md:grid-cols-2" style={{ backgroundColor: SOL.base03 }}>
      <BlockedAppsCard />
      <RedactedCard />
    </div>
  );
}
