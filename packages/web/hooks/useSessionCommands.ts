// Feeders and readers for the sessionCommands collection (lib/sessionCommands).
import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { conversationCommandRows, type SessionCommandRow } from "../lib/sessionCommands";

// A row still waiting on its daemon, keyed by a request id (a row keyed by its
// command id came from forConversation and is already the server's). A line
// edit's daemon answers twice: the write, then the republish it ran after.
const republishing = (row: any) => row.kind === "line_edit" && typeof row.result === "string" && row.result.includes('"ok":"pending"');
const awaitingResult = (row: any) => (!row.executed_at || republishing(row)) && row._id !== row.command_id;
const unsettledSig = makeCollectionSig((row: any) => (awaitingResult(row) ? row._id : ""));

/**
 * Settles every request this window is waiting on, whichever surface asked:
 * the inbox row's restart, a header move, a switch from a park card. Mounted
 * once per window (the collection is per-window, so never host-gated).
 */
export function useSessionCommandResults(): { error?: Error } {
  const st = useTrackedStore([(s) => unsettledSig(s.sessionCommands)]);
  const requestIds = Object.values(st.sessionCommands as Record<string, SessionCommandRow>)
    .filter(awaitingResult)
    .map((row) => row._id).sort().slice(0, 100).join(",");
  const args = useMemo(() => (requestIds ? { request_ids: requestIds.split(",") } : "skip" as const), [requestIds]);
  const { error } = useSyncCollection("sessionCommands", (api as any).sessionCommands.results, args);
  return { error };
}

const rowSig = (row: any) => `${row._id}|${row.conversation_id}|${row.command}|${row.requested_at}|${row.executed_at}|${row.result}|${row.error}|${row.confirmed_at}`;

/**
 * One conversation's command rows, oldest first, fed with its restart/move
 * pipeline (the kill, a remote move's later resume) while `active`.
 */
export function useConversationCommands(conversationId: string | undefined, active: boolean): SessionCommandRow[] {
  useSyncCollection(
    "sessionCommands",
    (api as any).sessionCommands.forConversation,
    active ? entityIdArgs("conversation_id", conversationId) : "skip",
  );
  const sig = useInboxStore((s) => {
    if (!conversationId) return "";
    let out = "";
    for (const id in s.sessionCommands) {
      const row = s.sessionCommands[id];
      if (row?.conversation_id === conversationId) out += `${rowSig(row)};`;
    }
    return out;
  });
  return useMemo(
    () => (conversationId ? conversationCommandRows(useInboxStore.getState().sessionCommands, conversationId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, sig],
  );
}
