import { describe, expect, test } from "bun:test";
import { toMarkdown } from "./docSync";
import { markdownToDoc } from "./docs";
import { addAlternatives, ghostText, flagText, pickAlternative, describeDrafts } from "@codecast/shared/docs";
import { labPrompt, parseLabReply } from "./docLab";

// Drafting markup (alternatives, ghosts, Lab flags) crosses both server
// converters: a CLI write opens in the editor as live marks (markdownToDoc),
// and the editor's save writes the same spans back (toMarkdown).
describe("drafting markup round-trip", () => {
  const md0 = "# The Obvious\n\nMuch of the tension in product design comes from trying to balance things.\n\nLike a paperclip, for example.";

  test("CLI markdown -> editor marks -> saved markdown is byte-identical", () => {
    let md = addAlternatives(md0, "tension", ["pressure", "struggle"], { ai: true });
    md = pickAlternative(md, "tension", 2);
    md = ghostText(md, ", for example");
    md = flagText(md, "comes from trying to balance things", "convoluted", { note: "Say what is balanced" });
    const doc = markdownToDoc(md);
    const para = doc.content![1];
    const marked = para.content!.find((n) => n.text === "struggle")!;
    expect(marked.marks![0]).toMatchObject({ type: "draftAlts", attrs: { at: 2, ai: true } });
    expect(toMarkdown(doc).trim()).toBe(md);
    expect(describeDrafts(toMarkdown(doc)).map((d) => d.kind)).toEqual(["alts", "flag", "ghost"]);
  });

  test("an editor run split by bold stays one span on save", () => {
    const alts = { type: "draftAlts", attrs: { alts: [{ t: "a calmer line" }], at: 0, ai: false } };
    const doc = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "Say " },
          { type: "text", text: "it", marks: [alts, { type: "bold" }] },
          { type: "text", text: " loudly", marks: [alts] },
          { type: "text", text: "." },
        ],
      }],
    };
    expect(toMarkdown(doc).trim()).toBe(`Say <span data-alts='[{"t":"a calmer line"}]' data-alt-at="0">**it** loudly</span>.`);
  });
});

describe("Lab replies", () => {
  test("prompts ask for exact quotes and a JSON shape", () => {
    const { prompt } = labPrompt({ tool: "trim", level: "tighten" }, "one two three four five");
    expect(prompt).toContain("about 20% shorter");
    expect(prompt).toContain('{"cuts"');
  });

  test("parses each tool's shape and drops junk", () => {
    expect(parseLabReply({ tool: "alternatives", target: "tension", context: "" }, '{"options":["pressure","tension"," struggle ",""]}')).toEqual({
      tool: "alternatives",
      options: ["pressure", "struggle"],
    });
    expect(parseLabReply({ tool: "trim", level: "slight" }, 'Here you go:\n{"cuts":[", for example", 3]}')).toEqual({
      tool: "trim",
      level: "slight",
      cuts: [", for example"],
    });
    expect(parseLabReply({ tool: "typos" }, '{"fixes":[{"old":"teh","new":"the"},{"old":"x","new":"x"}]}')).toEqual({
      tool: "typos",
      fixes: [{ old: "teh", new: "the" }],
    });
    expect(parseLabReply({ tool: "flag", flag: "weak" }, "no json")).toBeNull();
  });
});
