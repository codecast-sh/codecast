// The review of moving a finding out of its problem ("Not this problem",
// line-journeys.md LJ6.3), as plain data: what leaves, from where, to where,
// and how to put it back.
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";

/** `problem`: the problem it leaves, as its ref. `count`: the findings that leave with it (its problem's findings under the
 *  same key, since a key is one place). `left`: how many findings the problem keeps. */
export function moveFindingLedger(r: { problem: string; count: number; left: number }): SwitchLedger {
  return {
    name: "Not this problem",
    subject: r.problem,
    shift: ["Here", "Own problem"],
    alert: r.left === 0 ? "Leaves it with none" : undefined,
    figures: [
      { value: String(r.count), label: r.count === 1 ? "finding moves" : "findings move" },
      { value: String(r.left), label: "stay", tone: r.left === 0 ? "warn" : undefined },
    ],
    rows: [
      { k: "Moves to", v: "A new problem" },
      ...(r.count > 1 ? [{ k: "Why many", v: "Same source key" }] : []),
      { k: "Starts", v: "Nothing" },
      { k: "To undo", v: "Move it back" },
    ],
    confirm: r.count === 1 ? "Move it out" : `Move ${r.count} out`,
    keep: "Keep it here",
  };
}

/** "Merge into ct-N": a problem the line reads as an older one's twin folds into it (convex signals mergeProblemCore). */
export function mergeProblemLedger(r: { twin: string; into: string; findings: number | null; twinProject?: string | null; intoProject?: string | null }): SwitchLedger {
  return {
    name: "Merge",
    subject: `${r.twin} into ${r.into}`,
    shift: [r.twin, r.into],
    figures: [
      ...(r.findings != null ? [{ value: String(r.findings), label: r.findings === 1 ? "finding moves" : "findings move" }] : []),
      { value: "1", label: "problem left" },
    ],
    rows: [
      ...(r.twinProject && r.intoProject && r.twinProject !== r.intoProject ? [{ k: "Projects", v: `${r.twinProject} → ${r.intoProject}` }] : []),
      { k: r.twin, v: "Dropped as duplicate" },
      { k: "Starts", v: "Nothing" },
      { k: "To undo", v: "No one step", tone: "warn" },
    ],
    confirm: `Merge into ${r.into}`,
    keep: "Keep both",
  };
}

/** "Make this a problem" on a group of a finder's asks under one cause (Team asks, LJ8.5): the unfiled ones become one
 *  problem titled by the cause, or join `into`, the open problem the group's filed asks already sit on (convex signals
 *  makeProblemOfFindingCore with the group); filed ones stay where they are. */
export function askCauseLedger(r: { cause: string; unfiled: string[]; filed: number; into?: string | null }): SwitchLedger {
  const n = r.unfiled.length;
  return {
    name: r.into ? `File into ${r.into}` : "Make this a problem",
    subject: r.cause,
    shift: null,
    figures: [
      { value: String(n), label: n === 1 ? "ask filed" : "asks filed" },
      { value: r.into ? "0" : "1", label: "new problem" },
    ],
    rows: [
      { k: "Asks", v: n === 1 ? "1 contact" : `${n} contacts`, list: r.unfiled },
      ...(r.filed ? [{ k: "Already filed", v: r.into ? `${r.filed} on ${r.into}` : `${r.filed} stay where they are` }] : []),
      { k: "Starts", v: "Nothing" },
      { k: "To undo", v: "Not this problem, per ask" },
    ],
    confirm: r.into ? `File ${n} into ${r.into}` : n === 1 ? "Make it a problem" : `File ${n} as one problem`,
    keep: "Not now",
  };
}
