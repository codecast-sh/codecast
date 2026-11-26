// Ship again from a run (the run card's button, a change run's page, the phone's run screen): the session that made the
// change is asked to send it through the same flow, one press at a time. The press is read back as the header's Ship
// reads it (lib/line/flowMessages pressWaiting): waiting while the session has neither started its run nor declined, so
// a double press starts one run, and free again once the session answered without one. A press whose message never
// comes back (the thread not loaded here) frees it after a minute: no dead end. Pure of any UI: the phone uses it too.
import { useMemo, useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useSessionFlowRuns } from "./useSyncWorkflows";
import { useCoarseNow } from "./useCoarseNow";
import { usePressApproval } from "./usePressApproval";
import { PRESS_WAIT_MS, pressFromSig, pressSig, pressWaiting, runThroughMessage, type Press, type PressMsg, type SentPress } from "../lib/line/flowMessages";
import { sessionIdleAt } from "../lib/liveness";
import type { JudgedFile } from "../lib/ship/judgedEdits";

/** The newest Ship press in the session's thread since its newest run started. */
export function usePress(conversationId: string, newestRunAt: number): Press | null {
  const sig = useInboxStore((s) => pressSig((s.messages as Record<string, PressMsg[]>)[conversationId] ?? [], newestRunAt));
  return useMemo(() => pressFromSig(sig), [sig]);
}

/** Whether the session has settled: its turn is over, so a press it answered without a run will not start one. Unknown is not settled. */
export function useSettled(conversationId: string): boolean {
  // Settling can come from time alone (a heartbeat that stops), so the read follows a clock as well as the row.
  const now = useCoarseNow(15_000);
  return useInboxStore((s) => {
    const row = ((s as any).sessions?.[conversationId] ?? (s as any).conversations?.[conversationId]) as Parameters<typeof sessionIdleAt>[0] | undefined;
    return row ? sessionIdleAt(row, now) : false;
  });
}

/**
 * Ship again for one session through one flow. `reviewing`: the confirm is open, which is when the judged files it
 * approves are read (usePressApproval); `send` records them as the person's approval and sends the run request. A
 * one-click press lists none, so it approves nothing. `sent` stays true while the press is in flight.
 */
export function useShipAgain(flow: { slug: string; label: string } | null, conversationId: string | null, reviewing: boolean): { sent: boolean; send: () => void; files: JudgedFile[] | null } {
  const id = conversationId ?? "";
  const approval = usePressApproval(id, reviewing && !!conversationId);
  const runs = useSessionFlowRuns(conversationId);
  const newest = runs?.[0] ?? null;
  const press = usePress(id, newest?.created_at ?? 0);
  const settled = useSettled(id);
  const [mine, setMine] = useState<SentPress | null>(null);
  const sent = pressWaiting({ sent: mine, newestRun: newest?._id ?? null, press, settled });
  const send = () => {
    if (sent || !flow || !conversationId) return;
    const at: SentPress = { run: newest?._id ?? null, press: press?.id ?? null };
    setMine(at);
    setTimeout(() => setMine((m) => (m === at ? null : m)), PRESS_WAIT_MS);
    void approval.record();
    useInboxStore.getState().sendMessage(conversationId, runThroughMessage(flow));
  };
  return { sent, send, files: approval.files };
}
