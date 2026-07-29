import { describe, expect, test } from "bun:test";
import {
  asGrantKey,
  asPrincipalId,
  asSourceEpoch,
  asSourceSequence,
  type OpaquePrincipalKey,
  type WriterEpoch,
} from "../../types";
import {
  PrincipalStoreFenceError,
  PrincipalStoreIdentityError,
  type CommandCoverageRequirement,
  type CommandRecord,
  type EntityRecord,
  type PrincipalStoreAdapter,
  type ViewMemberRecord,
  type ViewProjectionRecord,
  type ViewRecord,
} from "../adapter";

export type AdapterContractFixture = {
  adapter: PrincipalStoreAdapter;
  principalKey: OpaquePrincipalKey;
  setFault(point: "after-operations" | "after-head-write" | null): void;
  reopen(): Promise<PrincipalStoreAdapter>;
};

const grant = (key: string) => asGrantKey(key);

function entity(
  id: string,
  versionOrder = 1,
  grantKeys: readonly string[] = [],
): EntityRecord {
  return {
    key: `task:${id}`,
    entityType: "task",
    entityId: id,
    version: `v${versionOrder}`,
    versionOrder,
    canonicalOwnerContractId: "tasks.canonical/v1",
    grantKeys: grantKeys.map(grant),
    value: { title: id, versionOrder },
  };
}

function view(
  key: string,
  contractId: string,
  writerEpoch: WriterEpoch,
  sequence: number,
  grantKeys: readonly string[],
  source = "source-a",
): ViewRecord {
  return {
    key,
    contractId,
    grantKeys: grantKeys.map(grant),
    revision: String(sequence),
    writerEpoch,
    sourceEpoch: asSourceEpoch(source),
    sourceSequence: asSourceSequence(sequence),
    coverage: { kind: "view-revision", revision: String(sequence), revisionOrder: sequence },
  };
}

function member(
  viewKey: string,
  entityKey: string,
  grantKeys: readonly string[],
  segmentKey = "complete",
): ViewMemberRecord {
  return {
    key: `${viewKey}\0${segmentKey}\0${entityKey}`,
    viewKey,
    entityKey,
    segmentKey,
    grantKeys: grantKeys.map(grant),
  };
}

function projection(
  viewKey: string,
  entityKey: string,
  value: unknown,
  segmentKey = "complete",
): ViewProjectionRecord {
  return {
    key: `${viewKey}\0${segmentKey}\0${entityKey}`,
    viewKey,
    entityKey,
    segmentKey,
    value,
  };
}

function command(
  id: string,
  principalId: ReturnType<typeof asPrincipalId>,
  targetGrantKeys: readonly string[],
  targetEntityKeys: readonly string[],
  requiredCoverage: CommandCoverageRequirement = {
    kind: "view-revision",
    contractId: "tasks.view/v1",
    viewKey: "view:tasks",
  },
): Omit<CommandRecord, "localSequence"> {
  return {
    id,
    principalId,
    contractId: "tasks.command/v1",
    commandType: "task.change/v1",
    conflictKey: targetEntityKeys[0] ?? id,
    status: "queued",
    createdAt: 1,
    operationSchemaVersion: 1,
    targetGrantKeys: targetGrantKeys.map(grant),
    targetEntityKeys,
    optimisticActive: true,
    replayPolicy: "server-deduplicated",
    payload: { private: id },
    requiredCoverage,
    optimisticOperations: [{ kind: "hide-entity", entityKey: targetEntityKeys[0] ?? id }],
  };
}

export function definePrincipalStoreAdapterContract(
  name: string,
  makeFixture: () => Promise<AdapterContractFixture>,
) {
  describe(`${name} principal-store contract`, () => {
    test("commits semantic data and local head atomically, then survives reopen", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      try {
        const initialized = await fixture.adapter.activateVerified(1, principalId);
        const fence = { principalKey: fixture.principalKey, generation: 1 };
        const commit = await fixture.adapter.commit(fence, [{ kind: "put-entity", record: entity("1") }]);
        expect(commit.head).toBe(initialized.head + 1);
        fixture.adapter.close();
        const reopened = await fixture.reopen();
        const metadata = await reopened.openOffline(fence);
        const snapshot = await reopened.readSnapshot(fence);
        expect(metadata.head).toBe(commit.head);
        expect(snapshot.entities).toEqual([entity("1")]);
        await reopened.purge();
      } finally {
        fixture.adapter.close();
      }
    });

    test("rolls back rows, writer claims, and head on injected transaction failures", async () => {
      const fixture = await makeFixture();
      try {
        const principalId = asPrincipalId("principal-a");
        const initialized = await fixture.adapter.activateVerified(1, principalId);
        const fence = { principalKey: fixture.principalKey, generation: 1 };
        fixture.setFault("after-head-write");
        await expect(fixture.adapter.commit(fence, [
          { kind: "put-entity", record: entity("bad") },
        ])).rejects.toThrow("injected-storage-fault");
        await expect(fixture.adapter.claimViewWriter(fence, "view:bad", "bad/v1"))
          .rejects.toThrow("injected-storage-fault");
        fixture.setFault(null);
        expect(await fixture.adapter.readHead(fence)).toBe(initialized.head);
        const snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.entities).toEqual([]);
        expect(snapshot.viewWriters).toEqual([]);
      } finally {
        fixture.setFault(null);
        await fixture.adapter.purge();
      }
    });

    test("fences stale generations and refuses cross-principal command records", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 4 };
      try {
        await fixture.adapter.activateVerified(4, principalId);
        await expect(fixture.adapter.commit(fence, [{
          kind: "queue-command",
          record: command("cmd-foreign", asPrincipalId("principal-b"), [], []),
        }])).rejects.toBeInstanceOf(PrincipalStoreIdentityError);

        await fixture.adapter.fence(4, 5);
        await expect(fixture.adapter.readHead(fence)).rejects.toBeInstanceOf(PrincipalStoreFenceError);
        await expect(fixture.adapter.commit(fence, [{
          kind: "put-sync-meta",
          record: { key: "late", grantKeys: [], value: true },
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
        await fixture.adapter.activateVerified(5, principalId);
        expect(await fixture.adapter.readHead({ ...fence, generation: 5 })).toBeGreaterThan(0);
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("queue authorization rejects invented and revoked opaque grants", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      try {
        await fixture.adapter.activateVerified(1, principalId);
        await expect(fixture.adapter.commit(fence, [{
          kind: "queue-command",
          record: command("cmd-invented", principalId, ["grant:invented"], ["task:x"]),
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
        await expect(fixture.adapter.commit(fence, [
          { kind: "put-grant", record: { key: grant("grant:synthetic"), contractId: "tasks.view/v1", scopeKey: "view:tasks", grantedAt: 1 } },
          {
            kind: "queue-command",
            record: command("cmd-synthetic", principalId, ["grant:synthetic"], ["task:x"]),
          },
        ])).rejects.toBeInstanceOf(PrincipalStoreFenceError);

        const writer = await fixture.adapter.claimViewWriter(fence, "view:tasks", "tasks.view/v1");
        await fixture.adapter.commit(fence, [
          { kind: "put-grant", record: { key: grant("grant:real"), contractId: "tasks.view/v1", scopeKey: "view:tasks", grantedAt: 1 } },
          {
            kind: "replace-complete-view",
            view: view("view:tasks", "tasks.view/v1", writer.writerEpoch, 1, ["grant:real"]),
            members: [],
            projections: [],
          },
        ]);
        await fixture.adapter.commit(fence, [{ kind: "revoke-grant", grantKey: "grant:real" }]);
        await expect(fixture.adapter.commit(fence, [{
          kind: "queue-command",
          record: command("cmd-revoked", principalId, ["grant:real"], ["task:x"]),
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
        expect((await fixture.adapter.readSnapshot(fence)).commands).toEqual([]);
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("complete replacement releases omitted/rotated grants but preserves shared references", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      try {
        await fixture.adapter.activateVerified(1, principalId);
        const writerA = await fixture.adapter.claimViewWriter(fence, "view:a", "a/v1");
        const writerB = await fixture.adapter.claimViewWriter(fence, "view:b", "b/v1");
        await fixture.adapter.commit(fence, [
          { kind: "put-entity", record: entity("shared") },
          { kind: "put-entity", record: entity("omitted") },
          { kind: "put-grant", record: { key: grant("grant:a"), contractId: "a/v1", scopeKey: "view:a", grantedAt: 1 } },
          { kind: "put-grant", record: { key: grant("grant:b"), contractId: "b/v1", scopeKey: "view:b", grantedAt: 1 } },
          {
            kind: "replace-complete-view",
            view: view("view:a", "a/v1", writerA.writerEpoch, 1, ["grant:a"]),
            members: [
              member("view:a", "task:shared", ["grant:a"]),
              member("view:a", "task:omitted", ["grant:a"]),
            ],
            projections: [projection("view:a", "task:omitted", { rank: 1 })],
          },
          {
            kind: "replace-complete-view",
            view: view("view:b", "b/v1", writerB.writerEpoch, 1, ["grant:b"], "source-b"),
            members: [member("view:b", "task:shared", ["grant:b"])],
            projections: [],
          },
        ]);

        await fixture.adapter.commit(fence, [
          { kind: "put-grant", record: { key: grant("grant:c"), contractId: "a/v1", scopeKey: "view:a", grantedAt: 2 } },
          {
            kind: "replace-complete-view",
            view: view("view:a", "a/v1", writerA.writerEpoch, 2, ["grant:c"]),
            members: [member("view:a", "task:shared", ["grant:c"])],
            projections: [],
          },
        ]);
        let snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.grants.map((row) => row.key).sort()).toEqual(["grant:b", "grant:c"]);
        expect(snapshot.viewMembers.some((row) => row.entityKey === "task:omitted")).toBe(false);
        expect(snapshot.viewProjections).toEqual([]);
        expect(snapshot.entities.map((row) => row.key).sort()).toEqual(["task:omitted", "task:shared"]);

        // Omission made the canonical row ordinary-GC eligible without
        // confusing it with an authoritative deletion.
        await fixture.adapter.commit(fence, [{ kind: "garbage-collect-entity", key: "task:omitted" }]);
        snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.entities.map((row) => row.key)).toEqual(["task:shared"]);
        expect(snapshot.viewMembers.filter((row) => row.entityKey === "task:shared")).toHaveLength(2);
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("revoking only the final grant purges data and retires command overlays", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      try {
        await fixture.adapter.activateVerified(1, principalId);
        const writer = await fixture.adapter.claimViewWriter(fence, "view:tasks", "tasks.view/v1");
        const queued = command("queued-a", principalId, ["grant:a"], ["task:a"]);
        const sending = command("sending-a", principalId, ["grant:a"], ["task:a"]);
        const shared = command("queued-shared", principalId, ["grant:a", "grant:b"], ["task:shared"]);
        await fixture.adapter.commit(fence, [
          { kind: "put-entity", record: entity("a") },
          { kind: "put-entity", record: entity("shared") },
          { kind: "put-entity", record: entity("direct", 1, ["grant:a"]) },
          { kind: "put-grant", record: { key: grant("grant:a"), contractId: "tasks.view/v1", scopeKey: "view:tasks", grantedAt: 1 } },
          { kind: "put-grant", record: { key: grant("grant:b"), contractId: "tasks.view/v1", scopeKey: "view:tasks", grantedAt: 1 } },
          {
            kind: "replace-complete-view",
            view: view("view:tasks", "tasks.view/v1", writer.writerEpoch, 1, ["grant:a", "grant:b"]),
            members: [
              member("view:tasks", "task:a", ["grant:a"]),
              member("view:tasks", "task:shared", ["grant:a", "grant:b"]),
            ],
            projections: [
              projection("view:tasks", "task:a", { secret: "a" }),
              projection("view:tasks", "task:shared", { secret: "shared" }),
            ],
          },
          { kind: "put-sync-meta", record: { key: "sync:a", grantKeys: [grant("grant:a")], value: "private" } },
        ]);
        await expect(fixture.adapter.commit(fence, [
          { kind: "queue-command", record: queued },
          { kind: "queue-command", record: sending },
        ])).rejects.toThrow("A commit may queue only one durable command");
        await fixture.adapter.commit(fence, [{ kind: "queue-command", record: queued }]);
        await fixture.adapter.commit(fence, [{ kind: "queue-command", record: sending }]);
        await fixture.adapter.commit(fence, [{ kind: "queue-command", record: shared }]);
        const queuedSending = await fixture.adapter.readCommand(fence, sending.id);
        expect(queuedSending).not.toBeNull();
        expect(new Set((await fixture.adapter.readSnapshot(fence)).commands
          .map((row) => row.localSequence)).size).toBe(3);
        await fixture.adapter.commit(fence, [{
          kind: "put-command",
          record: { ...queuedSending!, status: "sending" },
        }]);

        await fixture.adapter.commit(fence, [{ kind: "revoke-grant", grantKey: "grant:a" }]);
        const snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.entities.map((row) => row.key).sort()).toEqual(["task:shared"]);
        expect(snapshot.viewMembers.map((row) => [row.entityKey, row.grantKeys])).toEqual([
          ["task:shared", ["grant:b"]],
        ]);
        expect(snapshot.viewProjections.map((row) => row.entityKey)).toEqual(["task:shared"]);
        expect(snapshot.syncMetadata).toEqual([]);
        expect(snapshot.grants.map((row) => row.key)).toEqual(["grant:b"]);
        const byId = Object.fromEntries(snapshot.commands.map((row) => [row.id, row]));
        expect(byId["queued-a"]).toMatchObject({ status: "blocked", optimisticActive: false, payload: null });
        expect(byId["queued-a"].optimisticOperations).toEqual([]);
        expect(byId["sending-a"]).toMatchObject({ status: "ambiguous", optimisticActive: false, payload: null });
        expect(byId["queued-shared"]).toMatchObject({ status: "queued", optimisticActive: true });
        expect(byId["queued-shared"].targetGrantKeys).toEqual(["grant:b"]);
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("forbidden view clear keeps membership evidence until its final-grant purge completes", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      try {
        await fixture.adapter.activateVerified(1, principalId);
        const writer = await fixture.adapter.claimViewWriter(fence, "view:secure", "secure/v1");
        await fixture.adapter.commit(fence, [
          { kind: "put-entity", record: entity("membership-only") },
          { kind: "put-grant", record: { key: grant("grant:secure"), contractId: "secure/v1", scopeKey: "view:secure", grantedAt: 1 } },
          {
            kind: "replace-complete-view",
            view: view("view:secure", "secure/v1", writer.writerEpoch, 1, ["grant:secure"]),
            members: [member("view:secure", "task:membership-only", ["grant:secure"])],
            projections: [projection("view:secure", "task:membership-only", { secret: true })],
          },
          {
            kind: "queue-command",
            record: command(
              "queued-secure",
              principalId,
              ["grant:secure"],
              ["task:membership-only"],
              { kind: "view-revision", contractId: "secure/v1", viewKey: "view:secure" },
            ),
          },
        ]);

        await fixture.adapter.commit(fence, [{
          kind: "clear-authoritative-view",
          record: {
            key: "view:secure",
            contractId: "secure/v1",
            writerEpoch: writer.writerEpoch,
            sourceEpoch: asSourceEpoch("source-a"),
            sourceSequence: asSourceSequence(2),
            coverage: { kind: "none" },
            access: "forbidden",
            revokedGrantKeys: [grant("grant:secure")],
          },
        }]);

        const snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.views).toEqual([]);
        expect(snapshot.viewMembers).toEqual([]);
        expect(snapshot.viewProjections).toEqual([]);
        expect(snapshot.entities).toEqual([]);
        expect(snapshot.grants).toEqual([]);
        expect(snapshot.commands[0]).toMatchObject({
          id: "queued-secure",
          status: "blocked",
          optimisticActive: false,
          payload: null,
          targetGrantKeys: [],
          targetEntityKeys: [],
        });
        expect(snapshot.commands[0].optimisticOperations).toEqual([]);
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("a revocation still purges after a reload re-claims the writer", async () => {
      // The reload sequence: the view was granted under writer W, the tab
      // closed, access was revoked server-side, and reopening claims writer
      // W+1 before the first authoritative result arrives as forbidden with
      // no comparable coverage. That clear must purge — rejecting it would
      // leave revoked content rendering from the offline cache forever.
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      try {
        await fixture.adapter.activateVerified(1, principalId);
        const writer = await fixture.adapter.claimViewWriter(fence, "view:secure", "secure/v1");
        await fixture.adapter.commit(fence, [
          { kind: "put-entity", record: entity("revoked-later") },
          { kind: "put-grant", record: { key: grant("grant:secure"), contractId: "secure/v1", scopeKey: "view:secure", grantedAt: 1 } },
          {
            kind: "replace-complete-view",
            view: view("view:secure", "secure/v1", writer.writerEpoch, 1, ["grant:secure"]),
            members: [member("view:secure", "task:revoked-later", ["grant:secure"])],
            projections: [projection("view:secure", "task:revoked-later", { secret: true })],
          },
        ]);

        const successor = await fixture.adapter.claimViewWriter(fence, "view:secure", "secure/v1");
        expect(successor.writerEpoch).not.toBe(writer.writerEpoch);
        await fixture.adapter.commit(fence, [{
          kind: "clear-authoritative-view",
          record: {
            key: "view:secure",
            contractId: "secure/v1",
            writerEpoch: successor.writerEpoch,
            sourceEpoch: asSourceEpoch("source-b"),
            sourceSequence: asSourceSequence(1),
            coverage: { kind: "none" },
            access: "forbidden",
            revokedGrantKeys: [grant("grant:secure")],
          },
        }]);

        const snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.views).toEqual([]);
        expect(snapshot.viewMembers).toEqual([]);
        expect(snapshot.viewProjections).toEqual([]);
        expect(snapshot.entities).toEqual([]);
        expect(snapshot.grants).toEqual([]);

        // The relaxation is scoped to deletions: a GRANTED payload from a
        // successor writer without comparable coverage is still fenced.
        const another = await fixture.adapter.claimViewWriter(fence, "view:secure", "secure/v1");
        await expect(fixture.adapter.commit(fence, [{
          kind: "replace-complete-view",
          view: {
            ...view("view:secure", "secure/v1", another.writerEpoch, 1, [], "source-c"),
            coverage: { kind: "none" },
          },
          members: [],
          projections: [],
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("release is not security revocation and explicit tombstones own canonical deletion", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      try {
        await fixture.adapter.activateVerified(1, principalId);
        await fixture.adapter.commit(fence, [
          { kind: "put-grant", record: { key: grant("grant:a"), contractId: "tasks/v1", scopeKey: "a", grantedAt: 1 } },
          { kind: "put-entity", record: entity("one", 1, ["grant:a"]) },
          {
            kind: "queue-command",
            record: command(
              "keep-command",
              principalId,
              ["grant:a"],
              ["task:one"],
              { kind: "canonical-write-set", entityKeys: ["task:one"] },
            ),
          },
          { kind: "release-grant", grantKey: "grant:a" },
        ]);
        let snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.entities).toHaveLength(1);
        expect(snapshot.entities[0].grantKeys).toEqual([]);
        expect(snapshot.commands[0]).toMatchObject({ status: "queued", optimisticActive: true });

        await fixture.adapter.commit(fence, [{
          kind: "put-entity-tombstone",
          record: {
            key: "task:one",
            entityType: "task",
            entityId: "one",
            tombstoneVersion: "v2",
            tombstoneVersionOrder: 2,
            deletionOwnerContractId: "tasks.canonical/v1",
          },
        }]);
        await expect(fixture.adapter.commit(fence, [
          { kind: "put-entity", record: entity("one", 1) },
        ])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
        await fixture.adapter.commit(fence, [{ kind: "put-entity", record: entity("one", 3) }]);
        snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.entities[0].version).toBe("v3");
        expect(snapshot.entityTombstones).toEqual([]);
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("durable writer claims reject equal-sequence rewrites and stale grants after clear", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      try {
        await fixture.adapter.activateVerified(1, principalId);
        const first = await fixture.adapter.claimViewWriter(fence, "view:secure", "secure/v1");
        await fixture.adapter.commit(fence, [
          { kind: "put-grant", record: { key: grant("grant:a"), contractId: "secure/v1", scopeKey: "view:secure", grantedAt: 1 } },
          {
            kind: "replace-complete-view",
            view: view("view:secure", "secure/v1", first.writerEpoch, 1, ["grant:a"]),
            members: [member("view:secure", "projection:a", ["grant:a"])],
            projections: [projection("view:secure", "projection:a", { value: "first" })],
          },
        ]);
        await expect(fixture.adapter.commit(fence, [{
          kind: "replace-complete-view",
          view: view("view:secure", "secure/v1", first.writerEpoch, 1, ["grant:a"]),
          members: [member("view:secure", "projection:b", ["grant:a"])],
          projections: [projection("view:secure", "projection:b", { value: "changed" })],
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);

        await fixture.adapter.commit(fence, [{
          kind: "clear-authoritative-view",
          record: {
            key: "view:secure",
            contractId: "secure/v1",
            writerEpoch: first.writerEpoch,
            sourceEpoch: asSourceEpoch("source-a"),
            sourceSequence: asSourceSequence(2),
            coverage: { kind: "none" },
            access: "forbidden",
            revokedGrantKeys: [grant("grant:a")],
          },
        }]);
        await expect(fixture.adapter.commit(fence, [{
          kind: "replace-complete-view",
          view: view("view:secure", "secure/v1", first.writerEpoch, 3, ["grant:a"]),
          members: [member("view:secure", "projection:a", ["grant:a"])],
          projections: [],
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
        expect((await fixture.adapter.readSnapshot(fence)).views).toEqual([]);

        const successor = await fixture.adapter.claimViewWriter(fence, "view:secure", "secure/v1");
        expect(successor.writerEpoch).toBeGreaterThan(first.writerEpoch);
        // The view row is gone, but its durable coverage/access high-water mark
        // is not. A cache value acquired before the claim cannot resurrect the
        // forbidden scope merely because this is the successor's first result.
        await expect(fixture.adapter.commit(fence, [
          { kind: "put-grant", record: { key: grant("grant:a"), contractId: "secure/v1", scopeKey: "view:secure", grantedAt: 2 } },
          {
            kind: "replace-complete-view",
            view: view("view:secure", "secure/v1", successor.writerEpoch, 1, ["grant:a"], "successor"),
            members: [member("view:secure", "projection:stale", ["grant:a"])],
            projections: [],
          },
        ])).rejects.toThrow("Equal server coverage cannot change authoritative access state");
        expect((await fixture.adapter.readSnapshot(fence)).grants).toEqual([]);

        // A genuinely newer authoritative result can restore access.
        await fixture.adapter.commit(fence, [
          { kind: "put-grant", record: { key: grant("grant:a"), contractId: "secure/v1", scopeKey: "view:secure", grantedAt: 3 } },
          {
            kind: "replace-complete-view",
            view: view("view:secure", "secure/v1", successor.writerEpoch, 2, ["grant:a"], "successor"),
            members: [member("view:secure", "projection:fresh", ["grant:a"])],
            projections: [],
          },
        ]);
        expect((await fixture.adapter.readSnapshot(fence)).viewMembers
          .map((row) => row.entityKey)).toEqual(["projection:fresh"]);
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("a successor writer cannot overwrite a newer server revision or diverge at equality", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      try {
        await fixture.adapter.activateVerified(1, principalId);
        const first = await fixture.adapter.claimViewWriter(fence, "view:monotonic", "monotonic/v1");
        await fixture.adapter.commit(fence, [
          { kind: "put-grant", record: { key: grant("grant:monotonic"), contractId: "monotonic/v1", scopeKey: "view:monotonic", grantedAt: 1 } },
          {
            kind: "replace-complete-view",
            view: view("view:monotonic", "monotonic/v1", first.writerEpoch, 10, ["grant:monotonic"]),
            members: [member("view:monotonic", "projection:new", ["grant:monotonic"])],
            projections: [projection("view:monotonic", "projection:new", { value: "new" })],
          },
        ]);

        // Models a second tab acquiring the durable writer after the first tab
        // already committed revision 10, then observing an older cached query
        // result as its first callback.
        const successor = await fixture.adapter.claimViewWriter(
          fence,
          "view:monotonic",
          "monotonic/v1",
        );
        await expect(fixture.adapter.commit(fence, [{
          kind: "replace-complete-view",
          view: view("view:monotonic", "monotonic/v1", successor.writerEpoch, 9, ["grant:monotonic"], "successor"),
          members: [member("view:monotonic", "projection:old", ["grant:monotonic"])],
          projections: [projection("view:monotonic", "projection:old", { value: "old" })],
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
        await expect(fixture.adapter.commit(fence, [{
          kind: "replace-complete-view",
          view: view("view:monotonic", "monotonic/v1", successor.writerEpoch, 10, ["grant:monotonic"], "successor"),
          members: [member("view:monotonic", "projection:divergent", ["grant:monotonic"])],
          projections: [projection("view:monotonic", "projection:divergent", { value: "divergent" })],
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);

        let snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.views[0].revision).toBe("10");
        expect(snapshot.viewMembers.map((row) => row.entityKey)).toEqual(["projection:new"]);
        expect(snapshot.viewProjections[0].value).toEqual({ value: "new" });

        // Equality is permitted only as an idempotent bootstrap of the exact
        // same authoritative content under the successor's local fences.
        await fixture.adapter.commit(fence, [{
          kind: "replace-complete-view",
          view: view("view:monotonic", "monotonic/v1", successor.writerEpoch, 10, ["grant:monotonic"], "successor"),
          members: [member("view:monotonic", "projection:new", ["grant:monotonic"])],
          projections: [projection("view:monotonic", "projection:new", { value: "new" })],
        }]);
        snapshot = await fixture.adapter.readSnapshot(fence);
        expect(snapshot.views[0].writerEpoch).toBe(successor.writerEpoch);
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("ordered delta cursor compare-and-swap rejects gaps, duplicates, and non-advancing cursors", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-a");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      const cursor = (value: string, sequence: number) => ({
        key: "tasks:delta",
        contractId: "tasks.delta/v1",
        cursor: value,
        sourceEpoch: asSourceEpoch("delta-source"),
        sourceSequence: asSourceSequence(sequence),
        coverage: { kind: "none" } as const,
      });
      try {
        await fixture.adapter.activateVerified(1, principalId);
        await fixture.adapter.commit(fence, [{
          kind: "put-delta-cursor",
          expectedCursor: null,
          record: cursor("cursor-1", 1),
        }]);
        await expect(fixture.adapter.commit(fence, [{
          kind: "put-delta-cursor",
          expectedCursor: "wrong",
          record: cursor("cursor-2", 2),
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
        await expect(fixture.adapter.commit(fence, [{
          kind: "put-delta-cursor",
          expectedCursor: "cursor-1",
          record: cursor("cursor-1", 2),
        }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
        expect((await fixture.adapter.readSnapshot(fence)).deltaCursors[0].cursor).toBe("cursor-1");
      } finally {
        await fixture.adapter.purge();
      }
    });

    test("inspection exposes protocol health without protected payloads", async () => {
      const fixture = await makeFixture();
      const principalId = asPrincipalId("principal-inspection-secret");
      const fence = { principalKey: fixture.principalKey, generation: 1 };
      try {
        await fixture.adapter.activateVerified(1, principalId);
        const writer = await fixture.adapter.claimViewWriter(
          fence,
          "view:inspection",
          "inspection/v1",
        );
        const inspectedCommand = {
          ...command(
            "cmd-inspection",
            principalId,
            ["grant:inspection"],
            ["task:inspection"],
            { kind: "view-revision", contractId: "inspection/v1", viewKey: "view:inspection" },
          ),
          createdAt: 25,
          payload: { private: "COMMAND-PAYLOAD-MUST-NOT-LEAK" },
          optimisticOperations: [{
            kind: "upsert-projection" as const,
            viewKey: "view:inspection",
            entityKey: "task:inspection",
            value: { private: "OPTIMISM-MUST-NOT-LEAK" },
          }],
        };
        await fixture.adapter.commit(fence, [
          {
            kind: "put-entity",
            record: {
              ...entity("inspection"),
              value: { private: "ENTITY-PAYLOAD-MUST-NOT-LEAK" },
            },
          },
          { kind: "put-grant", record: { key: grant("grant:inspection"), contractId: "inspection/v1", scopeKey: "view:inspection", grantedAt: 1 } },
          {
            kind: "replace-complete-view",
            view: view("view:inspection", "inspection/v1", writer.writerEpoch, 1, ["grant:inspection"]),
            members: [member("view:inspection", "task:inspection", ["grant:inspection"])],
            projections: [projection("view:inspection", "task:inspection", {
              private: "PROJECTION-MUST-NOT-LEAK",
            })],
          },
          { kind: "queue-command", record: inspectedCommand },
          {
            kind: "put-legacy-collection",
            record: {
              key: "sessions\0secret",
              collection: "sessions",
              rowId: "secret",
              value: { private: "LEGACY-PAYLOAD-MUST-NOT-LEAK" },
            },
          },
          {
            kind: "put-conversation-messages",
            record: {
              conversationId: "conversation-secret",
              messages: [{ content: "MESSAGE-PAYLOAD-MUST-NOT-LEAK" }],
              pagination: {},
              latestTimestamp: 1,
            },
          },
        ]);

        const inspection = await fixture.adapter.inspect(fence, 100);
        expect(inspection.schemaVersion).toBe(3);
        expect(inspection.views).toEqual([{
          key: "view:inspection",
          contractId: "inspection/v1",
          revision: "1",
          writerEpoch: writer.writerEpoch,
          sourceEpoch: asSourceEpoch("source-a"),
          sourceSequence: asSourceSequence(1),
          access: "granted",
        }]);
        expect(inspection.commands).toEqual([{
          id: "cmd-inspection",
          type: "task.change/v1",
          status: "queued",
          ageMs: 75,
        }]);
        expect(inspection.grantCount).toBe(1);
        expect(inspection.legacy).toEqual({
          collectionRowCount: 1,
          metaRowCount: 0,
          outboxCount: 0,
          conversationCacheCount: 1,
        });
        const serialized = JSON.stringify(inspection);
        for (const secret of [
          "principal-inspection-secret",
          "ENTITY-PAYLOAD-MUST-NOT-LEAK",
          "PROJECTION-MUST-NOT-LEAK",
          "COMMAND-PAYLOAD-MUST-NOT-LEAK",
          "OPTIMISM-MUST-NOT-LEAK",
          "LEGACY-PAYLOAD-MUST-NOT-LEAK",
          "MESSAGE-PAYLOAD-MUST-NOT-LEAK",
          "conversation-secret",
        ]) expect(serialized).not.toContain(secret);
      } finally {
        await fixture.adapter.purge();
      }
    });
  });
}
