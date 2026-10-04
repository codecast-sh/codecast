// How a room's last recording run ended, and what the room is told about it:
// the pure half of the stop notice, shared by every platform that sits in a
// huddle. The web's notice (components/calls/RoomRecording) and the phone's
// call screen (mobile app/call.tsx) say the same words from the same facts,
// so a run LiveKit refused reads the same on a laptop and in a hand.
//
// Kept free of the web call engine and of the `@/` alias: Metro reads this
// file for the phone, where `@/` means the mobile app.
import { api } from "@codecast/convex/convex/_generated/api";
import {
  callAnchorHref,
  callMomentHref,
  recordingFailureWords,
  recordingStoppedItselfWords,
  type CallRecordingStopReason,
} from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { firstName, speakerShortName } from "../../components/calls/speakers";
import type { RoomRecordingLive } from "./roomRecordingFields";

/** How the room's last run ended (convex roomRecordingEnd): still being
 *  finished, finished, or failed, why, and who stopped it if somebody did.
 *  Absent on a server older than it. */
export type RoomRecordingEnd = {
  run_id: string;
  status: "stopping" | "ready" | "failed";
  stop_reason: CallRecordingStopReason | null;
  error: string | null;
  stopped_by: { id: string; name: string } | null;
  /** Where the video went: the call, its short id, and where in the call
   *  the file begins. Absent from a server older than them. */
  transcript_id?: string;
  short_id?: string | null;
  at_ms?: number | null;
};

/** How the room's last run ended, for the notice that says so: undefined
 *  while loading, null when it cannot be known here. Its own narrow query
 *  (callRecordings.getRoomRecordingEnd), whose read set is the room's ended
 *  runs alone: it is mounted in every window of everyone seated, for the
 *  whole huddle, and re-runs only as a run ends. An enrichment, so a server
 *  without the query degrades to "Recording stopped". */
export function useRoomRecordingEnded(roomKey: string | null | undefined): RoomRecordingEnd | null | undefined {
  const { data, error } = useQueryNoThrow(api.callRecordings.getRoomRecordingEnd, roomKey ? { room_key: roomKey } : "skip");
  if (error || data === null) return null;
  return data === undefined ? undefined : (data as RoomRecordingEnd);
}

/** What the room is told while a run is filming: the title every surface
 *  shows (the web's toast, banner and system banner, the phone's card). */
export const RECORDING_STARTED_TITLE = "This call is being recorded";

/** What the room is told when the run's video will be on the call's public
 *  link (callRecordings: a link whose video was chosen before this press):
 *  faces and screens, guests' included, then reach anyone with the link. */
export const RECORDING_SHARED_WORDS = "The video is shared by the call's public link.";

/** The body under RECORDING_STARTED_TITLE: who pressed, whether the video
 *  goes out with the public link, and that anyone may stop it. Consent copy,
 *  so the web and the phone say it from this one place. Without the run (a
 *  server too old to send it) it says what is kept, and nothing it cannot
 *  know. */
export function startedWords(live: Pick<RoomRecordingLive, "started_by" | "video_shared"> | null | undefined): string {
  if (!live) return "Video and shared screens are kept with the call. Anyone in the call can stop it.";
  const shared = live.video_shared ? ` ${RECORDING_SHARED_WORDS}` : "";
  return `${firstName(live.started_by.name)} started recording.${shared} Anyone in the call can stop it.`;
}

/** The call a run's video went to, by its short id when the server sent
 *  one: what a notice names. */
const savedTo = (end: RoomRecordingEnd | null) => end?.short_id ?? "the call";

/** Where a notice's Open goes: the call page at the run's first frame (or
 *  the whole call, before LiveKit said where that is). Null from a server
 *  that did not say which call. */
export function recordingEndHref(end: RoomRecordingEnd | null | undefined): string | null {
  // A run that failed left nothing to open.
  if (!end?.transcript_id || end.status === "failed") return null;
  return end.at_ms != null ? callMomentHref(end.transcript_id, end.at_ms) : callAnchorHref(end.transcript_id);
}

/** What the room is told when a run stops, from how it ended (convex
 *  roomRecordingEnd): who stopped it, or why it stopped on its own, whether
 *  there is a video at all, and where it went. "Saving" is said only of a
 *  run that was filming; a run LiveKit refused or lost left nothing to save.
 *  Unknown (a server older than the end facts), it says only that it
 *  stopped. */
export function stoppedWords(end: RoomRecordingEnd | null, me: string | null): { title: string; body: string; failed: boolean } {
  const by = end?.stopped_by ? (me && end.stopped_by.id === me ? "You" : speakerShortName(end.stopped_by.name)) : null;
  const pressed = by && end?.stop_reason === "pressed" ? `${by} stopped recording` : null;
  if (end?.status === "failed") {
    return { title: pressed ?? "Recording failed", body: recordingFailureWords(end.error), failed: !pressed };
  }
  const title = pressed ?? recordingStoppedItselfWords(end?.stop_reason) ?? "Recording stopped";
  const body = !end ? "" : end.status === "ready" ? `The video is saved to ${savedTo(end)}.` : `The video is saving to ${savedTo(end)}.`;
  return { title, body, failed: false };
}

/** Did the run stop without anybody asking, while the huddle went on? It
 *  failed, hit a time limit, LiveKit ended it, or the room stood empty
 *  (a laptop asleep, a slow reload). The people still in the call may not
 *  notice the mark going, and keep talking as if they were recorded, so
 *  that notice stays up until it is dismissed and offers to record again.
 *  A press, the huddle ending, or a share ending is somebody's own doing. */
export function stoppedByItself(end: RoomRecordingEnd | null | undefined): boolean {
  if (!end) return false;
  if (end.stop_reason === "failed" || end.stop_reason === "limit" || end.stop_reason === "ended" || end.stop_reason === "room_empty") return true;
  return end.status === "failed" && !end.stop_reason;
}

/** The presser's own line, once the run they stopped has landed: where it
 *  went, quietly. */
export function savedWords(end: RoomRecordingEnd | null): string {
  return `Recording saved to ${savedTo(end)}`;
}

/** A stop's notice as every surface shows it: the words for how it is said
 *  (`saved`, the presser's own landed run; `say`, the stop or a failure),
 *  whether it stays until dismissed (stoppedByItself), and where its Open
 *  goes. The web's banner, toast and system banner and the phone's card all
 *  take it from here, so none of them can say a stop differently or let one
 *  that matters go by itself. */
export type StopNoticeCard = { title: string; body: string; failed: boolean; sticky: boolean; href: string | null };

export function stopNoticeCard(how: "saved" | "say", end: RoomRecordingEnd | null | undefined, me: string | null): StopNoticeCard {
  const words = how === "saved" ? { title: savedWords(end ?? null), body: "", failed: false } : stoppedWords(end ?? null, me);
  return { ...words, sticky: stoppedByItself(end), href: recordingEndHref(end) };
}

/** Whether a stopped run's line is said to this person yet, and which.
 *  Whoever pressed Stop (from whichever window or device: the end names who
 *  stopped it, the same fact on every screen) is not told they stopped it;
 *  once the file lands they get one quiet line saying where it went
 *  (`saved`), and if it never lands, the failure (`say`). Everyone else gets
 *  the stop (`say`). `wait` holds while the run's end has not arrived (the
 *  room's row and the end are two subscriptions; the end follows within a
 *  push), and while the presser's file is still saving. A server too old to
 *  send the end (null) cannot say who stopped it, so the line is said. */
export function stopNoticeVerdict(end: RoomRecordingEnd | null | undefined, runId: string, me: string | null): "say" | "saved" | "wait" {
  if (end === null) return "say";
  if (!end || end.run_id !== runId) return "wait";
  if (!(me && end.stop_reason === "pressed" && end.stopped_by?.id === me)) return "say";
  return end.status === "ready" ? "saved" : end.status === "failed" ? "say" : "wait";
}

/**
 * The run to tell its presser about when it failed unseen: this person's own
 * press made it (`pressedRun`, the press's answer), the room's last end is
 * that run failing, and this screen never saw it live (`seenRun`), which is
 * how a press LiveKit refuses within a push looks: the mark shows the press
 * in flight, then simply goes. Shaped as the run the notice speaks of; null
 * when nothing is owed this way.
 */
export function unseenPressedFailure(
  end: RoomRecordingEnd | null | undefined,
  pressedRun: string | null,
  seenRun: string | null,
): RoomRecordingLive | null {
  if (!end || end.status !== "failed" || !pressedRun || end.run_id !== pressedRun || seenRun === end.run_id) return null;
  return { status: "starting", run_id: end.run_id, started_by: { id: "", name: "" }, requested_at: 0, started_at: null, stop_requested_at: null, video_shared: false };
}

// ── Watching a room's runs ────────────────────────────────────────────────
//
// Which run a screen saw filming, and which stop it still owes its person,
// as one step per push of the room's row: the web's notice and the phone's
// call screen both walk it, so "a stop is said once, a refused press is
// still said to its presser, a newer run makes the last stop old news" is
// one rule rather than two that drift.

/** How long a stop stays worth saying to someone who was not looking. */
export const STOP_NEWS_MS = 10 * 60_000;

/** What a screen has seen of one room's runs: the run last seen filming (to
 *  tell a stop from a room never recorded), every run seen filming, and the
 *  stop it still owes its person. */
export type RoomRunWatch = {
  room: string | null;
  live: RoomRecordingLive | null;
  shown: Set<string>;
  stop: { was: RoomRecordingLive; at: number } | null;
};

export function roomRunWatch(room: string | null): RoomRunWatch {
  return { room, live: null, shown: new Set(), stop: null };
}

/**
 * One step: the room's run as its row has it now (`live`, null when nothing
 * runs), how the last run ended, and the run this person's own press made.
 * Updates the watch and answers the run filming now and the run that stopped
 * on this step (each screen's sounds hang on those). `noticed` says whether a
 * stop was already said, here or on another screen of this person's.
 */
export function watchRoomRun(
  w: RoomRunWatch,
  live: RoomRecordingLive | null | undefined,
  end: RoomRecordingEnd | null | undefined,
  pressedRun: string | null,
  noticed: (key: string) => boolean,
  now: number,
): { running: RoomRecordingLive | null; stopped: RoomRecordingLive | null } {
  const was = w.live;
  const running = live && live.status !== "stopping" ? live : null;
  if (running) {
    w.live = running;
    w.shown.add(running.run_id);
    // A newer run is the news now; the last one's stop is not.
    if (w.stop && w.stop.was.run_id !== running.run_id) w.stop = null;
  }
  let stopped: RoomRecordingLive | null = null;
  if (was && (!live || live.run_id !== was.run_id || live.status === "stopping")) {
    w.live = running;
    stopped = was;
    if (!noticed(stopNoticeKey(was.run_id))) w.stop = { was, at: now };
  }
  // A run this person pressed for that LiveKit refused before any push
  // showed it live: the steps above never saw it, but the presser is owed
  // the reason all the same, through the notice every stop takes.
  const unseen = unseenPressedFailure(end, pressedRun, end && w.shown.has(end.run_id) ? end.run_id : null);
  if (unseen && !w.stop && !noticed(stopNoticeKey(unseen.run_id))) w.stop = { was: unseen, at: now };
  return { running, stopped };
}

/** The key a stop's notice is claimed under, once said. */
export const stopNoticeKey = (runId: string) => `stop:${runId}`;

/**
 * The stop a watch owes its person, if any, and how to say it now: `saved`
 * (their own Stop, landed), `say` (the stop, or a failure), `wait` (the end
 * has not arrived, or their file is still saving), or `drop` (said already,
 * or old news). `end` is the run's own end when the server sent it.
 */
export function owedStopNotice(
  w: RoomRunWatch,
  end: RoomRecordingEnd | null | undefined,
  me: string | null,
  noticed: (key: string) => boolean,
  now: number,
): { stop: NonNullable<RoomRunWatch["stop"]>; key: string; how: "saved" | "say" | "wait" | "drop"; end: RoomRecordingEnd | null } | null {
  const stop = w.stop;
  if (!stop) return null;
  const key = stopNoticeKey(stop.was.run_id);
  const own = end?.run_id === stop.was.run_id ? end : null;
  if (now - stop.at >= STOP_NEWS_MS || noticed(key)) return { stop, key, how: "drop", end: own };
  const verdict = stopNoticeVerdict(end, stop.was.run_id, me);
  // `saved` names where the file went, so it needs the run's own end.
  return { stop, key, how: verdict === "saved" && !own ? "wait" : verdict, end: own };
}
