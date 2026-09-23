// The reduction a stranger reads a session through, and the pure helpers
// around it. The rule itself — pinned AND tokened — belongs to privacy.ts;
// this pins what each side of it looks like once it reaches a public page.
import { describe, expect, test } from "bun:test";
import { anonymousSessionTitle, isSessionOnRepoNow, pathInRepository, publicSessionRef, sessionInRepository } from "./repoSessions";

const SEP_20_2026 = Date.UTC(2026, 8, 20, 15, 0, 0);
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

const conv = (over: Record<string, unknown> = {}) => ({
  _id: "c1" as any,
  title: "Fix the auth race",
  short_id: "jx7abcd",
  started_at: SEP_20_2026,
  ...over,
});

describe("anonymousSessionTitle", () => {
  test("names the owner's first name and the day, without the year when it is this year", () => {
    expect(anonymousSessionTitle("Ashot Petrosian", SEP_20_2026, NOW)).toBe("Ashot's session on Sep 20");
  });

  test("spells the year out for an older session", () => {
    expect(anonymousSessionTitle("Ashot", Date.UTC(2025, 0, 3), NOW)).toBe("Ashot's session on Jan 3, 2025");
  });

  test("has a label even when the owner has no name", () => {
    expect(anonymousSessionTitle(undefined, SEP_20_2026, NOW)).toBe("A session on Sep 20");
  });
});

describe("publicSessionRef", () => {
  const owner = { name: "Ashot Petrosian", image: "https://avatars/ashot.png" };

  test("a pinned, tokened session keeps its title, short id and share token", () => {
    expect(publicSessionRef(conv({ profile_pinned_at: NOW, share_token: "tok" }), owner, NOW)).toEqual({
      conversation_id: "c1",
      title: "Fix the auth race",
      public: true,
      share_token: "tok",
      short_id: "jx7abcd",
      author_name: owner.name,
      author_image: owner.image,
    });
  });

  test("a session that is not public is reduced to who and when, and carries no token or short id", () => {
    const ref = publicSessionRef(conv({ share_token: "tok" }), owner, NOW);
    expect(ref).toEqual({
      conversation_id: "c1",
      title: "Ashot's session on Sep 20",
      public: false,
      author_name: owner.name,
      author_image: owner.image,
    });
    // A pin with no token is not public either: both halves are required.
    expect(publicSessionRef(conv({ profile_pinned_at: NOW }), owner, NOW).public).toBe(false);
  });
});

describe("pathInRepository", () => {
  test("strips the checkout root and nothing else", () => {
    expect(pathInRepository("/Users/a/src/codecast/packages/web/app.tsx", "/Users/a/src/codecast")).toBe("packages/web/app.tsx");
    expect(pathInRepository("/Users/a/src/codecast/packages/web/app.tsx", "/Users/a/src/codecast/")).toBe("packages/web/app.tsx");
  });

  test("a file outside the checkout, or a session with no root, has no repository path", () => {
    expect(pathInRepository("/Users/a/src/other/x.ts", "/Users/a/src/codecast")).toBeNull();
    expect(pathInRepository("/Users/a/src/codecast-two/x.ts", "/Users/a/src/codecast")).toBeNull();
    expect(pathInRepository("/Users/a/src/codecast/x.ts", undefined)).toBeNull();
  });
});

describe("sessionInRepository", () => {
  const roots = new Set(["/Users/a/src/codecast"]);

  test("a recorded remote decides, whichever way it is spelled", () => {
    expect(sessionInRepository({ git_remote_url: "git@github.com:Codecast-sh/Codecast.git" }, "codecast-sh/codecast", roots)).toBe(true);
    expect(sessionInRepository({ git_remote_url: "https://github.com/other/repo", git_root: "/Users/a/src/codecast" }, "codecast-sh/codecast", roots)).toBe(false);
  });

  test("a session that never recorded a remote belongs by its checkout", () => {
    expect(sessionInRepository({ git_root: "/Users/a/src/codecast/" }, "codecast-sh/codecast", roots)).toBe(true);
    expect(sessionInRepository({ git_root: "/Users/a/src/elsewhere" }, "codecast-sh/codecast", roots)).toBe(false);
    expect(sessionInRepository({}, "codecast-sh/codecast", roots)).toBe(false);
  });
});

describe("isSessionOnRepoNow", () => {
  const now = 1_000_000_000;
  const fresh = { text: "editing chat.ts", tool: "Edit", at: now - 60_000 };
  test("a live session is an active, top level row whose newest tool call is fresh", () => {
    expect(isSessionOnRepoNow({ activity: fresh, status: "active" }, now)).toBe(true);
  });
  test("a tool call older than the freshness window no longer counts", () => {
    expect(isSessionOnRepoNow({ activity: { ...fresh, at: now - 6 * 60_000 }, status: "active" }, now)).toBe(false);
  });
  test("no activity, a completed row, a killed row and a subagent never count", () => {
    expect(isSessionOnRepoNow({ status: "active" }, now)).toBe(false);
    expect(isSessionOnRepoNow({ activity: fresh, status: "completed" }, now)).toBe(false);
    expect(isSessionOnRepoNow({ activity: fresh, status: "active", inbox_killed_at: now - 1 }, now)).toBe(false);
    expect(isSessionOnRepoNow({ activity: fresh, status: "active", parent_conversation_id: "x" as any }, now)).toBe(false);
  });
});
