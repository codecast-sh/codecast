import { describe, expect, test } from 'bun:test';
import {
  recordingIsWorking,
  recordingState,
  recordingStatusLine,
  type RecordingRow,
} from './recordingStatus';

// A phone recording waits in more places than a huddle does: captured,
// uploaded, read by the server, then summarized. Each step can fail on its
// own, and the screen has to name the one it is actually in — a surface that
// says "getting the words" about a recording that already gave up is the thing
// that makes an app feel broken rather than slow.
describe('recordingState', () => {
  const row = (over: Partial<RecordingRow> = {}): RecordingRow => ({
    status: 'ended',
    transcribe_status: 'done',
    summary_status: 'done',
    last_seq: 12,
    ...over,
  });

  test('a running recording is recording, whatever else is set', () => {
    expect(recordingState(row({ status: 'live', transcribe_status: null, summary_status: null, last_seq: 0 }))).toBe(
      'recording',
    );
  });

  test('audio waiting to be read says so', () => {
    expect(recordingState(row({ transcribe_status: 'pending', summary_status: 'pending', last_seq: 0 }))).toBe(
      'transcribing',
    );
  });

  test('words in, summary pending', () => {
    expect(recordingState(row({ summary_status: 'pending' }))).toBe('summarizing');
  });

  test('a finished recording with a summary is ready', () => {
    expect(recordingState(row())).toBe('ready');
  });

  // The precedence that matters. A failed transcription also leaves
  // summary_status "skipped" behind it, and reporting the skip would tell
  // somebody their meeting was too short to summarize when the truth is that
  // the words never arrived at all.
  test('a failed transcription outranks the skipped summary it caused', () => {
    expect(recordingState(row({ transcribe_status: 'failed', summary_status: 'skipped', last_seq: 0 }))).toBe(
      'no_words',
    );
    expect(recordingStatusLine(row({ transcribe_status: 'failed', summary_status: 'skipped', last_seq: 0 }))).toBe(
      'No words could be read from this one',
    );
  });

  test('a recording of a quiet room has no words and no failure to blame', () => {
    expect(recordingState(row({ transcribe_status: 'done', summary_status: 'skipped', last_seq: 0 }))).toBe(
      'no_words',
    );
  });

  test('words with nothing worth summarizing is a transcript, not a failure', () => {
    expect(recordingState(row({ summary_status: 'skipped' }))).toBe('no_summary');
    expect(recordingStatusLine(row({ summary_status: 'skipped' }))).toBe('Transcript only');
  });

  test('a huddle row, which carries no transcribe status at all, still reads', () => {
    // Every field this feature added is optional, and the list renders rows
    // that predate it.
    expect(recordingState({ status: 'ended', last_seq: 9, summary_status: 'done' })).toBe('ready');
    expect(recordingState({ status: 'ended', last_seq: 9 })).toBe('no_summary');
  });

  test('a finished recording never shows a spinner', () => {
    expect(recordingIsWorking(row())).toBe(false);
    expect(recordingIsWorking(row({ transcribe_status: 'failed', last_seq: 0 }))).toBe(false);
    expect(recordingIsWorking(row({ status: 'live' }))).toBe(true);
    expect(recordingIsWorking(row({ transcribe_status: 'pending' }))).toBe(true);
  });

  test('a ready recording adds no status noise to its row', () => {
    expect(recordingStatusLine(row())).toBe('');
  });
});
