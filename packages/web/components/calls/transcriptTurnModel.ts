// The transcript's reading unit: consecutive segments from one speaker fold
// into a turn. Shared by the calls page (which adds selection on top) and the
// huddle digest rows in chat and sessions. Plain .ts on purpose — component
// modules export only components (Fast Refresh boundaries) — and named apart
// from TranscriptTurns.tsx: macOS resolves imports case-insensitively, so a
// module differing only in case imports ITSELF.

import type { CallAnchor } from "@codecast/shared/contracts";

/** The anchor for a run of turns: first segment of the first to last of the last. */
export function turnsAnchor(turns: Array<{ segments: Array<{ seq: number }> }>): CallAnchor | null {
  const first = turns[0]?.segments[0]?.seq;
  const lastTurn = turns[turns.length - 1];
  const last = lastTurn?.segments[lastTurn.segments.length - 1]?.seq;
  return first === undefined || last === undefined ? null : { kind: "turns", from_seq: first, to_seq: last };
}

export type TranscriptSegment = {
  seq: number;
  speaker_id: string;
  speaker_name: string;
  text: string;
  t0: number;
  t1?: number;
};

export type Turn = {
  index: number;
  speaker_id: string;
  speaker_name: string;
  t0: number;
  segments: TranscriptSegment[];
};

export function groupTurns(segments: TranscriptSegment[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker_id === s.speaker_id) last.segments.push(s);
    else
      turns.push({
        index: turns.length,
        speaker_id: s.speaker_id,
        speaker_name: s.speaker_name,
        t0: s.t0,
        segments: [s],
      });
  }
  return turns;
}

/**
 * One segment per turn. A recording has a single microphone, so grouping by
 * speaker folds the whole meeting into one block — the phone lists each
 * line, and so does the call page when it uses this.
 */
export function oneSegmentTurns(segments: TranscriptSegment[]): Turn[] {
  return segments.map((s, i) => ({
    index: i,
    speaker_id: s.speaker_id,
    speaker_name: s.speaker_name,
    t0: s.t0,
    segments: [s],
  }));
}
