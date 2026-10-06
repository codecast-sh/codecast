import { beforeEach, expect, test } from "bun:test";
import { useInboxStore, syncLogScopeMetaKey } from "../inboxStore";
import { deliveryReceiptIds, settleDeliveryReceipts, stampDeliveryReceipts } from "../../lib/syncDeliveryReceipts";

const id = "a".repeat(32);
const other = "b".repeat(32);
const field = `sessions:${id}:title`;
const receipt = { id: "receipt", revision: 2, entity_type: "conversations", entity_id: id };
const delivered = { id: "receipt", revision: 2, scope_key: "user:u", position: 7 };

beforeEach(() => {
  useInboxStore.setState({
    sessions: { [id]: { _id: id, title: "Mine" } }, conversations: {},
    pending: { [field]: { type: "field", value: "Mine", ts: 100 } }, syncMeta: {},
  } as any);
});

function stamp() {
  stampDeliveryReceipts(useInboxStore.getState(), { conversations: { [id]: { title: "Mine" } } }, [receipt], 200);
}
function settle(rows = [delivered]) {
  settleDeliveryReceipts(useInboxStore.getState(), rows, syncLogScopeMetaKey);
}

test("a durable receipt waits for both delivery revision and applied cursor", () => {
  stamp();
  expect(deliveryReceiptIds(useInboxStore.getState().pending)).toEqual(["receipt"]);
  settle();
  expect(useInboxStore.getState().pending[field]).toBeDefined();
  useInboxStore.getState().recordSyncMeta(syncLogScopeMetaKey("user:u"), { cursor: 7 });
  settle([{ ...delivered, revision: 1 }]);
  expect(useInboxStore.getState().pending[field]).toBeDefined();
  settle();
  expect(useInboxStore.getState().pending[field]).toBeUndefined();
});

test("receipt received after catch-up restores a superseding server value", () => {
  useInboxStore.setState({
    pending: { [field]: { type: "field", value: "Mine", ts: 100, seen: ["Superseded"] } },
    syncMeta: { [syncLogScopeMetaKey("user:u")]: { cursor: 9 } },
  } as any);
  stamp();
  settle();
  expect(useInboxStore.getState().pending[field]).toBeUndefined();
  expect(useInboxStore.getState().sessions[id]?.title).toBe("Superseded");
});

test("one entity's delivery cannot retire another entity's write", () => {
  const second = `sessions:${other}:title`;
  useInboxStore.setState({ pending: {
    [field]: { type: "field", value: "Mine", ts: 100 },
    [second]: { type: "field", value: "Other", ts: 100 },
  } } as any);
  stampDeliveryReceipts(useInboxStore.getState(), { conversations: { [id]: { title: "Mine" }, [other]: { title: "Other" } } },
    [receipt, { ...receipt, id: "second", entity_id: other }], 200);
  useInboxStore.getState().recordSyncMeta(syncLogScopeMetaKey("user:u"), { cursor: 7 });
  settle();
  expect(useInboxStore.getState().pending[field]).toBeUndefined();
  expect(useInboxStore.getState().pending[second]).toBeDefined();
});

test("a late receipt cannot stamp a newer local edit", () => {
  useInboxStore.setState({ pending: { [field]: { type: "field", value: "New local edit", ts: 300 } } } as any);
  stamp();
  expect(deliveryReceiptIds(useInboxStore.getState().pending)).toEqual([]);
});

test("fanout scopes share one receipt list and any applied copy settles the entity", () => {
  stampDeliveryReceipts(useInboxStore.getState(), { conversations: { [id]: { title: "Mine" } } },
    [receipt, { ...receipt, id: "otherScope" }], 200);
  expect(deliveryReceiptIds(useInboxStore.getState().pending)).toEqual(["otherScope", "receipt"]);
  useInboxStore.getState().recordSyncMeta(syncLogScopeMetaKey("user:u"), { cursor: 7 });
  settle();
  expect(useInboxStore.getState().pending[field]).toBeUndefined();
});
