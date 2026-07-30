import { describe, expect, test } from "bun:test";
import {
  clearMessageDeliveryStateForConversation,
  collectPastedInjectedIds,
  markInjectedBestEffort,
} from "./daemon.js";

// DEC-01 (docs/architecture/local-first-sync-test-matrix.md, DAEMON section):
// the injected-ack the daemon fires after syncing a user turn is scoped to the
// rows THIS process actually pasted. collectPastedInjectedIds is that scope —
// it must report exactly the resolved injections of the one conversation, so a
// historical user-turn echo (auto-resume resyncing a fresh JSONL from position
// 0) can never terminalize a row this daemon cannot vouch for.

const okSync = () => ({
  updateMessageStatus: async (_: { messageId: string; status: string }) => {},
});

describe("collectPastedInjectedIds", () => {
  test("reports a pasted message for its conversation and no other", async () => {
    await markInjectedBestEffort(okSync(), "m_scope_1", 5000, { conversationId: "conv_scope_a", retryDelaysMs: [] });
    await markInjectedBestEffort(okSync(), "m_scope_2", 5000, { conversationId: "conv_scope_b", retryDelaysMs: [] });

    expect(collectPastedInjectedIds("conv_scope_a")).toEqual(["m_scope_1"]);
    expect(collectPastedInjectedIds("conv_scope_b")).toEqual(["m_scope_2"]);
    expect(collectPastedInjectedIds("conv_scope_other")).toEqual([]);

    clearMessageDeliveryStateForConversation("conv_scope_a");
    clearMessageDeliveryStateForConversation("conv_scope_b");
  });

  test("a fresh process (no pastes recorded) vouches for nothing", () => {
    expect(collectPastedInjectedIds("conv_scope_fresh")).toEqual([]);
  });

  test("a pane-death clear withdraws the vouching for confirmed pastes", async () => {
    await markInjectedBestEffort(okSync(), "m_scope_3", 5000, { conversationId: "conv_scope_c", retryDelaysMs: [] });
    expect(collectPastedInjectedIds("conv_scope_c")).toEqual(["m_scope_3"]);
    clearMessageDeliveryStateForConversation("conv_scope_c");
    // Confirmed entry cleared → the row was reset to pending server-side; the
    // daemon must no longer vouch it as pasted.
    expect(collectPastedInjectedIds("conv_scope_c")).toEqual([]);
  });

  test("an UNCONFIRMED paste keeps its vouching through a clear (storm guard parity)", async () => {
    const jammed = { updateMessageStatus: (_: unknown) => new Promise<void>(() => {}) };
    await markInjectedBestEffort(jammed as any, "m_scope_4", 10, { conversationId: "conv_scope_d", retryDelaysMs: [] });
    clearMessageDeliveryStateForConversation("conv_scope_d");
    // The unconfirmed entry survives the clear (its row is still `pending`
    // server-side), so it remains in the vouch list — harmless: the scoped ack
    // only touches rows that are `injected` server-side.
    expect(collectPastedInjectedIds("conv_scope_d")).toEqual(["m_scope_4"]);
  });
});
