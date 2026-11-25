// The linked session's rules: a pick wins, then the conversation beside Files on
// the stage, then the most recently active session working in the folder.
import { describe, expect, it } from "bun:test";
import { besideSessionId, candidateSessions, pathWithin, resolveLink, sessionColor, sessionOfPanePath, sessionShortTitle, steerable, type AgentSessionRow } from "../sessions";

const row = (id: string, over: Partial<AgentSessionRow> = {}): AgentSessionRow => ({ _id: id, agent_type: "claude_code", updated_at: 0, project_path: "/r/app", ...over });

describe("pathWithin", () => {
  it("matches the folder and what is under it, never a sibling with the same prefix", () => {
    expect(pathWithin("/r/app", "/r/app")).toBe(true);
    expect(pathWithin("/r/app/src/x.ts", "/r/app/")).toBe(true);
    expect(pathWithin("/r/app2/x.ts", "/r/app")).toBe(false);
    expect(pathWithin("/anything", "/")).toBe(true);
    expect(pathWithin(null, "/r")).toBe(false);
  });
});

describe("candidateSessions", () => {
  it("keeps the viewer's sessions whose project or checkout holds the vault, newest first", () => {
    const rows = [
      row("old", { updated_at: 1 }),
      row("new", { updated_at: 9 }),
      row("viaGitRoot", { project_path: "/r/app/packages/web", git_root: "/r/app", updated_at: 5 }),
      row("elsewhere", { project_path: "/r/other", updated_at: 99 }),
      row("teammate", { user_id: "u2", updated_at: 50 }),
      row("sub", { is_subagent: true, updated_at: 60 }),
      row("killed", { inbox_killed_at: 1, updated_at: 70 }),
      row("notMine", { owned_by_me: false, updated_at: 80 }),
    ];
    expect(candidateSessions(rows, "/r/app", "u1").map((r) => r._id)).toEqual(["new", "viaGitRoot", "old"]);
  });

  it("a vault inside the session's folder counts; a session in a subfolder of the vault does not by project alone", () => {
    expect(candidateSessions([row("a")], "/r/app/src", null).map((r) => r._id)).toEqual(["a"]);
    expect(candidateSessions([row("b", { project_path: "/r/app/src" })], "/r/app", null)).toEqual([]);
  });

  it("no vault root, no candidates", () => {
    expect(candidateSessions([row("a")], null, null)).toEqual([]);
  });

  it("steerable rejects a row owned by someone else", () => {
    expect(steerable(row("a", { user_id: "u2" }), "u1")).toBe(false);
    expect(steerable(row("a", { user_id: "u1" }), "u1")).toBe(true);
  });
});

describe("besideSessionId", () => {
  const split = (...paths: string[]) => ({ type: "split", children: paths.map((path) => ({ type: "leaf", path })) });

  it("reads the conversation sharing a tab with Files", () => {
    const tabs = [{ id: "t1", path: "/files", layout: split("/conversation/abc123", "/files?path=/r/app") }];
    expect(besideSessionId(tabs, "t1", null)).toBe("abc123");
  });

  it("prefers the active tab and reads the bare inbox as the focused conversation there only", () => {
    const tabs = [
      { id: "t1", path: "/files", layout: split("/conversation/other", "/files") },
      { id: "t2", path: "/inbox", layout: split("/inbox", "/vault") },
    ];
    expect(besideSessionId(tabs, "t2", "focused")).toBe("focused");
    expect(besideSessionId(tabs, "t1", "focused")).toBe("other");
  });

  it("Files alone, or a split without Files, links nothing", () => {
    expect(besideSessionId([{ id: "t", path: "/files", layout: { type: "leaf", path: "/files" } }], "t", "x")).toBeNull();
    expect(besideSessionId([{ id: "t", path: "/x", layout: split("/conversation/a", "/tasks") }], "t", null)).toBeNull();
  });

  it("parses pane paths", () => {
    expect(sessionOfPanePath("/inbox?s=zz", null)).toBe("zz");
    expect(sessionOfPanePath("/inbox", "cur")).toBe("cur");
    expect(sessionOfPanePath("/tasks", "cur")).toBeNull();
  });
});

describe("resolveLink", () => {
  const exists = (id: string) => id !== "gone";
  const candidates = [row("latest"), row("older")];

  it("a pick wins, then beside, then the latest in the folder, then none", () => {
    expect(resolveLink({ override: "mine", besideId: "b", candidates, exists })).toEqual({ sessionId: "mine", source: "picked" });
    expect(resolveLink({ override: undefined, besideId: "b", candidates, exists })).toEqual({ sessionId: "b", source: "beside" });
    expect(resolveLink({ override: undefined, besideId: null, candidates, exists })).toEqual({ sessionId: "latest", source: "folder" });
    expect(resolveLink({ override: undefined, besideId: null, candidates: [], exists })).toEqual({ sessionId: null, source: "none" });
  });

  it("an explicit None holds even with candidates; a pick or beside that no longer exists falls through", () => {
    expect(resolveLink({ override: "none", besideId: "b", candidates, exists })).toEqual({ sessionId: null, source: "none" });
    expect(resolveLink({ override: "gone", besideId: "gone", candidates, exists })).toEqual({ sessionId: "latest", source: "folder" });
  });
});

describe("faces", () => {
  it("short title prefers short_title, strips tags, truncates", () => {
    expect(sessionShortTitle({ short_title: "Fix auth", title: "long" })).toBe("Fix auth");
    expect(sessionShortTitle({ title: "<b>Bold</b>  title" })).toBe("Bold title");
    expect(sessionShortTitle({ title: "x".repeat(60) })).toHaveLength(48);
    expect(sessionShortTitle(null)).toBe("Untitled session");
  });

  it("color uses the session's own icon color, else a stable hue", () => {
    expect(sessionColor({ _id: "a", icon_color: "magenta" })).toBe("var(--sol-magenta)");
    expect(sessionColor({ _id: "a", icon_color: "#123456" })).toBe("#123456");
    expect(sessionColor("abc")).toBe(sessionColor({ _id: "abc" }));
    expect(sessionColor(null)).toBe("var(--sol-text-dim)");
  });
});
