import { describe, expect, it } from "bun:test";
import { pathLabel, inboxTabSessionId } from "../pathLabel";

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
});

describe("tabTitle — a stamped inbox tab is titled by its session", () => {
  const SID = "jx70102ex3nwd6g2j9gn8fzwe58ahmz0";
  const sessions = { [SID]: { _id: SID, title: "Broker outreach pipeline monitor" } };

  it("resolves the session title from the ?s= param", async () => {
    const { tabTitle } = await import("../../components/TabBar");
    const tab = { id: "t1", title: "Inbox", path: `/inbox?s=${SID}`, createdAt: 1 };
    expect(tabTitle(tab as any, sessions, {})).toBe("Broker outreach pipeline monitor");
  });

  it("never shows a stored raw-path title from before the pathLabel fix", async () => {
    const { tabTitle } = await import("../../components/TabBar");
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
