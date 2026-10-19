import { describe, expect, test } from "bun:test";
import { RECEIPT_EXPIRES_MS, settleReceipts, type Ticket } from "./pushReceipts";

const t = (n: number, extra: Partial<Ticket> = {}): Ticket =>
  ({ _id: `row${n}`, ticket_id: `tk${n}`, push_token: `tok${n}`, user_id: `user${n}`, sent_at: 0, ...extra }) as Ticket;
const invalidCreds = {
  status: "error" as const,
  message: "The Apple Push Notification service failed to send the notification (reason: InvalidProviderToken, status code: 403).",
  details: { error: "InvalidCredentials" },
};

describe("settleReceipts", () => {
  test("a revoked APNs key surfaces as one InvalidCredentials failure with its count", () => {
    const r = settleReceipts([t(1), t(2), t(3)], { tk1: invalidCreds, tk2: invalidCreds, tk3: { status: "ok" } }, 1000);
    expect(r.settled).toEqual(["row1", "row2", "row3"] as any);
    expect(r.dead).toEqual([]);
    expect(r.failures).toEqual([{ code: "InvalidCredentials", count: 2, sample: invalidCreds.message }]);
  });

  test("a dead token is cleared, not reported", () => {
    const r = settleReceipts([t(1)], { tk1: { status: "error", details: { error: "DeviceNotRegistered" } } }, 1000);
    expect(r.dead).toEqual([{ user_id: "user1", push_token: "tok1" }] as any);
    expect(r.failures).toEqual([]);
  });

  test("a ticket without a receipt waits until Expo has dropped it", () => {
    expect(settleReceipts([t(1)], {}, 1000).settled).toEqual([]);
    expect(settleReceipts([t(1)], {}, RECEIPT_EXPIRES_MS + 1).settled).toEqual(["row1"] as any);
  });
});
