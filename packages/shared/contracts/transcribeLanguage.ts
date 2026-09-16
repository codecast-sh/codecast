// What the live recognizer is allowed to hear.
//
// Unconstrained auto-detect guesses a language per utterance. A cough or a
// "ja" then locks the rest of the huddle onto Japanese, Thai, or Korean.
// Pinning a single language (English) stops that and also stops a real
// Japanese (or Korean, or Thai) conversation. The live model takes an
// allowlist instead: the languages this browser — and later, this room —
// actually uses. Latin is always kept, because product names and code-switch
// into English show up in every language we transcribe.

export const LIVE_TRANSCRIBE_MODEL = "gpt-live-transcribe";

/**
 * The session body the mint posts and the live socket updates with.
 * One shape, so the allowlist cannot drift between the two.
 */
export function asrTranscriptionSession(model: string, languages: string[] = []) {
  const transcription: { model: string; languages?: string[] } = { model };
  if (languages.length) transcription.languages = languages;
  return {
    type: "transcription" as const,
    audio: {
      input: {
        format: { type: "audio/pcm" as const, rate: 24000 },
        transcription,
        turn_detection: { type: "server_vad" as const, silence_duration_ms: 600 },
      },
    },
  };
}

/** How many languages one recognizer may be told about. */
export const TRANSCRIBE_LANGUAGE_CAP = 8;

export type TranscriptScript =
  | "latin"
  | "kana"
  | "han"
  | "hangul"
  | "thai"
  | "arabic"
  | "cyrillic"
  | "hebrew"
  | "devanagari"
  | "greek";

const SCRIPT_OF_LANGUAGE: Record<string, TranscriptScript[]> = {
  ja: ["kana", "han"],
  ko: ["hangul", "han"],
  zh: ["han"],
  "zh-cn": ["han"],
  "zh-tw": ["han"],
  "zh-hk": ["han"],
  yue: ["han"],
  cmn: ["han"],
  th: ["thai"],
  ar: ["arabic"],
  fa: ["arabic"],
  ur: ["arabic"],
  he: ["hebrew"],
  ru: ["cyrillic"],
  uk: ["cyrillic"],
  bg: ["cyrillic"],
  sr: ["cyrillic", "latin"],
  hi: ["devanagari"],
  mr: ["devanagari"],
  ne: ["devanagari"],
  el: ["greek"],
};

/** Codes the live recognizer accepts. A tag outside this set is dropped
 *  rather than sent: the Realtime API rejects the whole session for one
 *  unsupported language, which is how a huddle can sit on "transcribing"
 *  with no words. Whisper's 57, plus the Chinese region forms and the
 *  two ISO-639-3 tags the live model documents. */
const TRANSCRIBE_LANGUAGE_CODES = new Set([
  "af", "ar", "hy", "az", "be", "bs", "bg", "ca", "zh", "zh-cn", "zh-tw", "zh-hk",
  "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "gl", "de", "el", "he", "hi",
  "hu", "is", "id", "it", "ja", "kn", "kk", "ko", "lv", "lt", "mk", "ms", "mr",
  "mi", "ne", "no", "fa", "pl", "pt", "ro", "ru", "sr", "sk", "sl", "es", "sw",
  "sv", "tl", "ta", "th", "tr", "uk", "ur", "vi", "cy", "yue", "cmn",
]);

/** Browser/OS tags that fold onto a code the recognizer actually has. */
const TRANSCRIBE_LANGUAGE_ALIASES: Record<string, string> = {
  nb: "no",
  nn: "no",
  iw: "he",
  in: "id",
  fil: "tl",
};

/** Fold a BCP-47 tag into the code the transcriber accepts. */
export function foldLanguageTag(tag: string): string | null {
  const t = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!t) return null;
  if (t === "yue" || t === "cmn") return t;
  if (t === "fil") return TRANSCRIBE_LANGUAGE_ALIASES.fil;
  if (t.startsWith("zh")) {
    if (t.startsWith("zh-tw") || t.includes("hant")) return "zh-tw";
    if (t.startsWith("zh-hk")) return "zh-hk";
    return "zh-cn";
  }
  const primary = t.split("-")[0] ?? "";
  if (!/^[a-z]{2}$/.test(primary)) return null;
  const folded = TRANSCRIBE_LANGUAGE_ALIASES[primary] ?? primary;
  return TRANSCRIBE_LANGUAGE_CODES.has(folded) ? folded : null;
}

/** Unique, valid, capped. Empty means "the caller did not say". */
export function normalizeTranscribeLanguages(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const code = foldLanguageTag(item);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= TRANSCRIBE_LANGUAGE_CAP) break;
  }
  return out;
}

/** Merge several lists (a seat, a room, a mint) into one allowlist. */
export function unionTranscribeLanguages(
  ...lists: readonly (readonly string[] | undefined)[]
): string[] {
  return normalizeTranscribeLanguages(lists.flatMap((list) => list ?? []));
}

/**
 * Languages this device is set to. Browser, phone, and tests all go through
 * here so a Japanese OS and an English OS produce different allowlists.
 */
export function localTranscribeLanguages(): string[] {
  const raw: string[] = [];
  if (typeof navigator !== "undefined") {
    if (Array.isArray(navigator.languages)) raw.push(...navigator.languages);
    if (typeof navigator.language === "string") raw.push(navigator.language);
  }
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale;
    if (loc) raw.push(loc);
  } catch {
    // Intl missing: the navigator tags above are enough.
  }
  return normalizeTranscribeLanguages(raw);
}

export function scriptsForLanguage(code: string): TranscriptScript[] {
  return SCRIPT_OF_LANGUAGE[code] ?? ["latin"];
}

export function letterScript(ch: string): TranscriptScript | null {
  if (/\p{Script=Latin}/u.test(ch)) return "latin";
  if (/\p{Script=Hiragana}/u.test(ch) || /\p{Script=Katakana}/u.test(ch)) return "kana";
  if (/\p{Script=Han}/u.test(ch)) return "han";
  if (/\p{Script=Hangul}/u.test(ch)) return "hangul";
  if (/\p{Script=Thai}/u.test(ch)) return "thai";
  if (/\p{Script=Arabic}/u.test(ch)) return "arabic";
  if (/\p{Script=Cyrillic}/u.test(ch)) return "cyrillic";
  if (/\p{Script=Hebrew}/u.test(ch)) return "hebrew";
  if (/\p{Script=Devanagari}/u.test(ch)) return "devanagari";
  if (/\p{Script=Greek}/u.test(ch)) return "greek";
  return null;
}

/** The script most of the letters in `text` belong to, or null if none. */
export function dominantTranscriptScript(text: string): TranscriptScript | null {
  const counts = new Map<TranscriptScript, number>();
  let letters = 0;
  for (const ch of text) {
    const script = letterScript(ch);
    if (!script) continue;
    letters += 1;
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  if (letters === 0) return null;
  let best: TranscriptScript | null = null;
  let bestN = 0;
  for (const [script, n] of counts) {
    if (n > bestN) {
      best = script;
      bestN = n;
    }
  }
  return best;
}

/**
 * True when a line is in a script nobody on the allowlist writes.
 *
 * Latin is never unexpected: names, APIs and code-switch into English appear
 * in every language we transcribe. An empty allowlist means "do not guess",
 * so nothing is unexpected.
 */
export function isUnexpectedTranscript(text: string, languages: readonly string[]): boolean {
  if (languages.length === 0) return false;
  const script = dominantTranscriptScript(text);
  if (!script || script === "latin") return false;
  const allowed = new Set<TranscriptScript>();
  for (const code of languages) {
    for (const s of scriptsForLanguage(code)) allowed.add(s);
  }
  return !allowed.has(script);
}
