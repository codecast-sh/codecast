// Whether a flow is a personal Ship, as its DOT source says (`graph [own_results=true]`, personal.cast): read by the
// CLI when it writes the shipped snapshot (cli workflow/shippedFlows.ts) and by the web for a pushed or stored row's
// source (web lib/ship/ownRound.ts). Pure.

import { flowRunAttr } from "./flowPool";

/** Whether a DOT source says `own_results=true` in its graph attributes, or extends a library flow that does (a
 *  variant of the personal Ship rounds on its own results as the personal Ship does: flowPool.ts flowRunAttr). */
export const sourceSaysOwnResults = (source: string | null | undefined): boolean => flowRunAttr(source, "own_results") === "true";
