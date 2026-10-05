import { describe, expect, it } from "bun:test";
import { useInboxStore } from "../../../store/inboxStore";
import { queryCollection } from "../host";

// A mod reads sessions with the inbox's own answers attached, so "waiting on
// me" is one where clause and never a re-derivation of inbox rules.
describe("session rows a mod reads", () => {
  it("carry state, mine, inbox and waiting_since", () => {
    const now = Date.now();
    useInboxStore.setState({
      currentUser: { _id: "u1", name: "Me" },
      sessions: {
        s1: { _id: "s1", session_id: "s1", user_id: "u1", title: "Mine, waiting", agent_type: "claude_code", message_count: 12, updated_at: now - 60_000, started_at: now - 3_600_000, turn_completed_at: now - 60_000, awaiting_input: true, is_idle: true, is_connected: true, status: "active" },
        s2: { _id: "s2", session_id: "s2", user_id: "u9", title: "Someone else's", agent_type: "claude_code", message_count: 3, updated_at: now - 30_000, status: "active" },
      },
    } as any);
    const rows = queryCollection("sessions", { fields: ["title", "state", "mine", "inbox", "waiting_since"] });
    const mine = rows.find((r) => r._id === "s1")!;
    const theirs = rows.find((r) => r._id === "s2")!;
    expect(mine.mine).toBe(true);
    expect(theirs.mine).toBe(false);
    expect(mine.state).toBe("needs_input");
    expect(mine.waiting_since).toBe(now - 60_000);
    expect("inbox" in mine).toBe(true);
    expect(theirs.inbox).toBe(null);
  });

  it("where takes a dotted path into a row", () => {
    useInboxStore.setState({ modObjects: { o1: { _id: "o1", prefix: "bug", fields: { severity: "p0" }, workspace: "user:u1" }, o2: { _id: "o2", prefix: "bug", fields: { severity: "p2" }, workspace: "user:u1" } } } as any);
    expect(queryCollection("objects", { where: { "fields.severity": "p0" } }).map((r) => r._id)).toEqual(["o1"]);
  });
});
