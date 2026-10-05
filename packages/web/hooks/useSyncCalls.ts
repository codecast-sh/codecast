import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { callNeedsPlace, type CallPlace } from "../lib/calls/roomLabels";

// The viewer's calls and recordings, local first: transcripts.webListCalls
// feeds `callList` and transcripts.webGetCall feeds `callDetails` (both
// persisted, clientSyncRegistry). Readers paint the cached rows on the first
// frame; the live queries only keep them current.

// Every field a list row draws: the web's history row also shows who spoke,
// whether the huddle is waiting out its idle grace, and a recording's scope.
const listSig = (c: any) =>
  `${c.title ?? ""}|${c.status}|${c.idle_since ?? ""}|${c.ended_at ?? ""}|${c.summary_status ?? ""}|${c.transcribe_status ?? ""}|${c.last_seq ?? ""}|${(c.participants ?? []).map((p: any) => p.name).join(",")}|${c.rec_shared ? 1 : 0}|${c.team_id ?? ""}`;
const newestFirst = (a: any, b: any) => (b.started_at ?? 0) - (a.started_at ?? 0);

/** What one answer of the list is the whole truth about. The list is a delta
 *  overlay (a phone's shorter page must not prune a longer one), so without
 *  this a call the server stops listing stays cached forever: a huddle that
 *  ended with nothing said would read "Live" on every visit, a deleted or
 *  unshared recording would never leave. A full page vouches for everything
 *  back to its oldest call; a short one is everything the server would list.
 *  Older cached calls are outside the window and kept. */
export function callListPruneScope(rows: any[] | null | undefined, limit: number) {
  if (!Array.isArray(rows)) return undefined;
  const floor = rows.length >= limit ? Math.min(...rows.map((r) => r.started_at ?? 0)) : -Infinity;
  return {
    pruneAbsentScope: (row: any) => isConvexId(String(row?._id ?? "")) && (row.started_at ?? 0) >= floor,
  };
}

/** The newest page of calls, newest first. `ready` is the first live answer;
 *  before it the cached rows stand in. `error` (with `retry`) is a feed that
 *  failed, for a surface with nothing cached to show instead. */
export function useCallList(limit = 50): { calls: any[]; ready: boolean; error?: Error; retry: () => void } {
  const syncOpts = useMemo(() => (data: any) => callListPruneScope(data, limit), [limit]);
  const { ready, error, retry } = useSyncCollection("callList", api.transcripts.webListCalls, { limit }, { syncOpts });
  const calls = useCollectionRows("callList", { sig: listSig, sort: newestFirst });
  return { calls, ready: ready || !!error, error, retry };
}

const SELECT_ONE = { select: (d: any) => (d ? [d] : null) };

/** One call with its segments. undefined while neither the cache nor the
 *  server has it, null when the server says the viewer cannot read it: a
 *  refusal wins over the cache, so a deleted call or one whose share was
 *  taken back does not keep painting from what this device saw last. */
export function useCallDetail(transcriptId: string | undefined): any | null | undefined {
  const { refused } = useSyncCollection(
    "callDetails",
    api.transcripts.webGetCall,
    entityIdArgs("transcript_id", transcriptId) as any,
    SELECT_ONE,
  );
  const row = useInboxStore((s: any) => (transcriptId ? s.callDetails?.[transcriptId] : undefined));
  return useMemo(() => (refused ? null : row ?? undefined), [row, refused]);
}

const NO_PLACES: Record<string, CallPlace> = {};

/** The server's place names for the calls the store cannot name
 *  (roomLabels.callNeedsPlace), keyed by call id, for callTitle's `place`.
 *  An enrichment: while it is out, or if it never answers, a row keeps the
 *  name the store gives it. The ids are read as one string out of the store
 *  so a write that changes none of the answers re-renders nothing. */
export function useCallPlaces(calls: any[]): Record<string, CallPlace> {
  const ids = useInboxStore((s: any) =>
    calls
      .filter((c) => c && isConvexId(String(c._id ?? "")) && callNeedsPlace(c, s))
      .map((c) => String(c._id))
      .sort()
      .join(","),
  );
  const { data } = useQueryNoThrow(
    api.transcripts.webCallPlaces,
    ids ? { transcript_ids: ids.split(",") as any } : "skip",
  );
  return (data as Record<string, CallPlace> | undefined) ?? NO_PLACES;
}
