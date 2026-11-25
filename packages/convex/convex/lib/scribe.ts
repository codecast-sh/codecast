// Words and who said them, from ElevenLabs Scribe v3 (engine C's words
// source, docs/architecture/speaker-attribution.md). Scribe labels every word
// with its speaker, so this source returns the speaker turns too.
import type { SpeakerTurn, TimedWord } from "@codecast/shared/contracts";
import { elevenlabsFetch } from "./elevenlabs";
import { turnsFromLabeledWords } from "./voiceMatch";
import type { VendorGate } from "./vendorGuard";

export const SCRIBE_MODEL = "scribe_v3";
/** The longest Scribe may take: the action's deadline also caps it
 *  (transcripts.transcribeVoiceNote keeps the whole pass inside Convex's
 *  10 minute action limit). */
export const SCRIBE_MAX_MS = 5 * 60_000;
/** Above this the audio goes to Scribe by URL (cloud_storage_url) and is
 *  never read into the action: the default runtime has 64 MB, and an inline
 *  upload holds the file and its multipart copy at once. */
export const SCRIBE_INLINE_MAX_BYTES = 8 * 1024 * 1024;

export type ScribeResult = { words: TimedWord[]; turns: SpeakerTurn[]; language: string | null };

/** The language_code Scribe is pinned to: the room's one language, else none (Scribe detects it). */
export function scribeLanguageCode(languages: readonly string[]): string | null {
  const one = [...new Set(languages)];
  return one.length === 1 ? one[0]! : null;
}

/**
 * A Scribe reply as words on voice keys and the turns they make. Only
 * entries of type "word" with times count; Scribe's speaker labels become
 * `spk:<n>` in order of first appearance, and a word with no label takes the
 * previous word's voice. Anything unexpected in the reply is skipped, never thrown.
 */
export function parseScribeReply(raw: unknown): ScribeResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as { words?: unknown; language_code?: unknown };
  const keyOf = new Map<string, string>();
  const words: TimedWord[] = [];
  let last: string | undefined;
  for (const w of Array.isArray(r.words) ? r.words : []) {
    if (!w || typeof w !== "object") continue;
    const { type, text, start, end, speaker_id } = w as Record<string, unknown>;
    if (type !== "word" || typeof start !== "number" || typeof end !== "number" || typeof text !== "string") continue;
    let key = last;
    if (typeof speaker_id === "string" && speaker_id) {
      if (!keyOf.has(speaker_id)) keyOf.set(speaker_id, `spk:${keyOf.size}`);
      key = keyOf.get(speaker_id)!;
    }
    key ??= "spk:0";
    last = key;
    words.push({ text: text.trim(), start, end: Math.max(start, end), key });
  }
  return { words, turns: turnsFromLabeledWords(words), language: typeof r.language_code === "string" ? r.language_code : null };
}

/** Transcribe one recording with Scribe v3. Throws with the reason when it cannot. */
export async function scribeTranscribe(
  gate: VendorGate,
  input: { audio?: Blob | null; audioUrl: string | null; contentType?: string | null; languages: readonly string[]; timeoutMs?: number },
): Promise<ScribeResult> {
  const form = new FormData();
  form.append("model_id", SCRIBE_MODEL);
  form.append("diarize", "true");
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  const language = scribeLanguageCode(input.languages);
  if (language) form.append("language_code", language);
  if (input.audio) {
    const webm = (input.audio.type || input.contentType || "").includes("webm");
    form.append("file", input.audio, webm ? "recording.webm" : "recording.m4a");
  } else if (input.audioUrl) form.append("cloud_storage_url", input.audioUrl);
  else throw new Error("Scribe needs the audio or a URL to it");
  const timeout = Math.max(1, Math.min(SCRIBE_MAX_MS, input.timeoutMs ?? SCRIBE_MAX_MS));
  const resp = await elevenlabsFetch(gate, "/v1/speech-to-text", { method: "POST", body: form, signal: AbortSignal.timeout(timeout) });
  if (!resp) throw new Error("Scribe unavailable: no ElevenLabs key, or this team may not send to ElevenLabs");
  if (!resp.ok) throw new Error(`Scribe ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const result = parseScribeReply(await resp.json());
  if (!result.words.length) throw new Error("Scribe returned no words");
  return result;
}
