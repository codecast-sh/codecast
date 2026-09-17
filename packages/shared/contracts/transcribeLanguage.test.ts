import { describe, expect, test } from "bun:test";
import {
  LIVE_TRANSCRIBE_MODEL,
  asrTranscriptionSession,
  dominantTranscriptScript,
  foldLanguageTag,
  isUnexpectedTranscript,
  localTranscribeLanguages,
  normalizeTranscribeLanguages,
  scriptsForLanguage,
  unionTranscribeLanguages,
} from "./transcribeLanguage";

describe("foldLanguageTag", () => {
  test("strips region from a BCP-47 tag", () => {
    expect(foldLanguageTag("en-US")).toBe("en");
    expect(foldLanguageTag("fr_FR")).toBe("fr");
    expect(foldLanguageTag("JA")).toBe("ja");
  });

  test("keeps the Chinese region the transcriber accepts", () => {
    expect(foldLanguageTag("zh-CN")).toBe("zh-cn");
    expect(foldLanguageTag("zh-TW")).toBe("zh-tw");
    expect(foldLanguageTag("zh-HK")).toBe("zh-hk");
    expect(foldLanguageTag("zh-Hant")).toBe("zh-tw");
  });

  test("rejects noise", () => {
    expect(foldLanguageTag("")).toBe(null);
    expect(foldLanguageTag("123")).toBe(null);
    expect(foldLanguageTag("english")).toBe(null);
  });

  test("maps OS aliases onto a code the recognizer has", () => {
    expect(foldLanguageTag("nb-NO")).toBe("no");
    expect(foldLanguageTag("nn")).toBe("no");
    expect(foldLanguageTag("fil")).toBe("tl");
    expect(foldLanguageTag("iw")).toBe("he");
  });

  test("drops a well-formed tag the recognizer would reject", () => {
    expect(foldLanguageTag("zz")).toBe(null);
    expect(foldLanguageTag("eu")).toBe(null);
  });

  test("keeps Armenian, which the live model accepts", () => {
    expect(foldLanguageTag("hy-AM")).toBe("hy");
  });
});

describe("normalizeTranscribeLanguages", () => {
  test("dedupes and caps", () => {
    expect(normalizeTranscribeLanguages(["en-US", "en", "fr-FR", "ja"])).toEqual([
      "en",
      "fr",
      "ja",
    ]);
  });

  test("drops what it cannot fold", () => {
    expect(normalizeTranscribeLanguages(["en", "", "nope"])).toEqual(["en"]);
  });
});

describe("unionTranscribeLanguages", () => {
  test("a Japanese seat plus an English scribe keeps both", () => {
    expect(unionTranscribeLanguages(["en-US"], ["ja-JP", "en"])).toEqual(["en", "ja"]);
  });

  test("empty and missing lists do not pollute", () => {
    expect(unionTranscribeLanguages(undefined, [], ["fr"])).toEqual(["fr"]);
  });
});

describe("localTranscribeLanguages", () => {
  test("reads the device locale when the browser list is empty", () => {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale;
    const out = localTranscribeLanguages();
    const folded = foldLanguageTag(loc);
    if (folded) expect(out).toContain(folded);
    else expect(Array.isArray(out)).toBe(true);
  });
});

describe("isUnexpectedTranscript", () => {
  test("an English allowlist keeps English and drops a Hangul cough", () => {
    expect(isUnexpectedTranscript("I cannot hear you.", ["en"])).toBe(false);
    expect(isUnexpectedTranscript("Ja.", ["en"])).toBe(false);
    expect(isUnexpectedTranscript("위위위", ["en"])).toBe(true);
    expect(isUnexpectedTranscript("เลอ", ["en"])).toBe(true);
    expect(
      isUnexpectedTranscript("アショット, サムビット, エージェントレイヤー。", ["en"]),
    ).toBe(true);
  });

  test("a Japanese allowlist keeps Japanese and still keeps Latin names", () => {
    expect(
      isUnexpectedTranscript("アショット, サムビット, エージェントレイヤー。", ["ja"]),
    ).toBe(false);
    expect(isUnexpectedTranscript("Ashot, Samvit, agent layer", ["ja"])).toBe(false);
    expect(isUnexpectedTranscript("위위위", ["ja"])).toBe(true);
  });

  test("English plus Japanese keeps both and still drops Thai", () => {
    expect(isUnexpectedTranscript("the agent layer", ["en", "ja"])).toBe(false);
    expect(isUnexpectedTranscript("エージェントレイヤー", ["en", "ja"])).toBe(false);
    expect(isUnexpectedTranscript("เลอ", ["en", "ja"])).toBe(true);
  });

  test("an empty allowlist does not guess", () => {
    expect(isUnexpectedTranscript("위위위", [])).toBe(false);
    expect(isUnexpectedTranscript("エージェント", [])).toBe(false);
  });

  test("numbers and punctuation are not a script", () => {
    expect(isUnexpectedTranscript("...", ["en"])).toBe(false);
    expect(isUnexpectedTranscript("42", ["en"])).toBe(false);
  });
});

describe("dominantTranscriptScript", () => {
  test("reads kana as kana, Hangul as Hangul", () => {
    expect(dominantTranscriptScript("エージェント")).toBe("kana");
    expect(dominantTranscriptScript("위위위")).toBe("hangul");
    expect(dominantTranscriptScript("Yeah.")).toBe("latin");
  });
});

describe("scriptsForLanguage", () => {
  test("Japanese is kana and Han, not Hangul", () => {
    expect(scriptsForLanguage("ja")).toEqual(["kana", "han"]);
    expect(scriptsForLanguage("en")).toEqual(["latin"]);
  });
});

describe("LIVE_TRANSCRIBE_MODEL", () => {
  test("is the live model that accepts a languages allowlist", () => {
    expect(LIVE_TRANSCRIBE_MODEL).toBe("gpt-live-transcribe");
  });
});

describe("asrTranscriptionSession", () => {
  test("omits languages when the caller did not name any", () => {
    expect(asrTranscriptionSession(LIVE_TRANSCRIBE_MODEL).audio.input.transcription).toEqual({
      model: LIVE_TRANSCRIBE_MODEL,
    });
  });

  test("sends the allowlist when named", () => {
    expect(
      asrTranscriptionSession(LIVE_TRANSCRIBE_MODEL, ["en", "ja"]).audio.input.transcription,
    ).toEqual({
      model: LIVE_TRANSCRIBE_MODEL,
      languages: ["en", "ja"],
    });
  });

  test("sends the full VAD object the live mint requires", () => {
    expect(asrTranscriptionSession(LIVE_TRANSCRIBE_MODEL).audio.input.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 600,
    });
  });
});
