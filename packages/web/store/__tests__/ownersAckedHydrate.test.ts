// An acked owners lock persists (the pending map is written to IndexedDB). A
// window whose acked check found nothing (cleared its hint) and then
// hydrates such a lock must look again: the next push retires it.
import "fake-indexeddb/auto";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterAll, expect, test } from "bun:test";
import Dexie from "dexie";

const hadWindow = "window" in globalThis;
if (!hadWindow) (globalThis as any).window = globalThis;
afterAll(() => { if (!hadWindow) delete (globalThis as any).window; });
const { stampCacheOwner } = await import("./fixtures/signedInPrincipal");
const { _reopenForTests, setHydrating } = await import("../idbCache");
await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();
const { useInboxStore, rebootPersistence } = await import("../inboxStore");
const { _ackedScanCount } = await import("../syncProtocol");

const db = () => Dexie.connections.find((d) => d.name === "codecast-store") as any;
const S = "s".repeat(32);
const row = (over: Record<string, unknown> = {}) => ({ _id: S, session_id: S, title: "Freeze case", user_id: "u_ashot", updated_at: 1, message_count: 3, owners_model: true, owned_by_me: true, ...over });
const st = () => useInboxStore.getState() as any;

test("a hydrated acked lock re-arms the acked check, and the next push retires it", { timeout: 20_000 } as any, async () => {
  for (let i = 0; i < 100 && !st().clientStateInitialized; i++) await Bun.sleep(20);
  setHydrating(false);
  useInboxStore.setState({ currentUser: { _id: "u_me" } as any, syncRole: "host" } as any);
  st().syncTable("sessions", [row()], { isDelta: true });
  // A push with no acked lock anywhere: the check scans once and stands down.
  st().syncTable("sessions", [row({ title: "again" })], { isDelta: true });
  const scans = _ackedScanCount();
  st().syncTable("sessions", [row({ title: "and again" })], { isDelta: true });
  expect(_ackedScanCount()).toBe(scans);
  // The page reloads holding an acked lock from before: Add me painted it, the
  // ack marked it, and no server value came before the window closed.
  await db().meta.put({ key: "pending", value: { [`sessions:${S}:owned_by_me`]: { type: "field", value: true, ts: Date.now(), acked: true } } });
  rebootPersistence();
  for (let i = 0; i < 200 && !st().pending[`sessions:${S}:owned_by_me`]; i++) await Bun.sleep(20);
  expect(st().pending[`sessions:${S}:owned_by_me`]?.acked).toBe(true);
  // The server's answer since: Ashot removed me. It lands and the lock retires.
  st().syncTable("sessions", [row({ owned_by_me: false })], { isDelta: true });
  expect(st().pending[`sessions:${S}:owned_by_me`]).toBeUndefined();
  expect(st().sessions[S].owned_by_me).toBe(false);
});
