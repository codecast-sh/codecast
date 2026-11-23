import { beforeEach, expect, test } from "bun:test";
import { __inboxStoreWindowBindings, useInboxStore } from "../inboxStore";

// An acknowledgement can reach the host before the sibling's write it
// answers (earlyAcks in inboxStore): it is kept until that write plants its
// mirror lock. Only a sibling's ack is kept (this window's own write has no
// mut still to come: its echo usually retired the lock first), and only a
// digest of the value, never a draft or a doc body.
const ID = "jx700000000000000000000000000eak";
const KEY = `sessions:${ID}:title`;
const BODY = "a long draft ".repeat(50);
const patches = { conversations: { [ID]: { title: BODY } } };
const ack = [{ scope_key: "user:me", position: 7 }];
const early = () => __inboxStoreWindowBindings.get().earlyAcks;

beforeEach(() => {
  early().clear();
  useInboxStore.setState({ currentUser: { _id: "me" }, pending: {}, syncMeta: {}, sessions: { [ID]: { _id: ID, session_id: "s-eak", user_id: "me", updated_at: 1, title: "old" } } } as any);
});

test("this window's own ack with no lock left keeps nothing", () => {
  useInboxStore.getState().stampSyncAck(patches, ack, Date.now(), { local: true });
  expect(early().has(KEY)).toBe(false);
});

test("a sibling's early ack keeps a digest, and the write it answers plants its lock acknowledged", () => {
  const sentAt = Date.now();
  useInboxStore.getState().applyGestureBridge({ kind: "ack", patches, ack, sentAt, ts: sentAt } as any);
  const kept = early().get(KEY) as any;
  expect(kept).toBeDefined();
  expect(JSON.stringify(kept)).not.toContain("a long draft");
  useInboxStore.getState().applyReplicatedFields("sessions", { [ID]: { title: BODY } }, sentAt - 1);
  expect((useInboxStore.getState().pending as any)[KEY]?.ack).toEqual([{ s: "user:me", p: 7 }]);
  expect(early().has(KEY)).toBe(false);
});
