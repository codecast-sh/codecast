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

describe("PrincipalRuntime storage recovery wiring", () => {
  // Matrix ACC-01: the offline-ready -> server-verified upgrade path must keep
  // the storage-recovery signal wired. Without it, one transient fault after a
  // verify-upgrade leaves health degraded (dispatch closed) until reload even
  // though durable commits demonstrably succeed.
  test("a commit after the verify-upgrade path restores degraded storage health", async () => {
    const deployment = `runtime-recovery-${randomUUID()}`;
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const principalId = asPrincipalId("principal-recovery");
    const credential = "credential-recovery" as CredentialBinding;
    const launcher = new DexieLauncherStore(deployment, () => principalKey);
    const hooks = {
      stopProtectedIO: () => {},
      clearProtectedMemory: () => {},
      bindPersistence: () => {},
      unbindPersistence: () => {},
      hydrate: async ({ isCurrent }: { isCurrent: () => boolean }) => isCurrent(),
    };
    // First boot verifies online, then the page closes WITHOUT logout — the
    // launcher stays unlocked, which is what authorizes the next offline boot.
    const firstBoot = new PrincipalRuntime(
      launcher,
      new DexiePrincipalStoreFactory(deployment),
      hooks,
    );
    expect(await firstBoot.verify({ credentialBinding: credential, principalId })).toBe(true);
    firstBoot.close();

    const runtime = new PrincipalRuntime(
      launcher,
      new DexiePrincipalStoreFactory(deployment),
      hooks,
    );
    try {
      expect(await runtime.resolveOffline(credential)).toBe(true);
      expect(runtime.getSnapshot().phase).toBe("offline-ready");
      // Upgrade in place: same credential and principal, adapter retained.
      expect(await runtime.verify({ credentialBinding: credential, principalId })).toBe(true);
      expect(runtime.getSnapshot().phase).toBe("server-verified");

      runtime.reportStorageFailure(new Error("transient-idb-fault"));
      let state = runtime.getSnapshot();
      expect(state.phase === "server-verified" && state.storageHealth).toBe("degraded");

      const engine = runtime.materializer!;
      const { CompleteViewSource } = await import("../contracts");
      const { defineQueryView } = await import("../queryView");
      const view = defineQueryView({
        id: "recovery.notes/v2",
        query: {} as never,
        key: (_args: Record<string, never>) => "recovery:notes",
        rows: (granted: { notes: readonly { _id: string }[] }) => granted.notes,
        entityKey: (row: { _id: string }) => `note:${row._id}`,
      });
      const source = await CompleteViewSource.open(engine, view, {});
      await source.apply(source.capture(), {
        contractId: "recovery.notes/v2",
        viewKey: "recovery:notes",
        access: "granted",
        grantKeys: ["recovery-grant"],
        viewRevision: 1,
        coverage: { kind: "view-revision", revision: "1", revisionOrder: 1 },
        notes: [{ _id: "n1" }],
      });
      source.close();

      state = runtime.getSnapshot();
      expect(state.phase === "server-verified" && state.storageHealth).toBe("healthy");
      expect(runtime.canDispatch).toBe(true);
    } finally {
      await runtime.lock({ purge: true, removeActiveBinding: true, reason: "test-cleanup" });
      runtime.close();
      launcher.close();
      await Dexie.delete(launcherDatabaseName(deployment));
    }
  });
});

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
