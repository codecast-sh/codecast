import { test, expect, describe } from "bun:test";
import { buildPrefillText, PREFILL_MAX_LENGTH, seedComposer } from "./composerPrefill";

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

describe("seedComposer", () => {
  const quote = { fill: "> the proposal\n\n", add: "" };
  const cont = { fill: "", add: "About in-22 Infrastructure: " };
  const both = { fill: "> the proposal\n\n", add: "No, " };
  test("an empty composer takes the whole seed", () => {
    expect(seedComposer("", false, quote)).toBe(quote.fill);
    expect(seedComposer("  \n", false, cont)).toBe(cont.add);
    expect(seedComposer("", false, both)).toBe("> the proposal\n\nNo, ");
  });
  test("a draft or an image outranks a quote, which is dropped", () => {
    expect(seedComposer("half a thought", false, quote)).toBeNull();
    expect(seedComposer("", true, quote)).toBeNull();
  });
  test("text to continue goes under a draft after a blank line", () => {
    expect(seedComposer("half a thought\n", false, cont)).toBe("half a thought\n\nAbout in-22 Infrastructure: ");
  });
  test("under a draft, a link with both adds only its text, never the quote", () => {
    expect(seedComposer("half a thought", false, both)).toBe("half a thought\n\nNo, ");
  });
  test("text to continue fills the box beside an attached image", () => {
    expect(seedComposer("", true, cont)).toBe(cont.add);
  });
  test("the same link clicked again adds nothing", () => {
    const once = seedComposer("half a thought", false, cont)!;
    expect(seedComposer(once, false, cont)).toBe(once);
    expect(seedComposer(cont.add, false, cont)).toBe(cont.add);
  });
  test("a draft that merely ends with the same words still gets the link's text", () => {
    const tests = { fill: "", add: "tests" };
    expect(seedComposer("please run the tests", false, tests)).toBe("please run the tests\n\ntests");
  });
});
