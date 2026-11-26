// Whether a flow is a personal Ship, as its DOT source says (`graph [own_results=true]`, personal.cast): read by the
// CLI when it writes the shipped snapshot (cli workflow/shippedFlows.ts) and by the web for a pushed or stored row's
// source (web lib/ship/ownRound.ts). Pure.

/** Whether a DOT source says `own_results=true` in its graph attributes. */
export const sourceSaysOwnResults = (source: string | null | undefined): boolean =>
  /graph\s*\[[^\]]*\bown_results\s*=\s*"?true\b/.test(source ?? "");
