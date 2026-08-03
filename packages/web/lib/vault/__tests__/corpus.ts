// The shared syntax corpus.
//
// These cases are the CONTRACT for Obsidian-flavored markdown in codecast, not
// tests of one implementation. `parseNote` is checked against them today;
// `remarkWikiLink` (rendering) and the `@lezer/markdown` extension (CM6 live
// preview) must be checked against the same list when they land, because the
// cost of defining this grammar three times is exactly that the three drift.
// So: no assertions here, only markdown paired with the facts any correct
// reader of it must produce. Each case asserts only the keys it declares.

export interface CorpusExpectation {
  title?: string | null;
  aliases?: string[];
  frontmatterTags?: string[];
  /** Inline tags in document order, without '#'. */
  inlineTags?: string[];
  /** Links in document order. `target` is required; other keys optional. */
  links?: {
    target: string;
    subpath?: string;
    subpathType?: "heading" | "block";
    alias?: string;
    isEmbed?: boolean;
    line?: number;
    col?: number;
  }[];
  headings?: { text: string; level: number; slug?: string; line?: number; endLine?: number }[];
  blocks?: { id: string; line?: number; text?: string }[];
  tasks?: { done: boolean; text?: string; line?: number }[];
  /** Substrings that MUST appear in plainText. */
  plainTextIncludes?: string[];
  /** Substrings that must NOT appear in plainText. */
  plainTextExcludes?: string[];
  frontmatter?: Record<string, unknown>;
}

export interface CorpusCase {
  name: string;
  /** Why this case exists — the rule it pins. */
  rule: string;
  markdown: string;
  expect: CorpusExpectation;
}

export const CORPUS: CorpusCase[] = [
  // -- frontmatter --------------------------------------------------------
  {
    name: "frontmatter: inline array tags and aliases",
    rule: "tags/aliases accept inline-array form; title wins over H1",
    markdown: [
      "---",
      "title: Real Title",
      "tags: [status/draft, recipe]",
      'aliases: ["Short Name", Other]',
      "rating: 4",
      "reviewed: true",
      "created: 2026-02-16",
      "---",
      "",
      "# Different H1",
      "",
      "Body.",
    ].join("\n"),
    expect: {
      title: "Real Title",
      aliases: ["Short Name", "Other"],
      frontmatterTags: ["status/draft", "recipe"],
      frontmatter: { rating: 4, reviewed: true, created: "2026-02-16" },
      headings: [{ text: "Different H1", level: 1, line: 10 }],
    },
  },
  {
    name: "frontmatter: block list form",
    rule: "block lists (`- x`) are equivalent to inline arrays, at either indent",
    markdown: [
      "---",
      "tags:",
      "  - project",
      "  - status/done",
      "aliases:",
      "- The Other Name",
      "---",
      "",
      "Body.",
    ].join("\n"),
    expect: {
      frontmatterTags: ["project", "status/done"],
      aliases: ["The Other Name"],
      title: null,
    },
  },
  {
    name: "frontmatter: bare scalar tags with leading hashes",
    rule: "`tags: a, b` is a string; split it, and strip '#' either way",
    markdown: ["---", "tags: #idea, #status/draft", "alias: Solo", "---", "", "Body."].join("\n"),
    expect: { frontmatterTags: ["idea", "status/draft"], aliases: ["Solo"] },
  },
  {
    name: "frontmatter: only at byte 0",
    rule: "a `---` fence further down is a thematic break, not frontmatter",
    markdown: ["Intro paragraph.", "", "---", "title: Not Frontmatter", "---", "", "More."].join("\n"),
    expect: { title: null, frontmatterTags: [] },
  },
  {
    name: "frontmatter: unparseable line degrades to string",
    rule: "a property this parser can't model must not cost the note its links",
    markdown: [
      "---",
      "weird: {this: [is, nested, {deeply: true}]}",
      "tags: [ok]",
      "---",
      "",
      "See [[Target]].",
    ].join("\n"),
    expect: { frontmatterTags: ["ok"], links: [{ target: "Target" }] },
  },

  // -- links --------------------------------------------------------------
  {
    name: "links: all wiki forms",
    rule: "alias, heading subpath, block subpath, embed, image embed with width",
    markdown: [
      "[[Plain]] and [[Target|alias text]].",
      "[[Note#Heading]] then [[Note#^block-id]].",
      "![[Embedded Note]] and ![[diagram.png|300]].",
      "[[folder/Nested Note]] and [[Café Réunion — planning]].",
      "[[#Same File Heading]] and [[#^same-file-block]].",
    ].join("\n"),
    expect: {
      links: [
        { target: "Plain", line: 1, col: 0 },
        { target: "Target", alias: "alias text", line: 1 },
        { target: "Note", subpath: "Heading", subpathType: "heading", line: 2 },
        { target: "Note", subpath: "block-id", subpathType: "block", line: 2 },
        { target: "Embedded Note", isEmbed: true, line: 3 },
        { target: "diagram.png", alias: "300", isEmbed: true, line: 3 },
        { target: "folder/Nested Note", line: 4 },
        { target: "Café Réunion — planning", line: 4 },
        { target: "", subpath: "Same File Heading", subpathType: "heading", line: 5 },
        { target: "", subpath: "same-file-block", subpathType: "block", line: 5 },
      ],
    },
  },
  {
    name: "links: escaped brackets are not links",
    rule: "`\\[[x]]` is literal text; `\\![[x]]` escapes only the embed marker",
    markdown: ["\\[[not a link]] but [[real link]].", "\\![[still a link, not an embed]]"].join("\n"),
    expect: {
      links: [
        { target: "real link", line: 1 },
        { target: "still a link, not an embed", isEmbed: false, line: 2 },
      ],
    },
  },
  {
    name: "links: inside a markdown link target",
    rule: "PIN: `[text]([[x]])` counts the inner wiki link — over-counting a backlink is recoverable, missing one is not",
    markdown: "See [text]([[Inner Target]]).",
    expect: { links: [{ target: "Inner Target" }] },
  },
  {
    name: "links: unicode, dots and punctuation in targets",
    rule: "targets are filenames, so anything but [ ] | # is fair game",
    markdown: "[[What's next?]] [[2026 Goals]] [[Note v1.2]] [[日本語ノート]]",
    expect: {
      links: [
        { target: "What's next?" },
        { target: "2026 Goals" },
        { target: "Note v1.2" },
        { target: "日本語ノート" },
      ],
    },
  },

  // -- code exclusion -----------------------------------------------------
  {
    name: "code: fenced blocks are invisible to the scanner",
    rule: "links, tags and tasks inside ``` are not vault facts",
    markdown: [
      "Real [[Link One]] and #realtag.",
      "",
      "```ts",
      "// [[Fake Link]] and #faketag",
      "- [ ] fake task",
      "```",
      "",
      "~~~python",
      "# [[Also Fake]] #alsofake",
      "~~~",
      "",
      "Real [[Link Two]].",
    ].join("\n"),
    expect: {
      links: [{ target: "Link One", line: 1 }, { target: "Link Two", line: 12 }],
      inlineTags: ["realtag"],
      tasks: [],
      plainTextExcludes: ["Fake Link", "faketag", "Also Fake"],
    },
  },
  {
    name: "code: fence with a longer closing run and an info string",
    rule: "a fence closes on >= its own length of the same character",
    markdown: ["````md", "```", "[[Inside]] #inside", "````", "", "[[Outside]]"].join("\n"),
    expect: { links: [{ target: "Outside", line: 6 }], inlineTags: [] },
  },
  {
    name: "code: indented fences up to three spaces",
    rule: "CommonMark allows a fence indented 0-3 spaces",
    markdown: ["   ```", "   [[Indented Fake]]", "   ```", "", "[[Real]]"].join("\n"),
    expect: { links: [{ target: "Real" }] },
  },
  {
    name: "code: inline spans, including double-backtick",
    rule: "`...` masks its content; ``a `b` c`` closes only on a run of equal length",
    markdown: [
      "Use `[[not a link]]` and `#nottag` here.",
      "But ``code with ` tick and [[still not]]`` too.",
      "And [[Yes A Link]] after.",
    ].join("\n"),
    expect: {
      links: [{ target: "Yes A Link", line: 3 }],
      inlineTags: [],
      plainTextExcludes: ["not a link", "still not"],
    },
  },
  {
    name: "code: an unmatched backtick does not swallow the line",
    rule: "a backtick run with no closer is literal text",
    markdown: "Cost is 3` and [[Still Linked]].",
    expect: { links: [{ target: "Still Linked" }] },
  },

  // -- tags ---------------------------------------------------------------
  {
    name: "tags: shapes that count and shapes that do not",
    rule: "nested/dashed/underscored/unicode count; pure numeric does not; a '#' mid-word does not",
    markdown: [
      "#tag #nested/tag #tag-with-dash #tag_underscore #1a #日本語",
      "Not tags: #123 and a#b and https://x.com/page#frag",
      "(#in-parens) and \"#in-quotes\"",
    ].join("\n"),
    expect: {
      inlineTags: [
        "tag",
        "nested/tag",
        "tag-with-dash",
        "tag_underscore",
        "1a",
        "日本語",
        "in-parens",
        "in-quotes",
      ],
    },
  },
  {
    name: "tags: inside headings count",
    rule: "a heading is prose too",
    markdown: ["# Heading with #headingtag", "", "Body #bodytag"].join("\n"),
    expect: {
      inlineTags: ["headingtag", "bodytag"],
      headings: [{ text: "Heading with #headingtag", level: 1 }],
    },
  },
  {
    name: "tags: a markdown link destination is a URL, not a tag",
    rule: "`[Intro](#introduction)` is an anchor link — the '#' is a URL fragment",
    markdown: [
      "See the [Introduction](#introduction) section.",
      "Also [site](https://example.com/x#frag) and (https://example.com/y#frag2).",
      "But a real (#parenthesized) tag still counts.",
    ].join("\n"),
    expect: { inlineTags: ["parenthesized"] },
  },
  {
    name: "tags: trailing slash trimmed",
    rule: "`#status/` is the tag `status`",
    markdown: "Filed under #status/ today.",
    expect: { inlineTags: ["status"] },
  },

  // -- headings -----------------------------------------------------------
  {
    name: "headings: levels, slugs, spans, closing sequences",
    rule: "ATX only; endLine runs to the line before the next same-or-higher heading",
    markdown: [
      "# Top",
      "body a",
      "## Middle ##",
      "body b",
      "### Deep",
      "body c",
      "## Second Middle",
      "body d",
    ].join("\n"),
    expect: {
      headings: [
        { text: "Top", level: 1, slug: "top", line: 1, endLine: 8 },
        { text: "Middle", level: 2, slug: "middle", line: 3, endLine: 6 },
        { text: "Deep", level: 3, slug: "deep", line: 5, endLine: 6 },
        { text: "Second Middle", level: 2, slug: "second-middle", line: 7, endLine: 8 },
      ],
    },
  },
  {
    name: "headings: not a heading without a space",
    rule: "`#foo` is a tag, `####### x` is too deep, setext is UNSUPPORTED (documented)",
    markdown: ["#foo", "", "####### seven", "", "Setext Title", "===="].join("\n"),
    expect: { headings: [], inlineTags: ["foo"] },
  },
  {
    name: "headings: unicode slug",
    rule: "unicode letters survive slugification; punctuation does not",
    markdown: "## Café Réunion — planning",
    expect: { headings: [{ text: "Café Réunion — planning", level: 2, slug: "café-réunion--planning" }] },
  },

  // -- blocks and tasks ---------------------------------------------------
  {
    name: "blocks: trailing id and standalone id",
    rule: "`^id` ends a line, or sits alone on the line after the block it names",
    markdown: [
      "Key claim goes here. ^key-claim",
      "",
      "A paragraph that gets its id below.",
      "^detached-id",
      "",
      "Not an id: ^has_underscore stays inline.",
    ].join("\n"),
    expect: {
      blocks: [
        { id: "key-claim", line: 1, text: "Key claim goes here." },
        { id: "detached-id", line: 4, text: "A paragraph that gets its id below." },
      ],
      plainTextExcludes: ["^detached-id"],
    },
  },
  {
    name: "tasks: markers, states, nesting",
    rule: "-, * and + all start tasks; x/X is done; nesting is allowed; other chars are open tasks",
    markdown: [
      "- [ ] open task with [[A Link]]",
      "- [x] done task",
      "* [X] also done",
      "  - [ ] nested open",
      "+ [/] custom state counts as open",
      "- not a task",
      "- [ ]",
    ].join("\n"),
    expect: {
      tasks: [
        { done: false, text: "open task with A Link", line: 1 },
        { done: true, text: "done task", line: 2 },
        { done: true, text: "also done", line: 3 },
        { done: false, text: "nested open", line: 4 },
        { done: false, text: "custom state counts as open", line: 5 },
        { done: false, text: "", line: 7 },
      ],
      links: [{ target: "A Link", line: 1 }],
    },
  },

  // -- plain text ---------------------------------------------------------
  {
    name: "plainText: syntax stripped, display text kept",
    rule: "links contribute their display text; tags stay; tables become cell text",
    markdown: [
      "# Title Here",
      "",
      "**Bold** and *italic* and ~~struck~~ text with a [md link](https://x.com) and [[Wiki Target]] and [[Other|shown text]].",
      "",
      "| Col A | Col B |",
      "| ----- | ----- |",
      "| cell1 | cell2 |",
      "",
      "> quoted line",
      "",
      "![alt text](img.png) and ![[embedded.md]]",
      "",
      "Tagged #keepme",
    ].join("\n"),
    expect: {
      plainTextIncludes: [
        "Title Here",
        "Bold and italic and struck",
        "md link",
        "Wiki Target",
        "shown text",
        "cell1",
        "quoted line",
        "#keepme",
      ],
      plainTextExcludes: ["**", "~~", "https://x.com", "| ----- |", "embedded.md", "alt text"],
    },
  },
  {
    name: "plainText: subpath display forms",
    rule: "a heading link reads 'Note > Heading'; a block id is never prose (else searching 'key claim' matches ^key-claim)",
    markdown: "See [[Note#Background]] and [[Other#^key-claim]] and [[Third#^id|shown]].",
    expect: {
      plainTextIncludes: ["Note > Background", "Other", "shown"],
      plainTextExcludes: ["key-claim", "^id"],
    },
  },

  // -- codecast object references -----------------------------------------
  // These are ORDINARY MARKDOWN LINKS, deliberately: the file is read in
  // Obsidian, on GitHub and in plain editors, where a bespoke token would be a
  // broken link or literal noise. So every reader below must treat them as the
  // links they are — only codecast recognizes the host and draws a pill.
  {
    name: "entity refs: object links are plain markdown links",
    rule: "a link to a codecast object parses as a link, not as vault syntax; its display text is the prose",
    markdown: [
      "# Session notes",
      "",
      "Figured out in [the debug run](https://codecast.sh/conversation/jx7dnj1),",
      "under [Fix the sync clog](https://codecast.sh/tasks/ct-40561).",
      "",
      "Owner: [@ashot](https://codecast.sh/team/ashot). Plan: [Vault links](/plans/pl-264).",
      "",
      "Bare form works too: https://codecast.sh/tasks/ct-9",
    ].join("\n"),
    expect: {
      // No `[[…]]` anywhere: object references never claim the vault's own syntax.
      links: [],
      plainTextIncludes: ["the debug run", "Fix the sync clog", "@ashot", "Vault links"],
      plainTextExcludes: ["](https://codecast.sh", "conversation/jx7dnj1"],
    },
  },
  {
    name: "entity refs: beside wiki links, tags and code",
    rule: "object links coexist with vault syntax on one line and stay literal inside code",
    markdown: [
      "See [[Sleep]] and [ct-40561](https://codecast.sh/tasks/ct-40561) #status/draft",
      "",
      "An example, not a reference: `https://codecast.sh/tasks/ct-1`",
      "",
      "```md",
      "[nope](https://codecast.sh/tasks/ct-2)",
      "```",
    ].join("\n"),
    expect: {
      links: [{ target: "Sleep", line: 1 }],
      inlineTags: ["status/draft"],
      plainTextIncludes: ["Sleep", "ct-40561"],
    },
  },
];
