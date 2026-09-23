// One switch on a role (docs/architecture/org-staffing.md S23.1): Starts work
// on its own. On, the role starts hands and answers decisions inside its
// scope; off, it reads, answers questions and recommends, and a person starts
// the work. The stored field keeps its old name and its three values for one
// release, mapped both ways here and nowhere else: on is "direct", off is
// "understand", and "decide" reads as on and is never written again. Every
// gate, every surface and every history line reads the switch through this
// file, so they cannot disagree about what a role may do.

export type StoredTrust = "understand" | "decide" | "direct";

/** The switch as stored: true when the role starts work on its own. */
export function autonomyOn(trust: string | null | undefined): boolean {
  return trust === "direct" || trust === "decide";
}

/** The value to store for a switch position. */
export function trustForSwitch(on: boolean): StoredTrust {
  return on ? "direct" : "understand";
}

/** A legacy stage word, as the switch it means; null for a word that is neither. */
export function switchFromStageWord(word: string): boolean | null {
  const w = word.trim().toLowerCase();
  if (w === "on" || w === "direct" || w === "decide" || w === "true") return true;
  if (w === "off" || w === "understand" || w === "false") return false;
  return null;
}

/** The label a person reads on the role page and in the CLI. */
export const AUTONOMY_LABEL = "Starts work on its own";

/** What the position means, in one sentence. */
export function autonomySentence(on: boolean): string {
  return on
    ? "It starts work in its area and answers decisions there without asking."
    : "It reads, answers questions and recommends; you start the work, or turn this on.";
}

/** "starts work on its own" / "does not start work on its own": the short form for a role line. */
export function autonomyWords(on: boolean): string {
  return on ? "starts work on its own" : "does not start work on its own";
}

/** The history line and the charter note: what a person did to the switch. */
export function autonomyChangeWords(on: boolean): string {
  return `turned ${on ? "on" : "off"} starting work on its own`;
}
