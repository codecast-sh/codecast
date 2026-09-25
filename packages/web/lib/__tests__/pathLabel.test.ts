import { describe, expect, it } from "bun:test";
import { conversationTabPath, deepLinkSessionId, pathLabel, inboxTabSessionId, poppedTabPath, urlSessionId, tabNeedsUrlRestore } from "../pathLabel";

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
    expect(pathLabel("/decisions/sd-28")).toBe("Decision sd-28");
    expect(pathLabel("/decisions/stacks/ds-3")).toBe("Stack ds-3");
    expect(pathLabel("/org?proposal=op-7")).toBe("Proposal op-7");
    expect(pathLabel("/org?proposal=nope")).toBe("Org");
    expect(pathLabel("/org")).toBe("Org");
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

describe("conversationTabPath", () => {
  it("routes a plain conversation reload straight through the cached inbox", () => {
    expect(conversationTabPath("/conversation/jx77e151jzzb8jnk1234567890abcdef")).toBe(
      "/inbox?s=jx77e151jzzb8jnk1234567890abcdef",
    );
  });

  it("keeps a reference that is not a full id on the route, whose resolver finds the session", () => {
    // The inbox reads ?s= as a Convex id: a short id there selected nothing and
    // the view fell to the top session (the published-page session chip).
    expect(conversationTabPath("/conversation/jx7etg8")).toBe("/conversation/jx7etg8");
    expect(conversationTabPath("/conversation/3f2c9a1e-7b1d-4c55-9a0e-1c2d3e4f5a6b")).toBe(
      "/conversation/3f2c9a1e-7b1d-4c55-9a0e-1c2d3e4f5a6b",
    );
  });

  it("preserves conversation URLs whose query must be resolved by the route", () => {
    expect(conversationTabPath("/conversation/id?share=token")).toBe("/conversation/id?share=token");
    expect(conversationTabPath("/conversation/id?prefill=hello")).toBe("/conversation/id?prefill=hello");
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
    expect(urlSessionId("/conversation/jx77e151jzzb8jnk1234567890abcdef", "")).toBe("jx77e151jzzb8jnk1234567890abcdef");
  });

  it("shows no session for a reference the route has not resolved yet", () => {
    // A short id or a session UUID names no row until resolveConversation
    // answers, so the URL shows no session the inbox could have selected.
    expect(urlSessionId("/conversation/jx7etg8", "")).toBeNull();
  });

  it("reads the inbox deep-link param", () => {
    expect(urlSessionId("/inbox", "?s=jx77e151jzzb8jnk1234567890abcdef")).toBe("jx77e151jzzb8jnk1234567890abcdef");
  });

  it("shows no session on the bare inbox or other routes", () => {
    expect(urlSessionId("/inbox", "")).toBeNull();
    expect(urlSessionId("/tasks", "?s=jx77e151jzzb8jnk1234567890abcdef")).toBeNull();
  });
});

describe("tabNeedsUrlRestore — inbox/conversation spellings are the same content", () => {
  it("stands down when the live URL is the tab's session in canonical spelling", () => {
    expect(tabNeedsUrlRestore("/conversation/jx77e151jzzb8jnk1234567890abcdef", "/inbox?s=jx77e151jzzb8jnk1234567890abcdef")).toBe(false);
  });

  it("stands down when the live URL already matches the tab's route", () => {
    expect(tabNeedsUrlRestore("/inbox", "/inbox?s=jx77e151jzzb8jnk1234567890abcdef")).toBe(false);
    expect(tabNeedsUrlRestore("/tasks", "/tasks?focus=1")).toBe(false);
  });

  it("restores when the live URL shows a different session than the tab holds", () => {
    expect(tabNeedsUrlRestore("/conversation/jx77e151jzzb8jnk1234567890abcdef", "/inbox?s=jx7zzz51jzzb8jnk1234567890abcdef")).toBe(true);
  });

  it("restores when the live URL belongs to another surface entirely", () => {
    expect(tabNeedsUrlRestore("/tasks", "/inbox?s=jx77e151jzzb8jnk1234567890abcdef")).toBe(true);
    expect(tabNeedsUrlRestore("/conversation/jx77e151jzzb8jnk1234567890abcdef", "/tasks")).toBe(true);
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

  it("titles a repository tab by the page it is on", () => {
    expect(pathLabel("/repo/o/n/commits/main")).toBe("Commits");
    expect(pathLabel("/repo/o/n/compare/main...topic")).toBe("Compare");
    expect(pathLabel("/repo/o/n/branches")).toBe("Branches");
    expect(pathLabel("/repo/o/n/tags")).toBe("Tags");
    expect(pathLabel("/repo/o/n/pulls")).toBe("Pull requests");
    expect(pathLabel("/repo/o/n/search?q=useRepoFamily")).toBe("Search");
    // A file history is titled by the file, like a blob tab.
    expect(pathLabel("/repo/o/n/commits/main?path=packages%2Fweb%2Flib%2FrepoView.ts")).toBe(
      "repoView.ts",
    );
  });

  it("shortens a commit sha instead of showing all forty characters", () => {
    expect(pathLabel("/commit/o/n/034e8d4c8cf2749a7d14fe6a39d8ec6fb471f21c")).toBe("034e8d4");
  });

  it("names a pull request by its number", () => {
    expect(pathLabel("/pr/codecast-sh/shepherd-lab/2")).toBe("PR #2");
  });
});

// Back from a page opened out of a conversation (session → /tasks → back).
// The popped entry is the inbox's own `{ inboxId }` select, but the inbox
// pane is unmounted once the tab shows another page, so nobody re-selected
// the session: the URL moved to /conversation/<id> while the task page
// stayed on screen. The tab must be re-pointed at the inbox spelling.
describe("poppedTabPath — traversing onto a session entry from another page", () => {
  const A = "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("re-points a tab on another page at the inbox spelling of the session", () => {
    expect(poppedTabPath({ inboxId: A }, `/conversation/${A}`, "", ["/tasks"])).toBe(`/inbox?s=${A}`);
    expect(poppedTabPath({ inboxId: A }, `/conversation/${A}`, "", ["/tasks/ct-1"])).toBe(`/inbox?s=${A}`);
  });

  it("stands down when the inbox pane is mounted — its own listener selects the session", () => {
    expect(poppedTabPath({ inboxId: A }, `/conversation/${A}`, "", ["/inbox"])).toBeNull();
    expect(poppedTabPath({ inboxId: A }, `/conversation/${A}`, "", [`/inbox?s=${A}`])).toBeNull();
  });

  it("stands down when a split stage holds an inbox pane beside the focused page", () => {
    expect(poppedTabPath({ inboxId: A }, `/conversation/${A}`, "", ["/tasks/ct-1", `/inbox?s=${A}`])).toBeNull();
  });

  it("mirrors a tab navigation entry as-is", () => {
    expect(poppedTabPath({ tabNav: true } as any, "/tasks/ct-1", "", ["/inbox?s=" + A])).toBe("/tasks/ct-1");
    expect(poppedTabPath(null, "/files", "?f=a.md", ["/tasks"])).toBe("/files?f=a.md");
  });
});

describe("deepLinkSessionId — what a desktop deep link selects in place", () => {
  const id = "jx7etg8nap9wz7zt0npak20tax8f3k33";
  it("selects a full id in either spelling, anchors and all", () => {
    expect(deepLinkSessionId(`/conversation/${id}`)).toBe(id);
    expect(deepLinkSessionId(`/conversation/${id}#msg-1`)).toBe(id);
    expect(deepLinkSessionId(`/inbox?s=${id}`)).toBe(id);
  });
  it("sends a short id, a session UUID or a share link to the route instead", () => {
    // A browser handed /conversation/jx7etg8 to the desktop app, which selected
    // "jx7etg8" as an id: nothing, and the view stayed wherever it was.
    expect(deepLinkSessionId("/conversation/jx7etg8")).toBeNull();
    expect(deepLinkSessionId("/inbox?s=jx7etg8")).toBeNull();
    expect(deepLinkSessionId("/conversation/3f2c9a1e-7b1d-4c55-9a0e-1c2d3e4f5a6b")).toBeNull();
    expect(deepLinkSessionId(`/conversation/${id}?share=tok`)).toBeNull();
  });
});
