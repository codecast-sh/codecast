import { describe, expect, it } from "bun:test";
import { tabTitle } from "../tabTitle";

// ct-97018: a coordinator and the worker it spawned were both titled "Apple
// Calendar sync", and the tab and window title named them identically.
const coordinatorId = "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const workerId = "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const sessions = {
  [coordinatorId]: { _id: coordinatorId, title: "Apple Calendar sync", agent_type: "claude_code", status: "active", updated_at: 1 },
  [workerId]: { _id: workerId, title: "Apple Calendar sync", agent_type: "claude_code", status: "active", updated_at: 2, parent_conversation_id: coordinatorId, is_subagent: false },
};
const tabFor = (sessionId: string) => ({ id: sessionId, path: `/inbox?s=${sessionId}`, sessionId, title: "", createdAt: 0 }) as any;

describe("sessions that share a title", () => {
  it("get different tab and window titles", () => {
    const a = tabTitle(tabFor(coordinatorId), sessions, {});
    const b = tabTitle(tabFor(workerId), sessions, {});
    expect(a).not.toBe(b);
  });

  it("leave a uniquely titled session's title unchanged", () => {
    const only = { [coordinatorId]: sessions[coordinatorId] };
    expect(tabTitle(tabFor(coordinatorId), only, {})).toBe("Apple Calendar sync");
  });
});
