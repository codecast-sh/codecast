// How a finished recording's audio becomes transcript segments: the model
// that reads the file, the write batch, and the reply parser. Used by
// transcripts.transcribeRecording.

/**
 * What reads the file.
 *
 * Deliberately NOT the live recognizer's model. The live path streams words as
 * they are spoken and has no use for timestamps; a recording is a finished
 * thing somebody scrolls through next to a player, so every line needs to know
 * when it was said. `whisper-1` is the transcription model that returns
 * segment boundaries, which is the whole reason it is used here.
 */
export const RECORDING_TRANSCRIBE_MODEL = "whisper-1";

/** Segments written per mutation. A two hour meeting is a couple of thousand
 *  lines, and one mutation inserting all of them would run past what a
 *  transaction should do; the seq watermark makes the batches safe to resume
 *  from and stitch back together in order. */
export const SEGMENT_WRITE_BATCH = 200;

/** One microphone in a room heard everybody. There is no diarization here and
 *  no honest name to put on a line, so every segment carries the same one and
 *  the surfaces that render a recording hide the label entirely. */
export const RECORDING_SPEAKER = { id: "mic", name: "Speaker" } as const;

/**
 * The transcriber's reply, as segments this table can hold.
 *
 * `verbose_json` gives `{ text, segments: [{ start, end, text }] }` with the
 * times in seconds. A reply without a segments array is still words — the
 * models degrade to a plain transcript under load and for very short audio —
 * so it becomes one segment spanning the whole file rather than nothing.
 * Exported for its test: this is the seam between somebody else's JSON and our
 * rows, and it is the piece most likely to change under us.
 */
export function parseTranscriptionSegments(
  payload: unknown,
  fallbackDurationMs: number,
): { speaker_id: string; speaker_name: string; text: string; t0: number; t1: number }[] {
  const body = (payload ?? {}) as {
    text?: unknown;
    segments?: unknown;
  };
  const speaker = {
    speaker_id: RECORDING_SPEAKER.id,
    speaker_name: RECORDING_SPEAKER.name,
  };
  if (Array.isArray(body.segments)) {
    const out = body.segments
      .map((raw: any) => {
        const text = typeof raw?.text === "string" ? raw.text.trim() : "";
        if (!text) return null;
        const t0 = Math.max(0, Math.round((Number(raw?.start) || 0) * 1000));
        const t1 = Math.max(t0, Math.round((Number(raw?.end) || 0) * 1000));
        return { ...speaker, text, t0, t1 };
      })
      .filter(Boolean) as {
      speaker_id: string;
      speaker_name: string;
      text: string;
      t0: number;
      t1: number;
    }[];
    if (out.length) return out;
  }
  const whole = typeof body.text === "string" ? body.text.trim() : "";
  if (!whole) return [];
  return [{ ...speaker, text: whole, t0: 0, t1: Math.max(0, fallbackDurationMs) }];
}
