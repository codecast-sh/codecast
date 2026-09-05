import { expect, test } from "bun:test";
import { applyPatches } from "./dispatch";
import { computeInboxSessions, computeSessionsLiveness } from "./conversations";
import { enqueuePendingMessage } from "./pendingMessages";
import { makeFakeDb } from "./testDb";
import { placeProjectableRow } from "@codecast/shared/contracts";

test("durable snooze reaches both inbox channels and resurfaces after expiry without a browser", async () => {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const until = now + 86400_000;
  const id = "conversations_snooze";
  const user = "users_me";
  const db = makeFakeDb({ users: [{ _id: user }], conversations: [{ _id: id, user_id: user, title: "Snoozed", status: "active", message_count: 10, updated_at: now - 40 * 86400_000, thread_state_status: "done" }], session_owners: [], managed_sessions: [], messages: [], session_decisions: [], pending_messages: [] });
  await applyPatches({ db } as any, user as any, { conversations: { [id]: { inbox_snoozed_until: until } } });
  expect(db._tables.conversations[0].inbox_snoozed_until).toBe(until);
  const { sessions } = await computeInboxSessions({ db }, user as any, {});
  const row = sessions.find((s: any) => s._id === id);
  expect(row.inbox_snoozed_until).toBe(until);
  const result = await computeSessionsLiveness({ db }, user as any);
  expect((result.liveness as any)[id].bucket).toBe("snoozed");
  expect((result.liveness as any)[id].bucket_stale_at).toBe(until);
  expect(placeProjectableRow(db._tables.conversations[0] as any, false, until).bucket).toBe("needs_input");
  expect(db._tables.daemon_commands ?? []).toHaveLength(0);
});

test("an unrelated user cannot snooze a session", async () => {
  const db = makeFakeDb({ conversations: [{ _id: "conv", user_id: "owner", message_count: 2 }], session_owners: [] });
  await applyPatches({ db } as any, "outsider" as any, { conversations: { conv: { inbox_snoozed_until: Date.now() + 86400_000 } } });
  expect(db._tables.conversations[0].inbox_snoozed_until).toBeUndefined();
});


test("machine wakes respect snooze; a human send clears it", async () => {
  const until = Date.now() + 86400_000;
  const conv = { _id: "conversations_snooze", user_id: "users_me", session_id: "session", status: "active", inbox_snoozed_until: until };
  const db = makeFakeDb({ conversations: [conv], pending_messages: [], session_owners: [], managed_sessions: [] });
  await enqueuePendingMessage({ db } as any, conv as any, "users_me" as any, { content: "scheduled check", origin: "scheduler" });
  expect(conv.inbox_snoozed_until).toBe(until);
  await enqueuePendingMessage({ db } as any, conv as any, "users_me" as any, { content: "continue now" });
  expect(conv.inbox_snoozed_until).toBeUndefined();
});
