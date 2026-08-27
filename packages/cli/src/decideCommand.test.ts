import { describe, expect, it } from "bun:test";
import { parseDecideOption, pickDecisionTarget, looksLikeDecisionId, describeResolution, formatDecisionList, type DecisionRow } from "./decideCommand.js";

describe("cast decide option parsing", () => {
  it("keeps a bare label as a label", () => {
    expect(parseDecideOption("Approve")).toEqual({ label: "Approve" });
  });

  it("splits 'label :: what happens' into label and consequence", () => {
    expect(parseDecideOption("Approve :: frees the last migration")).toEqual({
      label: "Approve",
      description: "frees the last migration",
    });
  });

  it("tolerates missing spaces around the separator", () => {
    expect(parseDecideOption("Path wins::stable across edits")).toEqual({
      label: "Path wins",
      description: "stable across edits",
    });
  });

  it("ignores a trailing separator with no consequence after it", () => {
    expect(parseDecideOption("Hold ::")).toEqual({ label: "Hold" });
  });

  it("only splits on the FIRST separator, so a consequence may contain one", () => {
    expect(parseDecideOption("Ship :: a :: b")).toEqual({
      label: "Ship",
      description: "a :: b",
    });
  });
});

const row = (over: Partial<DecisionRow>): DecisionRow => ({
  id: "k57abcdefghijklmnopqrstuv",
  question: "Which schema wins?",
  options: [{ label: "Frontmatter" }, { label: "Path", description: "stable across edits" }],
  blocking: true,
  status: "pending",
  created_at: 1,
  ...over,
});

describe("cast decide edit/cancel target", () => {
  it("an explicit id always wins", () => {
    expect(pickDecisionTarget([], "k57abcdefghijklmnopqrstuv")).toEqual({ id: "k57abcdefghijklmnopqrstuv" });
  });

  it("acts on the session's one open decision when no id is given", () => {
    const rows = [row({ id: "aaaaaaaaaaaaaaaaaaaaaaaa", status: "answered", answer_index: 1 }), row({})];
    expect(pickDecisionTarget(rows)).toEqual({ id: "k57abcdefghijklmnopqrstuv" });
  });

  it("refuses to guess between several open decisions and lists them", () => {
    const rows = [row({ id: "aaaaaaaaaaaaaaaaaaaaaaaa", question: "A?" }), row({ id: "bbbbbbbbbbbbbbbbbbbbbbbb", question: "B?" })];
    const out = pickDecisionTarget(rows);
    expect("error" in out).toBe(true);
    expect((out as any).error).toContain("2 open decisions");
    expect((out as any).error).toContain("aaaaaaaaaaaaaaaaaaaaaaaa  A?");
  });

  it("explains how the latest decision was resolved when none is open", () => {
    const rows = [row({ status: "answered", answer_index: 1 })];
    expect((pickDecisionTarget(rows) as any).error).toContain("answered: Path");
  });

  it("points at posting one when the session never asked", () => {
    expect((pickDecisionTarget([]) as any).error).toContain("Post one with");
  });
});

describe("cast decide id shape", () => {
  it("accepts a Convex id and rejects prose or a subcommand word", () => {
    expect(looksLikeDecisionId("k57abcdefghijklmnopqrstuv")).toBe(true);
    expect(looksLikeDecisionId("edit")).toBe(false);
    expect(looksLikeDecisionId("Which schema wins?")).toBe(false);
    expect(looksLikeDecisionId(undefined)).toBe(false);
  });
});

describe("cast decide ls formatting", () => {
  it("names the answer label, marks the chosen option, and flags advisory", () => {
    const text = formatDecisionList([
      row({ status: "answered", answer_index: 1, blocking: false, default_option: 0 }),
    ]);
    expect(text).toContain("answered: Path  (advisory)");
    expect(text).toContain("✓ 2. Path — stable across edits");
    expect(text).not.toContain("→ 1.");
  });

  it("marks the default of an open advisory decision", () => {
    const text = formatDecisionList([row({ blocking: false, default_option: 0 })]);
    expect(text).toContain("→ 1. Frontmatter");
    expect(text).toContain("still open  (advisory)");
  });

  it("describes a free-text answer and a withdrawal", () => {
    expect(describeResolution(row({ status: "answered", answer_text: "neither, merge them" }))).toBe("answered: neither, merge them");
    expect(describeResolution(row({ status: "withdrawn" }))).toBe("withdrawn");
  });
});
