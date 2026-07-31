import { test, expect, describe } from "bun:test";
import { buildPrefillText, PREFILL_MAX_LENGTH } from "./composerPrefill";

describe("buildPrefillText", () => {
  test("quotes the text and leaves a blank line to type under", () => {
    expect(buildPrefillText("ping Jamie about the deck")).toBe("> ping Jamie about the deck\n\n");
  });
  test("multi-line drafts stay inside one blockquote", () => {
    expect(buildPrefillText("first\n\nsecond")).toBe("> first\n>\n> second\n\n");
  });
  test("missing or blank param yields nothing", () => {
    expect(buildPrefillText(null)).toBeNull();
    expect(buildPrefillText(undefined)).toBeNull();
    expect(buildPrefillText("")).toBeNull();
    expect(buildPrefillText("   \n  ")).toBeNull();
  });
  test("drops everything past the length cap", () => {
    const out = buildPrefillText("x".repeat(PREFILL_MAX_LENGTH + 500))!;
    expect(out).toBe(`> ${"x".repeat(PREFILL_MAX_LENGTH)}\n\n`);
  });
  test("markup is carried as plain text, not interpreted", () => {
    expect(buildPrefillText("<img src=x onerror=alert(1)>")).toBe("> <img src=x onerror=alert(1)>\n\n");
  });
});
