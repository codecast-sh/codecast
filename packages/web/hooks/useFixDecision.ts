import { useInboxStore } from "../store/inboxStore";
import { openFixDecisionFor, openFixDecisions, type FixDecisionRow } from "../lib/line/fixDecision";

type StoreRows = Record<string, FixDecisionRow> | undefined;

/** The open fix decision waiting on a problem (its task id), from the store; null when none waits. */
export function useOpenFixDecision(taskId: string | null | undefined): FixDecisionRow | null {
  return useInboxStore((s) => openFixDecisionFor(s.sessionDecisions as unknown as StoreRows, (s as { lineCards?: StoreRows }).lineCards, taskId));
}

/** Every open fix decision by problem task id, for a list that marks each row. Stable while neither collection changes. */
export function useOpenFixDecisions(): Map<string, FixDecisionRow> {
  return useInboxStore((s) => openFixDecisions(s.sessionDecisions as unknown as StoreRows, (s as { lineCards?: StoreRows }).lineCards));
}
