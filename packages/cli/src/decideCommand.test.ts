import { describe, expect, it } from "bun:test";
import { parseDecideOption, pickDecisionTarget, looksLikeDecisionId, describeResolution, formatDecisionList, formatAge, isStaleDecision, type DecisionRow } from "./decideCommand.js";

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
    const now = 1 + 5 * 60_000;
    const text = formatDecisionList([row({ blocking: false, default_option: 0 })], now);
    expect(text).toContain("→ 1. Frontmatter");
    expect(text).toContain("still open — asked 5m ago  (advisory)");
  });

  it("describes a free-text answer and a withdrawal", () => {
    expect(describeResolution(row({ status: "answered", answer_text: "neither, merge them" }))).toBe("answered: neither, merge them");
    expect(describeResolution(row({ status: "withdrawn" }))).toBe("withdrawn");
  });

  it("shows how far the session has run past an open ask", () => {
    const now = 1 + 30 * 60_000;
    const text = formatDecisionList([row({ messages_since: 12 })], now);
    expect(text).toContain("still open — asked 30m ago, 12 messages since");
    expect(text).not.toContain("moved past");
  });

  it("nudges cleanup when an open ask has gone stale, and only then", () => {
    const now = 1 + 3 * 60 * 60_000;
    const stale = formatDecisionList([row({})], now);
    expect(stale).toContain("cast decide cancel <id>");

    const fresh = formatDecisionList([row({})], 1 + 10 * 60_000);
    expect(fresh).not.toContain("cast decide cancel <id>");

    // A resolved row never counts as stale, however old.
    const resolved = formatDecisionList([row({ status: "withdrawn" })], now);
    expect(resolved).not.toContain("cast decide cancel <id>");
  });
});

describe("decision staleness", () => {
  it("goes stale on age or on conversation drift, pending rows only", () => {
    expect(isStaleDecision(row({}), 1 + 60_000)).toBe(false);
    expect(isStaleDecision(row({}), 1 + 3 * 60 * 60_000)).toBe(true);
    expect(isStaleDecision(row({ messages_since: 40 }), 1 + 60_000)).toBe(true);
    expect(isStaleDecision(row({ status: "answered", messages_since: 40 }), 1 + 3 * 60 * 60_000)).toBe(false);
  });

  it("formats ages coarsely", () => {
    expect(formatAge(20_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5m ago");
    expect(formatAge(3 * 60 * 60_000)).toBe("3h ago");
    expect(formatAge(50 * 60 * 60_000)).toBe("2d ago");
  });
});
