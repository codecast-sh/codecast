import { randomUUID } from "node:crypto";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import {
  asCommitSequence,
  asPrincipalId,
  asSourceEpoch,
  asSourceSequence,
  asWriterEpoch,
  type OpaquePrincipalKey,
} from "../../types";
import {
  DexiePrincipalStoreAdapter,
  PRINCIPAL_DEXIE_V1_STORES,
  PRINCIPAL_DEXIE_V2_STORES,
  principalDatabaseName,
  type DexieFaultPoint,
} from "../dexieAdapter";
import { definePrincipalStoreAdapterContract } from "./adapter.contract";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

definePrincipalStoreAdapterContract("Dexie", async () => {
  const principalKey = randomUUID() as OpaquePrincipalKey;
  const name = principalDatabaseName(`test-${randomUUID()}`, principalKey);
  let fault: DexieFaultPoint | null = null;
  const inject = (point: DexieFaultPoint) => {
    if (point === fault) throw new Error("injected-storage-fault");
  };
  const adapter = new DexiePrincipalStoreAdapter(name, principalKey, inject);
  await adapter.ensureOpen();
  return {
    adapter,
    principalKey,
    setFault(point) { fault = point; },
    async reopen() {
      const reopened = new DexiePrincipalStoreAdapter(name, principalKey, inject);
      await reopened.ensureOpen();
      return reopened;
    },
  };
});

describe("Dexie principal-store migrations", () => {
  test("seeds a durable writer fence while upgrading a v1 store", async () => {
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const principalId = asPrincipalId("principal-migration");
    const name = principalDatabaseName(`migration-${randomUUID()}`, principalKey);
    const legacy = new Dexie(name);
    legacy.version(1).stores(PRINCIPAL_DEXIE_V1_STORES);

    await legacy.open();
    await legacy.table("meta").put({
      key: "store",
      schemaVersion: 1,
      principalKey,
      principalId,
      activeGeneration: 7,
      fenced: false,
      head: asCommitSequence(11),
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table("views").put({
      key: "view:migrated",
      contractId: "migrated/v1",
      grantKeys: [],
      revision: "8",
      writerEpoch: asWriterEpoch(8),
      sourceEpoch: asSourceEpoch("legacy-source"),
      sourceSequence: asSourceSequence(5),
      coverage: { kind: "view-revision", revision: "8", revisionOrder: 8 },
    });
    legacy.close();

    const adapter = new DexiePrincipalStoreAdapter(name, principalKey);
    try {
      await adapter.ensureOpen();
      expect((await adapter.readMetadata())?.schemaVersion).toBe(3);
      const fence = { principalKey, generation: 7 };
      expect((await adapter.readSnapshot(fence)).viewWriters).toEqual([{
        key: "view:migrated",
        contractId: "migrated/v1",
        writerEpoch: asWriterEpoch(8),
        lastCoverage: { kind: "view-revision", revision: "8", revisionOrder: 8 },
        sourceEpoch: asSourceEpoch("legacy-source"),
        sourceSequence: asSourceSequence(5),
        lastAccess: "granted",
      }]);
      expect((await adapter.claimViewWriter(fence, "view:migrated", "migrated/v1")).writerEpoch)
        .toBe(asWriterEpoch(9));
    } finally {
      await adapter.purge();
    }
  });

  test("repairs an already-versioned v2 database that never created viewWriters", async () => {
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const principalId = asPrincipalId("principal-stale-v2");
    const name = principalDatabaseName(`stale-v2-${randomUUID()}`, principalKey);
    const staleV2 = new Dexie(name);
    // This deliberately models the intermediate browser schema: its IndexedDB
    // version is already 2, but its store list is still the v1 list.
    staleV2.version(2).stores(PRINCIPAL_DEXIE_V1_STORES);
    await staleV2.open();
    await staleV2.table("meta").put({
      key: "store",
      schemaVersion: 2,
      principalKey,
      principalId,
      activeGeneration: 4,
      fenced: false,
      head: asCommitSequence(6),
      createdAt: 1,
      updatedAt: 1,
    });
    await staleV2.table("views").put({
      key: "view:stale-v2",
      contractId: "stale-v2/v1",
      grantKeys: [],
      revision: "4",
      writerEpoch: asWriterEpoch(4),
      sourceEpoch: asSourceEpoch("stale-v2-source"),
      sourceSequence: asSourceSequence(3),
      coverage: { kind: "view-revision", revision: "4", revisionOrder: 4 },
    });
    staleV2.close();

    const adapter = new DexiePrincipalStoreAdapter(name, principalKey);
    try {
      await adapter.ensureOpen();
      expect((await adapter.readMetadata())?.schemaVersion).toBe(3);
      const snapshot = await adapter.readSnapshot({ principalKey, generation: 4 });
      expect(snapshot.viewWriters).toHaveLength(1);
      expect(snapshot.viewWriters[0]).toMatchObject({
        key: "view:stale-v2",
        writerEpoch: asWriterEpoch(4),
        sourceEpoch: asSourceEpoch("stale-v2-source"),
        sourceSequence: asSourceSequence(3),
      });
    } finally {
      await adapter.purge();
    }
  });

  test("does not lower an existing v2 durable writer during repair", async () => {
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const principalId = asPrincipalId("principal-valid-v2");
    const name = principalDatabaseName(`valid-v2-${randomUUID()}`, principalKey);
    const v2 = new Dexie(name);
    v2.version(2).stores(PRINCIPAL_DEXIE_V2_STORES);
    await v2.open();
    await v2.table("meta").put({
      key: "store",
      schemaVersion: 2,
      principalKey,
      principalId,
      activeGeneration: 9,
      fenced: false,
      head: asCommitSequence(12),
      createdAt: 1,
      updatedAt: 1,
    });
    await v2.table("views").put({
      key: "view:existing-writer",
      contractId: "existing/v1",
      grantKeys: [],
      revision: "5",
      writerEpoch: asWriterEpoch(5),
      sourceEpoch: asSourceEpoch("old-view-source"),
      sourceSequence: asSourceSequence(2),
      coverage: { kind: "view-revision", revision: "5", revisionOrder: 5 },
    });
    await v2.table("viewWriters").put({
      key: "view:existing-writer",
      contractId: "existing/v1",
      writerEpoch: asWriterEpoch(11),
      lastAccess: "missing",
    });
    v2.close();

    const adapter = new DexiePrincipalStoreAdapter(name, principalKey);
    try {
      await adapter.ensureOpen();
      const snapshot = await adapter.readSnapshot({ principalKey, generation: 9 });
      expect(snapshot.metadata.schemaVersion).toBe(3);
      expect(snapshot.viewWriters).toEqual([{
        key: "view:existing-writer",
        contractId: "existing/v1",
        writerEpoch: asWriterEpoch(11),
        lastCoverage: { kind: "view-revision", revision: "5", revisionOrder: 5 },
        lastAccess: "missing",
      }]);
    } finally {
      await adapter.purge();
    }
  });
});
