import { describe, expect, it } from "bun:test";
import { serverPendingBubbleVisible } from "../pendingBanner";

describe("serverPendingBubbleVisible", () => {
  const sentAt = 1_790_000_000_000;
  const live = { newestServerTs: sentAt - 5_000, atLiveTail: true };

  it("shows an in-flight row whatever the window holds", () => {
    for (const status of ["pending", "injected", "failed", "undeliverable", "held"]) {
      expect(serverPendingBubbleVisible({ status, created_at: sentAt }, live)).toBe(true);
      expect(serverPendingBubbleVisible({ status, created_at: sentAt }, { newestServerTs: sentAt + 60_000, atLiveTail: false })).toBe(true);
    }
  });

  // The 2026-09-23 gap: the daemon ingested the echo 33 minutes after the
  // send. Until this window's transcript reaches the send time, the delivered
  // row is the only copy of the message the viewer has.
  it("keeps a delivered row while the transcript on screen ends before the send", () => {
    expect(serverPendingBubbleVisible({ status: "delivered", created_at: sentAt }, live)).toBe(true);
  });

  it("drops a delivered row once the transcript has passed its delivery", () => {
    expect(serverPendingBubbleVisible({ status: "delivered", created_at: sentAt }, { newestServerTs: sentAt + 10 * 60_000, atLiveTail: true })).toBe(false);
  });

  it("never appends a delivered row to a window that is not at the live tail", () => {
    expect(serverPendingBubbleVisible({ status: "delivered", created_at: sentAt }, { newestServerTs: 0, atLiveTail: false })).toBe(false);
  });

  // A message queued for the end of the turn is created mid-turn, and the
  // agent keeps writing after it. When the turn ends and it goes in, the
  // transcript on screen is already newer than its send time but does not
  // hold its echo yet. It reached the session at delivery, so that is the
  // point the transcript has to pass.
  it("keeps a queued row delivered after the agent wrote past its send time", () => {
    const deliveredAt = sentAt + 5 * 60_000;
    const window = { newestServerTs: deliveredAt - 1_000, atLiveTail: true };
    expect(serverPendingBubbleVisible({ status: "delivered", created_at: sentAt, delivered_at: deliveredAt }, window)).toBe(true);
    expect(serverPendingBubbleVisible({ status: "delivered", created_at: sentAt, delivered_at: deliveredAt }, { newestServerTs: deliveredAt + 10 * 60_000, atLiveTail: true })).toBe(false);
  });

  it("never shows a cancelled row", () => {
    expect(serverPendingBubbleVisible({ status: "cancelled", created_at: sentAt }, live)).toBe(false);
  });
});
