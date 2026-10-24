import { describe, expect, test } from "bun:test";
import { deliveredOutcome, describeSendOutcome, failedOutcome, outcomeDelivered } from "./sendOutcome";

describe("deliveredOutcome", () => {
  test("an idle session reads it now: sent", () => {
    expect(deliveredOutcome(["a"], null)).toEqual({ kind: "sent", sent_ids: ["a"] });
  });

  test("a busy or offline session: queued, with why", () => {
    expect(deliveredOutcome(["a"], "busy")).toEqual({ kind: "queued", sent_ids: ["a"], waiting: "busy" });
    expect(deliveredOutcome(["a"], "offline")).toEqual({ kind: "queued", sent_ids: ["a"], waiting: "offline" });
  });

  test("a resolve with nothing left open: sent and resolved, waiting kept", () => {
    expect(deliveredOutcome(["a", "b"], "busy", { open_ids: [] })).toEqual({ kind: "sent_and_resolved", sent_ids: ["a", "b"], waiting: "busy" });
    expect(deliveredOutcome(["a"], null, { open_ids: [] })).toEqual({ kind: "sent_and_resolved", sent_ids: ["a"] });
  });

  test("a resolve that left rows open names them", () => {
    expect(deliveredOutcome(["a", "b"], null, { open_ids: ["b"], reason: "Comment not found" })).toEqual({
      kind: "resolve_failed",
      sent_ids: ["a", "b"],
      open_ids: ["b"],
      reason: "Comment not found",
    });
  });
});

describe("failedOutcome", () => {
  test("takes an Error, a string, or nothing", () => {
    expect(failedOutcome(new Error("No session matches x"))).toEqual({ kind: "failed", reason: "No session matches x" });
    expect(failedOutcome("Forbidden")).toEqual({ kind: "failed", reason: "Forbidden" });
    expect(failedOutcome("")).toEqual({ kind: "failed", reason: "The send failed" });
    expect(outcomeDelivered(failedOutcome("x"))).toBe(false);
    expect(outcomeDelivered(deliveredOutcome([], null, { open_ids: ["a"] }))).toBe(true);
  });
});

describe("describeSendOutcome", () => {
  test("one line per kind", () => {
    expect(describeSendOutcome({ kind: "sent", sent_ids: ["a"] }, { to: "jx7abcd" })).toBe("1 note sent to jx7abcd");
    expect(describeSendOutcome({ kind: "queued", sent_ids: ["a", "b"], waiting: "offline" })).toBe(
      "2 notes sent to the session, queued until it is back online",
    );
    expect(describeSendOutcome({ kind: "sent_and_resolved", sent_ids: ["a"] }, { noun: "comment" })).toBe("1 comment sent to the session and resolved");
    expect(describeSendOutcome({ kind: "resolve_failed", sent_ids: ["a", "b"], open_ids: ["b"], reason: "gone" })).toBe(
      "2 notes sent to the session; 1 note still open: gone",
    );
    expect(describeSendOutcome({ kind: "failed", reason: "Forbidden" })).toBe("Not sent: Forbidden");
    // A review with a verdict and no notes still reads as sent.
    expect(describeSendOutcome({ kind: "sent", sent_ids: [] })).toBe("Review sent to the session");
  });
});
