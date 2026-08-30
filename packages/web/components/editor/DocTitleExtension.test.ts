import { describe, expect, it } from "bun:test";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { DocTitleExtension, TitleFirstDocument, ensureTitleBlock } from "./DocTitleExtension";

// The invariants live in ensureTitleBlock, a pure transaction transform, so
// they can be exercised on real ProseMirror state without a DOM. The schema is
// the real title-first one: StarterKit minus its document, plus ours.
const schema = getSchema([
  StarterKit.configure({ document: false }),
  TitleFirstDocument,
  DocTitleExtension,
]);

const doc = (json: any) => schema.nodeFromJSON({ type: "doc", content: json });
const text = (t: string) => ({ type: "text", text: t });
const p = (...content: any[]) => ({ type: "paragraph", content });
const h = (level: number, ...content: any[]) => ({ type: "heading", attrs: { level }, content });

function apply(docNode: PMNode, fallbackTitle = "Stored Title") {
  const state = EditorState.create({ schema, doc: docNode });
  const tr = state.tr;
  const changed = ensureTitleBlock(tr, fallbackTitle);
  return { changed, doc: changed ? state.apply(tr).doc : state.doc };
}

const firstChild = (d: PMNode) => d.firstChild!;

describe("ensureTitleBlock", () => {
  it("declares the schema with the heading required first", () => {
    expect(TitleFirstDocument.config.content).toBe("heading block*");
  });

  it("leaves a compliant doc alone", () => {
    const { changed } = apply(doc([h(1, text("Title")), p(text("body"))]));
    expect(changed).toBe(false);
  });

  it("locks the title to level 1", () => {
    const { doc: d } = apply(doc([h(2, text("Title"))]));
    expect(firstChild(d).attrs.level).toBe(1);
    expect(firstChild(d).textContent).toBe("Title");
  });

  it("legacy snapshot: a body that opens with text keeps it and gets the stored title above", () => {
    const { doc: d } = apply(doc([p(text("first para")), p(text("second"))]));
    expect(firstChild(d).type.name).toBe("heading");
    expect(firstChild(d).textContent).toBe("Stored Title");
    expect(d.child(1).textContent).toBe("first para");
  });

  it("legacy snapshot: an empty first paragraph becomes the title, carrying the stored title", () => {
    const { doc: d } = apply(doc([p()]));
    expect(d.childCount).toBe(1);
    expect(firstChild(d).type.name).toBe("heading");
    expect(firstChild(d).textContent).toBe("Stored Title");
  });

  it("an empty doc gains an empty title when there is no stored title", () => {
    const { doc: d } = apply(doc([p()]), "");
    expect(firstChild(d).type.name).toBe("heading");
    expect(firstChild(d).textContent).toBe("");
  });

  it("a pasted newline in the title pushes the remainder into the first body paragraph", () => {
    const { doc: d } = apply(doc([h(1, text("Title\nrest of paste"))]));
    expect(firstChild(d).textContent).toBe("Title");
    expect(d.child(1).type.name).toBe("paragraph");
    expect(d.child(1).textContent).toBe("rest of paste");
  });

  it("a hard break in the title splits the same way", () => {
    const { doc: d } = apply(doc([h(1, text("Title"), { type: "hardBreak" }, text("below"))]));
    expect(firstChild(d).textContent).toBe("Title");
    expect(d.child(1).type.name).toBe("paragraph");
    expect(d.child(1).textContent).toBe("below");
  });
});
