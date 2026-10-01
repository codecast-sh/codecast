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

import { locateCallMoment, type CallMomentPrefer, type CallRecordingSpan } from "@codecast/shared/contracts";

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
 *  does not cover it. The end is exclusive, as locateCallMoment has it. */
export function fileSecondsAt(file: CallVideoFile, callStartedAt: number, callMs: number): number | null {
  if (file.started_at == null) return null;
  const into = callStartedAt + callMs - file.started_at;
  const length = file.duration_ms ?? (file.ended_at != null ? file.ended_at - file.started_at : null);
  if (into < 0 || (length != null && into >= length)) return null;
  return into / 1000;
}

/** The files that can be played: finished, with a URL, and a time 0. */
export function playableFiles(files: readonly CallVideoFile[]): CallVideoFile[] {
  return files
    .filter((f) => f.status === "ready" && !!f.url && f.started_at != null)
    .sort((a, b) => a.started_at! - b.started_at!);
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

/** The screen files showing at a moment, one per sharer (the latest share of
 *  each), for the view switch. */
export function screensAt(files: readonly CallVideoFile[], callStartedAt: number, callMs: number): CallVideoFile[] {
  const out = new Map<string, CallVideoFile>();
  for (const f of playableFiles(files)) {
    if (f.kind !== "screen" || fileSecondsAt(f, callStartedAt, callMs) === null) continue;
    out.set(f.participant_identity ?? f.id, f);
  }
  return [...out.values()];
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
  let last: number | null = null;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.t0 > callMs) break;
    const t1 = t.segments[t.segments.length - 1]?.t1;
    if (t1 != null && callMs < t1) return i;
    last = i;
  }
  return holdLast ? last : null;
}

/** A file's name in the view switch: "Room" for the composite, the sharer's
 *  first name for a screen. */
export function videoViewLabel(file: Pick<CallVideoFile, "kind" | "participant_name">): string {
  if (file.kind === "composite") return "Room";
  const first = (file.participant_name ?? "").trim().split(/\s+/)[0];
  return first ? `${first}'s screen` : "Screen";
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
