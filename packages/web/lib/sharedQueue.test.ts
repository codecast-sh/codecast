import { describe, expect, test } from "bun:test";
import { parseJointMessage } from "@codecast/shared/contracts/jointMessage";
import { inFlightPending, serverPendingBubbles } from "./pendingBanner";
import { formatScheduledTask, formatSessionMessage } from "@codecast/shared/contracts";
import { canSteer, isHeldForTurnEnd, mergeQueueRows, queueGroupsOf, queueLineOf, queueRowsOf, reorderQueueRows, type QueueRow } from "./sharedQueue";

const row = (id: string, at: number, from: string, content: string, status = "pending", queued?: boolean): QueueRow =>
  ({ message_id: id, created_at: at, status, content, from_name: from, from_user_id: `u_${from}`, queued });

describe("shared queue", () => {
  test("reads the waiting rows, never settled ones", () => {
    expect(queueRowsOf({ inflight: [row("a", 1, "Ann", "x"), row("b", 2, "Bob", "y", "cancelled")] }).map((r) => r.message_id)).toEqual(["a"]);
    expect(queueRowsOf(null)).toEqual([]);
  });

  test("moves a row up, and never ahead of one going in", () => {
    const rows = [row("a", 1, "Ann", "one", "injected"), row("b", 2, "Ann", "two"), row("c", 3, "Bob", "three")];
    expect(reorderQueueRows(rows, "c", "b").map((r) => r.message_id)).toEqual(["a", "c", "b"]);
    expect(reorderQueueRows(rows, "c", "a")).toBe(rows);
    expect(reorderQueueRows(rows, "b", null).map((r) => r.message_id)).toEqual(["a", "c", "b"]);
  });

  test("merges two into the earlier one, each part under its author", () => {
    const rows = [row("a", 1, "Ann", "fix the header"), row("b", 2, "Bob", '<user-message from="Bob">\ncheck mobile\n</user-message>')];
    const merged = mergeQueueRows(rows, "b", "a");
    expect(merged).toHaveLength(1);
    expect(parseJointMessage(merged[0].content)).toEqual([{ from: "Ann", body: "fix the header" }, { from: "Bob", body: "check mobile" }]);
  });

  test("a row queued for the turn's end waits and can be steered", () => {
    const held = row("q", 1, "Ann", "after this", "held", true);
    expect(isHeldForTurnEnd(held)).toBe(true);
    expect(canSteer(held)).toBe(true);
    expect(canSteer(row("h", 1, "Ann", "note", "held"))).toBe(false);
  });
});


describe("queued rows and the delivery tracker", () => {
  const timeline = { seen: new Set<string>(), seenContent: new Set<string>(), local: [], newestServerTs: 0, atLiveTail: true, normalize: (s: string) => s.trim() };

  test("a row held for the turn's end is not late and draws no bubble", () => {
    const held = { message_id: "q", created_at: 1, status: "held", queued: true, content: "after this" };
    expect(inFlightPending(held)).toBeNull();
    expect(inFlightPending({ inflight: [held] } as any)).toBeNull();
    expect(serverPendingBubbles({ ...held, inflight: [held] }, timeline)).toEqual([]);
  });

  test("a teammate's waiting message is drawn as theirs", () => {
    const row = { message_id: "p", created_at: 1, status: "pending", content: "check mobile", from_user_id: "u_bob" };
    expect(serverPendingBubbles({ ...row, inflight: [row] }, timeline)[0]).toMatchObject({ from_user_id: "u_bob" });
  });
});

// What a row reads as: who it is really from and what it says, never the
// wrapper machinery delivers it in.
describe("queue lines", () => {
  const wake = (id: string, at: number, session: string, state: string, status = "pending") =>
    row(id, at, "Ashot", formatScheduledTask({ title: "A session under you needs input", trigger: "tr-1167", event: "session_needs_input", waiting: { short_id: session, title: "Worker", why: "blocked", since: 1, state }, body: "A session that reports to you is waiting." }), status);
  const fromSession = (id: string, at: number, from: string, body: string) => row(id, at, "Ashot", formatSessionMessage(from, body, { name: "Ashot Petrosian" }));

  test("a trigger run reads as its title, its trigger and the session it fired for", () => {
    const line = queueLineOf(wake("a", 1, "jx7abcd", "Needs a prod key"));
    expect(line).toMatchObject({ kind: "trigger", title: "A session under you needs input", trigger: "tr-1167", text: "Needs a prod key" });
    expect(line.kind === "trigger" && line.waiting?.short_id).toBe("jx7abcd");
  });

  test("another session's message reads as that session and its words", () => {
    expect(queueLineOf(fromSession("a", 1, "jx7c12d", "Delivery check:\nreply with one line"))).toEqual({ kind: "session", source: "Ashot Petrosian", ref: "jx7c12d", text: "Delivery check: reply with one line" });
  });

  test("a role's brief reads as its first line without the markdown, and typed words stay the person's", () => {
    expect(queueLineOf(row("a", 1, "Jason", "You are the **Agent Quality lead** (@agent-quality) in Union. You report to Jason.\n\nMore."))).toEqual({ kind: "brief", text: "You are the Agent Quality lead (@agent-quality) in Union. You report to Jason." });
    expect(queueLineOf(row("b", 2, "Ann", "fix the header"))).toEqual({ kind: "person" });
  });

  test("the same trigger waiting back to back folds into one line; anything between starts a new one", () => {
    const rows = [
      fromSession("s1", 1, "jx7c12d", "first"),
      ...Array.from({ length: 8 }, (_, i) => wake(`w${i}`, 2 + i, `jx7w00${i}`, `ask ${i}`)),
      fromSession("s2", 20, "jx79zjy", "second"),
      wake("w8", 21, "jx7w008", "ask 8"),
      wake("w9", 22, "jx7w009", "ask 9"),
      row("p", 30, "Ann", "typed"),
    ];
    const groups = queueGroupsOf(rows);
    expect(groups.map((g) => [g.line.kind, g.rows.length])).toEqual([["session", 1], ["trigger", 8], ["session", 1], ["trigger", 2], ["person", 1]]);
    expect(groups.flatMap((g) => g.rows)).toEqual(rows);
  });

  test("a run going in now is its own line, and a different trigger never folds in", () => {
    const other = row("m", 3, "Jason", formatScheduledTask({ title: "Morning agenda", body: "Set the day." }));
    expect(queueGroupsOf([wake("a", 1, "jx7w001", "x", "injected"), wake("b", 2, "jx7w002", "y"), other]).map((g) => g.rows.length)).toEqual([1, 1, 1]);
  });
});
