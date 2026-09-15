import { describe, expect, test } from "bun:test";
import {
  LIVE_TRANSCRIBE_MODEL,
  dominantTranscriptScript,
  foldLanguageTag,
  isUnexpectedTranscript,
  normalizeTranscribeLanguages,
  scriptsForLanguage,
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
