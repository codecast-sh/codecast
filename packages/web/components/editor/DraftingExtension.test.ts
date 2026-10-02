// Drafting in the live editor, on a real TipTap editor over jsdom: the doc's
// markdown opens as marks (tiptap-markdown seed path), cycling swaps in place
// with a/an agreement, the Lab's results land as marks, and both the editor's
// markdown and the server's save converter write the shared markup back.
import { beforeAll, describe, expect, test } from "bun:test";

let Editor: typeof import("@tiptap/core").Editor;
let createBaseExtensions: typeof import("./editorExtensions").createBaseExtensions;
let D: typeof import("./DraftingExtension");
let toMarkdown: typeof import("@codecast/convex/convex/docSync").toMarkdown;
let shared: typeof import("@codecast/shared/docs");

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle", "DOMParser", "Text"]) {
    (globalThis as any)[key] = (dom.window as any)[key];
  }
  ({ Editor } = await import("@tiptap/core"));
  ({ createBaseExtensions } = await import("./editorExtensions"));
  D = await import("./DraftingExtension");
  ({ toMarkdown } = await import("@codecast/convex/convex/docSync"));
  shared = await import("@codecast/shared/docs");
}, 120_000);

function make(markdown: string) {
  const editor = new Editor({
    extensions: [...createBaseExtensions({ placeholder: "" }), D.DraftingExtension],
    content: markdown,
  });
  D.setDraftingEnabled(editor, true);
  return editor;
}
const md = (e: any) => e.storage.markdown.getMarkdown() as string;
const saved = (e: any) => toMarkdown(e.getJSON()).trim();

describe("drafting in the editor", () => {
  test("markdown spans open as marks and write back unchanged, from both serializers", () => {
    let src = shared.addAlternatives("Like a paperclip, for example.", "paperclip", ["thumbtack", "eraser"], { ai: true });
    src = shared.ghostText(src, ", for example");
    const e = make(src);
    const json = JSON.stringify(e.getJSON());
    expect(json).toContain('"type":"draftAlts"');
    expect(json).toContain('"type":"draftGhost"');
    expect(saved(e)).toBe(src);
    expect(md(e)).toBe(src);
    e.destroy();
  });

  test("a copy carries the prose as shown, never the drafting markup", () => {
    let src = shared.addAlternatives("Like a paperclip, for example.", "paperclip", ["thumbtack", "eraser"], { ai: true });
    src = shared.ghostText(src, ", for example");
    const e = make(src);
    const slice = e.view.someProp("transformCopied", (f: any) => f(e.state.doc.slice(0, e.state.doc.content.size), e.view));
    const text = e.storage.markdown.serializer.serialize(slice.content).trim();
    expect(text).toBe("Like a paperclip.");
    expect(md(e)).toBe(src);
    e.destroy();
  });

  test("cycling swaps the word in place and fixes the article", () => {
    const e = make(shared.addAlternatives("Like a paperclip, for example.", "paperclip", ["thumbtack", "eraser"]));
    const pos = D.findTextRanges(e.state.doc, "paperclip")[0].from;
    expect(D.cycleAlternativeAt(e.view, pos, -1)).toBe(true);
    expect(e.getText()).toBe("Like an eraser, for example.");
    const at = D.findTextRanges(e.state.doc, "eraser")[0].from;
    D.cycleAlternativeAt(e.view, at, -1);
    expect(e.getText()).toBe("Like a thumbtack, for example.");
    const d = shared.describeDrafts(saved(e))[0] as any;
    expect(d.at).toBe(1);
    expect(d.versions.map((v: any) => v.t)).toEqual(["paperclip", "thumbtack", "eraser"]);
    e.destroy();
  });

  test("adding a version by hand shows it; dropping the last extra settles the run", () => {
    const e = make("Much of the tension here.");
    const r = D.findTextRanges(e.state.doc, "tension")[0];
    D.addAlternativesAt(e.view, r, ["challenge"], { show: true });
    expect(e.getText()).toBe("Much of the challenge here.");
    const pos = D.findTextRanges(e.state.doc, "challenge")[0].from;
    D.pickAlternativeAt(e.view, pos, 0);
    D.removeAlternativeAt(e.view, D.findTextRanges(e.state.doc, "tension")[0].from, 1);
    expect(saved(e)).toBe("Much of the tension here.");
    e.destroy();
  });

  test("a trim lands as proposed cuts; a new trim replaces them; making the cuts tidies spacing", () => {
    const e = make("Much of the tension, for example, really comes from trying.");
    D.applyLabResultInEditor(e.view, { tool: "trim", level: "slight", cuts: ["really "] });
    D.applyLabResultInEditor(e.view, { tool: "trim", level: "tighten", cuts: [", for example,", "really "] });
    expect(D.ghostRanges(e.state, shared.TRIM_REASON)).toHaveLength(2);
    expect(D.wordsWithout(e.state, shared.TRIM_REASON)).toBe(7);
    D.makeCuts(e.view);
    expect(e.getText()).toBe("Much of the tension comes from trying.");
    e.destroy();
  });

  test("typo fixes land as a version the writer can flip back", () => {
    const e = make("Teh obvious choice.");
    D.applyLabResultInEditor(e.view, { tool: "typos", fixes: [{ old: "Teh", new: "The" }] });
    expect(e.getText()).toBe("The obvious choice.");
    D.cycleAlternativeAt(e.view, 1, -1);
    expect(e.getText()).toBe("Teh obvious choice.");
    e.destroy();
  });

  test("ghost toggles on the selection and revives", () => {
    const e = make("Keep this, maybe not this.");
    const r = D.findTextRanges(e.state.doc, ", maybe not this")[0];
    e.commands.setTextSelection(r);
    D.toggleGhost(e.view);
    expect(saved(e)).toBe('Keep this<span data-ghost="">, maybe not this</span>.');
    D.reviveAt(e.view, r.from + 2);
    expect(saved(e)).toBe("Keep this, maybe not this.");
    e.destroy();
  });

  test("scopes: word, sentence, paragraph around the caret", () => {
    const e = make("First one here. Second sentence is longer! Third.");
    const pos = D.findTextRanges(e.state.doc, "sentence")[0].from + 2;
    const t = (r: any) => e.state.doc.textBetween(r.from, r.to);
    expect(t(D.scopeRange(e.state, pos, "word"))).toBe("sentence");
    expect(t(D.scopeRange(e.state, pos, "sentence"))).toBe("Second sentence is longer!");
    expect(t(D.scopeRange(e.state, pos, "paragraph"))).toBe("First one here. Second sentence is longer! Third.");
    e.destroy();
  });
});
