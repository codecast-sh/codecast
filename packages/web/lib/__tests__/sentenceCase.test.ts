import { describe, expect, test } from "bun:test";
import { sentenceCase } from "../sessionCard";
import { hostedNoteLines } from "../hostedNoteRow";

describe("sentenceCase", () => {
  test("capitalises the first letter and keeps the rest", () => {
    expect(sentenceCase("call the plumber")).toBe("Call the plumber");
    expect(sentenceCase("  buy milk")).toBe("  Buy milk");
    expect(sentenceCase("")).toBe("");
  });

  test("leaves a first word that is already cased inside, a name", () => {
    expect(sentenceCase("iMessage read and write")).toBe("iMessage read and write");
    expect(sentenceCase("eBay listing for the desk")).toBe("eBay listing for the desk");
  });
});

describe("hostedNoteLines", () => {
  test("a named note is its title over what follows it", () => {
    expect(hostedNoteLines({ title: "Packing list", content: "# Packing list\n\n- towels\n- sunscreen" })).toEqual({ title: "Packing list", snippet: "towels sunscreen" });
  });

  test("an untitled note goes by its first sentence", () => {
    expect(hostedNoteLines({ title: "", content: "Call the bank. Ask about the fee." })).toEqual({ title: "Call the bank.", snippet: "Ask about the fee." });
  });
});
