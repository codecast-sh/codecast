import { describe, expect, test } from "bun:test";
import { docOrigin, docOriginClass, isHumanDocOrigin, isOnHumanShelf, docSourceForPlanSource, DOC_TYPES, DOC_TYPE_LABELS, docTypeLabel, docMentionExcerpt, renderDocMentionExcerpt } from "./index";

describe("docOrigin", () => {
  test("only an explicit human stamp is human", () => {
    expect(docOrigin({ source: "human" })).toBe("human");
    for (const source of ["agent", "plan_mode", "file_sync", "inline_extract", "import"]) {
      expect(docOrigin({ source })).toBe("agent");
    }
  });

  test("unknown and missing sources default to agent, never leaking onto the shelf", () => {
    expect(docOrigin({ source: "some_future_writer" })).toBe("agent");
    expect(docOrigin({ source: undefined })).toBe("agent");
    expect(docOrigin({ source: null })).toBe("agent");
    expect(isHumanDocOrigin({})).toBe(false);
  });
});

describe("docOriginClass", () => {
  test("splits deliberate agent filing from mined collection, like tasks split agent from triage", () => {
    expect(docOriginClass({ source: "human" })).toBe("human");
    expect(docOriginClass({ source: "agent" })).toBe("agent");
    expect(docOriginClass({ source: "plan_mode" })).toBe("agent");
    expect(docOriginClass({ source: "file_sync" })).toBe("mined");
    expect(docOriginClass({ source: "inline_extract" })).toBe("mined");
    expect(docOriginClass({ source: "import" })).toBe("mined");
  });

  test("unknown sources class as agent, not mined", () => {
    expect(docOriginClass({ source: "some_future_writer" })).toBe("agent");
    expect(docOriginClass({})).toBe("agent");
  });
});

describe("isOnHumanShelf", () => {
  test("human origin is on the shelf", () => {
    expect(isOnHumanShelf({ source: "human" })).toBe(true);
  });

  test("machine docs stay off the shelf until pinned", () => {
    expect(isOnHumanShelf({ source: "file_sync" })).toBe(false);
    expect(isOnHumanShelf({ source: "agent", pinned: false })).toBe(false);
    expect(isOnHumanShelf({ source: "agent", pinned: true })).toBe(true);
  });
});

describe("docSourceForPlanSource", () => {
  test("only a human plan yields a human plan-body doc", () => {
    expect(docSourceForPlanSource("human")).toBe("human");
    for (const s of ["agent", "promoted", "template", "fork", "imported", undefined, null]) {
      expect(docSourceForPlanSource(s as any)).toBe("agent");
    }
  });
});

describe("title = leading heading", () => {
  const { leadingHeading, docTitleFromContent, setTitleHeading, withTitleHeading, stripTitleHeading } =
    require("./index") as typeof import("./index");

  test("leadingHeading reads only a heading that opens the body", () => {
    expect(leadingHeading("# Auth notes\n\nbody")).toBe("Auth notes");
    expect(leadingHeading("\n\n  ## Second level  \nbody")).toBe("Second level");
    expect(leadingHeading("# Closing hashes ##")).toBe("Closing hashes");
    expect(leadingHeading("#")).toBe("");
    expect(leadingHeading("intro\n\n# Later heading")).toBeNull();
    expect(leadingHeading("#hashtag not a heading")).toBeNull();
    expect(leadingHeading("")).toBeNull();
    expect(leadingHeading(undefined)).toBeNull();
  });

  test("a leading horizontal rule is not frontmatter", () => {
    const md = "---\n\nTimeline notes\n\n# Later\n\n---\nmore";
    expect(leadingHeading(md)).toBeNull();
    expect(withTitleHeading("Weekly Plan", md)).toBe(`# Weekly Plan\n\n${md}`);
    expect(stripTitleHeading(md)).toBe(md);
  });

  test("frontmatter is skipped, never read as the title", () => {
    const md = "---\ntitle: Front\n---\n# Real\n\nbody";
    expect(leadingHeading(md)).toBe("Real");
    expect(leadingHeading("---\ntitle: Front\n---\nplain")).toBeNull();
  });

  test("docTitleFromContent falls back when the body has no leading heading", () => {
    expect(docTitleFromContent("# Real", "Fallback")).toBe("Real");
    expect(docTitleFromContent("plain body", "Fallback")).toBe("Fallback");
    expect(docTitleFromContent("#", "Fallback")).toBe("Fallback");
  });

  test("setTitleHeading replaces the leading heading and keeps the body", () => {
    expect(setTitleHeading("New", "# Old\n\nbody")).toBe("# New\n\nbody");
    expect(setTitleHeading("New", "## Old level two\nbody")).toBe("# New\nbody");
    expect(setTitleHeading("New", "plain body")).toBe("# New\n\nplain body");
    expect(setTitleHeading("New", "")).toBe("# New\n");
    expect(setTitleHeading("New", undefined)).toBe("# New\n");
    expect(setTitleHeading("  ", "body")).toBe("#\n\nbody");
    expect(setTitleHeading("New", "---\nk: v\n---\n# Old\nbody")).toBe("---\nk: v\n---\n# New\nbody");
  });

  test("withTitleHeading only adds a heading when there is none", () => {
    expect(withTitleHeading("Given", "# Kept\n\nbody")).toBe("# Kept\n\nbody");
    expect(withTitleHeading("Given", "body")).toBe("# Given\n\nbody");
    expect(withTitleHeading("Given", "")).toBe("# Given\n");
  });

  test("stripTitleHeading drops the leading heading and the blank line after it", () => {
    expect(stripTitleHeading("# T\n\nbody\n\n# Section")).toBe("body\n\n# Section");
    expect(stripTitleHeading("# T\nbody")).toBe("body");
    expect(stripTitleHeading("# T")).toBe("");
    expect(stripTitleHeading("plain\n\n# later")).toBe("plain\n\n# later");
    expect(stripTitleHeading("---\nk: v\n---\n# T\n\nbody")).toBe("---\nk: v\n---\nbody");
    expect(stripTitleHeading("")).toBe("");
  });

  test("round trip: set then read then strip", () => {
    const md = setTitleHeading("Round trip", "first para\n\n- item");
    expect(leadingHeading(md)).toBe("Round trip");
    expect(stripTitleHeading(md)).toBe("first para\n\n- item");
  });
});

describe("DOC_TYPES", () => {
  test("every type in the tuple has a label, so no tab or picker can dereference a missing entry", () => {
    // The docs list crashed on "decision" when the ordered list and the label
    // map were two hand-kept copies; now the tuple is the only list.
    for (const t of DOC_TYPES) expect(DOC_TYPE_LABELS[t]).toBeTruthy();
    expect(DOC_TYPES).toContain("decision");
    expect(Object.keys(DOC_TYPE_LABELS).sort()).toEqual([...DOC_TYPES].sort());
  });

  test("an unknown stored type reads as a note, matching every client's style fallback", () => {
    expect(docTypeLabel("decision")).toBe("Decision");
    expect(docTypeLabel("some_future_type")).toBe("Note");
    expect(docTypeLabel(undefined)).toBe("Note");
  });
});

describe("docMentionExcerpt", () => {
  const long = [
    "# Plan",
    "",
    ...Array.from({ length: 60 }, (_, i) => `intro line ${i} with some words to fill it out`),
    "## Workstreams",
    "```",
    "# not a heading, inside a fence",
    "```",
    "### W0 Signal",
    "body",
    "## Execution",
  ].join("\n");

  test("a short doc rides along whole", () => {
    const ex = docMentionExcerpt("# Small\n\nbody", 2000);
    expect(ex.truncated).toBe(false);
    expect(ex.excerpt).toBe("# Small\n\nbody");
  });

  test("a long doc is cut at a whole line, and the headings after it carry their line numbers", () => {
    const ex = docMentionExcerpt(long, 500);
    expect(ex.truncated).toBe(true);
    expect(ex.excerpt.length).toBeLessThanOrEqual(500);
    expect(long.startsWith(ex.excerpt + "\n")).toBe(true);
    const lines = long.split("\n");
    expect(ex.outline.map((o) => o.heading)).toEqual(["## Workstreams", "### W0 Signal", "## Execution"]);
    for (const o of ex.outline) expect(lines[o.line - 1]).toBe(o.heading);
  });

  test("the rendered excerpt names the doc and how to read the rest", () => {
    const md = renderDocMentionExcerpt(long, "s979abc", 500);
    expect(md).toContain("L63 ## Workstreams");
    expect(md).toContain("cast doc show s979abc <from>:<to>");
    expect(md).not.toContain("intro line 59");
  });
});
