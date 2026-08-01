import { test, expect, describe } from "bun:test";
import { parseNote, type NoteLink } from "../parseNote";
import { VaultIndex } from "../vaultIndex";
import {
  applySpanEdits,
  newLinkRaw,
  planFolderRewrites,
  planLinkRewrites,
  renameTargetFor,
  simulateMoves,
  type FileRewrite,
} from "../linkRewrite";
import { CORPUS } from "./corpus";

const build = (files: Record<string, string>) => VaultIndex.build(Object.entries(files));

const linkAt = (markdown: string, n = 0): NoteLink => {
  const links = parseNote(markdown).links;
  expect(links.length).toBeGreaterThan(n);
  return links[n];
};

/** Run a plan against a file table, the way the store does. */
function applyPlan(files: Record<string, string>, plan: FileRewrite[]) {
  const out = { ...files };
  let applied = 0;
  let skipped = 0;
  for (const { source, edits } of plan) {
    const res = applySpanEdits(out[source], edits);
    out[source] = res.content;
    applied += res.applied;
    skipped += res.skipped;
  }
  return { files: out, applied, skipped };
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

describe("span coordinates", () => {
  test("line is 1-based and col is 0-based — the contract applySpanEdits assumes", () => {
    const md = "first line\nsee [[Target]] here";
    const link = linkAt(md);
    expect(link.line).toBe(2);
    expect(link.col).toBe(4);
    expect(md.split("\n")[link.line - 1].slice(link.col)).toStartWith(link.raw);
  });

  test("a link at column 0 of line 1", () => {
    const link = linkAt("[[Target]] trailing");
    expect(link.line).toBe(1);
    expect(link.col).toBe(0);
    const res = applySpanEdits("[[Target]] trailing", [
      { line: 1, col: 0, raw: "[[Target]]", newRaw: "[[Moved]]" },
    ]);
    expect(res.content).toBe("[[Moved]] trailing");
    expect(res.applied).toBe(1);
  });

  test("CRLF and lone-CR files keep their line breaks and their offsets", () => {
    for (const eol of ["\r\n", "\r", "\n"]) {
      const content = `one${eol}two [[A]]${eol}three`;
      const link = linkAt(content);
      expect(link.line).toBe(2);
      const res = applySpanEdits(content, [
        { line: link.line, col: link.col, raw: link.raw, newRaw: "[[B]]" },
      ]);
      expect(res.applied).toBe(1);
      expect(res.content).toBe(`one${eol}two [[B]]${eol}three`);
    }
  });
});

// ---------------------------------------------------------------------------
// applySpanEdits
// ---------------------------------------------------------------------------

describe("applySpanEdits", () => {
  test("several links on one line all land, offsets unshifted by earlier edits", () => {
    const md = "[[A]] and [[Bee]] and [[C]]";
    const links = parseNote(md).links;
    const res = applySpanEdits(
      md,
      links.map((l) => ({ line: l.line, col: l.col, raw: l.raw, newRaw: `[[${l.target}-x]]` })),
    );
    expect(res.content).toBe("[[A-x]] and [[Bee-x]] and [[C-x]]");
    expect(res.applied).toBe(3);
    expect(res.skipped).toBe(0);
  });

  test("replacements of different lengths on one line stay correct", () => {
    const md = "[[A]] mid [[B]]";
    const links = parseNote(md).links;
    const res = applySpanEdits(md, [
      { line: 1, col: links[0].col, raw: "[[A]]", newRaw: "[[A very long new name]]" },
      { line: 1, col: links[1].col, raw: "[[B]]", newRaw: "[[b]]" },
    ]);
    expect(res.content).toBe("[[A very long new name]] mid [[b]]");
  });

  test("a span whose text no longer matches is skipped, not applied blind", () => {
    const md = "the file changed [[Renamed Already]] under us";
    const res = applySpanEdits(md, [
      { line: 1, col: 17, raw: "[[Old Name]]", newRaw: "[[New Name]]" },
    ]);
    expect(res.content).toBe(md);
    expect(res.applied).toBe(0);
    expect(res.skipped).toBe(1);
  });

  test("stale edits are skipped while fresh ones on the same line still apply", () => {
    const md = "[[A]] and [[B]]";
    const res = applySpanEdits(md, [
      { line: 1, col: 0, raw: "[[Z]]", newRaw: "[[zz]]" },
      { line: 1, col: 10, raw: "[[B]]", newRaw: "[[bb]]" },
    ]);
    expect(res.content).toBe("[[A]] and [[bb]]");
    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(1);
  });

  test("out-of-range lines and empty raws are skipped", () => {
    const md = "only line";
    const res = applySpanEdits(md, [
      { line: 9, col: 0, raw: "[[A]]", newRaw: "[[B]]" },
      { line: 1, col: 0, raw: "", newRaw: "x" },
    ]);
    expect(res.content).toBe(md);
    expect(res.skipped).toBe(2);
  });

  test("overlapping edits: the first applies, the overlap is counted not applied", () => {
    const md = "[[A]] tail";
    const res = applySpanEdits(md, [
      { line: 1, col: 0, raw: "[[A]]", newRaw: "[[X]]" },
      { line: 1, col: 0, raw: "[[A]]", newRaw: "[[Y]]" },
    ]);
    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.content).toBe("[[X]] tail");
  });

  test("no edits is a no-op", () => {
    expect(applySpanEdits("body", [])).toEqual({ content: "body", applied: 0, skipped: 0 });
  });
});

// ---------------------------------------------------------------------------
// newLinkRaw
// ---------------------------------------------------------------------------

describe("newLinkRaw", () => {
  test("round-trip identity: rewriting a link to its own target reproduces the source exactly", () => {
    let checked = 0;
    for (const c of CORPUS) {
      for (const link of parseNote(c.markdown).links) {
        expect(newLinkRaw(link, link.target)).toBe(link.raw);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test("preserves the embed marker, subpath and alias", () => {
    const cases: [string, string][] = [
      ["[[Note]]", "[[New]]"],
      ["[[Note|display text]]", "[[New|display text]]"],
      ["[[Note#Heading]]", "[[New#Heading]]"],
      ["[[Note#Sub#Deeper]]", "[[New#Sub#Deeper]]"],
      ["[[Note#^block-id]]", "[[New#^block-id]]"],
      ["[[Note#Heading|alias]]", "[[New#Heading|alias]]"],
      ["![[Note]]", "![[New]]"],
      ["![[Note#Heading]]", "![[New#Heading]]"],
      ["![[Note|400]]", "![[New|400]]"],
      ["![[Note|400x200]]", "![[New|400x200]]"],
    ];
    for (const [source, expected] of cases) {
      expect(newLinkRaw(linkAt(source), "New")).toBe(expected);
    }
  });

  test("the author's spacing inside the brackets survives", () => {
    expect(newLinkRaw(linkAt("[[  Note  |  alias  ]]"), "New")).toBe("[[  New  |  alias  ]]");
  });

  test("unicode targets round-trip and rewrite", () => {
    const link = linkAt("[[Café Réunion — planning|le café]]");
    expect(newLinkRaw(link, link.target)).toBe(link.raw);
    expect(newLinkRaw(link, "Café Réunion 2")).toBe("[[Café Réunion 2|le café]]");
  });
});

// ---------------------------------------------------------------------------
// renameTargetFor
// ---------------------------------------------------------------------------

describe("renameTargetFor", () => {
  const after = (files: string[], moves: { from: string; to: string }[]) =>
    simulateMoves(build(Object.fromEntries(files.map((f) => [f, ""]))), moves);

  test("a bare name that stays unique stays a bare name", () => {
    const idx = after(["Notes/Sleep.md", "Journal.md"], [{ from: "Notes/Sleep.md", to: "Notes/Rest.md" }]);
    expect(renameTargetFor(linkAt("[[Sleep]]"), "Journal.md", "Notes/Rest.md", idx)).toBe("Rest");
  });

  test("a bare name that would become ambiguous falls back to the full path", () => {
    const idx = after(
      ["Notes/Sleep.md", "Archive/Rest.md", "Journal.md"],
      [{ from: "Notes/Sleep.md", to: "Notes/Rest.md" }],
    );
    expect(renameTargetFor(linkAt("[[Sleep]]"), "Journal.md", "Notes/Rest.md", idx)).toBe("Notes/Rest");
  });

  test("a path-form link stays a path-form link", () => {
    const idx = after(["Notes/Sleep.md", "Journal.md"], [{ from: "Notes/Sleep.md", to: "Rest.md" }]);
    expect(renameTargetFor(linkAt("[[Notes/Sleep]]"), "Journal.md", "Rest.md", idx)).toBe("Rest");
  });

  test("extension style is preserved in both directions", () => {
    const idx = after(["Sleep.md", "Journal.md"], [{ from: "Sleep.md", to: "Rest.md" }]);
    expect(renameTargetFor(linkAt("[[Sleep.md]]"), "Journal.md", "Rest.md", idx)).toBe("Rest.md");
    expect(renameTargetFor(linkAt("[[Sleep]]"), "Journal.md", "Rest.md", idx)).toBe("Rest");
    const deep = after(["Sleep.md", "Journal.md"], [{ from: "Sleep.md", to: "A/Rest.md" }]);
    expect(renameTargetFor(linkAt("[[Notes/Sleep.md]]"), "Journal.md", "A/Rest.md", deep)).toBe("A/Rest.md");
    expect(renameTargetFor(linkAt("[[Notes/Sleep]]"), "Journal.md", "A/Rest.md", deep)).toBe("A/Rest");
  });

  test("a same-file anchor is never rewritten", () => {
    const idx = after(["Sleep.md"], [{ from: "Sleep.md", to: "Rest.md" }]);
    expect(renameTargetFor(linkAt("[[#Heading]]"), "Rest.md", "Rest.md", idx)).toBeNull();
    expect(renameTargetFor(linkAt("[[#^block]]"), "Rest.md", "Rest.md", idx)).toBeNull();
  });

  test("a name that would re-parse as something else is refused outright", () => {
    const idx = after(["Sleep.md", "Journal.md"], [{ from: "Sleep.md", to: "Re[st]|x#y.md" }]);
    expect(renameTargetFor(linkAt("[[Sleep]]"), "Journal.md", "Re[st]|x#y.md", idx)).toBeNull();
  });

  test("no change needed when the written target already says the right thing", () => {
    const idx = after(
      ["A/Note.md", "Journal.md"],
      [{ from: "A/Note.md", to: "B/Note.md" }],
    );
    expect(renameTargetFor(linkAt("[[Note]]"), "Journal.md", "B/Note.md", idx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// planLinkRewrites
// ---------------------------------------------------------------------------

describe("planLinkRewrites", () => {
  test("rewrites inbound links across the vault, keeping alias, heading and embed forms", () => {
    const files = {
      "Sleep.md": "# Sleep\n\n## Naps\n\ncontent ^b1\n",
      "Journal.md": [
        "Plain [[Sleep]] link.",
        "Alias [[Sleep|how I sleep]].",
        "Heading [[Sleep#Naps]].",
        "Block [[Sleep#^b1]].",
        "Embed ![[Sleep]].",
        "Path [[Sleep.md]].",
      ].join("\n"),
    };
    const index = build(files);
    const plan = planLinkRewrites(index, "Sleep.md", "Rest.md");
    expect(plan).toHaveLength(1);
    expect(plan[0].source).toBe("Journal.md");
    expect(plan[0].edits).toHaveLength(6);

    const { files: next, applied, skipped } = applyPlan(files, plan);
    expect({ applied, skipped }).toEqual({ applied: 6, skipped: 0 });
    expect(next["Journal.md"]).toBe(
      [
        "Plain [[Rest]] link.",
        "Alias [[Rest|how I sleep]].",
        "Heading [[Rest#Naps]].",
        "Block [[Rest#^b1]].",
        "Embed ![[Rest]].",
        "Path [[Rest.md]].",
      ].join("\n"),
    );
  });

  test("links that resolve elsewhere are left alone", () => {
    const files = {
      "A/Note.md": "",
      "B/Note.md": "",
      // Path-form links: each resolves to exactly one of the two.
      "Journal.md": "[[A/Note]] and [[B/Note]]",
    };
    const plan = planLinkRewrites(build(files), "A/Note.md", "A/Renamed.md");
    expect(plan[0].edits).toHaveLength(1);
    expect(applyPlan(files, plan).files["Journal.md"]).toBe("[[A/Renamed]] and [[B/Note]]");
  });

  test("an unresolved look-alike target is not touched", () => {
    const files = { "Sleep.md": "", "Journal.md": "[[Sleeping]] is not [[Sleep]]" };
    const plan = planLinkRewrites(build(files), "Sleep.md", "Rest.md");
    expect(applyPlan(files, plan).files["Journal.md"]).toBe("[[Sleeping]] is not [[Rest]]");
  });

  test("a bare name colliding after the rename is rewritten as a path", () => {
    const files = {
      "Notes/Sleep.md": "",
      "Archive/Rest.md": "",
      "Journal.md": "[[Sleep]] tonight",
    };
    const plan = planLinkRewrites(build(files), "Notes/Sleep.md", "Notes/Rest.md");
    expect(applyPlan(files, plan).files["Journal.md"]).toBe("[[Notes/Rest]] tonight");
  });

  test("the renamed note's own self-reference is rewritten; its anchor links are not", () => {
    const files = {
      "Sleep.md": "# Sleep\nSee [[Sleep]] and [[#Naps]] and [[Sleep#Naps]].\n## Naps\n",
      "Other.md": "",
    };
    const plan = planLinkRewrites(build(files), "Sleep.md", "Rest.md");
    expect(plan).toHaveLength(1);
    expect(plan[0].source).toBe("Rest.md"); // written at its POST-move path
    const applied = applySpanEdits(files["Sleep.md"], plan[0].edits);
    expect(applied.content).toBe("# Sleep\nSee [[Rest]] and [[#Naps]] and [[Rest#Naps]].\n## Naps\n");
    expect(applied.skipped).toBe(0);
  });

  test("unicode note names rewrite cleanly", () => {
    const files = {
      "Café Réunion.md": "",
      "Journal.md": "[[Café Réunion|le café]] et ![[Café Réunion]]",
    };
    const plan = planLinkRewrites(build(files), "Café Réunion.md", "Café Münich.md");
    expect(applyPlan(files, plan).files["Journal.md"]).toBe(
      "[[Café Münich|le café]] et ![[Café Münich]]",
    );
  });

  test("links inside code are never planned (the parser hides them, and so must we)", () => {
    const files = {
      "Sleep.md": "",
      "Journal.md": "Real [[Sleep]]\n\n```\n[[Sleep]]\n```\n\nInline `[[Sleep]]` too",
    };
    const plan = planLinkRewrites(build(files), "Sleep.md", "Rest.md");
    expect(plan[0].edits).toHaveLength(1);
    expect(applyPlan(files, plan).files["Journal.md"]).toBe(
      "Real [[Rest]]\n\n```\n[[Sleep]]\n```\n\nInline `[[Sleep]]` too",
    );
  });

  test("an asset embed follows its file", () => {
    const files = {
      "assets/diagram.png": "",
      "Journal.md": "![[diagram.png|400]] and ![[assets/diagram.png]]",
    };
    const plan = planLinkRewrites(build(files), "assets/diagram.png", "img/flow.png");
    expect(applyPlan(files, plan).files["Journal.md"]).toBe(
      "![[flow.png|400]] and ![[img/flow.png]]",
    );
  });

  test("a no-op move plans nothing", () => {
    const index = build({ "Sleep.md": "", "Journal.md": "[[Sleep]]" });
    expect(planLinkRewrites(index, "Sleep.md", "Sleep.md")).toEqual([]);
    expect(planLinkRewrites(index, "Ghost.md", "Other.md")).toEqual([]);
  });

  test("a plan built before the file changed skips exactly the stale span", () => {
    const files = { "Sleep.md": "", "Journal.md": "[[Sleep]] and [[Sleep|later]]" };
    const plan = planLinkRewrites(build(files), "Sleep.md", "Rest.md");
    // Someone edited the first link on disk between plan and write. The edit
    // is the same length, so the second link's span is still exactly where the
    // plan says — only the stale one may be dropped.
    const drifted = "[[Slept]] and [[Sleep|later]]";
    const res = applySpanEdits(drifted, plan[0].edits);
    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.content).toBe("[[Slept]] and [[Rest|later]]");
  });
});

// ---------------------------------------------------------------------------
// Folder moves
// ---------------------------------------------------------------------------

describe("planFolderRewrites", () => {
  test("inbound links to nested children follow the folder", () => {
    const files = {
      "Work/Alpha.md": "",
      "Work/Deep/Beta.md": "",
      "Journal.md": "[[Work/Alpha]] and [[Work/Deep/Beta]] and [[Beta]]",
    };
    const moves = [
      { from: "Work/Alpha.md", to: "Archive/Work/Alpha.md" },
      { from: "Work/Deep/Beta.md", to: "Archive/Work/Deep/Beta.md" },
    ];
    const plan = planFolderRewrites(build(files), moves);
    expect(plan).toHaveLength(1);
    // The bare `[[Beta]]` is left alone: it is still unique after the move, so
    // it still points at the same note and rewriting it would be pure noise.
    expect(plan[0].edits).toHaveLength(2);
    expect(applyPlan(files, plan).files["Journal.md"]).toBe(
      "[[Archive/Work/Alpha]] and [[Archive/Work/Deep/Beta]] and [[Beta]]",
    );
  });

  test("one source linking several moved files gets all its edits merged", () => {
    const files = {
      "Work/Alpha.md": "",
      "Work/Beta.md": "",
      "Journal.md": "[[Work/Alpha]] then [[Work/Beta]] on one line",
    };
    const plan = planFolderRewrites(build(files), [
      { from: "Work/Alpha.md", to: "Done/Alpha.md" },
      { from: "Work/Beta.md", to: "Done/Beta.md" },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].edits.map((e) => e.col)).toEqual([0, 20]);
    expect(applyPlan(files, plan).files["Journal.md"]).toBe(
      "[[Done/Alpha]] then [[Done/Beta]] on one line",
    );
  });

  test("links between two moved siblings are rewritten in the moved file itself", () => {
    const files = {
      "Work/Alpha.md": "see [[Work/Beta]] and [[Beta]]",
      "Work/Beta.md": "",
    };
    const plan = planFolderRewrites(build(files), [
      { from: "Work/Alpha.md", to: "Done/Alpha.md" },
      { from: "Work/Beta.md", to: "Done/Beta.md" },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].source).toBe("Done/Alpha.md");
    expect(applySpanEdits(files["Work/Alpha.md"], plan[0].edits).content).toBe(
      "see [[Done/Beta]] and [[Beta]]",
    );
  });
});

// ---------------------------------------------------------------------------
// Integration against the real index
// ---------------------------------------------------------------------------

describe("index round trip", () => {
  test("after plan → apply → re-index, every backlink survives and nothing became unresolved", () => {
    const files: Record<string, string> = {
      "Notes/Sleep.md": "# Sleep\n## Naps\ntext ^b1\nSelf [[Sleep]] and [[#Naps]]\n",
      "Journal.md": "[[Sleep]], [[Notes/Sleep]], [[Sleep|rest]], [[Sleep#Naps]], ![[Sleep#^b1]]",
      "Inbox.md": "morning [[Sleep.md]] note",
      "Unrelated.md": "[[Journal]] only",
    };
    const index = build(files);
    const before = index.backlinks("Notes/Sleep.md").length;
    const unresolvedBefore = index.unresolvedTargets().size;
    // Eight: the six links in Journal/Inbox plus the note's own self-link and
    // its `[[#Naps]]` anchor, which resolves to the note itself.
    expect(before).toBe(8);

    const plan = planLinkRewrites(index, "Notes/Sleep.md", "Archive/Rest.md");
    // The store moves the file first, then rewrites — so does this: the plan
    // addresses the renamed note at its new path.
    const moved = { ...files, "Archive/Rest.md": files["Notes/Sleep.md"] };
    delete moved["Notes/Sleep.md"];
    const { files: next, applied, skipped } = applyPlan(moved, plan);
    expect(skipped).toBe(0);
    expect(applied).toBe(7); // every backlink but the `[[#Naps]]` anchor

    // Re-index the way the store does: move the note, then re-upsert the
    // sources whose bodies changed.
    index.rename("Notes/Sleep.md", "Archive/Rest.md");
    for (const { source } of plan) index.upsert(source, next[source]);

    expect(index.backlinks("Archive/Rest.md").length).toBe(before);
    expect(index.backlinks("Notes/Sleep.md")).toEqual([]);
    expect(index.unresolvedTargets().size).toBe(unresolvedBefore);
    for (const p of index.paths()) {
      for (const out of index.outgoing(p)) {
        if (out.link.target) expect(out.resolved).not.toBeNull();
      }
    }
  });

  test("a rewritten vault re-indexes identically to one written that way from scratch", () => {
    const files: Record<string, string> = {
      "Work/Note.md": "",
      "Journal.md": "[[Note]] and [[Work/Note|w]] and ![[Note]]",
    };
    const index = build(files);
    const plan = planLinkRewrites(index, "Work/Note.md", "Work/Renamed.md");
    const next = applyPlan(files, plan).files;
    index.rename("Work/Note.md", "Work/Renamed.md");
    for (const { source } of plan) index.upsert(source, next[source]);

    const scratch = build({ "Work/Renamed.md": "", "Journal.md": next["Journal.md"] });
    const dump = (i: VaultIndex) =>
      i.paths().map((p) => [p, i.outgoing(p).map((o) => [o.link.raw, o.resolved])]);
    expect(dump(index)).toEqual(dump(scratch));
  });
});

describe("aliases", () => {
  test("a link that reaches the note through an alias is left alone", () => {
    const files = {
      "Sleep.md": "---\naliases: [Shuteye, Kip]\n---\n# Sleep\n",
      "Journal.md": "[[Shuteye]] and [[Sleep]] and [[Kip|nap]]",
    };
    const index = build(files);
    // All three resolve to the note today.
    expect(index.backlinks("Sleep.md")).toHaveLength(3);

    const plan = planLinkRewrites(index, "Sleep.md", "Rest.md");
    expect(plan[0].edits).toHaveLength(1);
    expect(applyPlan(files, plan).files["Journal.md"]).toBe(
      "[[Shuteye]] and [[Rest]] and [[Kip|nap]]",
    );

    // And they still resolve, because the aliases moved with the file.
    index.rename("Sleep.md", "Rest.md");
    for (const { source } of plan) index.upsert(source, applyPlan(files, plan).files[source]);
    expect(index.backlinks("Rest.md")).toHaveLength(3);
  });
});
