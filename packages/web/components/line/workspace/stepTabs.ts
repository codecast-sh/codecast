// A step's tabs (line-workspace.md LW1): the same words in the same order in
// the drawer and the Notebook, so a step reads one way wherever it opens.
import type { LineStep } from "../../../lib/line/lineModel";
import { LINE_ACTIONS } from "../widgets/actionSlots";
import type { DrawerTab } from "./stepDrafts";

export type StepTab = { key: DrawerTab; label: string; count?: number; tone?: "person" };

/** The tabs a step's kind has, in order, with their words. */
export function stepTabs(step: LineStep): StepTab[] {
  const n = step.decisions.length;
  if (step.kind === "agent") {
    return [
      { key: "prompt", label: "Prompt" },
      { key: "decisions", label: "Decisions", count: n },
      ...(LINE_ACTIONS.Try ? [{ key: "try" as const, label: "Try" }] : []),
      ...(LINE_ACTIONS.Ask ? [{ key: "ask" as const, label: "Ask an agent", tone: "person" as const }] : []),
    ];
  }
  if (step.kind === "person") return [{ key: "prompt", label: "Question" }, { key: "decisions", label: "Answers", count: n, tone: "person" }];
  if (step.kind === "script") return [{ key: "prompt", label: "Command" }, { key: "decisions", label: "Runs", count: n }];
  return [{ key: "decisions", label: "Runs", count: n }];
}
