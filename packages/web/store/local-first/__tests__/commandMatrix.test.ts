import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { LocalFirstCommandRuntime } from "../commands";
import { CompleteViewSource } from "../contracts";
import { LocalFirstEngine } from "../engine";
import { defineQueryView } from "../queryView";
import { selectVisibleMaterializedView } from "../visibleView";
import {
  PrincipalStoreFenceError,
  PrincipalStoreIdentityError,
  type CommandReceiptRecord,
  type CommandRecord,
  type PrincipalStoreFence,
} from "../persistence/adapter";
import {
  DexiePrincipalStoreAdapter,
  principalDatabaseName,
} from "../persistence/dexieAdapter";
import {
  asGrantKey,
  asPrincipalEpoch,
  asPrincipalId,
  asSourceEpoch,
  asSourceSequence,
  type OpaquePrincipalKey,
} from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const VIEW_KEY = "view:cmd-matrix";
const CONTRACT = "cmd-matrix.view/v1";

async function makeFixture() {
  const principalKey = randomUUID() as OpaquePrincipalKey;
  const principalId = asPrincipalId("cmd-matrix-principal");
  const name = principalDatabaseName(`cmd-matrix-${randomUUID()}`, principalKey);
  const adapter = new DexiePrincipalStoreAdapter(name, principalKey);
  const fence: PrincipalStoreFence = { principalKey, generation: 1 };
  await adapter.activateVerified(1, principalId);
  const writer = await adapter.claimViewWriter(fence, VIEW_KEY, CONTRACT);
  const grantKey = asGrantKey("grant:cmd-matrix");
  const view = (revision: number, sequence: number, epoch = writer.writerEpoch) => ({
    key: VIEW_KEY,
    contractId: CONTRACT,
    grantKeys: [grantKey],
    revision: String(revision),
    writerEpoch: epoch,
    sourceEpoch: asSourceEpoch("cmd-matrix-source"),
    sourceSequence: asSourceSequence(sequence),
    coverage: {
      kind: "view-revision" as const,
      revision: String(revision),
      revisionOrder: revision,
    },
  });
  await adapter.commit(fence, [
    {
      kind: "put-grant",
      record: { key: grantKey, contractId: CONTRACT, scopeKey: VIEW_KEY, grantedAt: 1 },
    },
    { kind: "replace-complete-view", view: view(1, 1), members: [], projections: [] },
  ]);
  const storageFailures: unknown[] = [];
  const runtime = new LocalFirstCommandRuntime(
    adapter,
    fence,
    principalId,
    (error) => storageFailures.push(error),
  );
  const queue = (
    id: string,
    overrides: Partial<Parameters<LocalFirstCommandRuntime["queue"]>[0]> = {},
  ) =>
    runtime.queue({
      id,
      contractId: "cmd-matrix.command/v1",
      commandType: "cmd-matrix.change/v1",
      conflictKey: VIEW_KEY,
      operationSchemaVersion: 1,
      targetGrantKeys: [grantKey],
      targetEntityKeys: [],
      replayPolicy: "server-deduplicated",
      payload: { secret: id },
      requiredCoverage: {
        kind: "view-revision",
        contractId: CONTRACT,
        viewKey: VIEW_KEY,
      },
      optimisticOperations: [{
        kind: "upsert-projection",
        viewKey: VIEW_KEY,
        entityKey: `projection:${id}`,
        value: { id, optimistic: true },
      }],
      ...overrides,
    });
  const acknowledgment = (
    commandId: string,
    minimumRevision: number,
    receivedAt = 10,
  ): CommandReceiptRecord => ({
    commandId,
    principalId,
    commandType: "cmd-matrix.change/v1",
    outcome: "acknowledged",
    receivedAt,
    coverage: [{
      kind: "view-revision",
      contractId: CONTRACT,
      viewKey: VIEW_KEY,
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
    writer,
    runtime,
    storageFailures,
    queue,
    view,
    acknowledgment,
    async close() { await adapter.purge(); },
  };
}

describe("command matrix", () => {
  // Matrix CMD-01: a crash while `sending` restarts as receipt-check, never a
  // blind re-send of an effect that may already have landed.
  test("restart drain resolves a crashed `sending` command via its receipt first", async () => {
    const fixture = await makeFixture();
    try {
      const command = await fixture.runtime.markSending(await fixture.queue("crashed-mid-send"));
      expect(command.status).toBe("sending");

      // "Restart": a fresh runtime instance over the same durable store.
      const restarted = new LocalFirstCommandRuntime(fixture.adapter, fixture.fence, fixture.principalId);
      const sends: string[] = [];
      await restarted.drain({
        getReceipt: async (candidate) => fixture.acknowledgment(candidate.id, 1),
        send: async (candidate) => { sends.push(candidate.id); throw new Error("must-not-send"); },
      });
      expect(sends).toEqual([]);
      expect((await fixture.adapter.readCommand(fixture.fence, command.id))?.status).toBe("reconciled");
    } finally {
      await fixture.close();
    }
  });

  // Matrix CMD-03: revoking the last grant retires every in-flight command
  // shape without breaking later drains, and purges the protected payload.
  test("revocation retires queued and in-flight commands and nulls their payloads", async () => {
    const fixture = await makeFixture();
    try {
      const queued = await fixture.queue("revoke-queued");
      const sending = await fixture.runtime.markSending(await fixture.queue("revoke-sending"));
      const checking = await fixture.runtime.markTransportUncertain(
        await fixture.runtime.markSending(await fixture.queue("revoke-checking")),
      );
      expect(checking.status).toBe("checking-receipt");
      const awaiting = await fixture.runtime.settleReceipt(
        await fixture.runtime.markSending(await fixture.queue("revoke-awaiting")),
        fixture.acknowledgment("revoke-awaiting", 99),
      );
      expect(awaiting.status).toBe("acknowledged-awaiting-coverage");

      await fixture.adapter.commit(fixture.fence, [{
        kind: "clear-authoritative-view",
        record: {
          key: VIEW_KEY,
          contractId: CONTRACT,
          writerEpoch: fixture.writer.writerEpoch,
          sourceEpoch: asSourceEpoch("cmd-matrix-source"),
          sourceSequence: asSourceSequence(2),
          coverage: { kind: "none" },
          access: "forbidden",
          revokedGrantKeys: [fixture.grantKey],
        },
      }]);

      const byId = async (id: string) => (await fixture.adapter.readCommand(fixture.fence, id))!;
      expect(await byId(queued.id)).toMatchObject({
        status: "blocked", optimisticActive: false, payload: null, optimisticOperations: [],
      });
      expect(await byId(sending.id)).toMatchObject({ status: "ambiguous", optimisticActive: false, payload: null });
      expect(await byId(checking.id)).toMatchObject({ status: "ambiguous", optimisticActive: false, payload: null });
      expect(await byId(awaiting.id)).toMatchObject({ status: "reconciled", optimisticActive: false, payload: null });

      // Later drains must neither dispatch the blocked/ambiguous residue nor throw.
      const attempts: string[] = [];
      await fixture.runtime.drain({
        getReceipt: async (candidate) => { attempts.push(`receipt:${candidate.id}`); return null; },
        send: async (candidate) => { attempts.push(`send:${candidate.id}`); throw new Error("must-not-send"); },
      });
      expect(attempts).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  // Matrix CMD-05: removing a rejected command reveals the newest
  // authoritative base — never an inverse patch over newer state.
  test("a rejection folds away over a newer authoritative base", async () => {
    const fixture = await makeFixture();
    try {
      const command = await fixture.runtime.markSending(await fixture.queue("reject-fold"));
      // Newer authoritative content arrives while the command is in flight —
      // including a server-side version of the same projection row.
      await fixture.adapter.commit(fixture.fence, [{
        kind: "replace-complete-view",
        view: fixture.view(2, 2),
        members: [{
          key: `${VIEW_KEY}\0complete\0projection:reject-fold`,
          viewKey: VIEW_KEY,
          entityKey: "projection:reject-fold",
          segmentKey: "complete",
          grantKeys: [fixture.grantKey],
        }],
        projections: [{
          key: `${VIEW_KEY}\0complete\0projection:reject-fold`,
          viewKey: VIEW_KEY,
          entityKey: "projection:reject-fold",
          segmentKey: "complete",
          value: { id: "reject-fold", server: "newer" },
        }],
      }]);
      let visible = selectVisibleMaterializedView(
        await fixture.adapter.readSnapshot(fixture.fence),
        VIEW_KEY,
      );
      expect(visible.rows[0].value).toEqual({ id: "reject-fold", optimistic: true });

      await fixture.runtime.settleReceipt(command, {
        commandId: command.id,
        principalId: fixture.principalId,
        commandType: command.commandType,
        outcome: "rejected",
        receivedAt: 11,
        rejection: { code: "conflict", message: "rejected" },
        coverage: [],
        retryUntil: null,
      });
      visible = selectVisibleMaterializedView(
        await fixture.adapter.readSnapshot(fixture.fence),
        VIEW_KEY,
      );
      expect(visible.rows[0].value).toEqual({ id: "reject-fold", server: "newer" });
      expect(visible.activeCommandIds).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  // Matrix CMD-06: one conflict key drains in creation order, even when the
  // commands were queued by different runtime instances (tabs/restarts).
  test("commands sharing a conflict key drain in durable creation order", async () => {
    const fixture = await makeFixture();
    try {
      const other = new LocalFirstCommandRuntime(fixture.adapter, fixture.fence, fixture.principalId);
      await fixture.queue("order-a");
      await other.queue({
        id: "order-b",
        contractId: "cmd-matrix.command/v1",
        commandType: "cmd-matrix.change/v1",
        conflictKey: VIEW_KEY,
        operationSchemaVersion: 1,
        targetGrantKeys: [fixture.grantKey],
        targetEntityKeys: [],
        replayPolicy: "server-deduplicated",
        payload: {},
        requiredCoverage: { kind: "view-revision", contractId: CONTRACT, viewKey: VIEW_KEY },
        optimisticOperations: [{
          kind: "upsert-projection",
          viewKey: VIEW_KEY,
          entityKey: "projection:order-b",
          value: {},
        }],
      });
      const sends: string[] = [];
      await fixture.runtime.drain({
        getReceipt: async () => null,
        send: async (command) => {
          sends.push(command.id);
          return fixture.acknowledgment(command.id, 1);
        },
      });
      expect(sends).toEqual(["order-a", "order-b"]);
    } finally {
      await fixture.close();
    }
  });

  // Matrix CMD-07: an expired replay horizon becomes visible, non-dispatchable
  // state — never a silent new command identity.
  test("an expired replay horizon parks the command as replay-expired", async () => {
    const fixture = await makeFixture();
    try {
      const command = await fixture.runtime.markSending(
        await fixture.queue("expired", { retryUntil: Date.now() - 1 }),
      );
      expect(command.retryUntil).toBeLessThan(Date.now());
      const sends: string[] = [];
      await fixture.runtime.drain({
        getReceipt: async () => null,
        send: async (candidate) => { sends.push(candidate.id); return fixture.acknowledgment(candidate.id, 1); },
      });
      expect(sends).toEqual([]);
      expect((await fixture.adapter.readCommand(fixture.fence, command.id))?.status).toBe("replay-expired");
      // And it stays parked on the next drain.
      await fixture.runtime.drain({
        getReceipt: async () => null,
        send: async (candidate) => { sends.push(candidate.id); return fixture.acknowledgment(candidate.id, 1); },
      });
      expect(sends).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  // Matrix TAB-04: two tabs draining the same journal concurrently. The server
  // dedupes by command id, but the receipts each tab constructs differ in
  // client-stamped receivedAt — the loser's settle must not corrupt state.
  test("concurrent two-tab drains of one command converge without corrupting the journal", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.queue("double-drain");
      const tabAFailures: unknown[] = [];
      const tabBFailures: unknown[] = [];
      const tabA = new LocalFirstCommandRuntime(
        fixture.adapter, fixture.fence, fixture.principalId, (e) => tabAFailures.push(e));
      const tabB = new LocalFirstCommandRuntime(
        fixture.adapter, fixture.fence, fixture.principalId, (e) => tabBFailures.push(e));
      const transportFor = (receivedAt: number) => ({
        getReceipt: async () => null,
        send: async (command: CommandRecord) =>
          fixture.acknowledgment(command.id, 1, receivedAt),
      });
      const outcomes = await Promise.allSettled([
        tabA.drain(transportFor(100)),
        tabB.drain(transportFor(200)),
      ]);
      // The journal must converge to exactly one settled command...
      const settled = (await fixture.adapter.readCommand(fixture.fence, "double-drain"))!;
      expect(settled.status).toBe("reconciled");
      const receipts = (await fixture.adapter.readSnapshot(fixture.fence)).commandReceipts;
      expect(receipts).toHaveLength(1);
      // ...and the losing tab's error must not be classified as storage
      // failure (which would flip a healthy tab to degraded and close
      // dispatch). Any drain rejection here must be a fence-classified error.
      const rejections = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
      for (const rejection of rejections) {
        const reasons = rejection.reason instanceof AggregateError
          ? rejection.reason.errors
          : [rejection.reason];
        for (const reason of reasons) {
          expect(
            reason instanceof PrincipalStoreFenceError ||
            reason instanceof PrincipalStoreIdentityError,
          ).toBe(true);
        }
      }
      expect(tabAFailures).toEqual([]);
      expect(tabBFailures).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  // Matrix SRV-08: a grant established for one scope cannot authorize a view
  // payload for another scope.
  test("a view payload cannot borrow a grant bound to another scope", async () => {
    const fixture = await makeFixture();
    try {
      const foreign = asGrantKey("grant:other-scope");
      await fixture.adapter.commit(fixture.fence, [{
        kind: "put-grant",
        record: { key: foreign, contractId: CONTRACT, scopeKey: "view:other", grantedAt: 1 },
      }]);
      await expect(fixture.adapter.commit(fixture.fence, [{
        kind: "replace-complete-view",
        view: { ...fixture.view(3, 3), grantKeys: [foreign] },
        members: [],
        projections: [],
      }])).rejects.toBeInstanceOf(PrincipalStoreIdentityError);
    } finally {
      await fixture.close();
    }
  });
});

// Matrix ENG-06 + SRV-04 + TAB-02 use the engine/source layer.
type Row = { _id: string; body: string };
type GrantedEnvelope = {
  contractId: "cmd-matrix.notes/v2";
  viewKey: string;
  access: "granted";
  grantKeys: readonly string[];
  viewRevision: number;
  coverage: { kind: "view-revision"; revision: string; revisionOrder: number };
  notes: readonly Row[];
};
type Envelope =
  | { contractId: "cmd-matrix.notes/v2"; viewKey: string; access: "missing"; releasedGrantKeys: readonly string[]; removals: readonly never[] }
  | GrantedEnvelope;

const notesView = defineQueryView({
  id: "cmd-matrix.notes/v2",
  query: {} as never,
  key: ({ scope }: { scope: string }) => `cmd-notes:${scope}`,
  rows: (granted: GrantedEnvelope) => granted.notes,
  entityKey: (row) => `note:${row._id}`,
});

function grantedNotes(scope: string, revision: number, notes: readonly Row[]): Envelope {
  return {
    contractId: "cmd-matrix.notes/v2",
    viewKey: `cmd-notes:${scope}`,
    access: "granted",
    grantKeys: [`cmd-notes-grant:${scope}`],
    viewRevision: revision,
    coverage: { kind: "view-revision", revision: String(revision), revisionOrder: revision },
    notes,
  };
}

async function makeEngineFixture() {
  const principalKey = randomUUID() as OpaquePrincipalKey;
  const name = principalDatabaseName(`cmd-engine-${randomUUID()}`, principalKey);
  const principalId = asPrincipalId("cmd-engine-principal");
  const bootstrap = new DexiePrincipalStoreAdapter(name, principalKey);
  const metadata = await bootstrap.activateVerified(1, principalId);
  const fence = { principalKey, generation: 1 };
  const engines: LocalFirstEngine[] = [];
  const adapters = [bootstrap];
  let sourceEpoch = 0;
  return {
    fence,
    principalId,
    bootstrap,
    openTab() {
      const adapter = new DexiePrincipalStoreAdapter(name, principalKey);
      adapters.push(adapter);
      const engine = new LocalFirstEngine({
        adapter,
        fence,
        principalId,
        principalEpoch: asPrincipalEpoch(1),
        initialHead: metadata.head,
        sourceEpochFactory: () => asSourceEpoch(`cmd-engine-source-${++sourceEpoch}`),
        channelFactory: () => null,
      });
      engines.push(engine);
      return engine;
    },
    async close() {
      for (const engine of engines) engine.close();
      for (const adapter of adapters.slice(1)) adapter.close();
      await bootstrap.purge();
    },
  };
}

describe("delta, missing, and concurrent-commit semantics", () => {
  // Matrix ENG-06: duplicate delta replay is rejected loudly at the cursor
  // precondition — it can never silently corrupt the stream.
  test("a replayed ordered delta is rejected at the cursor and changes nothing", async () => {
    const fixture = await makeEngineFixture();
    const engine = fixture.openTab();
    try {
      const handle = await engine.beginSource("stream:tasks", "tasks.delta/v1");
      const entity = (version: number) => ({
        entityType: "task",
        entityId: "one",
        entityVersion: `v${version}`,
        entityVersionOrder: version,
        canonicalOwnerContractId: "tasks.delta/v1",
        grantKeys: [asGrantKey("grant:delta")],
        value: { title: `v${version}` },
      });
      const deltaInput = (previous: string | null, next: string, sequence: number, version: number) => ({
        principalId: fixture.principalId,
        principalEpoch: asPrincipalEpoch(1),
        contractId: "tasks.delta/v1",
        streamKey: "stream:tasks",
        sourceEpoch: handle.sourceEpoch,
        sourceSequence: asSourceSequence(sequence),
        coverage: { kind: "none" as const },
        previousCursor: previous,
        nextCursor: next,
        changes: [{ type: "upsert" as const, entity: entity(version) }],
      });
      await engine.applyDelta(deltaInput(null, "cursor-b", 1, 1));
      await expect(engine.applyDelta(deltaInput(null, "cursor-b", 2, 2)))
        .rejects.toBeInstanceOf(PrincipalStoreFenceError);
      const snapshot = await fixture.bootstrap.readSnapshot(fixture.fence);
      expect(snapshot.deltaCursors[0]).toMatchObject({ cursor: "cursor-b" });
      expect(snapshot.entities[0].version).toBe("v1");
      // The stream continues cleanly from the committed cursor.
      await engine.applyDelta(deltaInput("cursor-b", "cursor-c", 3, 2));
      expect((await fixture.bootstrap.readSnapshot(fixture.fence)).entities[0].version).toBe("v2");
    } finally {
      await fixture.close();
    }
  });

  // Matrix SRV-04: a missing parent releases the view without a security
  // revocation, and a NEWER re-grant restores it cleanly.
  test("missing releases the view and a newer grant restores it", async () => {
    const fixture = await makeEngineFixture();
    const engine = fixture.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesView, { scope: "gone" });
      await source.apply(source.capture(), grantedNotes("gone", 1, [{ _id: "n1", body: "before" }]));
      await source.apply(source.capture(), {
        contractId: "cmd-matrix.notes/v2",
        viewKey: "cmd-notes:gone",
        access: "missing",
        releasedGrantKeys: ["cmd-notes-grant:gone"],
        removals: [],
      });
      let snapshot = await fixture.bootstrap.readSnapshot(fixture.fence);
      expect(snapshot.views).toEqual([]);
      expect(snapshot.viewMembers).toEqual([]);
      expect(snapshot.grants).toEqual([]);
      expect(snapshot.viewWriters[0].lastAccess).toBe("missing");

      const restored = await CompleteViewSource.open(engine, notesView, { scope: "gone" });
      await restored.apply(restored.capture(), grantedNotes("gone", 2, [{ _id: "n2", body: "after" }]));
      snapshot = await fixture.bootstrap.readSnapshot(fixture.fence);
      expect(snapshot.viewMembers.map((m) => m.entityKey)).toEqual(["note:n2"]);
    } finally {
      await fixture.close();
    }
  });

  // Matrix TAB-02: racing complete-view commits from two tabs leave exactly
  // one coherent generation; the fenced loser changes nothing.
  test("racing commits from two tabs settle on one coherent generation", async () => {
    const fixture = await makeEngineFixture();
    const engineA = fixture.openTab();
    const engineB = fixture.openTab();
    try {
      const sourceA = await CompleteViewSource.open(engineA, notesView, { scope: "race" });
      const sourceB = await CompleteViewSource.open(engineB, notesView, { scope: "race" });
      const outcomes = await Promise.allSettled([
        sourceA.apply(sourceA.capture(), grantedNotes("race", 1, [{ _id: "a", body: "tab-a" }])),
        sourceB.apply(sourceB.capture(), grantedNotes("race", 1, [{ _id: "b", body: "tab-b" }])),
      ]);
      // B claimed the writer after A, so B owns the durable view; A is fenced.
      expect(outcomes[1].status).toBe("fulfilled");
      expect(outcomes[0].status).toBe("rejected");
      const snapshot = await fixture.bootstrap.readSnapshot(fixture.fence);
      expect(snapshot.views).toHaveLength(1);
      expect(snapshot.viewMembers.map((m) => m.entityKey)).toEqual(["note:b"]);
      expect(snapshot.viewProjections).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
});
