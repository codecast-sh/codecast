// Live preview's contract, in three parts.
//
// 1. It changes nothing. Decorations are a view over the file, so a document
//    carrying the extension must read back byte for byte — checked against the
//    shared syntax corpus, which is the same list parseNote is held to.
// 2. It agrees with the reading view about what the vault's own syntax IS. The
//    markdown grammar mis-parses `[[A|b]]` as an ordinary link and `![[x]]` as
//    an image; the wiki scan has to win those ranges every time.
// 3. Raw syntax comes back exactly where the cursor is, and nowhere else.
//
// These run the real CodeMirror state and the real markdown parse. They do NOT
// run an EditorView — there is no DOM in this test process — so widget DOM,
// atomic-range cursor motion inside the browser, and click handling are the
// three things asserted structurally here and verified visually instead: the
// tests pin that hidden ranges ARE handed to the atomic set and that widgets
// are built for the right spans, not that CodeMirror then moves the caret
// correctly (that is CodeMirror's own contract).

import { test, expect, describe } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { scanLivePreview, type LiveSpan } from "../livePreviewScan";
import { decorationsFromSpans, livePreview } from "../livePreview";
import { CORPUS } from "./corpus";

const DEPS = {
  resolveWiki: (parts: { target: string }) => {
    if (parts.target === "Ambiguous") return { path: "a/Ambiguous.md", ambiguous: true };
    if (parts.target === "Missing" || parts.target === "") return { path: null };
    return { path: `${parts.target}.md` };
  },
  assetUrl: (raw: string) => `https://vault.test/${raw}`,
};

function stateFor(doc: string, cursor = 0, extra: readonly unknown[] = []) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(Math.min(cursor, doc.length)),
    extensions: [markdown({ base: markdownLanguage }), ...(extra as never[])],
  });
  // syntaxTree() only returns what the parser has reached; force the whole
  // document so a scan of the whole document sees a whole tree.
  ensureSyntaxTree(state, doc.length, 10_000);
  return state;
}

// Reveal is boundary inclusive, so in a short document there is often nowhere
// to put the cursor that isn't touching the thing under test. Omitting the
// cursor parks it on a scratch line appended past the end — "the cursor is
// somewhere else entirely", which is the state most of these assertions mean.
const PARK = "\n\nelsewhere";

function scan(doc: string, cursor?: number): LiveSpan[] {
  const full = cursor === undefined ? doc + PARK : doc;
  const state = stateFor(full, cursor ?? full.length);
  return scanLivePreview(state, [{ from: 0, to: doc.length }], DEPS);
}

/** The text a span covers — what an assertion actually wants to talk about. */
function textOf(doc: string, span: LiveSpan): string {
  return span.kind === "line" ? "" : doc.slice(span.from, span.to);
}

function marks(doc: string, cursor?: number) {
  return scan(doc, cursor)
    .filter((s) => s.kind === "mark")
    .map((s) => ({ class: (s as { class: string }).class, text: textOf(doc, s) }));
}

function hidden(doc: string, cursor?: number) {
  return scan(doc, cursor)
    .filter((s) => s.kind === "hide")
    .map((s) => textOf(doc, s));
}

function widgets(doc: string, cursor?: number) {
  return scan(doc, cursor)
    .filter((s) => s.kind === "widget")
    .map((s) => (s as { widget: { type: string } }).widget.type);
}

function lineClasses(doc: string, cursor?: number) {
  return scan(doc, cursor)
    .filter((s) => s.kind === "line")
    .map((s) => (s as { class: string }).class);
}

// ---------------------------------------------------------------------------
// 1. It changes nothing
// ---------------------------------------------------------------------------

describe("byte fidelity", () => {
  test("a document carrying the extension reads back unchanged", () => {
    for (const c of CORPUS) {
      const state = stateFor(c.markdown, 0, [livePreview(DEPS)]);
      expect(state.doc.toString()).toBe(c.markdown);
    }
  });

  test("scanning the whole corpus produces only in-bounds spans", () => {
    for (const c of CORPUS) {
      const state = stateFor(c.markdown);
      const spans = scanLivePreview(state, [{ from: 0, to: c.markdown.length }], DEPS);
      for (const s of spans) {
        expect(s.from).toBeGreaterThanOrEqual(0);
        expect(s.from).toBeLessThanOrEqual(c.markdown.length);
        if (s.kind !== "line") {
          expect(s.to).toBeGreaterThan(s.from);
          expect(s.to).toBeLessThanOrEqual(c.markdown.length);
        }
      }
    }
  });

  // A replacing decoration from a ViewPlugin may not cover a line break —
  // CodeMirror throws when one does, so this is a crash test, not a taste one.
  test("no replaced range ever crosses a line break", () => {
    for (const c of CORPUS) {
      const state = stateFor(c.markdown);
      const spans = scanLivePreview(state, [{ from: 0, to: c.markdown.length }], DEPS);
      for (const s of spans) {
        if (s.kind !== "hide" && s.kind !== "widget") continue;
        expect(state.doc.lineAt(s.from).number).toBe(state.doc.lineAt(s.to).number);
      }
    }
  });

  // CodeMirror rejects replacing decorations that PARTIALLY overlap, and it
  // does so while drawing — no headless assertion on the decoration set would
  // catch it, so the invariant is checked on the spans instead. Nesting is the
  // shape that produces it: emphasis inside a link, a wiki link inside
  // emphasis, a heading inside a quote.
  const NESTED = [
    "> # Quoted heading",
    "",
    "**[a link](x.md)** and [**bold text**](y.md)",
    "",
    "**[[Wiki|alias]]** and *#tag* and `[[not a link]]`",
    "",
    "- ***nested emphasis*** in a bullet",
    "- [ ] a task with **bold** and [[Note]]",
    "",
    "> - quoted bullet with ![img](p.png)",
    "",
    "# Heading with [[Note|alias]] and #tag ^anchor",
  ].join("\n");

  test("replaced ranges never partially overlap", () => {
    for (const doc of [...CORPUS.map((c) => c.markdown), NESTED]) {
      const state = stateFor(doc);
      const replaced = scanLivePreview(state, [{ from: 0, to: doc.length }], DEPS)
        .filter((s) => s.kind === "hide" || s.kind === "widget")
        .map((s) => [s.from, s.to] as [number, number])
        .sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < replaced.length; i++) {
        const previous = replaced[i - 1];
        const current = replaced[i];
        // Reported as text: a bare index comparison tells you nothing about
        // which two constructs collided.
        expect({
          previous: doc.slice(...previous),
          current: doc.slice(...current),
          disjoint: current[0] >= previous[1],
        }).toEqual({
          previous: doc.slice(...previous),
          current: doc.slice(...current),
          disjoint: true,
        });
      }
    }
  });

  test("nested constructs still build a decoration set", () => {
    for (const doc of [...CORPUS.map((c) => c.markdown), NESTED]) {
      const state = stateFor(doc);
      const spans = scanLivePreview(state, [{ from: 0, to: doc.length }], DEPS);
      expect(() => decorationsFromSpans(spans)).not.toThrow();
    }
  });

  test("scanning is stable across viewport slicing", () => {
    const doc = CORPUS.map((c) => c.markdown).join("\n\n");
    const state = stateFor(doc);
    const whole = scanLivePreview(state, [{ from: 0, to: doc.length }], DEPS);
    const half = Math.floor(doc.length / 2);
    const pieced = [
      ...scanLivePreview(state, [{ from: 0, to: half }], DEPS),
      ...scanLivePreview(state, [{ from: half, to: doc.length }], DEPS),
    ];
    // Every span the whole-document scan found is found by one of the halves.
    // (The halves may find MORE: both see the line the split lands on.)
    const key = (s: LiveSpan) => `${s.kind}:${s.from}:${"to" in s ? s.to : ""}`;
    const seen = new Set(pieced.map(key));
    for (const s of whole) expect(seen.has(key(s))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Construct coverage
// ---------------------------------------------------------------------------

describe("inline constructs", () => {
  test("emphasis, strong, strikethrough and code hide their fences", () => {
    const doc = "a **bold** *em* ~~gone~~ `code` z";
    expect(hidden(doc)).toEqual(["**", "**", "*", "*", "~~", "~~", "`", "`"]);
    expect(marks(doc)).toEqual([
      { class: "cm-live-strong", text: "bold" },
      { class: "cm-live-em", text: "em" },
      { class: "cm-live-strike", text: "gone" },
      { class: "cm-live-code", text: "code" },
    ]);
  });

  test("nested strong+emphasis styles both layers", () => {
    const doc = "x ***both*** y";
    const classes = marks(doc).map((m) => m.class);
    expect(classes).toContain("cm-live-strong");
    expect(classes).toContain("cm-live-em");
    // The grammar reads `***x***` as emphasis wrapping strong, so the outer
    // fence is the single `*`.
    expect(hidden(doc)).toEqual(["*", "**", "**", "*"]);
  });

  test("a markdown link shows its text and hides the target", () => {
    const doc = "see [the docs](https://example.com) now";
    expect(marks(doc)).toEqual([{ class: "cm-live-link", text: "the docs" }]);
    expect(hidden(doc)).toEqual(["[", "](https://example.com)"]);
  });

  test("the link's href rides along for the click handler", () => {
    const span = scan("see [x](https://example.com)").find(
      (s) => s.kind === "mark" && s.class === "cm-live-link",
    ) as { attrs?: Record<string, string> };
    expect(span.attrs?.["data-live-href"]).toBe("https://example.com");
  });

  test("an inline image becomes a widget", () => {
    expect(widgets("look ![a cat](cat.png) here")).toEqual(["image"]);
  });

  test("an image whose source cannot be served stays raw", () => {
    const state = stateFor("![a cat](cat.png)");
    const spans = scanLivePreview(state, [{ from: 0, to: 17 }], { assetUrl: () => null });
    expect(spans.filter((s) => s.kind === "widget")).toEqual([]);
  });
});

describe("block constructs", () => {
  test("heading marks hide and the line is sized by level", () => {
    // Cursor parked far away: heading lines are revealed by line, not by node.
    const doc = "# One\n\n### Three\n\ntail";
    expect(hidden(doc)).toEqual(["# ", "### "]);
    expect(lineClasses(doc)).toEqual(["cm-live-h1", "cm-live-h3"]);
  });

  test("a closed heading loses its trailing hashes too", () => {
    const doc = "## Two ##\n\ntail";
    expect(hidden(doc)).toEqual(["## ", " ##"]);
  });

  test("bullets become a widget, numbers keep their digits", () => {
    const doc = "- one\n* two\n+ three\n1. four";
    expect(widgets(doc)).toEqual(["bullet", "bullet", "bullet"]);
    expect(marks(doc)).toEqual([{ class: "cm-live-listmark", text: "1." }]);
  });

  test("a task item keeps its dash — the checkbox is its marker", () => {
    const doc = "- [ ] chore\n- [x] done";
    expect(widgets(doc)).toEqual([]);
    expect(marks(doc).map((m) => m.text)).toEqual(["-", "-"]);
  });

  test("blockquote markers hide behind a line rule", () => {
    const doc = "> quoted\n\ntail";
    expect(hidden(doc)).toEqual(["> "]);
    expect(lineClasses(doc)).toEqual(["cm-live-quote"]);
  });

  test("a horizontal rule becomes a drawn rule", () => {
    expect(widgets("above\n\n---\n\nbelow")).toEqual(["rule"]);
  });

  test("fenced code keeps every character and gets a background", () => {
    const doc = "```js\nconst a = 1;\n```\n";
    expect(hidden(doc)).toEqual([]);
    expect(lineClasses(doc)).toEqual([
      "cm-live-codeblock",
      "cm-live-codeblock",
      "cm-live-codeblock",
    ]);
  });
});

describe("vault syntax", () => {
  test("a plain wiki link shows its target and hides the brackets", () => {
    const doc = "see [[Some Note]] here";
    expect(hidden(doc)).toEqual(["[[", "]]"]);
    expect(marks(doc)).toEqual([{ class: "wiki-link", text: "Some Note" }]);
  });

  test("an aliased wiki link shows ONLY the alias", () => {
    const doc = "see [[Some Note|the alias]] here";
    expect(hidden(doc)).toEqual(["[[Some Note|", "]]"]);
    expect(marks(doc)).toEqual([{ class: "wiki-link", text: "the alias" }]);
  });

  test("a subpath link keeps the characters you would type", () => {
    const doc = "see [[Note#Section]] here";
    expect(marks(doc)).toEqual([{ class: "wiki-link", text: "Note#Section" }]);
  });

  test("unresolved and ambiguous targets carry the reading view's classes", () => {
    expect(marks("[[Missing]]")[0].class).toBe("wiki-link wiki-link-unresolved");
    expect(marks("[[Ambiguous]]")[0].class).toBe("wiki-link wiki-link-ambiguous");
  });

  test("the raw source rides along so a click can re-parse it", () => {
    const span = scan("[[Note#Head|shown]]").find((s) => s.kind === "mark") as {
      attrs?: Record<string, string>;
    };
    expect(span.attrs?.["data-live-wiki"]).toBe("[[Note#Head|shown]]");
  });

  test("the wiki scan beats the grammar's misreading of the same brackets", () => {
    // lang-markdown parses `[[A|b]]` as a Link over the INNER brackets and
    // `![[x.png]]` as an Image. Neither may produce a decoration of its own.
    const doc = "[[A|b]] and ![[pic.png]]";
    expect(marks(doc).map((m) => m.class)).toEqual(["wiki-link"]);
    expect(widgets(doc)).toEqual(["image"]);
  });

  test("an image embed renders, a note embed stays raw", () => {
    expect(widgets("![[diagram.png]]")).toEqual(["image"]);
    expect(scan("![[Some Note]]")).toEqual([]);
  });

  test("inline tags become pills, bare numbers do not", () => {
    expect(marks("about #cooking and #123 here")).toEqual([
      { class: "vault-tag", text: "#cooking" },
    ]);
  });

  test("a trailing block anchor disappears", () => {
    const doc = "A paragraph. ^abc-123\n\ntail";
    expect(hidden(doc)).toEqual([" ^abc-123"]);
  });

  test("vault syntax inside code is literal, exactly as the reading view has it", () => {
    expect(scan("`[[Not A Link]] and #nottag`")).toEqual([
      { kind: "hide", from: 0, to: 1 },
      { kind: "mark", from: 1, to: 27, class: "cm-live-code", attrs: undefined },
      { kind: "hide", from: 27, to: 28 },
    ]);
    const fenced = "```\n[[Not A Link]] #nottag\n```";
    expect(scan(fenced).filter((s) => s.kind !== "line")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Cursor reveal
// ---------------------------------------------------------------------------

describe("cursor reveal", () => {
  const doc = "a **bold** b";

  test("markers hide while the cursor is elsewhere", () => {
    expect(hidden(doc, 0)).toEqual(["**", "**"]);
  });

  test("markers come back when the cursor is inside the construct", () => {
    expect(hidden(doc, 6)).toEqual([]);
    // …and the content stays styled, so the text doesn't jump between fonts.
    expect(marks(doc, 6)).toEqual([{ class: "cm-live-strong", text: "bold" }]);
  });

  test("touching either boundary counts as inside", () => {
    expect(hidden(doc, 2)).toEqual([]); // just before the opening **
    expect(hidden(doc, 10)).toEqual([]); // just after the closing **
    expect(hidden(doc, 11)).toEqual(["**", "**"]); // one character clear
  });

  test("a selection spanning the construct reveals it", () => {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: [markdown({ base: markdownLanguage })],
    });
    ensureSyntaxTree(state, doc.length, 10_000);
    const spans = scanLivePreview(state, [{ from: 0, to: doc.length }], DEPS);
    expect(spans.filter((s) => s.kind === "hide")).toEqual([]);
  });

  test("only the touched construct reveals; its neighbours stay rendered", () => {
    const two = "**one** and **two**";
    expect(hidden(two, 3)).toEqual(["**", "**"]); // the second pair only
  });

  test("a block construct reveals from anywhere on its line", () => {
    const heading = "# Title\n\nbody";
    expect(hidden(heading, 7)).toEqual([]); // end of the heading line
    expect(hidden(heading, 9)).toEqual(["# "]); // down in the body
  });

  test("a wiki link reveals its brackets under the cursor", () => {
    const wiki = "see [[Note|shown]] here";
    expect(hidden(wiki, 0)).toEqual(["[[Note|", "]]"]);
    expect(hidden(wiki, 12)).toEqual([]);
    // Revealed or not, the grammar's misreading never gets to decorate it.
    expect(marks(wiki, 12)).toEqual([]);
  });

  test("a tag pill survives the cursor — it hides nothing to begin with", () => {
    expect(marks("a #tag b", 3)).toEqual([{ class: "vault-tag", text: "#tag" }]);
  });
});

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

describe("decoration building", () => {
  test("hidden markers and widgets are atomic; styled text is not", () => {
    const doc = "a **bold** and [[Note]] and\n\n---\n";
    const { decorations, atomic } = decorationsFromSpans(scan(doc, 0));
    expect(decorations.size).toBeGreaterThan(0);

    const atomicRanges: [number, number][] = [];
    atomic.between(0, doc.length, (from, to) => {
      atomicRanges.push([from, to]);
    });
    // Four hidden marker runs (** ** [[ ]]) plus the rule widget.
    expect(atomicRanges.length).toBe(5);
    for (const [from, to] of atomicRanges) {
      expect(["**", "[[", "]]", "---"]).toContain(doc.slice(from, to));
    }
  });

  test("every span becomes exactly one decoration", () => {
    const doc = "# H\n\n**b** [[N]] #t\n";
    const spans = scan(doc);
    expect(decorationsFromSpans(spans).decorations.size).toBe(spans.length);
  });

  test("nested emphasis produces a valid overlapping set", () => {
    // Decoration.set(…, true) has to sort these; an unsorted set throws.
    expect(() => decorationsFromSpans(scan("x ***both*** y"))).not.toThrow();
  });
});

// A claim inside a legitimate construct must not disqualify that construct —
// the editor and the reading view have to describe the same file the same way.
// (Review finding R12: `isClaimed` used overlap, so a #tag anywhere inside a
// bold run or a markdown link silently killed the outer construct's rendering.)
describe("vault syntax nested inside ordinary constructs", () => {
  // A leading word keeps every construct away from position 0, where the
  // default cursor sits — reveal is boundary-inclusive, so a construct at the
  // doc start is legitimately "under the cursor" and stays raw.
  const spansOf = (src: string) => {
    const doc = `lead ${src}`;
    const state = EditorState.create({ doc, extensions: [markdown()] });
    return scanLivePreview(state, [{ from: 0, to: doc.length }], {});
  };

  test("a markdown link containing a tag still live-previews", () => {
    const spans = spansOf("[text with #tag here](https://example.com)");
    expect(spans.some((s) => s.kind === "mark" && s.class.includes("cm-live-link"))).toBe(true);
    expect(spans.some((s) => s.kind === "mark" && s.class.includes("vault-tag"))).toBe(true);
    expect(spans.some((s) => s.kind === "hide")).toBe(true);
  });

  test("bold containing a tag still hides its fences", () => {
    const spans = spansOf("**bold text with #tag inside**");
    expect(spans.some((s) => s.kind === "mark" && s.class.includes("cm-live-strong"))).toBe(true);
    expect(spans.filter((s) => s.kind === "hide").length).toBeGreaterThanOrEqual(2);
  });

  test("emphasis containing a tag still hides its fences", () => {
    const spans = spansOf("*plain #tag*");
    expect(spans.some((s) => s.kind === "mark" && s.class.includes("cm-live-em"))).toBe(true);
    expect(spans.filter((s) => s.kind === "hide").length).toBeGreaterThanOrEqual(2);
  });

  test("bold wrapping a wiki link renders both", () => {
    const spans = spansOf("**[[Wiki|alias]]** tail");
    expect(spans.some((s) => s.kind === "mark" && s.class.includes("cm-live-strong"))).toBe(true);
    expect(spans.some((s) => s.kind === "mark" && s.class.includes("wiki-link"))).toBe(true);
  });

  test("a wiki link the grammar misreads as a Link is still left to the regex pass", () => {
    const spans = spansOf("see [[Target|shown]] here");
    // The wiki mark must exist and NO cm-live-link mark may be emitted for it.
    expect(spans.some((s) => s.kind === "mark" && s.class.includes("wiki-link"))).toBe(true);
    expect(spans.some((s) => s.kind === "mark" && s.class.includes("cm-live-link"))).toBe(false);
  });
});
