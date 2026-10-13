// A built fix read for review (line-journeys.md "Built fixes to review"), from
// facts rather than the builder's last handoff line: what the change does (its
// own commits), how its gates ended on the last build, where its branch stands
// against main, and from those the one act that moves it on. Pure.
import type { BranchStanding } from "./mergeFixLedger";

/** The gates a build passes after Implement, in the line's order (line.cast: verify -> green -> eval -> review). A run
 *  that loops back to Implement re-runs them in this order, so on the last build the first one that failed is where it
 *  stopped, those before it passed, and those after it did not run. */
const GATE_CHAIN: ReadonlyArray<{ id: string; name: string }> = [
  { id: "verify", name: "Verify" },
  { id: "green", name: "Test" },
  { id: "eval", name: "Eval" },
  { id: "review", name: "Review" },
];

export type GateState = {
  step: string;
  name: string;
  /** pass: passed on the last build; red: the gate that sent it back; changes: the reviewer asked for changes; skipped:
   *  not reached on the last build (its record is an earlier round's). */
  state: "pass" | "red" | "changes" | "skipped";
  /** For the red gate: what failed, in the run's own words ("typecheck red"). */
  words: string | null;
};

type GateNode = { node_id: string; status: string };

/** How each gate ended on the run's last build. `redWords`: the run's own words for its red check ("Verify: typecheck
 *  red", runReport checkAt), kept for the gate they name. A Review that completed with no card after it asked for
 *  changes (an approve goes on to the card). */
export function reviewGates(nodes: ReadonlyArray<GateNode>, red: { step: string | null; words: string | null } | null = null): GateState[] {
  const status = new Map(nodes.map((n) => [n.node_id, n.status]));
  const out: GateState[] = [];
  let stopped = false;
  for (const g of GATE_CHAIN) {
    const s = status.get(g.id);
    if (s == null) continue;
    if (stopped) { out.push({ step: g.id, name: g.name, state: "skipped", words: null }); continue; }
    if (s === "failed") {
      const said = red?.step === g.id && red.words ? red.words.replace(new RegExp(`^${g.name}\\b[:\\s]*`, "i"), "").trim() || null : null;
      out.push({ step: g.id, name: g.name, state: "red", words: said && !/^(?:failed|red)$/i.test(said) ? said : null });
      stopped = true;
      continue;
    }
    if (g.id === "review" && s === "completed" && !status.has("card_draft")) {
      out.push({ step: g.id, name: g.name, state: "changes", words: "asked for changes" });
      stopped = true;
      continue;
    }
    out.push({ step: g.id, name: g.name, state: s === "completed" ? "pass" : "skipped", words: null });
  }
  return out;
}

const TEST_ONLY = /^(?:test|tests|chore|revert|style|docs|ci|build)(?:\([^)]*\))?!?:/i;

/** What the change does, in its own commits' words: the newest commit that changes behaviour (not a test, a revert or
 *  a chore), its conventional prefix and trailing task ref taken off. `more`: how many other such commits it has. */
export function changeSays(commits: ReadonlyArray<{ subject: string }> | null | undefined): { line: string; more: number } | null {
  const said = [...new Set((commits ?? []).map((c) => c.subject.trim()).filter((s) => s && !TEST_ONLY.test(s)))];
  const last = said.at(-1);
  if (!last) return null;
  const line = last.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "").replace(/\s*\((?:ct|sd)-\d+\)\s*$/i, "").trim();
  return line ? { line: line.charAt(0).toUpperCase() + line.slice(1), more: said.length - 1 } : null;
}

/** What a built fix waiting on review needs next, from its facts: sent back to its builder when a gate was left red or
 *  the reviewer asked for changes; rebuilt on main when its branch shares files the default branch has moved since
 *  (it may no longer merge cleanly); else it is ready to approve. */
export type ReviewMove = { act: "sendback" | "rebuild" | "approve"; why: string[] };
export function reviewMove(gates: ReadonlyArray<GateState>, standing: BranchStanding | null): ReviewMove {
  const why: string[] = [];
  const red = gates.find((g) => g.state === "red" || g.state === "changes");
  if (red) why.push(red.state === "changes" ? "Review asked for changes" : `${red.name} red${red.words ? `: ${red.words}` : ""}`);
  if (standing?.conflicts) why.push(`${standing.base} moved ${standing.behind} ${standing.behind === 1 ? "commit" : "commits"}, ${standing.onBoth} of its ${standing.onBoth === 1 ? "file" : "files"} changed there too`);
  return { act: red ? "sendback" : standing?.conflicts ? "rebuild" : "approve", why };
}

/** The note the builder reads on the next run (the task's review comments, implement.md): what sends it back. */
export function sendBackNote(move: ReviewMove, base: string | null): string {
  const lines = move.why.map((w) => `- ${w}`);
  const steps = [
    ...(move.why.some((w) => /moved \d+/.test(w)) ? [`Rebase the branch onto ${base ?? "the default branch"} first and resolve what conflicts, keeping the change.`] : []),
    ...(move.act === "sendback" ? ["Make the red gate pass on the rebuilt branch before handing off again."] : []),
  ];
  return [`Sent back from review:`, ...lines, ...steps].join("\n");
}
