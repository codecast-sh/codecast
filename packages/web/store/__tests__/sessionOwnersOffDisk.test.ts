// A read off the session_owners model (the flag turned off, or rolled back)
// drops the cached owners read from the store AND from disk, so a reload
// draws the session as main does rather than the owners UI.
import "fake-indexeddb/auto";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterAll, expect, test } from "bun:test";
import Dexie from "dexie";

// Write-through runs only where a window exists (idbCache PERSISTENCE_AVAILABLE).
const hadWindow = "window" in globalThis;
if (!hadWindow) (globalThis as any).window = globalThis;
afterAll(() => { if (!hadWindow) delete (globalThis as any).window; });
const { stampCacheOwner } = await import("./fixtures/signedInPrincipal");
const { _reopenForTests, setHydrating } = await import("../idbCache");

await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();
setHydrating(false);
const { useInboxStore } = await import("../inboxStore");
const { applySessionOwnersRead } = await import("../../hooks/useSyncSessionOwners");

const db = () => Dexie.connections.find((d) => d.name === "codecast-store") as any;
const S = "s".repeat(32);
async function onDisk(): Promise<any> {
  const deadline = Date.now() + 5_000;
  let last: any;
  while (Date.now() < deadline) {
    await Bun.sleep(50);
    const row = await db().sessionOwners.get(S);
    if (JSON.stringify(row) === JSON.stringify(last) && Date.now() > deadline - 4_000) return row;
    last = row;
  }
  return last;
}

test("the off-model read takes the cached owners read off disk", { timeout: 20_000 }, async () => {
  // Boot hydration (bootPersistence) holds write-through until it lands.
  for (let i = 0; i < 100 && !useInboxStore.getState().clientStateInitialized; i++) await Bun.sleep(20);
  setHydrating(false);
  useInboxStore.setState({ currentUser: { _id: "me" } as any, syncRole: "host" } as any);
  applySessionOwnersRead(S, {
    session_owners: true, conversation_id: S, people: [{ user_id: "me", name: "Me", email: null, added_by: "me", added_at: 1 }],
    role: null, parent_session: null, implicit_starter: null, starter_id: "me", role_started: false, can_edit: true, owners_changed_at: 1,
  });
  expect((await onDisk())?.people_ids).toEqual(["me"]);
  applySessionOwnersRead(S, { conversation_id: S, short_id: "s1", owners: [] });
  expect((useInboxStore.getState() as any).sessionOwners[S]).toBeUndefined();
  expect(await onDisk()).toBeUndefined();
});
