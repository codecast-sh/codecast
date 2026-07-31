import { test, expect, describe } from "bun:test";
import { parseNote, parseWikiTarget, slugifyHeading, stripKnownExtension } from "../parseNote";
import { CORPUS, type CorpusExpectation } from "./corpus";

/** Assert only the keys the corpus case declares — a case pins the rule it is
 *  about and stays silent on everything else. */
function expectSubset(actual: Record<string, unknown>, expected: Record<string, unknown>, where: string) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key], `${where}.${key}`).toEqual(value as never);
  }
}

describe("corpus", () => {
  for (const testCase of CORPUS) {
    test(`${testCase.name} — ${testCase.rule}`, () => {
      const parsed = parseNote(testCase.markdown);
      const want: CorpusExpectation = testCase.expect;

      if (want.title !== undefined) expect(parsed.title).toBe(want.title);
      if (want.aliases) expect(parsed.aliases).toEqual(want.aliases);
      if (want.frontmatterTags) expect(parsed.frontmatterTags).toEqual(want.frontmatterTags);
      if (want.inlineTags) expect(parsed.inlineTags.map((t) => t.tag)).toEqual(want.inlineTags);
      if (want.frontmatter) expectSubset(parsed.frontmatter ?? {}, want.frontmatter, "frontmatter");

      if (want.links) {
        expect(parsed.links.map((l) => l.target)).toEqual(want.links.map((l) => l.target));
        want.links.forEach((expectedLink, i) => {
          expectSubset(parsed.links[i] as unknown as Record<string, unknown>, expectedLink, `links[${i}]`);
        });
      }
      if (want.headings) {
        expect(parsed.headings).toHaveLength(want.headings.length);
        want.headings.forEach((h, i) => {
          expectSubset(parsed.headings[i] as unknown as Record<string, unknown>, h, `headings[${i}]`);
        });
      }
      if (want.blocks) {
        expect(parsed.blocks.map((b) => b.id)).toEqual(want.blocks.map((b) => b.id));
        want.blocks.forEach((b, i) => {
          expectSubset(parsed.blocks[i] as unknown as Record<string, unknown>, b, `blocks[${i}]`);
        });
      }
      if (want.tasks) {
        expect(parsed.tasks).toHaveLength(want.tasks.length);
        want.tasks.forEach((t, i) => {
          expectSubset(parsed.tasks[i] as unknown as Record<string, unknown>, t, `tasks[${i}]`);
        });
      }
      for (const needle of want.plainTextIncludes ?? []) {
        expect(parsed.plainText).toContain(needle);
      }
      for (const needle of want.plainTextExcludes ?? []) {
        expect(parsed.plainText).not.toContain(needle);
      }
    });
  }
});

describe("parseNote basics", () => {
  test("empty and whitespace-only input", () => {
    for (const input of ["", "\n\n", "   "]) {
      const parsed = parseNote(input);
      expect(parsed.title).toBeNull();
      expect(parsed.links).toEqual([]);
      expect(parsed.wordCount).toBe(0);
    }
  });

  test("title falls back H1 when frontmatter has none, null when neither", () => {
    expect(parseNote("# Just An H1\n\nbody").title).toBe("Just An H1");
    expect(parseNote("body only").title).toBeNull();
    expect(parseNote("---\ntitle: FM\n---\n\n# H1").title).toBe("FM");
    // A deeper heading is not a title — only H1 counts.
    expect(parseNote("## Not A Title\n\nbody").title).toBeNull();
  });

  test("frontmatter that never closes is not frontmatter", () => {
    const parsed = parseNote("---\ntitle: Dangling\n\nbody with [[Link]]");
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.links.map((l) => l.target)).toEqual(["Link"]);
  });

  test("CRLF line endings keep line numbers correct", () => {
    const parsed = parseNote("# Title\r\n\r\nbody\r\n\r\n[[Target]]\r\n");
    expect(parsed.links[0].line).toBe(5);
    expect(parsed.headings[0].line).toBe(1);
  });

  test("code text is captured, not discarded", () => {
    const parsed = parseNote(["Prose.", "", "```ts", "const secret = 1;", "```", "", "And `inline code`."].join("\n"));
    expect(parsed.codeText).toContain("const secret = 1;");
    expect(parsed.codeText).toContain("inline code");
    expect(parsed.plainText).not.toContain("const secret");
    expect(parsed.plainText).not.toContain("inline code");
  });

  test("wordCount counts prose, not markup", () => {
    expect(parseNote("# A\n\none two three").wordCount).toBe(4);
  });

  test("chunks carry line spans and the heading trail", () => {
    const parsed = parseNote(
      ["# Top", "", "first para", "", "## Sub", "", "second para", "still second", ""].join("\n"),
    );
    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.chunks[0]).toMatchObject({ line: 3, endLine: 3, headingPath: ["Top"] });
    expect(parsed.chunks[1]).toMatchObject({ line: 7, endLine: 8, headingPath: ["Top", "Sub"] });
    expect(parsed.chunks[1].text).toBe("second para still second");
  });

  test("a chunk carrying a block id remembers it, in all three placements", () => {
    // Trailing on the line, on the next line, and after a blank line all name
    // the same paragraph — search must be able to deep-link the block in each.
    for (const markdown of [
      "Some claim. ^the-id\n",
      "Some claim.\n^the-id\n",
      "Some claim.\n\n^the-id\n",
    ]) {
      const parsed = parseNote(markdown);
      expect(parsed.blocks[0], markdown).toMatchObject({ id: "the-id", text: "Some claim." });
      expect(parsed.chunks, markdown).toHaveLength(1);
      expect(parsed.chunks[0].blockId, markdown).toBe("the-id");
    }
  });

  test("columns are 0-based and index into the raw line", () => {
    const line = "prefix text [[Target]] suffix";
    const parsed = parseNote(line);
    expect(line.slice(parsed.links[0].col)).toStartWith("[[Target]]");
  });
});

describe("helpers", () => {
  test("parseWikiTarget splits on the FIRST pipe and the FIRST hash", () => {
    expect(parseWikiTarget("A|b|c")).toEqual({ target: "A", alias: "b|c" });
    // Nested heading paths keep their inner hashes.
    expect(parseWikiTarget("Note#H1#H2")).toEqual({
      target: "Note",
      subpath: "H1#H2",
      subpathType: "heading",
    });
    expect(parseWikiTarget("img.png|300x200")).toEqual({ target: "img.png", alias: "300x200" });
  });

  test("stripKnownExtension only strips extensions the vault knows", () => {
    expect(stripKnownExtension("A/B.md")).toBe("A/B");
    expect(stripKnownExtension("A/B.markdown")).toBe("A/B");
    expect(stripKnownExtension("A/diagram.png")).toBe("A/diagram");
    // A version number is not an extension.
    expect(stripKnownExtension("Note v1.2")).toBe("Note v1.2");
    expect(stripKnownExtension("archive.tar.gz")).toBe("archive.tar.gz");
  });

  test("slugifyHeading keeps unicode letters, drops punctuation", () => {
    expect(slugifyHeading("Hello World")).toBe("hello-world");
    expect(slugifyHeading("What's next?")).toBe("whats-next");
    expect(slugifyHeading("日本語 見出し")).toBe("日本語-見出し");
  });
});
