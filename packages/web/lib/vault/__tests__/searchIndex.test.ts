import { test, expect, describe } from "bun:test";
import { VaultSearchIndex, snippetFor } from "../searchIndex";
import { parseNote } from "../parseNote";

function indexOf(files: Record<string, string>): VaultSearchIndex {
  const search = new VaultSearchIndex();
  for (const [path, body] of Object.entries(files)) search.upsertNote(path, parseNote(body));
  return search;
}

const LONG_NOTE = [
  "---",
  "title: Distributed Consensus",
  "---",
  "",
  "# Distributed Consensus",
  "",
  "Raft elects a leader by randomized timeout, which avoids split votes.",
  "",
  "## Log Replication",
  "",
  "The leader appends entries and waits for a quorum before committing.",
  "",
  "## Membership Changes",
  "",
  "Joint consensus keeps both configurations live during a transition.",
].join("\n");

describe("block-granular search", () => {
  const search = indexOf({
    "Notes/Consensus.md": LONG_NOTE,
    "Notes/Gardening.md": "# Gardening\n\nTomatoes want a quorum of sunny days.\n",
  });

  test("a hit reports the line and section it was found in, not just the file", () => {
    const [file] = search.search("quorum committing");
    expect(file.path).toBe("Notes/Consensus.md");
    expect(file.matches[0]).toMatchObject({ line: 11, headingPath: ["Distributed Consensus", "Log Replication"] });
  });

  test("several blocks in one file roll up under a single result", () => {
    const results = search.search("consensus");
    const consensus = results.find((r) => r.path === "Notes/Consensus.md");
    expect(consensus).toBeDefined();
    expect(consensus!.matches.length).toBeGreaterThan(1);
    expect(consensus!.title).toBe("Distributed Consensus");
  });

  test("one term, two files, both returned", () => {
    expect(search.search("quorum").map((r) => r.path).sort()).toEqual([
      "Notes/Consensus.md",
      "Notes/Gardening.md",
    ]);
  });

  test("terms are ANDed", () => {
    expect(search.search("quorum tomatoes").map((r) => r.path)).toEqual(["Notes/Gardening.md"]);
  });

  test("an empty query returns nothing rather than everything", () => {
    expect(search.search("   ")).toEqual([]);
  });

  test("a childless heading is still findable", () => {
    const only = indexOf({ "A.md": "# Body Text\n\nsome prose\n\n## Orphan Heading\n" });
    expect(only.search("orphan").map((r) => r.path)).toEqual(["A.md"]);
  });
});

describe("index maintenance", () => {
  test("removing a note takes its blocks out of results", () => {
    const search = indexOf({ "A.md": "# A\n\nunique-token here\n" });
    expect(search.search("unique-token")).toHaveLength(1);
    search.removeNote("A.md");
    expect(search.search("unique-token")).toEqual([]);
    expect(search.size).toBe(0);
  });

  test("re-upserting replaces the old blocks instead of duplicating them", () => {
    const search = new VaultSearchIndex();
    search.upsertNote("A.md", parseNote("# A\n\nfirst body text\n"));
    search.upsertNote("A.md", parseNote("# A\n\nsecond body text\n"));
    expect(search.search("first")).toEqual([]);
    expect(search.search("second")).toHaveLength(1);
    // Re-adding an id previously discarded must not throw.
    search.upsertNote("A.md", parseNote("# A\n\nthird body text\n"));
    expect(search.search("third")).toHaveLength(1);
  });

  test("rename carries the content to the new path", () => {
    const search = indexOf({ "Old.md": "# Old\n\nmoving target\n" });
    search.renameNote("Old.md", "New.md", parseNote("# Old\n\nmoving target\n"));
    expect(search.search("moving").map((r) => r.path)).toEqual(["New.md"]);
  });

  test("code is not searched — matching Obsidian would surface it, but the index feeds unlinked mentions too", () => {
    const search = indexOf({ "A.md": "# A\n\nprose\n\n```ts\nconst secretIdentifier = 1;\n```\n" });
    expect(search.search("secretIdentifier")).toEqual([]);
  });
});

describe("ranking", () => {
  test("boostFile tilts ranking without touching the index", () => {
    const search = indexOf({
      "Old.md": "# Old\n\nshared term appears here\n",
      "Recent.md": "# Recent\n\nshared term appears here\n",
    });
    const plain = search.search("shared term");
    expect(plain).toHaveLength(2);
    const boosted = search.search("shared term", {
      boostFile: (path) => (path === "Recent.md" ? 5 : 1),
    });
    expect(boosted[0].path).toBe("Recent.md");
  });

  test("a title match outranks a body match", () => {
    const search = indexOf({
      "Body.md": "# Body\n\nsomewhere in here is the word tomato\n",
      "Tomato.md": "# Tomato\n\nunrelated prose about soil\n",
    });
    expect(search.search("tomato")[0].path).toBe("Tomato.md");
  });

  test("matchesPerFile and limit cap the result size", () => {
    const many = Array.from({ length: 12 }, (_, i) => `paragraph ${i} with token here`).join("\n\n");
    const search = indexOf({ "A.md": `# A\n\n${many}` });
    expect(search.search("token", { matchesPerFile: 3 })[0].matches).toHaveLength(3);
  });
});

describe("snippets", () => {
  test("a window around the first match, with highlight ranges into the snippet", () => {
    const text = `${"filler ".repeat(40)}the needle is here${" trailing".repeat(40)}`;
    const { snippet, highlights } = snippetFor(text, ["needle"]);
    expect(snippet.length).toBeLessThan(240);
    expect(snippet).toContain("needle");
    expect(snippet).toStartWith("…");
    expect(snippet).toEndWith("…");
    // Highlight ranges must index into the snippet, not the original text.
    for (const [start, end] of highlights) {
      expect(snippet.slice(start, end).toLowerCase()).toBe("needle");
    }
    expect(highlights.length).toBeGreaterThan(0);
  });

  test("a short block is returned whole, without ellipses", () => {
    const { snippet, highlights } = snippetFor("short text with needle", ["needle"]);
    expect(snippet).toBe("short text with needle");
    expect(snippet.slice(highlights[0][0], highlights[0][1])).toBe("needle");
  });

  test("no matched terms still yields a readable prefix", () => {
    const { snippet, highlights } = snippetFor("some text", []);
    expect(snippet).toBe("some text");
    expect(highlights).toEqual([]);
  });
});
