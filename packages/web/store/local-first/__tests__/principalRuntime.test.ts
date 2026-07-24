import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { DexiePrincipalStoreFactory } from "../persistence/dexieAdapter";
import {
  DexieLauncherStore,
  launcherDatabaseName,
} from "../persistence/launcher";
import { PrincipalRuntime } from "../principalRuntime";
import {
  asPrincipalId,
  type CredentialBinding,
  type OpaquePrincipalKey,
} from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

describe("PrincipalRuntime inspection", () => {
  test("reports lifecycle/storage health without principal, credential, or error payload", async () => {
    const deployment = `runtime-inspection-${randomUUID()}`;
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const principalId = asPrincipalId("principal-runtime-MUST-NOT-LEAK");
    const credential = "credential-binding-MUST-NOT-LEAK" as CredentialBinding;
    const launcher = new DexieLauncherStore(deployment, () => principalKey);
    const runtime = new PrincipalRuntime(
      launcher,
      new DexiePrincipalStoreFactory(deployment),
      {
        stopProtectedIO: () => {},
        clearProtectedMemory: () => {},
        bindPersistence: () => {},
        unbindPersistence: () => {},
        hydrate: async ({ isCurrent }) => isCurrent(),
      },
    );

    try {
      expect(await runtime.verify({ credentialBinding: credential, principalId })).toBe(true);
      let inspection = await runtime.inspect(100);
      expect(inspection.lifecycle).toMatchObject({
        phase: "server-verified",
        generation: 1,
        principalEpoch: 1,
        storageHealth: "healthy",
      });
      expect(inspection.store).toMatchObject({
        storeKeyHint: `${String(principalKey).slice(0, 8)}…`,
        schemaVersion: 3,
        activeGeneration: 1,
        fenced: false,
        grantCount: 0,
      });

      runtime.reportStorageFailure(new Error("STORAGE-DETAIL-MUST-NOT-LEAK"));
      inspection = await runtime.inspect(100);
      expect(inspection.lifecycle.storageHealth).toBe("degraded");
      expect(inspection.lastFailure).toMatchObject({
        reason: "storage-failure",
        category: "Error",
      });
      const serialized = JSON.stringify(inspection);
      expect(serialized).not.toContain(principalId);
      expect(serialized).not.toContain(credential);
      expect(serialized).not.toContain(String(principalKey));
      expect(serialized).not.toContain("STORAGE-DETAIL-MUST-NOT-LEAK");

      // A durable commit succeeding after degradation restores capability —
      // one transient IDB fault must not close dispatch until reload.
      runtime.reportStorageRecovery();
      inspection = await runtime.inspect(100);
      expect(inspection.lifecycle.storageHealth).toBe("healthy");
      expect(runtime.canDispatch).toBe(true);

      // ...but the re-probe budget is bounded: storage that keeps flapping
      // between failure and success latches degraded permanently.
      for (let i = 0; i < 8; i++) {
        runtime.reportStorageFailure(new Error(`flap-${i}`));
        runtime.reportStorageRecovery();
      }
      inspection = await runtime.inspect(100);
      expect(inspection.lifecycle.storageHealth).toBe("degraded");
      expect(runtime.canDispatch).toBe(false);
    } finally {
      await runtime.lock({
        purge: true,
        removeActiveBinding: true,
        reason: "test-cleanup",
      });
      runtime.close();
      launcher.close();
      await Dexie.delete(launcherDatabaseName(deployment));
    }
  });
});
