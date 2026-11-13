import { describe, expect, test } from "bun:test";
import { formatContextResults, formatSearchResults, formatSearchSessions, searchQualifiers, sessionFacts } from "./formatter";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const row = (over: Record<string, unknown> = {}) => ({
  id: "jx7abcd",
  title: "Zebra migration",
  project_path: "/r",
  updated_at: new Date().toISOString(),
  message_count: 12,
  work_state: "idle",
  is_completed: true,
  matches: [{ line: 1, role: "assistant", content: "zebra migration done", timestamp: new Date().toISOString() }],
  context: [],
  ...over,
});

describe("search qualifiers come before the rows", () => {
  test("partial: names the words no session holds, before Found", () => {
    const out = strip(formatSearchResults({
      total_matches: 1,
      conversations: [row({ missing_terms: ["quokka"] })],
      partial: { words: ["zebra", "migration", "quokka"], missing_everywhere: ["quokka"] },
    } as any));
    const partialAt = out.indexOf('Partial: no session holds every word of "zebra migration quokka"; "quokka" found nowhere searched');
    expect(partialAt).toBeGreaterThan(-1);
    expect(partialAt).toBeLessThan(out.indexOf("Found 1 match"));
    expect(out).toContain("lacks quokka");
  });

  test("partial with every word held somewhere points at the rows", () => {
    expect(strip(searchQualifiers({ partial: { words: ["a1", "b2", "c3"], missing_everywhere: [] } })[0]))
      .toBe('Partial: no session holds every word of "a1 b2 c3"; each row names what it lacks');
  });

  test("excluded self is said even when no rows remain", () => {
    const out = strip(formatSearchResults({ total_matches: 0, conversations: [], excluded_self: { id: "jx73zpy", sessions: 2 } } as any));
    expect(out).toContain("Left out 2 matching sessions: this one (jx73zpy) and its workers. --include-self keeps them.");
    expect(out.indexOf("Left out")).toBeLessThan(out.indexOf("No matches found."));
    const sessions = strip(formatSearchSessions({ total_matches: 0, conversations: [], excluded_self: { id: "jx73zpy", sessions: 1 } } as any));
    expect(sessions.split("\n")[0]).toBe("Left out 1 matching session: this one (jx73zpy) and its workers. --include-self keeps them.");
  });

  test("nothing to qualify prints nothing extra", () => {
    const out = strip(formatSearchResults({ total_matches: 1, conversations: [row()] } as any));
    expect(out).not.toContain("Partial:");
    expect(out).not.toContain("Left out");
  });
});

describe("hit facts", () => {
  test("commits, PRs and failed tools in key=value form, omitted when zero", () => {
    expect(sessionFacts({ commits: 3, prs: [490, 482], failed_tools: 4 })).toBe("commits=3 pr=#490,#482 failed=4");
    expect(sessionFacts({ commits: 100, commits_capped: true })).toBe("commits=100+");
    expect(sessionFacts({})).toBe("");
  });

  test("they ride the session line of search, -l and context", () => {
    const facts = { commits: 2, prs: [7], failed_tools: 1 };
    const full = strip(formatSearchResults({ total_matches: 1, conversations: [row(facts)] } as any));
    expect(full).toMatch(/jx7abcd \| .*ended \| .* \| 12 msgs \| .* \| commits=2 pr=#7 failed=1/);
    const list = strip(formatSearchSessions({ total_matches: 1, conversations: [row(facts)] } as any));
    expect(list).toContain("commits=2 pr=#7 failed=1");
    const ctx = strip(formatContextResults({
      query: "zebra",
      sessions: [{ ...row(), match_type: "text", facts: sessionFacts(facts) } as any],
      related_files: [],
      qualifiers: searchQualifiers({ excluded_self: { sessions: 1 } }),
    }));
    expect(ctx).toContain('"Zebra migration" commits=2 pr=#7 failed=1');
    expect(ctx.split("\n")[1]).toBe("Left out 1 matching session: this one and its workers. --include-self keeps them.");
  });
});
