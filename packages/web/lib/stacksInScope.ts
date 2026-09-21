import { type DecisionStackItem } from "../store/inboxStore";

/** Stacks that hold at least one decision bound to a task in scope (the-line.md L10). */
export function stacksInScope(stacks: DecisionStackItem[], decisionIds: Set<string>): DecisionStackItem[] {
  return stacks.filter((st) => st.status === "open" && st.decision_ids.some((id) => decisionIds.has(id)));
}
