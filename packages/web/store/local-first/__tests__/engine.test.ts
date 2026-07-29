import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { LocalFirstCommandRuntime } from "../commands";
import {
  CompleteViewSource,
  defineCompleteView,
  type CompleteViewContractResult,
} from "../contracts";
import { LocalFirstEngine, StaleLocalFirstSourceError } from "../engine";
import {
  DexiePrincipalStoreAdapter,
  principalDatabaseName,
  type DexieFaultPoint,
} from "../persistence/dexieAdapter";
import {
  asGrantKey,
  asPrincipalEpoch,
  asPrincipalId,
  asSourceEpoch,
  type OpaquePrincipalKey,
} from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

type ProjectionResult =
  | { contractId: "projection/v1"; viewKey: "view:projection"; access: "unavailable" }
  | {
      contractId: "projection/v1";
      viewKey: "view:projection";
      access: "granted";
      grantKeys: readonly string[];
      revision: number;
      rows: readonly { id: string; privateValue: string }[];
    };

const projectionContract = defineCompleteView({
  id: "projection/v1",
  storage: "projection",
  key: (_args: Record<string, never>) => "view:projection",
  decode(result: ProjectionResult): CompleteViewContractResult<{ id: string; privateValue: string }> {
    if (result.access === "unavailable") return result;
    return {
      contractId: result.contractId,
      viewKey: result.viewKey,
      access: "granted",
      grantKeys: result.grantKeys,
      coverage: {
        kind: "view-revision",
        revision: String(result.revision),
        revisionOrder: result.revision,
      },
      rows: result.rows,
    };
  },
  normalize(row: { id: string; privateValue: string }, context) {
    return {
      entityKey: `projection:${row.id}`,
      grantKeys: context.grantKeys,
      projection: { privateValue: row.privateValue },
    };
  },
});

type CanonicalResult =
  | {
      contractId: "canonical/v1";
      viewKey: "view:canonical";
      access: "granted";
      grantKeys: readonly string[];
      revision: number;
      rows: readonly { id: string; version: number; title: string }[];
    }
  | {
      contractId: "canonical/v1";
      viewKey: "view:canonical";
      access: "forbidden";
      revokedGrantKeys: readonly string[];
    };

const canonicalContract = defineCompleteView({
  id: "canonical/v1",
  storage: "canonical",
  key: (_args: Record<string, never>) => "view:canonical",
  decode(result: CanonicalResult): CompleteViewContractResult<{
    id: string;
    version: number;
    title: string;
  }> {
    if (result.access === "forbidden") return result;
    return {
      contractId: result.contractId,
      viewKey: result.viewKey,
      access: "granted",
      grantKeys: result.grantKeys,
      coverage: {
        kind: "view-revision",
        revision: String(result.revision),
        revisionOrder: result.revision,
      },
      rows: result.rows,
    };
  },
  normalize(row: { id: string; version: number; title: string }, context) {
    return {
      entityType: "task",
      entityId: row.id,
      entityVersion: String(row.version),
      entityVersionOrder: row.version,
      canonicalOwnerContractId: "canonical/v1",
      grantKeys: context.grantKeys,
      value: { title: row.title },
    };
  },
});

async function makeEngine() {
  const principalKey = randomUUID() as OpaquePrincipalKey;
  const name = principalDatabaseName(`engine-${randomUUID()}`, principalKey);
  let fault: DexieFaultPoint | null = null;
  const failures: unknown[] = [];
  let sourceEpoch = 0;
  const adapter = new DexiePrincipalStoreAdapter(name, principalKey, (point) => {
    if (point === fault) throw new Error("engine-storage-fault");
  });
  const principalId = asPrincipalId("engine-principal");
  const fence = { principalKey, generation: 1 };
  const metadata = await adapter.activateVerified(1, principalId);
  const engine = new LocalFirstEngine({
    adapter,
    fence,
    principalId,
    principalEpoch: asPrincipalEpoch(1),
    initialHead: metadata.head,
    sourceEpochFactory: () => asSourceEpoch(`engine-source-${++sourceEpoch}`),
    channelFactory: () => null,
    onStorageFailure: (error) => failures.push(error),
  });
  return {
    adapter,
    engine,
    fence,
    principalId,
    failures,
    setFault(next: DexieFaultPoint | null) { fault = next; },
    async close() {
      engine.close();
      await adapter.purge();
    },
  };
}

describe("typed local-first materializer", () => {
  test("projection contracts never fabricate canonical entities and stale callbacks cannot win", async () => {
    const fixture = await makeEngine();
    try {
      const source = await CompleteViewSource.open(fixture.engine, projectionContract, {});
      const older = source.capture();
      const newer = source.capture();
      let published = 0;
      await source.apply(newer, {
        contractId: "projection/v1",
        viewKey: "view:projection",
        access: "granted",
        grantKeys: ["grant:projection"],
        revision: 2,
        rows: [{ id: "two", privateValue: "newer" }],
      }, () => { published++; });
      await expect(source.apply(older, {
        contractId: "projection/v1",
        viewKey: "view:projection",
        access: "granted",
        grantKeys: ["grant:projection"],
        revision: 1,
        rows: [{ id: "one", privateValue: "older" }],
      })).rejects.toBeInstanceOf(StaleLocalFirstSourceError);

      const snapshot = await fixture.adapter.readSnapshot(fixture.fence);
      expect(snapshot.entities).toEqual([]);
      expect(snapshot.viewMembers.map((row) => row.entityKey)).toEqual(["projection:two"]);
      expect(snapshot.viewProjections.map((row) => row.value)).toEqual([{
        privateValue: "newer",
      }]);
      expect(published).toBe(1);

      const retainedHead = snapshot.metadata.head;
      expect(await source.apply(source.capture(), {
        contractId: "projection/v1",
        viewKey: "view:projection",
        access: "unavailable",
      })).toBeNull();
      expect((await fixture.adapter.readHead(fixture.fence))).toBe(retainedHead);
    } finally {
      await fixture.close();
    }
  });

  test("a storage rollback never publishes an in-memory commit", async () => {
    const fixture = await makeEngine();
    try {
      const source = await CompleteViewSource.open(fixture.engine, projectionContract, {});
      const headBefore = await fixture.adapter.readHead(fixture.fence);
      fixture.setFault("after-head-write");
      let published = false;
      await expect(source.apply(source.capture(), {
        contractId: "projection/v1",
        viewKey: "view:projection",
        access: "granted",
        grantKeys: ["grant:projection"],
        revision: 1,
        rows: [{ id: "one", privateValue: "must-rollback" }],
      }, () => { published = true; })).rejects.toThrow("engine-storage-fault");
      fixture.setFault(null);

      expect(published).toBe(false);
      expect(fixture.failures).toHaveLength(1);
      expect(await fixture.adapter.readHead(fixture.fence)).toBe(headBefore);
      expect((await fixture.adapter.readSnapshot(fixture.fence)).views).toEqual([]);
    } finally {
      fixture.setFault(null);
      await fixture.close();
    }
  });

  test("forbidden apply atomically purges membership-only canonical data and optimism", async () => {
    const fixture = await makeEngine();
    try {
      const source = await CompleteViewSource.open(fixture.engine, canonicalContract, {});
      await source.apply(source.capture(), {
        contractId: "canonical/v1",
        viewKey: "view:canonical",
        access: "granted",
        grantKeys: ["grant:canonical"],
        revision: 1,
        rows: [{ id: "one", version: 1, title: "protected" }],
      });
      const commands = new LocalFirstCommandRuntime(
        fixture.adapter,
        fixture.fence,
        fixture.principalId,
      );
      await commands.queue({
        id: "command-before-revoke",
        contractId: "task.command/v1",
        commandType: "task.rename/v1",
        conflictKey: "task:one",
        operationSchemaVersion: 1,
        targetGrantKeys: [asGrantKey("grant:canonical")],
        targetEntityKeys: ["task:one"],
        replayPolicy: "server-deduplicated",
        payload: { title: "optimistic" },
        requiredCoverage: {
          kind: "view-revision",
          contractId: "canonical/v1",
          viewKey: "view:canonical",
        },
        optimisticOperations: [{ kind: "set-entity-field", entityKey: "task:one", field: "title", value: "optimistic" }],
      });

      await source.apply(source.capture(), {
        contractId: "canonical/v1",
        viewKey: "view:canonical",
        access: "forbidden",
        revokedGrantKeys: ["grant:canonical"],
      });
      const snapshot = await fixture.adapter.readSnapshot(fixture.fence);
      expect(snapshot.entities).toEqual([]);
      expect(snapshot.views).toEqual([]);
      expect(snapshot.grants).toEqual([]);
      expect(snapshot.commands[0]).toMatchObject({
        id: "command-before-revoke",
        status: "blocked",
        optimisticActive: false,
        payload: null,
      });
      expect(snapshot.commands[0].optimisticOperations).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
