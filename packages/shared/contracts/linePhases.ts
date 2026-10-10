// The line's phases (the-line-end-to-end.md LE16): which phase each of
// codecast's stations sits in, and a phase for another graph's station read
// from its words. The web's run report and map, and the server's cause history
// (causeHistory.ts), all place stations by this one table.

export type LinePhaseKey = "understand" | "prove" | "build" | "check" | "decide" | "ship";

export const LINE_PHASES: ReadonlyArray<{ key: LinePhaseKey; label: string; stations: readonly string[] }> = [
  { key: "understand", label: "Understand", stations: ["ground", "park", "plan", "plan_gate", "analyze"] },
  { key: "prove", label: "Prove", stations: ["prove", "prove_line", "red", "dissolve"] },
  { key: "build", label: "Build", stations: ["implement", "implement_line", "ask", "reopen"] },
  { key: "check", label: "Check", stations: ["verify", "green", "eval", "unscored", "review"] },
  { key: "decide", label: "Decide", stations: ["card_draft", "card_write", "card", "decide", "drop"] },
  { key: "ship", label: "Ship", stations: ["rebase", "ship", "merge", "watch"] },
];

const PHASE_OF = new Map(LINE_PHASES.flatMap((p) => p.stations.map((s) => [s, p.key] as const)));
export const phaseOfStation = (id: string): LinePhaseKey | null => PHASE_OF.get(id) ?? null;

/** A phase for a station codecast's line does not name, from its words, so a
 *  foreign graph's map still reads Understand, Prove, Build, Check, Decide, Ship. */
const PHASE_WORDS: Array<[RegExp, LinePhaseKey]> = [
  [/ship|merge|watch|rebase|land/, "ship"],
  [/card|decide|drop/, "decide"],
  [/verify|green|eval|review|check|test/, "check"],
  [/propos|approv|build|implement|fix/, "build"],
  [/prove|\bred\b|reproduc/, "prove"],
];
export const PHASE_ORDER: LinePhaseKey[] = ["understand", "prove", "build", "check", "decide", "ship"];
export function guessPhase(id: string, label = "", foreign = false): LinePhaseKey {
  // On another graph a shared id may sit elsewhere (AgentWatch's dissolve is
  // its first look), so there the words decide and the path keeps them in order.
  const known = foreign ? null : phaseOfStation(id);
  if (known) return known;
  const words = `${id.replace(/_/g, " ")} ${label}`.toLowerCase();
  return PHASE_WORDS.find(([re]) => re.test(words))?.[1] ?? "understand";
}

/** The half of the line a phase is in: understanding and proving diagnose, the rest fixes. */
export const halfOfPhase = (stage: LinePhaseKey): "diagnose" | "fix" => (stage === "understand" || stage === "prove" ? "diagnose" : "fix");
