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
