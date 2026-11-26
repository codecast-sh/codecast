// Acking a handoff (clearAssignedPing) clears the row's ping under a lock. The
// inbox feeds leave assigned_ping off a row with no ping waiting, so that
// absent echo must release the lock, or a later re-assign never shows.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

const S = "a".repeat(32);
const owner = {};
const row = (extra: Record<string, unknown> = {}) => ({ _id: S, session_id: "s1", title: "Handoff", user_id: "me", updated_at: 1, message_count: 1, ...extra });
const locks = () => Object.keys(useInboxStore.getState().pending as object).filter((k) => k.includes(":assigned_ping"));

beforeEach(() => {
  useInboxStore.setState({ currentUser: { _id: "me" } as any, pending: {}, sessions: {} } as any);
  useInboxStore.getState()._setDispatch(async () => null, { owner });
  useInboxStore.getState().syncTable("sessions", [row({ assigned_ping: { by_name: "Ashot", at: 1 } })] as any, { isDelta: true } as any);
});
afterEach(() => useInboxStore.getState()._clearDispatch(owner));

test("ack, an echo without the ping, then a re-assign: the new ping shows", async () => {
  useInboxStore.getState().clearAssignedPing(S);
  expect((useInboxStore.getState().sessions[S] as any).assigned_ping ?? null).toBeNull();
  await new Promise((r) => setTimeout(r, 20));
  const { assigned_ping: _gone, ...echo } = row();
  useInboxStore.getState().syncTable("sessions", [echo] as any, { isDelta: true } as any);
  expect(locks()).toEqual([]);
  useInboxStore.getState().syncTable("sessions", [row({ assigned_ping: { by_name: "Armen", at: 2 } })] as any, { isDelta: true } as any);
  expect((useInboxStore.getState().sessions[S] as any).assigned_ping?.by_name).toBe("Armen");
});
