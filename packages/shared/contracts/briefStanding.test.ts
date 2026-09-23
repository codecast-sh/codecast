import { describe, expect, test } from "bun:test";
import { noWordYet, parseStandingSection, standingLineAgeDays, standingLineFor, standingLineStale } from "./briefStanding";

// Where it stands (scopes-and-feed.md F5.2): one section in the brief, one
// line per project, the date the role wrote it at the end of the line.

const DAY = 86_400_000;

describe("parseStandingSection", () => {
  test("reads the lines under the heading, the project before the colon, the date at the end", () => {
    const brief = [
      "Calling: two markets filled",
      "Status: working",
      "",
      "## Where it stands",
      "- Union goals: two markets filled this week; the third waits on a lawyer. (2026-09-23)",
      "- **Growth** — not a line, no colon",
      "1. pj-abc Growth: no pages shipped since the redesign started; the copy is with Ada (2026-09-16)",
      "- Empty:",
      "",
      "## Goals: Ashot",
      "- Not standing: a goal",
    ].join("\n");
    const lines = parseStandingSection(brief);
    expect(lines.map((l) => l.project)).toEqual(["Union goals", "pj-abc Growth"]);
    expect(lines[0]).toMatchObject({ text: "two markets filled this week; the third waits on a lawyer.", written_on: "2026-09-23", written_at: Date.parse("2026-09-23T00:00:00Z") });
    expect(lines[1]).toMatchObject({ text: "no pages shipped since the redesign started; the copy is with Ada", written_on: "2026-09-16" });
  });

  test("a line with no date has no age; a bad date is kept as words", () => {
    const [a, b] = parseStandingSection("## Where it stands\n- Growth: waiting on the lawyer\n- Union: shipped (2026-13-45)");
    expect(a.written_at).toBeNull();
    expect(standingLineAgeDays(a, Date.now())).toBeNull();
    expect(b.text).toBe("shipped (2026-13-45)");
  });

  test("no section, no lines", () => {
    expect(parseStandingSection("Growth is steady\n## Goals: Ashot\n- Growth: not this")).toEqual([]);
    expect(parseStandingSection(null)).toEqual([]);
  });
});

describe("standingLineFor", () => {
  const lines = parseStandingSection("## Where it stands\n- Growth: fine (2026-09-01)\n- pj-xyz: stuck (2026-09-20)\n- Growth review: also a project");
  test("matches a project by title, whole and case blind", () => {
    expect(standingLineFor(lines, { title: "growth" })?.text).toBe("fine");
    expect(standingLineFor(lines, { title: "Growth review" })?.text).toBe("also a project");
    expect(standingLineFor(lines, { title: "Growth pages" })).toBeNull();
  });
  test("matches a project by short id", () => {
    expect(standingLineFor(lines, { title: "Something else", short_id: "pj-xyz" })?.text).toBe("stuck");
  });
  test("the words for a project with no line", () => {
    expect(noWordYet("calling")).toBe("no word from @calling yet");
  });
});

describe("age", () => {
  test("a line older than a week is stale; a fresh one is not", () => {
    const [line] = parseStandingSection("## Where it stands\n- Growth: fine (2026-09-01)");
    const at = Date.parse("2026-09-01T00:00:00Z");
    expect(standingLineStale(line, at + 6 * DAY)).toBe(false);
    expect(standingLineStale(line, at + 8 * DAY)).toBe(true);
    expect(standingLineAgeDays(line, at + 8 * DAY + 3600_000)).toBe(8);
  });
});
