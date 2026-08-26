// What a recording is doing, in words a person can act on.
//
// A recording passes through more waiting than a huddle does. A huddle's words
// exist the moment they are spoken; a phone recording is captured, uploaded,
// read by the server and only then summarized, and each of those can fail on
// its own. The list row and the detail screen both have to say which one it is
// sitting in — and never say "transcribing" about something that already gave
// up, which is the failure mode that makes an app feel broken.

export type RecordingRow = {
  status: 'live' | 'ended';
  transcribe_status?: 'pending' | 'done' | 'failed' | null;
  summary_status?: 'pending' | 'done' | 'failed' | 'skipped' | null;
  last_seq: number;
};

export type RecordingState =
  | 'recording'
  | 'transcribing'
  | 'summarizing'
  | 'ready'
  | 'no_words'
  | 'no_summary';

/**
 * Which of those states a row is in.
 *
 * Order matters and is the whole point: a failure is reported before any of
 * the waiting states it would otherwise hide behind. A recording whose audio
 * could not be read has `summary_status: "skipped"` too, and reporting the
 * skip would tell somebody their meeting was too short when the truth is that
 * the words never arrived.
 */
export function recordingState(row: RecordingRow): RecordingState {
  if (row.status === 'live') return 'recording';
  if (row.transcribe_status === 'failed') return 'no_words';
  if (row.transcribe_status === 'pending') return 'transcribing';
  if (row.summary_status === 'pending') return 'summarizing';
  // No words is no words, however it happened — a recording of a quiet room
  // reaches here with nothing appended and no failure to report.
  if (row.last_seq === 0) return 'no_words';
  if (row.summary_status === 'done') return 'ready';
  return 'no_summary';
}

/** One line for a list row. Written for somebody glancing, not reading. */
export function recordingStatusLine(row: RecordingRow): string {
  switch (recordingState(row)) {
    case 'recording':
      return 'Recording now';
    case 'transcribing':
      return 'Getting the words';
    case 'summarizing':
      return 'Writing the summary';
    case 'no_words':
      return 'No words could be read from this one';
    case 'no_summary':
      return 'Transcript only';
    case 'ready':
      return '';
  }
}

/** Is this row still working, so the surface should show it as in progress? */
export function recordingIsWorking(row: RecordingRow): boolean {
  const state = recordingState(row);
  return state === 'recording' || state === 'transcribing' || state === 'summarizing';
}
