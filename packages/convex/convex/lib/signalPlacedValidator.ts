// How a signal's project was decided (lib/signalPlacement.ts), kept on the
// signal and on the problem it opened. Its own file so the schema reads it
// without the placement code.
import { v } from "convex/values";

export const SIGNAL_PLACEMENTS = ["expectation", "filer", "source", "default", "none", "ground"] as const;
export type Placed = (typeof SIGNAL_PLACEMENTS)[number];
export const signalPlacedValidator = v.union(...SIGNAL_PLACEMENTS.map((p) => v.literal(p)));
