import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useInboxStore } from "../store/inboxStore";

// The viewer's calls and recordings, local first: transcripts.webListCalls
// feeds `callList` and transcripts.webGetCall feeds `callDetails` (both
// persisted, clientSyncRegistry). Readers paint the cached rows on the first
// frame; the live queries only keep them current.

const listSig = (c: any) =>
  `${c.title ?? ""}|${c.status}|${c.ended_at ?? ""}|${c.summary_status ?? ""}|${c.transcribe_status ?? ""}|${c.last_seq ?? ""}`;
const newestFirst = (a: any, b: any) => (b.started_at ?? 0) - (a.started_at ?? 0);

/** The newest page of calls, newest first. `ready` is the first live answer;
 *  before it the cached rows stand in. */
export function useCallList(limit = 50): { calls: any[]; ready: boolean } {
  const { ready, error } = useSyncCollection("callList", api.transcripts.webListCalls, { limit });
  const calls = useCollectionRows("callList", { sig: listSig, sort: newestFirst });
  return { calls, ready: ready || !!error };
}

const SELECT_ONE = { select: (d: any) => (d ? [d] : null) };

/** One call with its segments. undefined while neither the cache nor the
 *  server has it, null when the server says the viewer cannot read it. */
export function useCallDetail(transcriptId: string | undefined): any | null | undefined {
  const { refused } = useSyncCollection(
    "callDetails",
    api.transcripts.webGetCall,
    entityIdArgs("transcript_id", transcriptId) as any,
    SELECT_ONE,
  );
  const row = useInboxStore((s: any) => (transcriptId ? s.callDetails?.[transcriptId] : undefined));
  return useMemo(() => (row ? row : refused ? null : undefined), [row, refused]);
}
