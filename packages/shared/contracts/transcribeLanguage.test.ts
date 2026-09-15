import { describe, expect, test } from "bun:test";
import { TRANSCRIBE_LANGUAGE, isWrongScriptTranscript } from "./transcribeLanguage";

describe("isWrongScriptTranscript", () => {
  test("English speech is kept", () => {
    expect(isWrongScriptTranscript("I cannot hear you.")).toBe(false);
    expect(isWrongScriptTranscript("Yeah.")).toBe(false);
    expect(isWrongScriptTranscript("Ja.")).toBe(false);
  });

  test("a cough transcribed as Hangul or Thai is dropped", () => {
    expect(isWrongScriptTranscript("위위위")).toBe(true);
    expect(isWrongScriptTranscript("เลอ")).toBe(true);
  });

  test("a whole utterance invented in katakana is dropped", () => {
    expect(
      isWrongScriptTranscript(
        "アショット, サムビット, エージェントレイヤー。コンテキストがセッショ。",
      ),
    ).toBe(true);
  });

  test("mixed English with a borrowed word is kept", () => {
    expect(isWrongScriptTranscript("the agent layer, Ashot")).toBe(false);
  });

  test("numbers and punctuation alone are not this bug", () => {
    expect(isWrongScriptTranscript("...")).toBe(false);
    expect(isWrongScriptTranscript("42")).toBe(false);
    expect(isWrongScriptTranscript("")).toBe(false);
  });

  test("accented Latin is still Latin", () => {
    expect(isWrongScriptTranscript("café naïve")).toBe(false);
  });
});

describe("TRANSCRIBE_LANGUAGE", () => {
  test("is the ISO-639-1 code the transcribers pin", () => {
    expect(TRANSCRIBE_LANGUAGE).toBe("en");
  });
});
