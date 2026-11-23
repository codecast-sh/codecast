// The checkout whose own flows the Ship picker reads (hooks/useRepoFlows.ts). A session's origin remote comes from
// the conversation row when the sessions row lacks it (872 of 1,817 sessions rows in one live store on 2026-11-22,
// a union-mobile session among them, though INBOX_ROW_FIELDS names the field).
import { describe, expect, test } from "bun:test";
import { checkoutRow, repositoryOfRemote, sessionRemoteOf, sessionRootOf } from "../useRepoFlows";

describe("a session's repository for the Ship picker", () => {
  test("a sessions row without a remote falls through to the conversation row", () => {
    const s = { sessions: { a: { git_root: "/x/union-mobile" } }, conversations: { a: { git_remote_url: "https://github.com/Union-AI/union-mobile.git" } } };
    expect(sessionRemoteOf(s, "a")).toBe("https://github.com/Union-AI/union-mobile.git");
    expect(repositoryOfRemote(sessionRemoteOf(s, "a"))?.toLowerCase()).toBe("union-ai/union-mobile");
  });

  test("the sessions row's own remote wins, and a session with none has no repository", () => {
    expect(sessionRemoteOf({ sessions: { a: { git_remote_url: "git@github.com:a/b.git" } }, conversations: { a: { git_remote_url: "git@github.com:c/d.git" } } }, "a")).toBe("git@github.com:a/b.git");
    expect(sessionRemoteOf({ sessions: {}, conversations: {} }, "a")).toBeNull();
    expect(repositoryOfRemote(null)).toBeNull();
  });
});

describe("the checkout whose flows the Ship picker shows", () => {
  const row = (root: string, label: string, updated_at: number) => ({
    _id: root, root, repository: "union-ai/union-mobile", updated_at,
    flows: [{ slug: "change", name: "change", kind: "line" as const, label, description: null, takes: ["branch"], nodes: [], edges: [] }],
  });

  test("a session reads its own checkout's report, not a newer one from another worktree", () => {
    const rows = [row("/um", "Main", 1), row("/um-old-branch", "Old branch", 2)];
    expect(checkoutRow(rows, "/um")?.flows[0].label).toBe("Main");
    expect(sessionRootOf({ sessions: { a: { git_root: "/um" } } }, "a")).toBe("/um");
  });

  test("a checkout that reported no flows shows none, not another worktree's", () => {
    const rows = [row("/um", "Main", 2), { ...row("/um-no-flows", "", 1), flows: [] }];
    expect(checkoutRow(rows, "/um-no-flows")?.flows).toEqual([]);
  });

  test("a checkout that never reported falls back to its repository's newest report", () => {
    const rows = [row("/um", "Main", 1), row("/um-wt", "Newer", 2)];
    expect(checkoutRow(rows, "/um-unreported")?.flows[0].label).toBe("Newer");
    expect(checkoutRow([], "/um")).toBeNull();
  });
});
