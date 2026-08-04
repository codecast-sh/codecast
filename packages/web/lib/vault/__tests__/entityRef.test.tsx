// Codecast object references in vault notes.
//
// The binding constraint on this feature is that notes are REAL FILES the user
// may open in Obsidian, read on GitHub, or edit in vim, so the reference form
// has to keep working there. It is therefore an ordinary markdown link to the
// public URL that already addresses the object. These tests hold that line in
// four places:
//
//  1. the resolver — which URLs address an object, and which merely look like
//     they do (an id that could never name one must stay a plain link),
//  2. insertion — picking an object from `[[` writes the link form; picking a
//     note still writes `[[Note]]`, byte for byte,
//  3. agreement — the reading view and the live-preview editor find the SAME
//     references in the same document, because they ask the same function,
//  4. byte fidelity — a note carrying these links reads back unchanged.

import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  entityRefKey,
  entityRefMarkdown,
  entityRefRoute,
  entityRefUrl,
  isValidEntityHandle,
  makeEntityRef,
  parseEntityRefHref,
  sanitizeLinkText,
  scanEntityRefs,
  VaultIndex,
} from "@codecast/shared/vault";
import {
  entityCompletions,
  entityLinkEdit,
  markdownForMentionItem,
  refForMentionItem,
  wikiCompletionContext,
} from "../entityCompletion";
import { vaultRemarkPlugins } from "../remarkWikiLink";
import { scanLivePreview } from "../livePreviewScan";
import { livePreview } from "../livePreview";
import { CORPUS } from "./corpus";

const CONVEX_ID = "k57abcdefghijklmnopqrstuvwxyz012";

// ---------------------------------------------------------------------------
// 1. The resolver
// ---------------------------------------------------------------------------

describe("parseEntityRefHref", () => {
  test("recognizes every addressable type on the production origin", () => {
    const cases: [string, string, string][] = [
      ["https://codecast.sh/tasks/ct-40561", "task", "ct-40561"],
      ["https://codecast.sh/plans/pl-264", "plan", "pl-264"],
      ["https://codecast.sh/conversation/jx7dnj1", "session", "jx7dnj1"],
      ["https://codecast.sh/sessions/jx7dnj1", "session", "jx7dnj1"],
      [`https://codecast.sh/docs/${CONVEX_ID}`, "doc", CONVEX_ID],
      [`https://codecast.sh/projects/${CONVEX_ID}`, "project", CONVEX_ID],
      ["https://codecast.sh/triggers?task=tr-17", "trigger", "tr-17"],
      ["https://codecast.sh/team/ashot", "person", "ashot"],
      ["https://codecast.sh/u/ashot", "person", "ashot"],
    ];
    for (const [href, type, id] of cases) {
      expect(parseEntityRefHref(href)).toEqual({ type, id, key: entityRefKey(type as never, id) });
    }
  });

  test("accepts path-only hrefs and the local dev origins", () => {
    expect(parseEntityRefHref("/tasks/ct-1")?.type).toBe("task");
    expect(parseEntityRefHref("/team/ashot")?.type).toBe("person");
    expect(parseEntityRefHref("http://localhost:3200/plans/pl-9")?.id).toBe("pl-9");
  });

  test("another site's URL is not ours, however similar the path", () => {
    expect(parseEntityRefHref("https://example.com/tasks/ct-1")).toBeNull();
    expect(parseEntityRefHref("https://codecast.sh.evil.com/tasks/ct-1")).toBeNull();
  });

  // The guard that makes "unresolved" honest: a pill for an id that could never
  // name an object of that type is a promise the app cannot keep.
  test("an id that cannot name an object of that type stays a plain link", () => {
    expect(parseEntityRefHref("https://codecast.sh/tasks/pl-264")).toBeNull();
    expect(parseEntityRefHref("https://codecast.sh/tasks/not-an-id!")).toBeNull();
    expect(parseEntityRefHref("https://codecast.sh/plans/ct-1")).toBeNull();
    expect(parseEntityRefHref("https://codecast.sh/conversation/nope")).toBeNull();
    // Docs and projects have no short id — only a Convex id addresses them.
    expect(parseEntityRefHref("https://codecast.sh/docs/some-slug")).toBeNull();
  });

  test("non-object app pages are left alone", () => {
    expect(parseEntityRefHref("https://codecast.sh/settings/devices")).toBeNull();
    expect(parseEntityRefHref("https://codecast.sh/team")).toBeNull();
    expect(parseEntityRefHref("https://codecast.sh/team/activity")).toBeNull();
    expect(parseEntityRefHref("https://codecast.sh/")).toBeNull();
  });

  test("hrefs that are not app links at all", () => {
    expect(parseEntityRefHref("")).toBeNull();
    expect(parseEntityRefHref(null)).toBeNull();
    expect(parseEntityRefHref("mailto:a@b.c")).toBeNull();
    expect(parseEntityRefHref("wiki://Some%20Note")).toBeNull();
    expect(parseEntityRefHref("Other Note.md")).toBeNull();
  });

  test("a Convex id addresses any object type", () => {
    expect(isValidEntityHandle("task", CONVEX_ID)).toBe(true);
    expect(isValidEntityHandle("doc", CONVEX_ID)).toBe(true);
    expect(parseEntityRefHref(`https://codecast.sh/tasks/${CONVEX_ID}`)?.id).toBe(CONVEX_ID);
  });

  test("a person is addressed by a github username, and only by one", () => {
    expect(isValidEntityHandle("person", "ashot")).toBe(true);
    expect(isValidEntityHandle("person", "a-b-1")).toBe(true);
    expect(isValidEntityHandle("person", "has spaces")).toBe(false);
    expect(isValidEntityHandle("person", "has.dots")).toBe(false);
    expect(isValidEntityHandle("person", "x".repeat(40))).toBe(false);
  });

  test("the url and route are the inverse of the parse", () => {
    for (const href of [
      "https://codecast.sh/tasks/ct-40561",
      "https://codecast.sh/conversation/jx7dnj1",
      "https://codecast.sh/team/ashot",
    ]) {
      const ref = parseEntityRefHref(href)!;
      const url = entityRefUrl(ref)!;
      expect(parseEntityRefHref(url)).toEqual(ref);
      expect(entityRefRoute(ref)).toBe(new URL(url).pathname);
    }
  });

  test("one object gets one key however its URL was spelled", () => {
    const a = parseEntityRefHref("https://codecast.sh/tasks/CT-40561")!;
    const b = parseEntityRefHref("/tasks/ct-40561")!;
    expect(a.key).toBe(b.key);
    // The id keeps the case it was written in — Convex ids are case sensitive.
    expect(a.id).toBe("CT-40561");
  });
});

// ---------------------------------------------------------------------------
// 2. Scanning a note for references
// ---------------------------------------------------------------------------

describe("scanEntityRefs", () => {
  test("finds inline links and bare URLs, with their coordinates", () => {
    const note = [
      "# Notes",
      "",
      "Figured out in [the debug session](https://codecast.sh/conversation/jx7dnj1).",
      "",
      "Belongs to https://codecast.sh/tasks/ct-40561 and nothing else.",
    ].join("\n");
    const refs = scanEntityRefs(note);
    expect(refs.map((r) => r.ref.key)).toEqual(["session:jx7dnj1", "task:ct-40561"]);
    expect(refs[0].line).toBe(3);
    expect(refs[0].col).toBe(note.split("\n")[2].indexOf("[the debug"));
    expect(refs[0].text).toBe("the debug session");
    expect(refs[1].text).toBe("https://codecast.sh/tasks/ct-40561");
  });

  test("code is literal — an example URL is not a reference", () => {
    const note = [
      "Inline `https://codecast.sh/tasks/ct-1` stays text.",
      "",
      "```md",
      "[x](https://codecast.sh/tasks/ct-2)",
      "```",
      "",
      "[real](https://codecast.sh/tasks/ct-3)",
    ].join("\n");
    expect(scanEntityRefs(note).map((r) => r.ref.id)).toEqual(["ct-3"]);
  });

  test("a bare URL already inside a link is counted once", () => {
    const refs = scanEntityRefs("[ct-1](https://codecast.sh/tasks/ct-1)");
    expect(refs).toHaveLength(1);
  });

  // A path-only link carries no scheme, so any "does this line have a URL"
  // shortcut that looks for `//` skips it silently.
  test("a path-only link is found on a line with nothing else on it", () => {
    expect(scanEntityRefs("Owner: [t](/tasks/ct-9)").map((r) => r.ref.key)).toEqual(["task:ct-9"]);
  });

  test("a note with no references costs nothing and finds nothing", () => {
    expect(scanEntityRefs("# Title\n\nJust prose, and a [[Wiki Link]].")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The index answers "which notes reference this object" locally
// ---------------------------------------------------------------------------

describe("vault index", () => {
  const files: Record<string, string> = {
    "a.md": "Fixed in [the run](https://codecast.sh/conversation/jx7dnj1) for ct work.\n",
    "b.md": "Also see https://codecast.sh/conversation/jx7dnj1 and [t](/tasks/ct-9).\n",
    "c.md": "Nothing here.\n",
  };

  test("groups notes by the object they reference", () => {
    const index = VaultIndex.build(Object.entries(files));
    expect(index.notesReferencingEntity("session:jx7dnj1")).toEqual(["a.md", "b.md"]);
    expect(index.notesReferencingEntity("task:ct-9")).toEqual(["b.md"]);
    expect(index.notesReferencingEntity("task:ct-404")).toEqual([]);
    expect(index.entityRefs("c.md")).toEqual([]);
  });

  test("editing a note retires the references it dropped", () => {
    const index = VaultIndex.build(Object.entries(files));
    index.upsert("b.md", "Now it links nothing.\n");
    expect(index.notesReferencingEntity("session:jx7dnj1")).toEqual(["a.md"]);
    expect(index.notesReferencingEntity("task:ct-9")).toEqual([]);
  });

  test("removing a note retires its references", () => {
    const index = VaultIndex.build(Object.entries(files));
    index.remove("a.md");
    expect(index.notesReferencingEntity("session:jx7dnj1")).toEqual(["b.md"]);
  });

  test("a rename carries the references to the new path", () => {
    const index = VaultIndex.build(Object.entries(files));
    index.rename("a.md", "sub/a.md");
    expect(index.notesReferencingEntity("session:jx7dnj1")).toEqual(["b.md", "sub/a.md"]);
  });

  test("a snapshot round trip keeps them", () => {
    const index = VaultIndex.build(Object.entries(files));
    const restored = VaultIndex.fromSnapshot(index.snapshot())!;
    expect(restored.notesReferencingEntity("session:jx7dnj1")).toEqual(["a.md", "b.md"]);
    expect(restored.referencedEntities().map((e) => e.key)).toEqual([
      "session:jx7dnj1",
      "task:ct-9",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Autocomplete insertion
// ---------------------------------------------------------------------------

const ITEMS = {
  task: { id: CONVEX_ID, type: "task", label: "Fix the sync clog", shortId: "ct-40561" },
  plan: { id: CONVEX_ID, type: "plan", label: "Vault links", shortId: "pl-264" },
  session: { id: `${"jx7dnj1"}xxxxxxxxxxxxxxxxxxxxxxxxx`, type: "session", label: "Debug run", shortId: "jx7dnj1" },
  doc: { id: CONVEX_ID, type: "doc", label: "Library decisions" },
  person: { id: CONVEX_ID, type: "person", label: "Ashot", shortId: "@ashot" },
  label: { id: CONVEX_ID, type: "label", label: "fleet", shortId: `label:${CONVEX_ID}` },
  nameless: { id: CONVEX_ID, type: "person", label: "No Handle" },
};

describe("what an object completion inserts", () => {
  test("one markdown link per type, addressed by its own handle", () => {
    expect(markdownForMentionItem(ITEMS.task)).toBe(
      "[Fix the sync clog](https://codecast.sh/tasks/ct-40561)",
    );
    expect(markdownForMentionItem(ITEMS.plan)).toBe(
      "[Vault links](https://codecast.sh/plans/pl-264)",
    );
    expect(markdownForMentionItem(ITEMS.session)).toBe(
      "[Debug run](https://codecast.sh/conversation/jx7dnj1)",
    );
    expect(markdownForMentionItem(ITEMS.doc)).toBe(
      `[Library decisions](https://codecast.sh/docs/${CONVEX_ID})`,
    );
    expect(markdownForMentionItem(ITEMS.person)).toBe("[@ashot](https://codecast.sh/team/ashot)");
  });

  test("everything it inserts reads back as the reference it meant", () => {
    for (const item of [ITEMS.task, ITEMS.plan, ITEMS.session, ITEMS.doc, ITEMS.person]) {
      const md = markdownForMentionItem(item)!;
      const href = md.slice(md.indexOf("](") + 2, -1);
      expect(parseEntityRefHref(href)).toEqual(refForMentionItem(item));
    }
  });

  test("things with no page of their own offer nothing", () => {
    expect(markdownForMentionItem(ITEMS.label)).toBeNull();
    expect(markdownForMentionItem(ITEMS.nameless)).toBeNull();
    expect(entityCompletions([ITEMS.label, ITEMS.nameless])).toHaveLength(0);
  });

  test("brackets in a title are flattened, never left to break the link", () => {
    expect(sanitizeLinkText("Fix [the] sync\nclog")).toBe("Fix the sync clog");
    const md = markdownForMentionItem({ ...ITEMS.task, label: "Fix [the] clog" })!;
    expect(md).toBe("[Fix the clog](https://codecast.sh/tasks/ct-40561)");
  });

  test("the dropdown shows one option per object, titled and labelled", () => {
    const options = entityCompletions([ITEMS.task, ITEMS.task, ITEMS.person]);
    expect(options.map((o) => [o.label, o.detail])).toEqual([
      ["Fix the sync clog", "ct-40561"],
      ["Ashot", "@ashot"],
    ]);
  });
});

describe("where the insertion lands in the document", () => {
  const stateOf = (doc: string) => EditorState.create({ doc });
  const insert = "[T](https://codecast.sh/tasks/ct-1)";

  /** Apply the edit the way CodeMirror would, and report the resulting text. */
  const apply = (doc: string, from: number, to: number) => {
    const state = stateOf(doc);
    const edit = entityLinkEdit(state, from, to, insert);
    return {
      text: state.update({ changes: edit.changes }).state.doc.toString(),
      caret: edit.selection.anchor,
    };
  };

  test("replaces the brackets the user typed, not just the query inside them", () => {
    // "see [[fix" — the completion range starts after the `[[`.
    const { text, caret } = apply("see [[fix", 6, 9);
    expect(text).toBe(`see ${insert}`);
    expect(caret).toBe(4 + insert.length);
  });

  test("steps over the `]]` closeBrackets inserted, leaving no stray brackets", () => {
    const { text } = apply("see [[fix]]", 6, 9);
    expect(text).toBe(`see ${insert}`);
  });

  test("text after the construct is untouched", () => {
    const { text } = apply("see [[fix]] — later", 6, 9);
    expect(text).toBe(`see ${insert} — later`);
  });
});

describe("where objects are offered at all", () => {
  const ctx = (line: string, pos: number) => wikiCompletionContext(line, 0, pos);

  test("inside a fresh `[[`", () => {
    expect(ctx("see [[fix", 9)).toEqual({ from: 6, query: "fix" });
    expect(ctx("[[", 2)).toEqual({ from: 2, query: "" });
  });

  test("not after a `#` — that is the named note's headings", () => {
    expect(ctx("[[Note#Head", 11)).toBeNull();
  });

  test("not after a `|` — those are the user's own words", () => {
    expect(ctx("[[Note|my text", 14)).toBeNull();
  });

  test("not outside a wiki construct", () => {
    expect(ctx("ordinary prose", 14)).toBeNull();
    expect(ctx("[[Done]] and more", 17)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Rendering, and the two views agreeing about it
// ---------------------------------------------------------------------------

/** Every link the READING VIEW produces, with the reference it resolves to.
 *  Runs the real remark chain, so this is what the note actually renders. */
function readingViewLinks(content: string): { href: string; text: string; ref: string | null }[] {
  const found: { href: string; text: string; ref: string | null }[] = [];
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={vaultRemarkPlugins}
      components={{
        a: ({ href, children }: any) => {
          const url = href ?? "";
          found.push({
            href: url,
            text: typeof children === "string" ? children : String(children ?? ""),
            ref: parseEntityRefHref(url)?.key ?? null,
          });
          return <a href={url}>{children}</a>;
        },
      }}
    >
      {content}
    </ReactMarkdown>,
  );
  return found;
}

/** Every entity reference the LIVE PREVIEW editor draws a pill for. */
function livePreviewRefs(content: string): string[] {
  const doc = `${content}\n\nelsewhere`;
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 10_000);
  const spans = scanLivePreview(state, [{ from: 0, to: content.length }], {});
  return spans
    .filter((s) => s.kind === "mark" && s.class.includes("cm-live-entity"))
    .map((s) => parseEntityRefHref((s as { attrs?: Record<string, string> }).attrs?.["data-live-href"])?.key)
    .filter((k): k is string => !!k);
}

const AGREEMENT_DOCS = [
  "A [task](https://codecast.sh/tasks/ct-40561) in prose.",
  "A bare https://codecast.sh/conversation/jx7dnj1 on its own.",
  "Two: [a](/tasks/ct-1) and [b](https://codecast.sh/plans/pl-2).",
  "A person [@ashot](https://codecast.sh/team/ashot) and a [note](Other.md).",
  "An impostor [x](https://codecast.sh/tasks/nope) and a real [y](/tasks/ct-3).",
  "Not ours: [z](https://example.com/tasks/ct-4).",
  "Inside emphasis: **[t](/tasks/ct-5)** still counts.",
  "In code: `https://codecast.sh/tasks/ct-6` does not.",
  "- [ ] a task line linking [t](/tasks/ct-7)",
];

describe("rendering", () => {
  test("a codecast URL becomes a reference; anything else stays a link", () => {
    const links = readingViewLinks(AGREEMENT_DOCS[4]);
    expect(links.map((l) => l.ref)).toEqual([null, "task:ct-3"]);
    // The impostor keeps its href and its words — a readable plain link.
    expect(links[0].href).toBe("https://codecast.sh/tasks/nope");
    expect(links[0].text).toBe("x");
  });

  test("an unresolvable reference never renders as nothing", () => {
    // Every link the reading view sees either resolves to a reference or keeps
    // its own display text; neither branch can produce an empty pill.
    for (const doc of AGREEMENT_DOCS) {
      for (const link of readingViewLinks(doc)) {
        expect(link.ref !== null || link.text.length > 0).toBe(true);
      }
    }
  });

  test("wiki links are untouched by any of this", () => {
    const links = readingViewLinks("See [[Some Note]] and [[Other|alias]].");
    expect(links.map((l) => l.text)).toEqual(["Some Note", "alias"]);
    expect(links.every((l) => l.ref === null)).toBe(true);
  });

  test("the reading view and live preview find the same references", () => {
    for (const doc of AGREEMENT_DOCS) {
      const reading = readingViewLinks(doc)
        .map((l) => l.ref)
        .filter((k): k is string => !!k);
      expect(livePreviewRefs(doc)).toEqual(reading);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Byte fidelity
// ---------------------------------------------------------------------------

describe("byte fidelity", () => {
  test("the corpus carries entity references and still reads back unchanged", () => {
    const cases = CORPUS.filter((c) => c.markdown.includes("codecast.sh"));
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const state = EditorState.create({
        doc: c.markdown,
        extensions: [markdown({ base: markdownLanguage }), livePreview({})],
      });
      expect(state.doc.toString()).toBe(c.markdown);
    }
  });

  test("scanning a note never rewrites it", () => {
    for (const c of CORPUS) {
      const before = c.markdown;
      scanEntityRefs(c.markdown);
      expect(c.markdown).toBe(before);
    }
  });

  test("a reference survives the round trip through the index", () => {
    for (const c of CORPUS) {
      const index = VaultIndex.build([["n.md", c.markdown]]);
      for (const occurrence of index.entityRefs("n.md")) {
        expect(c.markdown).toContain(occurrence.raw);
        expect(makeEntityRef(occurrence.ref.type, occurrence.ref.id)).toEqual(occurrence.ref);
        expect(entityRefMarkdown(occurrence.ref, occurrence.text)).toBeTruthy();
      }
    }
  });
});
