import { describe, expect, test } from "bun:test";
import { parseJointMessage } from "@codecast/shared/contracts/jointMessage";
import { inFlightPending, serverPendingBubbles } from "./pendingBanner";
import { canSteer, isHeldForTurnEnd, mergeQueueRows, queueRowsOf, reorderQueueRows, type QueueRow } from "./sharedQueue";

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
