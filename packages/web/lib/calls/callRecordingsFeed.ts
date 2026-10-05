// A call's files in the store, fed and read on every platform: the web's
// call page, its share popover and each frame embed, and the phone's call
// detail. Here rather than in hooks/useRoomRecording (which re-exports all
// of it for web callers), because that module says refusals in a web toast
// and Metro cannot read it; this one is store and Convex only, and keeps off
// the `@/` alias, which means the mobile app on the phone.
import { useMemo, useRef } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { callRecordingUrlWindow, type CallRecordingKind, type CallRecordingStatus } from "@codecast/shared/contracts";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { syncTransaction } from "../../store/syncTransaction";
import { useFeederError } from "../../hooks/useSyncCollection";
import { useConvexSync } from "../../hooks/useConvexSync";
import { useServerAuthSettled } from "../../hooks/useServerAuthSettled";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { keepCallFrames } from "./momentFrames";

// ── A call's files ───────────────────────────────────────────────────────

export type CallRecordingRow = {
  _id: string;
  run_id: string;
  kind: CallRecordingKind;
  status: CallRecordingStatus;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  size_bytes: number | null;
  participant_identity: string | null;
  participant_name: string | null;
  started_by: string;
  started_by_name: string;
  requested_at: number;
  stop_reason: string | null;
  error: string | null;
  url: string | null;
  url_expires_at: number | null;
  can_delete: boolean;
};

export type CallRecordings = {
  transcript_id: string;
  short_id: string | null;
  call_started_at: number;
  call_ended_at: number | null;
  configured: boolean;
  share_link: boolean;
  video_shared: boolean;
  /** Room videos finished after the video was put on the link, which the
   *  link does not show until somebody includes them again. */
  video_later?: number;
  /** Whether this viewer may put the video on the link (the presser of every
   *  room video, or a team admin); taking it off is anyone's. */
  can_share_video?: boolean;
  /** This window deleted a run of the call, at this time (store
   *  deleteCallRecording); the thread's line says so for everyone else. */
  deleted_here_at?: number;
  /** The rows' URLs are past their window and the next answer is on its way
   *  (the tab slept through a rollover): a player already on screen keeps its
   *  place and says it is refreshing, rather than that the video is gone. */
  refreshing?: boolean;
  recordings: CallRecordingRow[];
  /** The pictures of the call on public links (`cast call snap --share`),
   *  newest first; absent from a server older than them. */
  frame_shares?: CallFrameShare[];
};

/** A picture of a call on a public link: the moment and view it shows, who
 *  shared it, and the URL anyone holding it can open. */
export type CallFrameShare = {
  _id: string;
  recording_id: string;
  kind: CallRecordingKind | null;
  participant_identity: string | null;
  participant_name: string | null;
  at_ms: number | null;
  url: string | null;
  shared_by: string;
  shared_by_name: string;
  created_at: number;
};
export type StoredFrameShare = CallFrameShare & { transcript_id: string };

/** The presigning window a page is in, moving only when it rolls over (four
 *  times an hour), so the recordings query is re-asked then and not on every
 *  tick (shared callRecordingUrlWindow). */
export function useCallRecordingUrlWindow(): number {
  const now = useNowWhen((t) => String(callRecordingUrlWindow(t)), 30_000);
  return callRecordingUrlWindow(now);
}

// A call's video lives in the store (registry callRecordings and
// callRecordingCalls), fed by whatever shows it. Every caller mounts the
// feeder and asks by the call's full id: the call page, its share popover and
// each frame embed of the call ask the same question, so Convex holds one
// subscription between them, and a surface that mounts later paints from what
// the store already holds. One
// answer feeds both collections in one store transaction (syncTransaction),
// so no render sees a call's files without its facts. The window rolling
// over is a new question with the same rows: the store keeps the last answer
// while the next loads, so the player on screen is never unmounted. Its
// URLs are signed for a window, though, so an answer held past them is not
// painted (useCallRecordings).

const CALL_FACTS = ["short_id", "call_started_at", "call_ended_at", "configured", "share_link", "video_shared", "video_later", "can_share_video"] as const;
type CallRecordingFacts = Omit<CallRecordings, "recordings" | "transcript_id"> & { _id: string };
type StoredRecordingRow = CallRecordingRow & { transcript_id: string };

// Which file ids each call's answers have carried in this tab, so a push
// releases only its own call's tombstones: a frame of another call open
// beside the page answers nothing about this one's delete in flight.
const seenFiles = new Map<string, Set<string>>();
// The same for each call's shared pictures (registry callFrameShares).
const seenShares = new Map<string, Set<string>>();

/** The tombstones an answer has settled: files of this call it no longer
 *  sends, and any whose call this tab never saw (planted in an earlier life
 *  of the tab, so nothing here holds them out any more). */
export function releasedRecordingTombstones(
  pending: Record<string, { type?: string } | undefined>,
  transcriptId: string,
  present: string[],
  seen: ReadonlyMap<string, ReadonlySet<string>>,
  collection: "callRecordings" | "callFrameShares" = "callRecordings",
): string[] {
  const here = new Set(present);
  const mine = seen.get(transcriptId);
  const released: string[] = [];
  const prefix = `${collection}:`;
  for (const [key, entry] of Object.entries(pending)) {
    if (entry?.type !== "exclude" || !key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (here.has(id)) continue;
    if (mine?.has(id) || ![...seen.values()].some((ids) => ids.has(id))) released.push(id);
  }
  return released;
}

function applyCallRecordings(data: CallRecordings | null | undefined): void {
  if (!data) return;
  const st = useInboxStore.getState() as any;
  const rows = data.recordings.map((r) => ({ ...r, transcript_id: data.transcript_id }));
  const present = rows.map((r) => r._id);
  // A file gone from the call (a run deleted) takes its kept frames with it.
  keepCallFrames(data.transcript_id, new Set(present));
  const released = releasedRecordingTombstones(st.pending ?? {}, data.transcript_id, present, seenFiles);
  noteSeen(seenFiles, data.transcript_id, present, released);
  // A server older than shared pictures sends none: nothing to say about them.
  const shares = data.frame_shares?.map((f) => ({ ...f, transcript_id: data.transcript_id }));
  const sharesPresent = shares?.map((f) => f._id) ?? [];
  const sharesReleased = shares ? releasedRecordingTombstones(st.pending ?? {}, data.transcript_id, sharesPresent, seenShares, "callFrameShares") : [];
  if (shares) noteSeen(seenShares, data.transcript_id, sharesPresent, sharesReleased);
  syncTransaction(() => {
    st.syncTable("callRecordingCalls", [
      { _id: data.transcript_id, ...Object.fromEntries(CALL_FACTS.map((k) => [k, data[k]])) } as CallRecordingFacts,
    ]);
    // Each answer is the call's complete set of files: a run deleted from
    // another window leaves this one too.
    st.syncTable("callRecordings", rows, {
      isDelta: true,
      pruneAbsentScope: (r: any) => r.transcript_id === data.transcript_id,
    });
    if (released.length) st.settleCallRecordingTombstones(released);
    if (shares) {
      st.syncTable("callFrameShares", shares, {
        isDelta: true,
        pruneAbsentScope: (r: any) => r.transcript_id === data.transcript_id,
      });
      if (sharesReleased.length) st.settleCallRecordingTombstones(sharesReleased, "callFrameShares");
    }
  });
}

function noteSeen(map: Map<string, Set<string>>, transcriptId: string, present: string[], released: string[]): void {
  const seen = map.get(transcriptId) ?? new Set<string>();
  for (const id of present) seen.add(id);
  for (const id of released) seen.delete(id);
  map.set(transcriptId, seen);
}

/** The server answered null for a call the store may hold: the viewer can no
 *  longer read it (removed from the team, the session made private, calls
 *  switched off), or it is gone. Its files and facts leave the store at once,
 *  so no player or frame embed keeps playing a signed URL until it lapses.
 *  Keyed by the full id every caller asks under, the id the facts row and
 *  the files' transcript_id carry. */
export function forgetCallRecordings(call: string): void {
  // The pictures kept of its moments go too (lib/calls/momentFrames), even
  // when the store held nothing of the call.
  keepCallFrames(call);
  const st = useInboxStore.getState() as any;
  if (!callFactsOf(st, call) && !Object.values(st.callRecordings ?? {}).some((r: any) => r.transcript_id === call)) return;
  seenFiles.delete(call);
  seenShares.delete(call);
  syncTransaction(() => {
    st.syncTable("callRecordings", [], { isDelta: true, pruneAbsentScope: (r: any) => r.transcript_id === call });
    st.syncTable("callRecordingCalls", [], { isDelta: true, pruneAbsentScope: (r: any) => r._id === call });
    st.syncTable("callFrameShares", [], { isDelta: true, pruneAbsentScope: (r: any) => r.transcript_id === call });
  });
}

// Every field a reader paints: the player and the notices (status, clock,
// URL, who started it, whose screen), the chips (grouped by identity) and
// the sort (requested_at). The rest of a row never changes after insert.
const rowSig = (r: StoredRecordingRow) =>
  `${r.status}|${r.started_at}|${r.ended_at}|${r.duration_ms}|${r.size_bytes}|${r.url}|${r.url_expires_at}|${r.error}|${r.stop_reason}|${r.can_delete ? 1 : 0}|${r.participant_identity}|${r.participant_name}|${r.started_by_name}|${r.requested_at}`;
const byRequestThenStart = (a: StoredRecordingRow, b: StoredRecordingRow) =>
  a.requested_at - b.requested_at || (a.started_at ?? 0) - (b.started_at ?? 0);
const NO_ROWS: StoredRecordingRow[] = [];
const FACTS_SIG_FIELDS = [...CALL_FACTS, "deleted_here_at"] as const;

/** The call's facts in the store, by the call's full id (what every caller
 *  asks under, and what the feeder keys them by). */
function callFactsOf(st: any, call: string | null | undefined): CallRecordingFacts | undefined {
  return call ? ((st.callRecordingCalls ?? {}) as Record<string, CallRecordingFacts>)[call] : undefined;
}

/** What a caller does with stored rows whose URLs are past their window
 *  while the next answer loads: `hold` them back on a first mount (the page
 *  keeps the player's place), keep them `refreshing` under a player already
 *  on screen, and `paint` when nothing has lapsed. */
export function lapsedRowsVerdict(lapsed: boolean, hadAnswer: boolean): "paint" | "hold" | "refreshing" {
  if (!lapsed) return "paint";
  return hadAnswer ? "refreshing" : "hold";
}

/** A signed URL past its window: an element handed it would be refused. */
const urlLapsed = (r: CallRecordingRow, now: number) => !!r.url && r.url_expires_at !== null && r.url_expires_at <= now;

/** A call's recordings, by the call's full id: undefined while loading, null
 *  when there is nothing to show (no such call for this viewer, or a server
 *  without callRecordings, whose error degrades to "no video" rather than a
 *  surface that waits forever). */
export function useCallRecordings(call: string | null | undefined): CallRecordings | null | undefined {
  const urlWindow = useCallRecordingUrlWindow();
  const authSettled = useServerAuthSettled();
  const args = call && authSettled ? { call, url_window: urlWindow } : ("skip" as const);
  const { data, error } = useQueryNoThrow(api.callRecordings.webCallRecordings, args);
  useFeederError("callRecordings.webCallRecordings", error);
  useConvexSync(data as CallRecordings | null | undefined, (answer) => (answer ? applyCallRecordings(answer) : call && forgetCallRecordings(call)));

  const factsSig = useMemo(
    () =>
      Object.assign(
        (st: any) => {
          const row = callFactsOf(st, call) as any;
          return row ? `${row._id}|${FACTS_SIG_FIELDS.map((k) => row[k]).join("|")}` : "";
        },
        { label: "callRecordingFacts" },
      ),
    [call],
  );
  const s = useTrackedStore([factsSig]);
  const factsKey = factsSig(s);
  const facts = callFactsOf(s, call);
  const transcriptId = facts?._id ?? null;
  const where = useMemo(() => (r: StoredRecordingRow) => r.transcript_id === transcriptId, [transcriptId]);
  const rows = useCollectionRows<StoredRecordingRow>("callRecordings", { where, sig: rowSig, sort: byRequestThenStart });
  const recordings = transcriptId ? rows : NO_ROWS;
  // The store holds a call's rows for the life of the tab, and their URLs
  // for one window. Until this window's answer lands, rows signed for an
  // earlier one are not an answer: painted, the element would be refused
  // and the surface would say the video could not load. A surface mounting
  // onto them holds the player's place (the frame its pulse) instead. Only
  // a FIRST mount, though: once this caller has had an answer its player is
  // on screen, and taking the rows away (the tab slept through a rollover,
  // the next answer a moment off) would unmount it and lose the person's
  // place. Then the rows stay, marked `refreshing`, and the element that is
  // refused takes the next URL where it was (useStableMediaSrcs).
  const answered = data !== undefined;
  const answeredFor = useRef<string | null>(null);
  if (answered && call) answeredFor.current = call;
  const verdict = lapsedRowsVerdict(
    !answered && recordings.some((r) => urlLapsed(r, Date.now())),
    !!call && answeredFor.current === call,
  );

  return useMemo(() => {
    if (!call || data === null) return null;
    if (!facts) return error ? null : undefined;
    if (verdict === "hold") return undefined;
    const { _id, ...rest } = facts;
    return { ...rest, transcript_id: _id, recordings, ...(verdict === "refreshing" ? { refreshing: true } : {}) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- facts is read through its signature
  }, [call, data === null, !!error, factsKey, recordings, verdict]);
}

