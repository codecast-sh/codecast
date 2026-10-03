// Links in the shared editor, on a real TipTap editor over jsdom: a bare URL
// in a markdown body opens as a clickable link and writes back as the same
// bare URL, from the editor's serializer and the server's save converter.
import { beforeAll, describe, expect, test } from "bun:test";

let Editor: typeof import("@tiptap/core").Editor;
let createBaseExtensions: typeof import("./editorExtensions").createBaseExtensions;
let toMarkdown: typeof import("@codecast/convex/convex/docSync").toMarkdown;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle", "DOMParser", "Text"]) {
    (globalThis as any)[key] = (dom.window as any)[key];
  }
  ({ Editor } = await import("@tiptap/core"));
  ({ createBaseExtensions } = await import("./editorExtensions"));
  ({ toMarkdown } = await import("@codecast/convex/convex/docSync"));
}, 120_000);

const make = (markdown: string) =>
  new Editor({ extensions: createBaseExtensions({ placeholder: "" }), content: markdown });
const md = (e: any) => e.storage.markdown.getMarkdown() as string;
const saved = (e: any) => toMarkdown(e.getJSON()).trim();

describe("links in the editor", () => {
  test("a bare URL opens as a link and writes back bare", () => {
    const src = "Mockups of every screen: https://example.com/a/0a1cr8_x?y=1";
    const e = make(src);
    expect(e.getHTML()).toContain('<a target="_blank" rel="noopener noreferrer nofollow" class="editor-link" href="https://example.com/a/0a1cr8_x?y=1">');
    expect(md(e)).toBe(src);
    expect(saved(e)).toBe(src);
  });

  test("a labelled link keeps its label", () => {
    const src = "See [the page](https://example.com/a(b)) now.";
    const e = make(src);
    expect(md(e)).toBe("See [the page](https://example.com/a\\(b\\)) now.");
    expect(saved(e)).toBe(src);
  });

  test("file names without a scheme stay text", () => {
    const e = make("Run deploy.sh then read README.md or mail a@b.co");
    expect(e.getHTML()).not.toContain("<a ");
  });
});
