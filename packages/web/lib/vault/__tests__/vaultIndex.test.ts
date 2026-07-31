import { test, expect, describe } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VaultIndex, type TagTreeNode } from "../vaultIndex";
import { parseNote } from "../parseNote";

const note = (body: string) => body;

function build(files: Record<string, string>): VaultIndex {
  return VaultIndex.build(Object.entries(files));
}

/** Canonical dump of every derived map — what the property test compares. */
function dump(index: VaultIndex) {
  return {
    paths: index.paths(),
    outgoing: index.paths().map((p) => [
      p,
      index.outgoing(p).map((o) => [o.link.target, o.resolved, o.isAmbiguous]),
    ]),
    backlinks: index
      .paths()
      .map((p) => [p, index.backlinks(p).map((b) => [b.source, b.link.target, b.link.line, b.link.col])]),
    unresolved: [...index.unresolvedTargets()].sort(),
    tags: index.tags().map((t) => [t, index.filesWithTag(t)]),
    tagTree: index.tagTree(),
  };
}

describe("resolution", () => {
  test("exact vault-relative path, with or without extension, any case", () => {
    const index = build({
      "Projects/Note.md": note("[[Projects/Note]] [[Projects/Note.md]] [[projects/note]]"),
      "Other.md": note(""),
    });
    for (const link of index.outgoing("Projects/Note.md")) {
      expect(link.resolved).toBe("Projects/Note.md");
      expect(link.isAmbiguous).toBe(false);
    }
  });

  test("unique basename resolves from anywhere in the vault", () => {
    const index = build({
      "A/Deep/Target.md": note(""),
      "B/Source.md": note("[[Target]] and [[Deep/Target]]"),
    });
    expect(index.outgoing("B/Source.md").map((o) => o.resolved)).toEqual([
      "A/Deep/Target.md",
      "A/Deep/Target.md",
    ]);
  });

  test("ambiguous basename prefers the linking file's own folder", () => {
    const index = build({
      "Projects/Meeting Notes.md": note(""),
      "Areas/Meeting Notes.md": note(""),
      "Areas/Source.md": note("[[Meeting Notes]]"),
      "Elsewhere/Other.md": note("[[Meeting Notes]]"),
    });
    const fromAreas = index.outgoing("Areas/Source.md")[0];
    expect(fromAreas.resolved).toBe("Areas/Meeting Notes.md");
    expect(fromAreas.isAmbiguous).toBe(true);

    // No same-folder candidate: alphabetically first, still flagged ambiguous
    // so the UI can offer a disambiguation affordance.
    const fromElsewhere = index.outgoing("Elsewhere/Other.md")[0];
    expect(fromElsewhere.resolved).toBe("Areas/Meeting Notes.md");
    expect(fromElsewhere.isAmbiguous).toBe(true);

    // Spelling the folder disambiguates completely.
    expect(index.resolveLinkInfo("Projects/Meeting Notes", "Elsewhere/Other.md")).toMatchObject({
      path: "Projects/Meeting Notes.md",
      isAmbiguous: false,
    });
  });

  test("aliases resolve, and lose to a real filename", () => {
    const index = build({
      "People/Ada Lovelace.md": note('---\naliases: ["Ada", "The Countess"]\n---\n'),
      "Notes/Ada.md": note(""),
      "Source.md": note("[[The Countess]] and [[Ada]]"),
    });
    const [byAlias, byName] = index.outgoing("Source.md");
    expect(byAlias.resolved).toBe("People/Ada Lovelace.md");
    // "Ada" is a real basename, so the file beats the alias.
    expect(byName.resolved).toBe("Notes/Ada.md");
  });

  test("empty target means this file (`[[#Heading]]`)", () => {
    const index = build({ "A.md": note("[[#Some Heading]]\n\n## Some Heading") });
    const [selfLink] = index.outgoing("A.md");
    expect(selfLink.resolved).toBe("A.md");
    expect(selfLink.link.subpath).toBe("Some Heading");
    expect(index.backlinks("A.md")).toHaveLength(1);
  });

  test("attachments resolve so embeds work", () => {
    const index = build({
      "attachments/diagram.png": "",
      "Note.md": note("![[diagram.png]] and ![[attachments/diagram.png|300]]"),
    });
    expect(index.outgoing("Note.md").map((o) => o.resolved)).toEqual([
      "attachments/diagram.png",
      "attachments/diagram.png",
    ]);
  });

  test("nothing answers → unresolved, listed with its sources", () => {
    const index = build({
      "A.md": note("[[Ghost Note]]"),
      "B.md": note("[[ghost note]] [[Real]]"),
      "Real.md": note(""),
    });
    expect(index.outgoing("A.md")[0].resolved).toBeNull();
    // Unresolved targets key case-insensitively: one row, two sources.
    expect(index.unresolvedTargets().get("ghost note")).toEqual(["A.md", "B.md"]);
  });

  test("unicode and punctuation filenames resolve", () => {
    const index = build({
      "Café Réunion — planning.md": note(""),
      "What's next?.md": note(""),
      "Source.md": note("[[Café Réunion — planning]] and [[What's next?]]"),
    });
    expect(index.outgoing("Source.md").map((o) => o.resolved)).toEqual([
      "Café Réunion — planning.md",
      "What's next?.md",
    ]);
  });
});

describe("the ambiguity flip", () => {
  // The classic trap: a file appears somewhere else entirely and a link in an
  // untouched third file changes what it points at.
  test("adding a duplicate basename re-resolves links in files nobody touched", () => {
    const index = build({
      "A/Note.md": note(""),
      "Source.md": note("[[Note]]"),
    });
    expect(index.outgoing("Source.md")[0]).toMatchObject({
      resolved: "A/Note.md",
      isAmbiguous: false,
    });
    const before = index.resolutionVersion;

    index.upsert("B/Note.md", note(""));

    expect(index.outgoing("Source.md")[0].isAmbiguous).toBe(true);
    expect(index.resolutionVersion).toBeGreaterThan(before);
  });

  test("removing the duplicate restores the unique resolution", () => {
    const index = build({
      "A/Note.md": note(""),
      "B/Note.md": note(""),
      "Source.md": note("[[Note]]"),
    });
    expect(index.outgoing("Source.md")[0].isAmbiguous).toBe(true);
    const before = index.resolutionVersion;

    index.remove("B/Note.md");

    expect(index.outgoing("Source.md")[0]).toMatchObject({
      resolved: "A/Note.md",
      isAmbiguous: false,
    });
    expect(index.resolutionVersion).toBeGreaterThan(before);
  });

  test("a note appearing turns unresolved links into backlinks", () => {
    const index = build({ "Source.md": note("[[Later]]") });
    expect(index.unresolvedTargets().has("later")).toBe(true);

    index.upsert("Later.md", note(""));

    expect(index.outgoing("Source.md")[0].resolved).toBe("Later.md");
    expect(index.backlinks("Later.md").map((b) => b.source)).toEqual(["Source.md"]);
    expect(index.unresolvedTargets().has("later")).toBe(false);
  });

  test("an edit that DROPS an alias re-resolves the links riding on it", () => {
    const index = build({
      "People/Ada.md": note('---\naliases: [The Countess]\n---\n'),
      "Source.md": note("[[The Countess]]"),
    });
    expect(index.outgoing("Source.md")[0].resolved).toBe("People/Ada.md");

    index.upsert("People/Ada.md", note("no frontmatter any more"));

    expect(index.outgoing("Source.md")[0].resolved).toBeNull();
  });

  test("editing a file's own body does not bump resolutionVersion", () => {
    const index = build({ "A.md": note("hello"), "B.md": note("[[A]]") });
    const before = index.resolutionVersion;
    index.upsert("A.md", note("hello, edited"));
    expect(index.resolutionVersion).toBe(before);
    expect(index.version).toBeGreaterThan(0);
  });
});

describe("rename", () => {
  test("moves the file's name space entry and keeps its outgoing links", () => {
    const index = build({
      "A.md": note("[[Target]]"),
      "Target.md": note("[[A]]"),
    });
    index.rename("Target.md", "Archive/Target.md");

    expect(index.note("Target.md")).toBeUndefined();
    expect(index.note("Archive/Target.md")?.basename).toBe("Target");
    // The link still resolves — by basename, from its new home.
    expect(index.outgoing("A.md")[0].resolved).toBe("Archive/Target.md");
    expect(index.outgoing("Archive/Target.md")[0].resolved).toBe("A.md");
    expect(index.backlinks("Archive/Target.md").map((b) => b.source)).toEqual(["A.md"]);
  });

  test("renaming to a new basename strands the links that used the old one", () => {
    const index = build({ "A.md": note("[[Target]]"), "Target.md": note("") });
    index.rename("Target.md", "Renamed.md");
    // This is exactly the moment the UI must offer link rewriting.
    expect(index.outgoing("A.md")[0].resolved).toBeNull();
    expect(index.unresolvedTargets().get("target")).toEqual(["A.md"]);
  });

  test("a move can change where the MOVED file's own links point", () => {
    const index = build({
      "X/Dup.md": note(""),
      "Y/Dup.md": note(""),
      "X/Source.md": note("[[Dup]]"),
    });
    expect(index.outgoing("X/Source.md")[0].resolved).toBe("X/Dup.md");
    index.rename("X/Source.md", "Y/Source.md");
    expect(index.outgoing("Y/Source.md")[0].resolved).toBe("Y/Dup.md");
  });
});

describe("backlinks and outgoing", () => {
  test("backlinks carry the source and the link, sorted deterministically", () => {
    const index = build({
      "Zed.md": note("[[Hub]]"),
      "Alpha.md": note("[[Hub]] again [[Hub|aliased]]"),
      "Hub.md": note(""),
    });
    expect(index.backlinks("Hub.md").map((b) => [b.source, b.link.col])).toEqual([
      ["Alpha.md", 0],
      ["Alpha.md", 14],
      ["Zed.md", 0],
    ]);
  });

  test("embeds are backlinks too, and keep their embed flag", () => {
    const index = build({ "A.md": note("![[B]]"), "B.md": note("") });
    expect(index.backlinks("B.md")[0].link.isEmbed).toBe(true);
  });

  test("outgoing preserves document order", () => {
    const index = build({
      "A.md": note("[[C]] [[B]]\n\n[[C]]"),
      "B.md": "",
      "C.md": "",
    });
    expect(index.outgoing("A.md").map((o) => o.link.target)).toEqual(["C", "B", "C"]);
  });
});

describe("tags", () => {
  const tagged = build({
    "A.md": note("---\ntags: [status/draft, project]\n---\n\n#status/draft #til"),
    "B.md": note("#status/done"),
    "C.md": note("#status/draft/deep"),
  });

  test("frontmatter and inline tags merge, deduped and case-folded", () => {
    expect(tagged.tags()).toEqual(["project", "status/done", "status/draft", "status/draft/deep", "til"]);
  });

  test("filesWithTag includes descendants", () => {
    expect(tagged.filesWithTag("status")).toEqual(["A.md", "B.md", "C.md"]);
    expect(tagged.filesWithTag("status/draft")).toEqual(["A.md", "C.md"]);
    expect(tagged.filesWithTag("#status/done")).toEqual(["B.md"]);
    expect(tagged.filesWithTag("nope")).toEqual([]);
  });

  test("tagTree nests by slash and counts files, not occurrences", () => {
    const byTag = new Map<string, TagTreeNode>();
    const walk = (nodes: TagTreeNode[]) => {
      for (const n of nodes) {
        byTag.set(n.tag, n);
        walk(n.children);
      }
    };
    walk(tagged.tagTree());

    // "status" is a synthetic parent: no file carries it directly, three carry
    // something under it.
    expect(byTag.get("status")).toMatchObject({ name: "status", count: 0, total: 3 });
    expect(byTag.get("status/draft")).toMatchObject({ count: 1, total: 2 });
    expect(byTag.get("status/draft/deep")).toMatchObject({ count: 1, total: 1 });
    expect(tagged.tagTree().map((n) => n.tag)).toEqual(["project", "status", "til"]);
  });

  test("a file tagged twice under one parent counts once", () => {
    const index = build({ "A.md": note("#status/draft #status/done") });
    const status = index.tagTree().find((n) => n.tag === "status");
    expect(status?.total).toBe(1);
  });
});

describe("snapshot", () => {
  test("round-trips through structured-clone-safe data", () => {
    const index = build({
      "A/Note.md": note("---\naliases: [Aka]\ntags: [x]\n---\n\n[[B]] #inline"),
      "B.md": note("[[Missing]]"),
    });
    const snapshot = structuredClone(index.snapshot());
    const restored = VaultIndex.fromSnapshot(snapshot);
    expect(restored).not.toBeNull();
    expect(dump(restored!)).toEqual(dump(index));
  });

  test("a version mismatch refuses the snapshot so callers rebuild", () => {
    const snapshot = build({ "A.md": note("") }).snapshot();
    expect(VaultIndex.fromSnapshot({ ...snapshot, version: snapshot.version + 1 })).toBeNull();
  });
});

describe("incremental patching equals a full rebuild", () => {
  // A seeded stream of random upserts, removes and renames. After every step
  // the incrementally-patched index must be indistinguishable from one built
  // from the same file set out of nothing.
  test("random operation streams stay identical to a rebuild", () => {
    let seed = 20260731;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];

    const folders = ["", "A/", "B/", "A/Deep/"];
    const names = ["Note", "Meeting Notes", "Café Réunion", "Target", "Hub"];
    const targets = [...names, "Ghost", "A/Note", "Note.md", "Hub|alias", "#self"];

    const bodyFor = (i: number) =>
      [
        "---",
        `aliases: [Alias ${i % 3}]`,
        `tags: [t/${i % 4}, plain]`,
        "---",
        "",
        `# Heading ${i}`,
        "",
        `Body [[${pick(targets)}]] and [[${pick(targets)}]] and #tag/${i % 5}.`,
        "",
        "```",
        "[[Not A Link]]",
        "```",
        "",
        `Claim. ^b${i}`,
      ].join("\n");

    const live = new Map<string, string>();
    const index = new VaultIndex();

    for (let step = 0; step < 300; step++) {
      const roll = rand();
      const existing = [...live.keys()];
      if (roll < 0.55 || existing.length === 0) {
        const p = `${pick(folders)}${pick(names)}.md`;
        const body = bodyFor(step);
        live.set(p, body);
        index.upsert(p, body);
      } else if (roll < 0.8) {
        const p = pick(existing);
        live.delete(p);
        index.remove(p);
      } else {
        const from = pick(existing);
        const to = `${pick(folders)}${pick(names)}.md`;
        if (to === from || live.has(to)) continue;
        live.set(to, live.get(from)!);
        live.delete(from);
        index.rename(from, to);
      }

      if (step % 7 === 0 || step === 299) {
        const rebuilt = VaultIndex.build(live);
        expect(dump(index), `after step ${step}`).toEqual(dump(rebuilt));
      }
    }
    expect(live.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration against the real fixture vault (scripts/vault-fixture.mjs).
// Skipped when it hasn't been generated — the unit tests above stand alone.
// ---------------------------------------------------------------------------

const FIXTURE = path.join(os.homedir(), "vault-fixture");
const hasFixture = fs.existsSync(FIXTURE);

function fixtureFiles(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push([path.relative(FIXTURE, abs), entry.name.endsWith(".md") ? fs.readFileSync(abs, "utf8") : ""]);
    }
  };
  walk(FIXTURE);
  return out;
}

describe.if(hasFixture)("real fixture vault", () => {
  const files = hasFixture ? fixtureFiles() : [];
  const index = VaultIndex.build(files);

  test("indexes every file and resolves most links", () => {
    expect(index.size()).toBe(files.length);
    const md = files.filter(([p]) => p.endsWith(".md"));
    expect(md.length).toBeGreaterThan(200);

    let total = 0;
    let resolved = 0;
    for (const [p] of md) {
      for (const link of index.outgoing(p)) {
        total++;
        if (link.resolved) resolved++;
      }
    }
    expect(total).toBeGreaterThan(300);
    // The fixture deliberately seeds "Ghost Note" / "Unresolved Idea", so a
    // handful must NOT resolve — a 100% rate would mean we resolved garbage.
    expect(resolved / total).toBeGreaterThan(0.75);
    expect(resolved).toBeLessThan(total);
  });

  test("code fences in real notes never contribute links", () => {
    for (const [p, body] of files) {
      if (!body.includes("[[Not A Link]]")) continue;
      expect(index.outgoing(p).map((o) => o.link.target)).not.toContain("Not A Link");
    }
  });

  test("the duplicate-basename notes are ambiguous, and folder-preference works", () => {
    const dupes = index.paths().filter((p) => p.endsWith("/Meeting Notes.md"));
    expect(dupes.length).toBeGreaterThan(1);
    const info = index.resolveLinkInfo("Meeting Notes", "Projects/Anything.md");
    expect(info.isAmbiguous).toBe(true);
    expect(info.path).toBe("Projects/Meeting Notes.md");
  });

  test("unicode-named notes are reachable", () => {
    const cafe = index.paths().find((p) => p.includes("Café"));
    expect(cafe).toBeDefined();
    expect(index.resolveLink("Café Réunion — planning", "Anything.md")).toBe(cafe);
  });

  test("tag tree covers the fixture's nested tags", () => {
    expect(index.tagTree().some((n) => n.tag === "status" && n.children.length >= 2)).toBe(true);
    expect(index.filesWithTag("status").length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// Micro-benchmark. Skipped by default: run with VAULT_BENCH=1 bun test.
// Targets: parseNote under 1ms for a typical note, 5k notes indexed under 2s.
// ---------------------------------------------------------------------------

describe.if(process.env.VAULT_BENCH === "1")("performance", () => {
  const synthetic = (i: number) =>
    [
      "---",
      `title: Synthetic Note ${i}`,
      `tags: [bench, group/${i % 20}]`,
      `aliases: [Alias ${i}]`,
      "---",
      "",
      `# Synthetic Note ${i}`,
      "",
      `Body text with [[Synthetic Note ${(i + 1) % 5000}]] and [[Synthetic Note ${(i + 7) % 5000}#Section]].`,
      "Another sentence with a #bench/tag and some **emphasis** plus `inline code`.",
      "",
      "## Section",
      "",
      "- [ ] a task",
      "- [x] a done task",
      "",
      "```ts",
      "const noise = 1;",
      "```",
      "",
      `Claim worth citing. ^claim-${i}`,
    ].join("\n");

  test("parseNote is comfortably under 1ms for a typical note", () => {
    const body = synthetic(1);
    for (let i = 0; i < 200; i++) parseNote(body); // warm
    const started = performance.now();
    const runs = 2000;
    for (let i = 0; i < runs; i++) parseNote(body);
    const per = (performance.now() - started) / runs;
    console.log(`parseNote: ${per.toFixed(3)}ms per note`);
    expect(per).toBeLessThan(1);
  });

  test("5000 notes index in under 2s", () => {
    const files: [string, string][] = Array.from({ length: 5000 }, (_, i) => [
      `Folder${i % 50}/Synthetic Note ${i}.md`,
      synthetic(i),
    ]);
    const started = performance.now();
    const index = VaultIndex.build(files);
    const elapsed = performance.now() - started;
    console.log(`full index of 5000 notes: ${elapsed.toFixed(0)}ms`);
    expect(index.size()).toBe(5000);
    expect(elapsed).toBeLessThan(2000);
  });

  test("a single incremental upsert is cheap", () => {
    const files: [string, string][] = Array.from({ length: 5000 }, (_, i) => [
      `Folder${i % 50}/Synthetic Note ${i}.md`,
      synthetic(i),
    ]);
    const index = VaultIndex.build(files);
    const started = performance.now();
    for (let i = 0; i < 100; i++) index.upsert(`Folder0/Synthetic Note ${i}.md`, synthetic(i));
    const per = (performance.now() - started) / 100;
    console.log(`incremental upsert: ${per.toFixed(3)}ms`);
    expect(per).toBeLessThan(10);
  });
});
