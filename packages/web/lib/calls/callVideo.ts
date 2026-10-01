// The call page's video, as a model: which file plays, what moment of the call
// it is showing, and which transcript line that moment is. Pure, so the page,
// the public share page and a frame embed in a message all ask the same
// questions of the same rows (convex callRecordings, webCallRecordings) and
// can never disagree about where a line is in the picture.
//
// Two clocks meet here. A transcript line's t0/t1 are ms since the call's
// started_at; a file's currentTime is seconds since its own started_at (the
// wall clock LiveKit reported for its first frame). Every conversion goes
// through the wall clock, the way locateCallMoment does, which is the one
// place the alignment rule is written.

import {
  locateCallMoment,
  offsetIntoRecording,
  playableFiles,
  segmentAt,
  type CallMomentPrefer,
  type CallRecordingSpan,
} from "@codecast/shared/contracts";
import { formatCallTime } from "@codecast/shared/entities";

// The files that can be played (finished, with a URL, and a time 0) are the
// shared contract's rule, which the CLI's frame grab reads too.
export { playableFiles };

/** A recording row as the call page reads it (webCallRecordings), or a shared
 *  video (getSharedCall) shaped to match. */
export type CallVideoFile = CallRecordingSpan & {
  /** The press this file belongs to: a composite's own id, a screen file's
   *  composite. Absent on a shared video, which is always its own run. */
  run_id?: string | null;
  url: string | null;
  error?: string | null;
  stop_reason?: string | null;
  can_delete?: boolean;
  started_by_name?: string | null;
};

/** Where in the call (ms since its started_at) a file's position is. */
export function callMsOf(file: Pick<CallVideoFile, "started_at">, callStartedAt: number, fileSeconds: number): number {
  return (file.started_at ?? callStartedAt) - callStartedAt + fileSeconds * 1000;
}

/** Where in a file (seconds) a moment of the call is, or null when the file
 *  does not cover it: the shared rule (offsetIntoRecording), so the player
 *  never seeks where locateCallMoment says there is no picture. */
export function fileSecondsAt(file: CallVideoFile, callStartedAt: number, callMs: number): number | null {
  const offset = offsetIntoRecording(file, callStartedAt, callMs);
  return offset === null ? null : offset / 1000;
}

/** One press of Record and everything it made: the room's file, the screen
 *  files, and where the run stands as a whole. */
export type CallVideoRun = {
  id: string;
  composite: CallVideoFile | null;
  screens: CallVideoFile[];
  /** live: still filming; saving: stopped, LiveKit finishing the upload;
   *  ready: something plays; failed: nothing of this run will. */
  state: "live" | "saving" | "ready" | "failed";
  /** Wall ms of the run's first frame (or of the press, while starting). */
  startedAt: number | null;
  error: string | null;
  canDelete: boolean;
};

function runState(rows: CallVideoFile[]): CallVideoRun["state"] {
  const composite = rows.find((r) => r.kind === "composite");
  const lead = composite ?? rows[0];
  if (lead && (lead.status === "starting" || lead.status === "recording")) return "live";
  if (rows.some((r) => r.status === "stopping")) return "saving";
  if (rows.some((r) => r.status === "ready")) return "ready";
  return "failed";
}

/** The call's runs, oldest first. */
export function callVideoRuns(files: readonly CallVideoFile[]): CallVideoRun[] {
  const byRun = new Map<string, CallVideoFile[]>();
  for (const f of files) {
    const key = f.run_id ?? f.id;
    byRun.set(key, [...(byRun.get(key) ?? []), f]);
  }
  const runs: CallVideoRun[] = [];
  for (const [id, rows] of byRun) {
    const composite = rows.find((r) => r.kind === "composite") ?? null;
    const failed = rows.find((r) => r.status === "failed" && r.error);
    runs.push({
      id,
      composite,
      screens: rows.filter((r) => r.kind === "screen").sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0)),
      state: runState(rows),
      startedAt: composite?.started_at ?? rows.map((r) => r.started_at).find((t) => t != null) ?? null,
      error: failed?.error ?? null,
      canDelete: rows.some((r) => r.can_delete),
    });
  }
  return runs.sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
}

/** The file to show a moment of the call in, and how far into it: the
 *  shared rule (locateCallMoment) over the files that can actually play. */
export function videoAt(
  files: readonly CallVideoFile[],
  callStartedAt: number,
  callMs: number,
  prefer: CallMomentPrefer = "composite",
  identity?: string | null,
): { file: CallVideoFile; seconds: number } | null {
  const hit = locateCallMoment({ callStartedAt, atMs: callMs, recordings: playableFiles(files), prefer, identity });
  return hit.ok ? { file: hit.recording, seconds: hit.offsetMs / 1000 } : null;
}

/** The moment of the video to show for something that happened at `callMs`
 *  (a thread line: Record pressed, Stop pressed). A press lands a little
 *  before the file's first frame and a stop a little after its last, so a
 *  moment just outside a recording snaps to its nearest edge within `slackMs`.
 *  Null when no video is near. */
export function shownMomentNear(files: readonly CallVideoFile[], callStartedAt: number, callMs: number, slackMs = 20_000): number | null {
  const playable = playableFiles(files);
  if (playable.some((f) => fileSecondsAt(f, callStartedAt, callMs) !== null)) return callMs;
  let best: { ms: number; gap: number } | null = null;
  for (const f of playable) {
    const from = callMsOf(f, callStartedAt, 0);
    const length = (f.duration_ms ?? 0) || (f.ended_at != null && f.started_at != null ? f.ended_at - f.started_at : 0);
    const edges = [from, ...(length > 1000 ? [from + length - 1000] : [])];
    for (const ms of edges) {
      const gap = Math.abs(ms - callMs);
      if (gap <= slackMs && (!best || gap < best.gap)) best = { ms, gap };
    }
  }
  return best?.ms ?? null;
}

/** What a page says when a line is clicked at a moment no video shows. */
export function noVideoWords(callMs: number): { title: string; detail: string } {
  return { title: `No video at ${formatCallTime(callMs)}`, detail: "That part of the call was not recorded." };
}

/** One chip of the view switch: a sharer's screen, folded across their
 *  shares in the run. The share up at the moment, else the next one they
 *  make, else their last; `at` (call ms) is where that share begins, and
 *  `several` says they shared more than once, so the chip names the time. */
export type ScreenChip = { file: CallVideoFile; up: boolean; at: number; several: boolean };

export function screenChips(screens: readonly CallVideoFile[], callStartedAt: number, callMs: number): ScreenChip[] {
  const bySharer = new Map<string, CallVideoFile[]>();
  for (const f of screens) {
    const key = f.participant_identity ?? f.participant_name ?? f.id;
    bySharer.set(key, [...(bySharer.get(key) ?? []), f]);
  }
  const chips: ScreenChip[] = [];
  for (const shares of bySharer.values()) {
    const ordered = [...shares].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
    const up = ordered.filter((f) => fileSecondsAt(f, callStartedAt, callMs) !== null).pop();
    const file = up ?? ordered.find((f) => callMsOf(f, callStartedAt, 0) > callMs) ?? ordered[ordered.length - 1];
    chips.push({ file, up: !!up, at: callMsOf(file, callStartedAt, 0), several: ordered.length > 1 });
  }
  return chips.sort((a, b) => a.at - b.at);
}

/** The transcript line being said at a moment: the turn whose words span it.
 *  `holdLast` keeps the turn last spoken through the silence after it, which
 *  is what a link to a time should land on (a moment between two lines is
 *  still "after what Ann said"). */
export function turnIndexAt(
  turns: ReadonlyArray<{ t0: number; segments: ReadonlyArray<{ t1?: number }> }>,
  callMs: number,
  holdLast = false,
): number | null {
  // A turn's words run from its first line's start to its last line's end;
  // the shared rule (segmentAt, which the CLI names a frame's line by) does
  // the rest.
  const spans = turns.map((t) => ({ t0: t.t0, t1: t.segments[t.segments.length - 1]?.t1 }));
  return segmentAt(spans, callMs, { holdMs: holdLast ? Infinity : 0 })?.index ?? null;
}

/** What the call page says above where the video goes, when there is
 *  something to say: the room is being filmed, a run is saving, or the last
 *  run failed and nothing of it plays. Null when the video speaks for itself
 *  (or there never was one). */
export type CallVideoNotice =
  | { kind: "live"; run: CallVideoRun }
  | { kind: "saving"; run: CallVideoRun }
  | { kind: "failed"; run: CallVideoRun };

export function callVideoNotice(runs: readonly CallVideoRun[]): CallVideoNotice | null {
  const live = runs.find((r) => r.state === "live");
  if (live) return { kind: "live", run: live };
  const saving = runs.find((r) => r.state === "saving");
  if (saving) return { kind: "saving", run: saving };
  const last = runs[runs.length - 1];
  return last?.state === "failed" ? { kind: "failed", run: last } : null;
}
