import { afterEach, beforeEach, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import type { ResourceOffloadIntent } from "@codecast/shared/contracts/resourceOffloadIntent";

const owner = {};
const intent: ResourceOffloadIntent = { client_batch_id: "rb_test", source_device_id: "local", wait_for_idle_ms: 60000,
  selections: [{ conversation_id: "c1", session_id: "s1", destination_id: "linux", attested: [] },
    { conversation_id: "c2", session_id: "s2", destination_id: "mac", attested: [] }] };
let dispatches: Array<{ action: string; args: any; result: any }>;
beforeEach(() => {
  dispatches = [];
  useInboxStore.setState({ migrationBatches: [], pending: {} });
  useInboxStore.getState()._setDispatch(async (action: string, args: any, _patches: any, result: any) => {
    dispatches.push({ action, args, result });
    return {};
  }, { owner });
});
afterEach(() => useInboxStore.getState()._clearDispatch(owner));

test("offload paints one batch per destination immediately and stale snapshots cannot erase it", async () => {
  const request = useInboxStore.getState().startResourceOffload(intent);
  const painted = useInboxStore.getState().migrationBatches!;
  expect(painted).toHaveLength(2);
  expect(painted.every(b => /^mg-[a-z0-9]{32}$/.test(b.batch_id))).toBe(true);
  useInboxStore.getState().syncTable("migrationBatches", []);
  expect(useInboxStore.getState().migrationBatches).toEqual(painted);
  await request;
  expect(dispatches[0].action).toBe("startResourceOffload");
  expect(dispatches[0].result.batch_ids.map((b: any) => b.batch_id)).toEqual(painted.map(b => b.batch_id));
  const echo = painted.map(b => ({ ...b, rows: b.rows.map(r => ({ ...r, migration_id: "real", status: "failed", error: "Host became unavailable" })), failed: 1, queued: 0, state: "failed" }));
  useInboxStore.getState().syncTable("migrationBatches", echo);
  expect(useInboxStore.getState().migrationBatches).toEqual(echo);
  expect(Object.keys(useInboxStore.getState().pending).filter(k => k.startsWith("migrationBatches:"))).toEqual([]);
});

test("cancel paints immediately, protects the acknowledgement, and accepts authoritative row progress", async () => {
  await useInboxStore.getState().startResourceOffload(intent);
  const batches = useInboxStore.getState().migrationBatches!;
  useInboxStore.getState().syncTable("migrationBatches", batches);
  const batchId = batches[0].batch_id;
  const cancelling = useInboxStore.getState().cancelResourceOffload(batchId);
  expect(useInboxStore.getState().migrationBatches![0].rows[0].status).toBe("cancelled");
  const at = useInboxStore.getState().migrationBatches![0].cancelled_at;
  useInboxStore.getState().syncTable("migrationBatches", batches);
  expect(useInboxStore.getState().migrationBatches![0].cancelled_at).toBe(at);
  await cancelling;
  expect(dispatches[1].result.requested_at).toBe(at);
  const echo = batches.map(b => b.batch_id === batchId ? { ...b, cancelled_at: at, queued: 0, cancelled: 1, state: "cancelled", rows: b.rows.map(r => ({ ...r, status: "cancelled" })) } : b);
  useInboxStore.getState().syncTable("migrationBatches", echo);
  expect(useInboxStore.getState().migrationBatches).toEqual(echo);
  expect(Object.keys(useInboxStore.getState().pending).filter(k => k.startsWith("migrationBatches:"))).toEqual([]);
});
