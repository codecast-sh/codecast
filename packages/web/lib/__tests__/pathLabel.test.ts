import { describe, expect, it } from "bun:test";
import { pathLabel, inboxTabSessionId, urlSessionId, tabNeedsUrlRestore } from "../pathLabel";

// A tab is labeled by its ROUTE, never its query string. The regression here:
// stampedTabPath normalizes a conversation tab to /inbox?s=<id>, and the raw
// "inbox?s=jx7…" string leaked into tab titles because pathLabel matched the
// full path (query included) against its segment table and fell through to
// the last path segment.
describe("pathLabel — query strings never leak into labels", () => {
  it("labels a stamped inbox deep link as Inbox", () => {
    expect(pathLabel("/inbox?s=jx77e151jzzb8jnk1234567890abcdef")).toBe("Inbox");
  });

  it("ignores hash fragments too", () => {
    expect(pathLabel("/feed#top")).toBe("Feed");
  });

  it("labels detail routes with a query by their surface", () => {
    expect(pathLabel("/tasks/ct-123?focus=1")).toBe("Task");
    expect(pathLabel("/chat/chan123?x=1")).toBe("Chat");
  });

  it("still titles a Files tab by the open file from its query", () => {
    expect(pathLabel("/files?f=notes%2Ftodo.md")).toBe("todo");
  });

  it("keeps plain segment labels working", () => {
    expect(pathLabel("/inbox")).toBe("Inbox");
    expect(pathLabel("/plans")).toBe("Plans");
  });

  it("labels the Threads page and its pre-move /chat/threads alias alike", () => {
    expect(pathLabel("/threads")).toBe("Threads");
    expect(pathLabel("/threads?type=chat")).toBe("Threads");
    expect(pathLabel("/chat/threads")).toBe("Threads");
    expect(pathLabel("/chat/threads?m=abc")).toBe("Threads");
  });
});

describe("tabTitle — a stamped inbox tab is titled by its session", () => {
  const SID = "jx70102ex3nwd6g2j9gn8fzwe58ahmz0";
  const sessions = { [SID]: { _id: SID, title: "Broker outreach pipeline monitor" } };

  it("resolves the session title from the ?s= param", async () => {
    const { tabTitle } = await import("../tabTitle");
    const tab = { id: "t1", title: "Inbox", path: `/inbox?s=${SID}`, createdAt: 1 };
    expect(tabTitle(tab as any, sessions, {})).toBe("Broker outreach pipeline monitor");
  });

  it("never shows a stored raw-path title from before the pathLabel fix", async () => {
    const { tabTitle } = await import("../tabTitle");
    const tab = { id: "t1", title: "inbox?s=jx77e151jzzb8jn", path: "/inbox?s=unknownsession", createdAt: 1 };
    expect(tabTitle(tab as any, {}, {})).toBe("Inbox");
  });
});

describe("inboxTabSessionId — the session a stamped inbox tab is pinned to", () => {
  it("extracts the ?s= session id", () => {
    expect(inboxTabSessionId("/inbox?s=jx77e151")).toBe("jx77e151");
  });

  it("returns null off the inbox or without the param", () => {
    expect(inboxTabSessionId("/inbox")).toBeNull();
    expect(inboxTabSessionId("/chat?s=x")).toBeNull();
  });
});

// Back/forward across inbox session selects depends on two URL spellings of
// the same content staying equivalent: the inbox canonicalizes to
// /conversation/<id> (and pushes a history entry per select) while its tab
// stores /inbox?s=<id>. The regression: TabPane's URL-restore effect treated
// the canonical spelling as drift and replaceState'd it away, so every select
// overwrote its own history entry and Back jumped straight to the boot session.
describe("urlSessionId — the session a live URL shows, either spelling", () => {
  it("reads the canonical conversation path", () => {
    expect(urlSessionId("/conversation/jx7abc", "")).toBe("jx7abc");
  });

  it("reads the inbox deep-link param", () => {
    expect(urlSessionId("/inbox", "?s=jx7abc")).toBe("jx7abc");
  });

  it("shows no session on the bare inbox or other routes", () => {
    expect(urlSessionId("/inbox", "")).toBeNull();
    expect(urlSessionId("/tasks", "?s=jx7abc")).toBeNull();
  });
});

describe("tabNeedsUrlRestore — inbox/conversation spellings are the same content", () => {
  it("stands down when the live URL is the tab's session in canonical spelling", () => {
    expect(tabNeedsUrlRestore("/conversation/jx7abc", "/inbox?s=jx7abc")).toBe(false);
  });

  it("stands down when the live URL already matches the tab's route", () => {
    expect(tabNeedsUrlRestore("/inbox", "/inbox?s=jx7abc")).toBe(false);
    expect(tabNeedsUrlRestore("/tasks", "/tasks?focus=1")).toBe(false);
  });

  it("restores when the live URL shows a different session than the tab holds", () => {
    expect(tabNeedsUrlRestore("/conversation/jx7abc", "/inbox?s=jx7zzz")).toBe(true);
  });

  it("restores when the live URL belongs to another surface entirely", () => {
    expect(tabNeedsUrlRestore("/tasks", "/inbox?s=jx7abc")).toBe(true);
    expect(tabNeedsUrlRestore("/conversation/jx7abc", "/tasks")).toBe(true);
  });
});

describe("pathLabel for the repository pages", () => {
  it("names the repository index", () => {
    expect(pathLabel("/repo")).toBe("Repositories");
  });

  it("names a repository by its own name, not its owner", () => {
    expect(pathLabel("/repo/codecast-sh/codecast")).toBe("codecast");
    expect(pathLabel("/repo/codecast-sh/codecast?branch=main")).toBe("codecast");
  });

  it("names a file or directory by what the query says is open", () => {
    expect(pathLabel("/repo/o/n/blob/main?path=packages%2Fweb%2Flib%2FcodeLanguage.ts")).toBe(
      "codeLanguage.ts",
    );
    expect(pathLabel("/repo/o/n/tree/main?path=packages%2Fweb")).toBe("web");
    // A tree at the root names no path, so the repository is the honest answer.
    expect(pathLabel("/repo/o/n/tree/main")).toBe("n");
  });

  it("shortens a commit sha instead of showing all forty characters", () => {
    expect(pathLabel("/commit/o/n/034e8d4c8cf2749a7d14fe6a39d8ec6fb471f21c")).toBe("034e8d4");
  });

  it("names a pull request by its number", () => {
    expect(pathLabel("/pr/codecast-sh/shepherd-lab/2")).toBe("PR #2");
  });
});
