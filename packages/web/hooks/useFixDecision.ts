import { useInboxStore } from "../store/inboxStore";
import { decisionTask, openFixDecisionFor, type FixDecisionRow } from "../lib/line/fixDecision";

type StoreRows = Record<string, FixDecisionRow> | undefined;

/** The open fix decision waiting on a problem (its task id), from the store; null when none waits. */
export function useOpenFixDecision(taskId: string | null | undefined): FixDecisionRow | null {
  return useInboxStore((s) => openFixDecisionFor(s.sessionDecisions as unknown as StoreRows, (s as { lineCards?: StoreRows }).lineCards, taskId));
}


/** The problem (task id) a decision named by ref is about; undefined when the store does not hold it. */
export function useDecisionTask(ref: string | null | undefined): string | null | undefined {
  return useInboxStore((s) => (ref ? decisionTask(s.sessionDecisions as unknown as StoreRows, (s as { lineCards?: StoreRows }).lineCards, ref) : undefined));
}
