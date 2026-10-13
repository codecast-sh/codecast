// The line's own machine faults as evidence about a problem (line-journeys.md LJ8.3, "In production"). A check that
// could not run on the line's machine prints why (`gate.infra`, runReport gateInfra): "layer 3 cannot run:
// L3_DATABASE_URL is not set". When a problem is about that very fault (its title or description names the same
// identifier), every such failure is the problem happening again: a fix "in production, quiet" while the line keeps
// failing on it is not quiet.
import type { LineStep } from "./lineModel";
import { gateInfra } from "./runReport";

/** One run whose step failed on the line's own machine, in the words the step printed. */
export type LineFault = { runId: string; caseId: string | null; caseRef: string | null; step: string; stepLabel: string; words: string; at: number };

/** The identifiers a fault or a problem names: an environment variable (L3_DATABASE_URL) or a script's file name
 *  (run-full-suite.sh). Plain words never match: two texts share a fault only when they name the same thing. */
const NAMES = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[\w-]+\.(?:sh|ts|tsx|js|mjs|py|toml|ya?ml)\b/g;
export const namesIn = (text: string): Set<string> => new Set(text.match(NAMES) ?? []);

/** Every failed step visit whose result printed a machine fault, newest first. */
export function stepFaults(steps: Readonly<Record<string, LineStep>>): LineFault[] {
  const out: LineFault[] = [];
  for (const s of Object.values(steps)) {
    for (const d of s.decisions) {
      if (d.status !== "failed" || d.at == null) continue;
      const words = gateInfra(d.decided.result);
      if (words) out.push({ runId: d.runId, caseId: d.caseId, caseRef: d.caseRef, step: s.id, stepLabel: s.label, words: words.charAt(0).toUpperCase() + words.slice(1), at: d.at });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The faults a problem is about: those naming an identifier its own text names. */
export function faultsNaming(text: string, faults: ReadonlyArray<LineFault>): LineFault[] {
  if (!faults.length) return [];
  const mine = namesIn(text);
  if (!mine.size) return [];
  return faults.filter((f) => [...namesIn(f.words)].some((n) => mine.has(n)));
}
