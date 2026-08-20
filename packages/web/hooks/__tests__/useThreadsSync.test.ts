import { describe, expect, it } from "bun:test";
import { threadInboxSig, threadRowInWorkspace } from "../useThreadsSync";
import { threadRowId } from "../../store/threadTypes";

// The workspace rule the page, the badge and the mark-all sweep share: a row
// belongs to the workspace on screen when its team_id equals the active team,
// with ABSENCE meaning the personal workspace on both sides.
describe("threadRowInWorkspace", () => {
  it("matches a team row to its team and a personal row to no team", () => {
    expect(threadRowInWorkspace({ team_id: "t1" }, "t1")).toBe(true);
    expect(threadRowInWorkspace({ team_id: "t1" }, "t2")).toBe(false);
    expect(threadRowInWorkspace({}, undefined)).toBe(true);
    expect(threadRowInWorkspace({ team_id: "t1" }, undefined)).toBe(false);
    expect(threadRowInWorkspace({}, "t1")).toBe(false);
  });
});

describe("threadInboxSig", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    _id: threadRowId("chat", "r1"),
    kind: "chat" as const,
    root_key: "r1",
    team_id: "t1",
    channel_id: "c1",
    last_activity_at: 10,
    last_read_at: 5,
    updated_at: 10,
    unread: 1,
    last_reply: { _id: "m1", created_at: 10, preview: "hi" },
    ...over,
  });

  it("wakes on the fields the page renders and stays quiet on the rest", () => {
    const a = threadInboxSig({ r: row() });
    expect(threadInboxSig({ r: row({ updated_at: 99 }) })).toBe(a);
    expect(threadInboxSig({ r: row({ unread: 0 }) })).not.toBe(a);
    expect(threadInboxSig({ r: row({ last_read_at: 10 }) })).not.toBe(a);
    expect(threadInboxSig({ r: row({ team_id: undefined }) })).not.toBe(a);
    expect(threadInboxSig({ r: row({ last_reply: { _id: "m2", created_at: 11, preview: "yo" } }) })).not.toBe(a);
  });
});
