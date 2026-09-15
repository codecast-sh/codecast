// What every transcriber is told about the language of the audio.
//
// The live huddle, the finished recording, and the voice-note fallback all
// pin this. Without it the model auto-detects per utterance, and a short
// noise or a "ja" locks the rest of the meeting onto Japanese, Thai, or
// Korean. Pinning is the documented way to stop that; the script check below
// is the net for the remainder.

/** ISO-639-1. Every transcription request sends this. */
export const TRANSCRIBE_LANGUAGE = "en";

/**
 * True when a line is mostly not Latin letters.
 *
 * Language pinning stops the model from staying in another language. This
 * catches what still leaks: a cough that comes back as Hangul or Thai, or a
 * whole utterance invented in katakana. A line with no letters (numbers,
 * punctuation) is not this bug and is kept.
 */
export function isWrongScriptTranscript(text: string): boolean {
  let letters = 0;
  let latin = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters += 1;
    if (/\p{Script=Latin}/u.test(ch)) latin += 1;
  }
  if (letters === 0) return false;
  return latin * 2 < letters;
}
