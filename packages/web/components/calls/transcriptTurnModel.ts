// The transcript's reading unit: consecutive segments from one speaker fold
// into a turn. Shared by the calls page (which adds selection on top) and the
// huddle digest rows in chat and sessions. Plain .ts on purpose — component
// modules export only components (Fast Refresh boundaries) — and named apart
// from TranscriptTurns.tsx: macOS resolves imports case-insensitively, so a
// module differing only in case imports ITSELF.

export type TranscriptSegment = {
  seq: number;
  speaker_id: string;
  speaker_name: string;
  text: string;
  t0: number;
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
