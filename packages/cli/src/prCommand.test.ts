import { describe, expect, test } from "bun:test";
import {
  buildPrLocator,
  diffPrRows,
  formatPrTable,
  formatChecks,
  formatReviews,
  convexUrlFromSiteUrl,
  splitCommentArgs,
  agePhrase,
  formatAge,
  formatPrShow,
  formatPrThreads,
  threadLocation,
  type PrWatchRow,
} from "./prCommand";
import { parsePrRef, extractRepoFromRemoteUrl } from "@codecast/shared/contracts";

const LOCAL = { session: "jx7c6zk", repository: "codecast-sh/codecast", branch: "fix-auth" };

describe("pull request references", () => {
  test("a bare number takes the repository from the checkout", () => {
    expect(buildPrLocator("123", LOCAL)).toEqual({
      repository: "codecast-sh/codecast",
      number: 123,
    });
  });

  test("a hash in front of the number is the same reference", () => {
    expect(buildPrLocator("#123", LOCAL).number).toBe(123);
  });

  test("owner and name with a number override the checkout", () => {
    expect(buildPrLocator("acme/widgets#7", LOCAL)).toEqual({
      repository: "acme/widgets",
      number: 7,
    });
  });

  test("a GitHub URL resolves, with or without a trailing path", () => {
    expect(parsePrRef("https://github.com/acme/widgets/pull/42")).toEqual({
      repository: "acme/widgets",
      number: 42,
    });
    expect(parsePrRef("https://github.com/acme/widgets/pull/42/files#discussion_r1")).toEqual({
      repository: "acme/widgets",
      number: 42,
    });
  });

  test("a codecast page URL resolves", () => {
    expect(parsePrRef("https://codecast.sh/pr/acme/widgets/9")).toEqual({
      repository: "acme/widgets",
      number: 9,
    });
  });

  test("no reference falls back to the session and the branch", () => {
    expect(buildPrLocator(undefined, LOCAL)).toEqual({
      repository: "codecast-sh/codecast",
      session: "jx7c6zk",
      branch: "fix-auth",
    });
  });

  test("outside a session the branch alone still locates a PR", () => {
    expect(buildPrLocator(undefined, { ...LOCAL, session: null })).toEqual({
      repository: "codecast-sh/codecast",
      branch: "fix-auth",
    });
  });

  test("a repository with no number keeps the session and branch fallbacks", () => {
    expect(buildPrLocator("acme/widgets", LOCAL)).toEqual({
      repository: "acme/widgets",
      session: "jx7c6zk",
      branch: "fix-auth",
    });
  });

  test("text that names no pull request fails at the shell", () => {
    expect(() => buildPrLocator("not a pr", LOCAL)).toThrow("does not name a pull request");
  });
});

describe("remote URLs", () => {
  test("every shape git writes yields owner/name", () => {
    expect(extractRepoFromRemoteUrl("git@github.com:codecast-sh/codecast.git")).toBe("codecast-sh/codecast");
    expect(extractRepoFromRemoteUrl("https://github.com/codecast-sh/codecast.git")).toBe("codecast-sh/codecast");
    expect(extractRepoFromRemoteUrl("https://github.com/codecast-sh/codecast")).toBe("codecast-sh/codecast");
    expect(extractRepoFromRemoteUrl("ssh://git@github.com/codecast-sh/codecast.git")).toBe("codecast-sh/codecast");
  });

  test("a remote that is not GitHub yields nothing", () => {
    expect(extractRepoFromRemoteUrl("git@gitlab.com:acme/widgets.git")).toBeNull();
    expect(extractRepoFromRemoteUrl("")).toBeNull();
  });
});

// ── watch ──

function row(overrides: Partial<PrWatchRow> = {}): PrWatchRow {
  return {
    id: "pr_1",
    repository: "acme/widgets",
    number: 7,
    title: "Fix the auth race",
    state: "open",
    shepherd_state: "ci_pending",
    checks_state: "pending",
    review_decision: "review_required",
    mergeable_state: "unstable",
    unresolved_review_count: 0,
    ...overrides,
  };
}

describe("watch diffing", () => {
  test("the first frame is silent", () => {
    expect(diffPrRows(null, [row()])).toEqual([]);
  });

  test("an unchanged frame prints nothing", () => {
    expect(diffPrRows([row()], [row()])).toEqual([]);
  });

  test("each changed field is its own line", () => {
    const events = diffPrRows([row()], [row({ shepherd_state: "ci_red", checks_state: "failure" })]);
    expect(events.map((e) => [e.field, e.from, e.to])).toEqual([
      ["shepherd_state", "ci_pending", "ci_red"],
      ["checks_state", "pending", "failure"],
    ]);
    expect(events.every((e) => e.event === "transition")).toBe(true);
  });

  test("open review comments count as a change", () => {
    const events = diffPrRows([row()], [row({ unresolved_review_count: 2 })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ field: "unresolved_review_count", from: "0", to: "2" });
  });

  test("a pull request entering the set is new, and leaving it is gone", () => {
    const other = row({ id: "pr_2", number: 8 });
    expect(diffPrRows([row()], [row(), other])).toEqual([
      {
        event: "new",
        id: "pr_2",
        repository: "acme/widgets",
        number: 8,
        title: "Fix the auth race",
        field: "state",
        from: null,
        to: "open",
      },
    ]);
    expect(diffPrRows([row(), other], [row()])).toEqual([
      {
        event: "gone",
        id: "pr_2",
        repository: "acme/widgets",
        number: 8,
        title: "Fix the auth race",
        field: "state",
        from: "open",
        to: null,
      },
    ]);
  });

  test("a merge shows up as both a state and a shepherd change", () => {
    const events = diffPrRows([row()], [row({ state: "merged", shepherd_state: "merged" })]);
    expect(events.map((e) => e.field)).toEqual(["state", "shepherd_state"]);
  });
});

// ── table ──

describe("the list table", () => {
  const rows = [
    {
      ...row(),
      head_ref: "fix-auth",
      base_ref: "main",
      checks_green: 3,
      checks_red: 1,
      checks_pending: 0,
      session_short_id: "jx7c6zk",
      shepherd_enabled: true,
      updated_at: Date.now() - 3 * 3_600_000,
    },
  ];

  test("one line per pull request, carrying its number, branch and session", () => {
    const table = formatPrTable(rows, Date.now());
    expect(table.split("\n")).toHaveLength(1);
    expect(table).toContain("#7");
    expect(table).toContain("Fix the auth race");
    expect(table).toContain("fix-auth");
    expect(table).toContain("main");
    expect(table).toContain("3 green");
    expect(table).toContain("1 red");
    expect(table).toContain("jx7c6zk");
    expect(table).toContain("3h");
  });

  test("an empty list says so instead of printing a blank block", () => {
    expect(formatPrTable([])).toContain("No pull requests");
  });

  test("checks and reviews compress to the words a person scans for", () => {
    expect(formatChecks({ checks_green: 4, checks_red: 0, checks_pending: 1 })).toBe("4 green 1 running");
    expect(formatChecks({ checks_green: 0, checks_red: 0, checks_pending: 0 })).toBe("");
    expect(formatReviews({ review_decision: "approved", unresolved_review_count: 0 })).toBe("approved");
    expect(formatReviews({ review_decision: "changes_requested", unresolved_review_count: 3 })).toBe("changes, 3 open");
    expect(formatReviews({ review_decision: null, unresolved_review_count: 0 })).toBe("");
  });
});

describe("the watch socket URL", () => {
  test("the site URL maps back to the websocket deployment", () => {
    expect(convexUrlFromSiteUrl("https://oval-cat-1.convex.site")).toBe("https://oval-cat-1.convex.cloud");
  });

  test("a self hosted deployment serves both from one origin", () => {
    expect(convexUrlFromSiteUrl("https://convex.codecast.sh")).toBe("https://convex.codecast.sh");
  });
});

describe("the comment arguments", () => {
  const readBody = () => "body from the heredoc";

  test("a reference and a body stay where they were typed", () => {
    expect(splitCommentArgs("123", "looks good", readBody)).toEqual({
      ref: "123",
      body: "looks good",
    });
  });

  test("one argument that names no pull request is the body", () => {
    expect(splitCommentArgs("looks good", undefined, readBody)).toEqual({
      ref: undefined,
      body: "looks good",
    });
  });

  test("one argument that names a pull request stays the reference", () => {
    expect(splitCommentArgs("acme/widgets#7", undefined, readBody)).toEqual({
      ref: "acme/widgets#7",
      body: undefined,
    });
  });

  test("a dash in the body slot reads stdin", () => {
    expect(splitCommentArgs("123", "-", readBody).body).toBe("body from the heredoc");
  });

  // `cast pr comment -` puts the dash in the reference slot, which the
  // program's stdin expansion skips, so it would otherwise post a hyphen.
  test("a dash alone reads stdin and leaves the reference to be inferred", () => {
    expect(splitCommentArgs("-", undefined, readBody)).toEqual({
      ref: undefined,
      body: "body from the heredoc",
    });
  });
});

describe("age as a phrase", () => {
  // The bug: formatAge answers "now" for a fresh row, which read as "now ago".
  test("a fresh row reads just now, never 'now ago'", () => {
    expect(agePhrase(0)).toBe("just now");
    expect(agePhrase(30_000)).toBe("just now");
    expect(agePhrase(30_000)).not.toContain("now ago");
  });

  test("anything older keeps the column wording and gains the suffix", () => {
    expect(agePhrase(5 * 60_000)).toBe("5m ago");
    expect(agePhrase(3 * 3600_000)).toBe("3h ago");
    expect(agePhrase(2 * 24 * 3600_000)).toBe("2d ago");
  });

  // Why this is not the shared contracts formatAgo, which stops at days.
  test("a pull request months old reads in months", () => {
    expect(agePhrase(75 * 24 * 3600_000)).toBe("2mo ago");
  });

  test("the table column still says now, where it is the right word", () => {
    expect(formatAge(0)).toBe("now");
  });

  test("show never prints the broken phrase for a row updated this minute", () => {
    const now = 1_000_000_000;
    const out = formatPrShow(
      { pull_request: { repository: "a/b", number: 1, state: "open", updated_at: now } },
      now,
    );
    expect(out).toContain("just now");
    expect(out).not.toContain("now ago");
  });
});

describe("review threads", () => {
  const threads = [
    { short_id: "aaaa0001", file_path: "src/auth.ts", line_number: 12, author: "reviewer", resolved: false, first_line: "This leaks a handle" },
    { short_id: "aaaa0002", file_path: null, line_number: null, author: "jx7mine", resolved: true, first_line: "Fixed" },
  ];

  test("a thread on a line reads as file:line", () => {
    expect(threadLocation(threads[0])).toBe("src/auth.ts:12");
  });

  test("a thread on the conversation has no location", () => {
    expect(threadLocation(threads[1])).toBe("");
    expect(threadLocation({ short_id: "x", file_path: "a.ts" })).toBe("a.ts");
  });

  test("the table leads with the id the next command takes", () => {
    // Colours are off when the output is not a terminal, so compare the text.
    const plain = (t: string) => t.replace(/\u001b\[[0-9;]*m/g, "");
    const out = formatPrThreads(threads);
    expect(plain(out).split("\n")[0].startsWith("aaaa0001")).toBe(true);
    expect(out).toContain("src/auth.ts:12");
    expect(out).toContain("reviewer");
    expect(out).toContain("This leaks a handle");
  });

  test("an author we do not know still reads as somebody", () => {
    expect(formatPrThreads([{ short_id: "a", first_line: "hi" }])).toContain("someone");
  });

  test("no open threads says so instead of printing a blank block", () => {
    expect(formatPrThreads([])).toContain("No open review threads");
  });
});
