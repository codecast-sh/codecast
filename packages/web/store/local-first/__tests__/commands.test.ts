import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { LocalFirstCommandRuntime } from "../commands";
import type {
  CommandReceiptRecord,
  CommandRecord,
  PrincipalStoreFence,
} from "../persistence/adapter";
import {
  DexiePrincipalStoreAdapter,
  principalDatabaseName,
} from "../persistence/dexieAdapter";
import {
  asGrantKey,
  asPrincipalId,
  asSourceEpoch,
  asSourceSequence,
  type OpaquePrincipalKey,
} from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

async function makeRuntime() {
  const principalKey = randomUUID() as OpaquePrincipalKey;
  const principalId = asPrincipalId("command-principal");
  const adapter = new DexiePrincipalStoreAdapter(
    principalDatabaseName(`commands-${randomUUID()}`, principalKey),
    principalKey,
  );
  const fence: PrincipalStoreFence = { principalKey, generation: 1 };
  await adapter.activateVerified(1, principalId);
  const writer = await adapter.claimViewWriter(fence, "view:commands", "commands.view/v1");
  const grantKey = asGrantKey("grant:commands");
  const view = (revision: number, sourceSequence: number) => ({
    key: "view:commands",
    contractId: "commands.view/v1",
    grantKeys: [grantKey],
    revision: String(revision),
    writerEpoch: writer.writerEpoch,
    sourceEpoch: asSourceEpoch("command-view-source"),
    sourceSequence: asSourceSequence(sourceSequence),
    coverage: {
      kind: "view-revision" as const,
      revision: String(revision),
      revisionOrder: revision,
    },
  });
  await adapter.commit(fence, [
    {
      kind: "put-grant",
      record: {
        key: grantKey,
        contractId: "commands.view/v1",
        scopeKey: "view:commands",
        grantedAt: 1,
      },
    },
    { kind: "replace-complete-view", view: view(1, 1), members: [], projections: [] },
  ]);
  const rejected: string[] = [];
  const runtime = new LocalFirstCommandRuntime(
    adapter,
    fence,
    principalId,
    undefined,
    (command) => rejected.push(command.id),
  );
  const queue = (id: string, replayPolicy: CommandRecord["replayPolicy"] = "server-deduplicated") =>
    runtime.queue({
      id,
      contractId: "commands.command/v1",
      commandType: "commands.change/v1",
      conflictKey: "view:commands",
      operationSchemaVersion: 1,
      targetGrantKeys: [grantKey],
      targetEntityKeys: [],
      replayPolicy,
      payload: { secret: id },
      requiredCoverage: {
        kind: "view-revision",
        contractId: "commands.view/v1",
        viewKey: "view:commands",
      },
      optimisticOperations: [{
        kind: "upsert-projection",
        viewKey: "view:commands",
        entityKey: `projection:${id}`,
        value: { id },
      }],
    });
  const acknowledgment = (commandId: string, minimumRevision: number): CommandReceiptRecord => ({
    commandId,
    principalId,
    commandType: "commands.change/v1",
    outcome: "acknowledged",
    receivedAt: 10,
    coverage: [{
      kind: "view-revision",
      contractId: "commands.view/v1",
      viewKey: "view:commands",
      minimumRevision: String(minimumRevision),
      minimumRevisionOrder: minimumRevision,
    }],
    retryUntil: null,
  });
  return {
    adapter,
    fence,
    principalId,
    grantKey,
    runtime,
    rejected,
    queue,
    view,
    acknowledgment,
    async close() { await adapter.purge(); },
  };
}

describe("durable command runtime", () => {
  test("receipt-before-view and view-before-receipt both retire optimism only after coverage", async () => {
    const fixture = await makeRuntime();
    try {
      const first = await fixture.runtime.markSending(await fixture.queue("receipt-first"));
      let settled = await fixture.runtime.settleReceipt(first, fixture.acknowledgment(first.id, 2));
      expect(settled).toMatchObject({
        status: "acknowledged-awaiting-coverage",
        optimisticActive: true,
      });

      await fixture.adapter.commit(fixture.fence, [{
        kind: "replace-complete-view",
        view: fixture.view(2, 2),
        members: [],
        projections: [],
      }]);
      settled = (await fixture.adapter.readCommand(fixture.fence, first.id))!;
      expect(settled).toMatchObject({ status: "reconciled", optimisticActive: false });

      const second = await fixture.runtime.markSending(await fixture.queue("view-first"));
      await fixture.adapter.commit(fixture.fence, [{
        kind: "replace-complete-view",
        view: fixture.view(3, 3),
        members: [],
        projections: [],
      }]);
      settled = await fixture.runtime.settleReceipt(second, fixture.acknowledgment(second.id, 3));
      expect(settled).toMatchObject({ status: "reconciled", optimisticActive: false });
    } finally {
      await fixture.close();
    }
  });

  test("canonical coverage recognizes a causally newer entity version", async () => {
    const fixture = await makeRuntime();
    try {
      const entityGrant = asGrantKey("grant:canonical-command");
      await fixture.adapter.commit(fixture.fence, [
        {
          kind: "put-grant",
          record: {
            key: entityGrant,
            contractId: "canonical/v1",
            scopeKey: "entity:task:one",
            grantedAt: 1,
          },
        },
        {
          kind: "put-entity",
          record: {
            key: "task:one",
            entityType: "task",
            entityId: "one",
            version: "v1",
            versionOrder: 1,
            canonicalOwnerContractId: "canonical/v1",
            grantKeys: [entityGrant],
            value: { title: "one" },
          },
        },
      ]);
      let command = await fixture.runtime.queue({
        id: "canonical-coverage",
        contractId: "canonical.command/v1",
        commandType: "canonical.change/v1",
        conflictKey: "task:one",
        operationSchemaVersion: 1,
        targetGrantKeys: [entityGrant],
        targetEntityKeys: ["task:one"],
        replayPolicy: "server-deduplicated",
        payload: {},
        requiredCoverage: { kind: "canonical-write-set", entityKeys: ["task:one"] },
        optimisticOperations: [{ kind: "set-entity-field", entityKey: "task:one", field: "title", value: "two" }],
      });
      command = await fixture.runtime.markSending(command);
      command = await fixture.runtime.settleReceipt(command, {
        commandId: command.id,
        principalId: fixture.principalId,
        commandType: command.commandType,
        outcome: "acknowledged",
        receivedAt: 10,
        coverage: [{
          kind: "canonical-write-set",
          entityVersions: { "task:one": { version: "v2", versionOrder: 2 } },
        }],
        retryUntil: null,
      });
      expect(command.status).toBe("acknowledged-awaiting-coverage");

      await fixture.adapter.commit(fixture.fence, [{
        kind: "put-entity",
        record: {
          key: "task:one",
          entityType: "task",
          entityId: "one",
          version: "v3",
          versionOrder: 3,
          canonicalOwnerContractId: "canonical/v1",
          grantKeys: [entityGrant],
          value: { title: "three" },
        },
      }]);
      expect((await fixture.adapter.readCommand(fixture.fence, command.id))).toMatchObject({
        status: "reconciled",
        optimisticActive: false,
      });
    } finally {
      await fixture.close();
    }
  });

  test("rejection is durable before its visible callback and retires the overlay", async () => {
    const fixture = await makeRuntime();
    try {
      const command = await fixture.runtime.markSending(await fixture.queue("rejected"));
      const settled = await fixture.runtime.settleReceipt(command, {
        commandId: command.id,
        principalId: fixture.principalId,
        commandType: command.commandType,
        outcome: "rejected",
        receivedAt: 10,
        rejection: { code: "forbidden", message: "No longer authorized" },
        coverage: [],
        retryUntil: null,
      });
      expect(settled).toMatchObject({ status: "rejected", optimisticActive: false });
      expect(fixture.rejected).toEqual([command.id]);
      expect((await fixture.adapter.readCommand(fixture.fence, command.id))?.status).toBe("rejected");
    } finally {
      await fixture.close();
    }
  });

  test("transport ambiguity reuses the same deduplicated ID and never replays non-replayable intent", async () => {
    const fixture = await makeRuntime();
    try {
      const replayable = await fixture.queue("same-id");
      const sentIds: string[] = [];
      await expect(fixture.runtime.drain({
        getReceipt: async () => null,
        send: async (command) => {
          sentIds.push(command.id);
          throw new Error("connection-lost-after-send");
        },
      })).rejects.toBeInstanceOf(AggregateError);
      expect((await fixture.adapter.readCommand(fixture.fence, replayable.id))?.status)
        .toBe("checking-receipt");

      await fixture.runtime.drain({
        getReceipt: async () => null,
        send: async (command) => {
          sentIds.push(command.id);
          return fixture.acknowledgment(command.id, 1);
        },
      });
      expect(sentIds).toEqual(["same-id", "same-id"]);
      expect((await fixture.adapter.readCommand(fixture.fence, replayable.id))?.status)
        .toBe("reconciled");

      const nonReplayable = await fixture.queue("never-replay", "non-replayable");
      let attempts = 0;
      await expect(fixture.runtime.drain({
        getReceipt: async () => null,
        send: async () => {
          attempts++;
          throw new Error("unknown-effect");
        },
      })).rejects.toBeInstanceOf(AggregateError);
      expect((await fixture.adapter.readCommand(fixture.fence, nonReplayable.id))?.status)
        .toBe("ambiguous");
      await fixture.runtime.drain({
        getReceipt: async () => { attempts++; return null; },
        send: async () => { attempts++; throw new Error("must-not-send"); },
      });
      expect(attempts).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
