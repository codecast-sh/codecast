import { describe, expect, test } from "bun:test";
import { docOrigin, docOriginClass, isHumanDocOrigin, isOnHumanShelf, docSourceForPlanSource } from "./index";

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
