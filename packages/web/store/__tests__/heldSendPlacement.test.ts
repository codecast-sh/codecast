import { describe, expect, it } from "bun:test";
import { collectInboxOverlayDeps, pendingSendIdsOf } from "../inboxOverlays";

// ct-97017: the daemon held a message ("waiting for terminal input
// confirmation") and synced that hold onto the conversation's server pending
// row. The send is not landing; it waits on the person. The sidebar must stop
// treating it as an in-flight send that files the row under Working and labels
// it "Sending" until the 10-minute bound runs out.

const CONV = "c".repeat(32);
const NOW = 1_756_600_000_000;
const SENT_AT = NOW - 9 * 60 * 1000;

const heldState = () => ({
  sessions: {},
  sessionsWithQueuedMessages: new Set<string>(),
  pendingMessages: {
    [CONV]: [{ _id: "client-1", client_id: "client-1", content: "do this", timestamp: SENT_AT }],
  },
  pendingMessageStatus: {
    [CONV]: {
      message_id: "m".repeat(32),
      client_id: "client-1",
      created_at: SENT_AT,
      status: "pending",
      content: "do this",
      hold_reason: "waiting for terminal input confirmation",
    },
  },
});

describe("a send the daemon is holding", () => {
  it("is not an in-flight pending send for placement", () => {
    expect(pendingSendIdsOf(heldState() as any, NOW).has(CONV)).toBe(false);
  });

  it("does not pin the row to Working through the pending_send overlay", () => {
    expect(collectInboxOverlayDeps(heldState() as any, NOW).pendingSendIds.has(CONV)).toBe(false);
  });

  it("an unheld send still counts (control)", () => {
    const s = heldState();
    delete (s.pendingMessageStatus[CONV] as any).hold_reason;
    expect(pendingSendIdsOf(s as any, NOW).has(CONV)).toBe(true);
  });
});
