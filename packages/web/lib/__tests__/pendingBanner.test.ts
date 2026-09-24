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

  it("drops a delivered row once the transcript has passed the send time", () => {
    expect(serverPendingBubbleVisible({ status: "delivered", created_at: sentAt }, { newestServerTs: sentAt + 1, atLiveTail: true })).toBe(false);
  });

  it("never appends a delivered row to a window that is not at the live tail", () => {
    expect(serverPendingBubbleVisible({ status: "delivered", created_at: sentAt }, { newestServerTs: 0, atLiveTail: false })).toBe(false);
  });

  it("never shows a cancelled row", () => {
    expect(serverPendingBubbleVisible({ status: "cancelled", created_at: sentAt }, live)).toBe(false);
  });
});
