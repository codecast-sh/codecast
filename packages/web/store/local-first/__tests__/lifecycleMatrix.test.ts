import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { CompleteViewSource } from "../contracts";
import { LocalFirstEngine } from "../engine";
import { LocalViewSession, type LocalViewPublication } from "../localViewSession";
import { defineQueryView } from "../queryView";
import {
  PrincipalStoreFenceError,
  type PrincipalStoreAdapter,
  type PrincipalStoreFence,
} from "../persistence/adapter";
import {
  boundStorageOpen,
  DexiePrincipalStoreAdapter,
  PRINCIPAL_DEXIE_V2_STORES,
  PrincipalStoreOpenTimeoutError,
  principalDatabaseName,
  type DexieFaultPoint,
} from "../persistence/dexieAdapter";
import {
  DexieLauncherStore,
  launcherDatabaseName,
} from "../persistence/launcher";
import { PrincipalRuntime } from "../principalRuntime";
import {
  asGrantKey,
  asPrincipalEpoch,
  asPrincipalId,
  asSourceEpoch,
  asSourceSequence,
  asViewKey,
  type CredentialBinding,
  type OpaquePrincipalKey,
} from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

type Row = { _id: string; body: string };
type GrantedEnvelope = {
  contractId: "life.notes/v2";
  viewKey: string;
  access: "granted";
  grantKeys: readonly string[];
  viewRevision: number;
  coverage: { kind: "view-revision"; revision: string; revisionOrder: number };
  notes: readonly Row[];
};

const notesView = defineQueryView({
  id: "life.notes/v2",
  query: {} as never,
  key: ({ scope }: { scope: string }) => `life-notes:${scope}`,
  rows: (granted: GrantedEnvelope) => granted.notes,
  entityKey: (row) => `note:${row._id}`,
});

function granted(scope: string, revision: number, notes: readonly Row[]): GrantedEnvelope {
  return {
    contractId: "life.notes/v2",
    viewKey: `life-notes:${scope}`,
    access: "granted",
    grantKeys: [`life-grant:${scope}`],
    viewRevision: revision,
    coverage: { kind: "view-revision", revision: String(revision), revisionOrder: revision },
    notes,
  };
}

function collector() {
  const publications: LocalViewPublication<Row>[] = [];
  return {
    publications,
    publish: (publication: LocalViewPublication<Row>) => publications.push(publication),
    latest: () => publications[publications.length - 1],
  };
}

describe("lifecycle matrix", () => {
  // Matrix LIF-05: a storage layer that cannot even open must fail CLOSED —
  // the runtime may not hang in "opening" while the UI waits forever.
  test("verify fails closed when the principal store cannot open", async () => {
    const deployment = `life-open-fail-${randomUUID()}`;
    const launcher = new DexieLauncherStore(deployment, () => randomUUID() as OpaquePrincipalKey);
    const runtime = new PrincipalRuntime(
      launcher,
      {
        exists: async () => false,
        open: async () => { throw new Error("indexeddb-unavailable"); },
      },
      {
        stopProtectedIO: () => {},
        clearProtectedMemory: () => {},
        bindPersistence: () => {},
        unbindPersistence: () => {},
        hydrate: async ({ isCurrent }) => isCurrent(),
      },
    );
    try {
      await expect(runtime.verify({
        credentialBinding: "cred-open-fail" as CredentialBinding,
        principalId: asPrincipalId("p-open-fail"),
      })).rejects.toThrow("indexeddb-unavailable");
      // The one unacceptable outcome is a runtime stranded in "opening".
      expect(["locked", "failed"]).toContain(runtime.getSnapshot().phase);
    } finally {
      runtime.close();
      launcher.close();
      await Dexie.delete(launcherDatabaseName(deployment));
    }
  });

  // Matrix R-10: indexedDB.open() can hang forever with no event (WebKit
  // #226547, Chromium #242115). A bounded open converts the hang into the
  // ordinary fail-closed path instead of stranding the runtime in "opening".
  test("a hung storage open times out into the fail-closed path", async () => {
    const hang = new Promise<never>(() => {});
    await expect(boundStorageOpen(hang, 30))
      .rejects.toBeInstanceOf(PrincipalStoreOpenTimeoutError);
    // A healthy open passes through untouched and the timer is cleared.
    expect(await boundStorageOpen(Promise.resolve("opened"), 30)).toBe("opened");
    // No deadline means no race — legacy behavior preserved when disabled.
    expect(await boundStorageOpen(Promise.resolve("opened"), 0)).toBe("opened");
  });

  // Matrix LIF-02: a transient failure during the session's initial source
  // open must not leave the mounted view dead — a later delivery re-opens.
  test("a session whose initial open failed recovers on a later delivery", async () => {
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const name = principalDatabaseName(`life-reopen-${randomUUID()}`, principalKey);
    let fault: DexieFaultPoint | null = "after-operations";
    const adapter = new DexiePrincipalStoreAdapter(name, principalKey, (point) => {
      if (point === fault) throw new Error("transient-claim-fault");
    });
    const principalId = asPrincipalId("life-reopen-principal");
    const metadata = await adapter.activateVerified(1, principalId);
    fault = "after-operations";
    const engine = new LocalFirstEngine({
      adapter,
      fence: { principalKey, generation: 1 },
      principalId,
      principalEpoch: asPrincipalEpoch(1),
      initialHead: metadata.head,
      sourceEpochFactory: () => asSourceEpoch(`life-reopen-${randomUUID()}`),
      channelFactory: () => null,
    });
    try {
      const seen = collector();
      const session = new LocalViewSession(engine, notesView, { scope: "reopen" }, seen.publish);
      await session.settled();
      // Storage heals; the subscription delivers a result.
      fault = null;
      await session.deliver(granted("reopen", 1, [{ _id: "n1", body: "recovered" }]));
      expect(seen.latest().status).toBe("granted");
      expect(seen.latest().rows.map((row) => (row.value as Row).body)).toEqual(["recovered"]);
      session.close();
    } finally {
      engine.close();
      await adapter.purge();
    }
  });

  // Matrix LIF-01: an evicted principal database fails closed offline and
  // rebuilds cleanly once the server re-verifies.
  test("an evicted store fails closed offline and rebuilds on verification", async () => {
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const name = principalDatabaseName(`life-evicted-${randomUUID()}`, principalKey);
    const adapter = new DexiePrincipalStoreAdapter(name, principalKey);
    try {
      await expect(adapter.openOffline({ principalKey, generation: 1 }))
        .rejects.toBeInstanceOf(PrincipalStoreFenceError);
      const metadata = await adapter.activateVerified(1, asPrincipalId("life-evicted"));
      expect(metadata.head).toBe(1);
      const snapshot = await adapter.readSnapshot({ principalKey, generation: 1 });
      expect(snapshot.views).toEqual([]);
      expect(snapshot.commands).toEqual([]);
    } finally {
      await adapter.purge();
    }
  });

  // Matrix ACC-03: identical grant-key strings in two principals' stores are
  // fully independent facts.
  test("the same grant string in two principal stores never interacts", async () => {
    const make = async (label: string) => {
      const principalKey = randomUUID() as OpaquePrincipalKey;
      const adapter = new DexiePrincipalStoreAdapter(
        principalDatabaseName(`life-grant-${label}-${randomUUID()}`, principalKey),
        principalKey,
      );
      const fence: PrincipalStoreFence = { principalKey, generation: 1 };
      await adapter.activateVerified(1, asPrincipalId(`life-grant-${label}`));
      const writer = await adapter.claimViewWriter(fence, "view:catalog", "catalog/v1");
      await adapter.commit(fence, [
        {
          kind: "put-grant",
          record: { key: asGrantKey("bucket-catalog"), contractId: "catalog/v1", scopeKey: "view:catalog", grantedAt: 1 },
        },
        {
          kind: "replace-complete-view",
          view: {
            key: "view:catalog",
            contractId: "catalog/v1",
            grantKeys: [asGrantKey("bucket-catalog")],
            revision: "1",
            writerEpoch: writer.writerEpoch,
            sourceEpoch: asSourceEpoch(`life-grant-${label}`),
            sourceSequence: asSourceSequence(1),
            coverage: { kind: "view-revision", revision: "1", revisionOrder: 1 },
          },
          members: [{
            key: `view:catalog\0complete\0row:${label}`,
            viewKey: "view:catalog",
            entityKey: `row:${label}`,
            segmentKey: "complete",
            grantKeys: [asGrantKey("bucket-catalog")],
          }],
          projections: [{
            key: `view:catalog\0complete\0row:${label}`,
            viewKey: "view:catalog",
            entityKey: `row:${label}`,
            segmentKey: "complete",
            value: { label },
          }],
        },
      ]);
      return { adapter, fence };
    };
    const storeA = await make("a");
    const storeB = await make("b");
    try {
      await storeA.adapter.commit(storeA.fence, [{ kind: "revoke-grant", grantKey: "bucket-catalog" }]);
      const snapshotA = await storeA.adapter.readSnapshot(storeA.fence);
      const snapshotB = await storeB.adapter.readSnapshot(storeB.fence);
      expect(snapshotA.viewMembers).toEqual([]);
      expect(snapshotA.grants).toEqual([]);
      expect(snapshotB.viewMembers).toHaveLength(1);
      expect(snapshotB.grants).toHaveLength(1);
    } finally {
      await storeA.adapter.purge();
      await storeB.adapter.purge();
    }
  });

  // Matrix ACC-04: logout (fence, then purge) racing an in-flight commit —
  // the commit either lands wholly before the fence or is wholly rejected;
  // afterwards nothing survives the purge and nothing resurrects the store.
  test("fence and purge racing an in-flight commit cannot corrupt or resurrect", async () => {
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const name = principalDatabaseName(`life-race-${randomUUID()}`, principalKey);
    let release: (() => void) | null = null;
    let park = false;
    const adapter = new DexiePrincipalStoreAdapter(name, principalKey, async (point) => {
      if (park && point === "after-operations") {
        await new Promise<void>((resolve) => { release = resolve; });
      }
    });
    const fence: PrincipalStoreFence = { principalKey, generation: 1 };
    const principalId = asPrincipalId("life-race");
    await adapter.activateVerified(1, principalId);
    const writer = await adapter.claimViewWriter(fence, "view:race", "race/v1");
    try {
      park = true;
      const inFlight = adapter.commit(fence, [
        {
          kind: "put-grant",
          record: { key: asGrantKey("grant:race"), contractId: "race/v1", scopeKey: "view:race", grantedAt: 1 },
        },
        {
          kind: "replace-complete-view",
          view: {
            key: "view:race",
            contractId: "race/v1",
            grantKeys: [asGrantKey("grant:race")],
            revision: "1",
            writerEpoch: writer.writerEpoch,
            sourceEpoch: asSourceEpoch("life-race"),
            sourceSequence: asSourceSequence(1),
            coverage: { kind: "view-revision", revision: "1", revisionOrder: 1 },
          },
          members: [],
          projections: [],
        },
      ]);
      // Queue the logout fence behind the parked commit, then release.
      const fencePromise = adapter.fence(1, 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      park = false;
      release?.();
      const commitOutcome = await inFlight.then(() => "committed", () => "rejected");
      await fencePromise;
      // Dexie.waitFor keeps the parked test hook inside the live transaction;
      // the queued fence therefore runs only after this atomic commit finishes.
      expect(commitOutcome).toBe("committed");
      // Once the queued fence lands, post-fence commits fail...
      await expect(adapter.commit(fence, [{
        kind: "put-grant",
        record: { key: asGrantKey("grant:late"), contractId: "race/v1", scopeKey: "view:race", grantedAt: 2 },
      }])).rejects.toBeInstanceOf(PrincipalStoreFenceError);
      // ...and the purge leaves nothing to resurrect.
      await adapter.purge();
      const reopened = new DexiePrincipalStoreAdapter(name, principalKey);
      expect(await reopened.readMetadata()).toBeNull();
      reopened.close();
    } finally {
      await adapter.purge();
    }
  });

  // Matrix TAB-05 / LIF-06: deploy-overlap schema versions. An old bundle
  // opening a newer database must fail loudly (degraded path), and a new
  // bundle must not hang behind the old connection.
  test("schema version overlap fails the old bundle loudly and lets the new one proceed", async () => {
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const name = principalDatabaseName(`life-schema-${randomUUID()}`, principalKey);
    // Old bundle creates the database at v2.
    const oldBundle = new Dexie(name);
    oldBundle.version(2).stores({ ...PRINCIPAL_DEXIE_V2_STORES });
    await oldBundle.open();
    await oldBundle.table("meta").put({ key: "probe" });

    // New bundle (v3 adapter) opens while the old connection is still live.
    const adapter = new DexiePrincipalStoreAdapter(name, principalKey);
    const opened = await Promise.race([
      adapter.ensureOpen().then(() => "opened" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 4000)),
    ]);
    expect(opened).toBe("opened");

    // (The old connection's post-upgrade fate is environment-specific: real
    // browsers refuse its next reopen with VersionError — surfacing through
    // onStorageFailure as degraded — while fake-indexeddb lets it linger.
    // The compliant half of that contract is pinned below.)

    // An old BUNDLE freshly opening the now-newer database: real browsers
    // refuse this with VersionError; fake-indexeddb tolerates it, so accept
    // either here — the adapter-level schema fence below is OUR guarantee.
    const staleBundle = new Dexie(name);
    staleBundle.version(2).stores({ ...PRINCIPAL_DEXIE_V2_STORES });
    const staleOpen = await staleBundle.open()
      .then(() => "ok", (error: unknown) => (error as { name?: string })?.name ?? "error");
    expect(["VersionError", "ok"]).toContain(staleOpen);
    staleBundle.close();
    oldBundle.close();

    // Defense in depth, environment-independent: a store whose metadata says
    // it was migrated by a NEWER bundle is fenced for this bundle's writes.
    const fence: PrincipalStoreFence = { principalKey, generation: 1 };
    await adapter.activateVerified(1, asPrincipalId("life-schema"));
    const db = new Dexie(name);
    db.version(3).stores({ ...PRINCIPAL_DEXIE_V2_STORES, viewWriters: "key, contractId, writerEpoch" });
    await db.open();
    const meta = await db.table("meta").get("store");
    await db.table("meta").put({ ...meta, schemaVersion: meta.schemaVersion + 1 });
    db.close();
    await expect(adapter.readHead(fence)).rejects.toThrow("newer than this application bundle");
    await adapter.purge();
  }, 10000);

  // Matrix VIEW-01: a complete replacement at NEWER coverage cleanly deletes
  // window segments; at EQUAL coverage with segments present it is fenced.
  test("complete replacement supersedes segments only with newer coverage", async () => {
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const name = principalDatabaseName(`life-segments-${randomUUID()}`, principalKey);
    const adapter = new DexiePrincipalStoreAdapter(name, principalKey);
    const fence: PrincipalStoreFence = { principalKey, generation: 1 };
    const principalId = asPrincipalId("life-segments");
    const metadata = await adapter.activateVerified(1, principalId);
    const engine = new LocalFirstEngine({
      adapter,
      fence,
      principalId,
      principalEpoch: asPrincipalEpoch(1),
      initialHead: metadata.head,
      sourceEpochFactory: () => asSourceEpoch(`life-segments-${randomUUID()}`),
      channelFactory: () => null,
    });
    try {
      const handle = await engine.beginSource("life-notes:seg", "life.notes/v2");
      const fenceFields = (sequence: number) => ({
        principalId,
        principalEpoch: asPrincipalEpoch(1),
        contractId: "life.notes/v2",
        writerEpoch: handle.writerEpoch,
        sourceEpoch: handle.sourceEpoch,
        sourceSequence: asSourceSequence(sequence),
        viewKey: asViewKey("life-notes:seg"),
      });
      await engine.replaceWindow({
        ...fenceFields(1),
        coverage: { kind: "view-revision", revision: "1", revisionOrder: 1 },
        segmentKind: "window",
        windowKey: "recent",
        storage: "projection",
        grantKeys: [asGrantKey("life-grant:seg")],
        rows: [{ entityKey: "note:w1", grantKeys: [asGrantKey("life-grant:seg")], projection: { _id: "w1" } }],
      });
      let snapshot = await adapter.readSnapshot(fence);
      expect(snapshot.viewSegments).toHaveLength(1);

      // Equal coverage cannot replace a view that holds segments.
      await expect(engine.replaceView({
        ...fenceFields(2),
        coverage: { kind: "view-revision", revision: "1", revisionOrder: 1 },
        storage: "projection",
        access: "granted",
        grantKeys: [asGrantKey("life-grant:seg")],
        rows: [],
      })).rejects.toBeInstanceOf(PrincipalStoreFenceError);

      // Newer coverage replaces the whole view, segments included.
      await engine.replaceView({
        ...fenceFields(3),
        coverage: { kind: "view-revision", revision: "2", revisionOrder: 2 },
        storage: "projection",
        access: "granted",
        grantKeys: [asGrantKey("life-grant:seg")],
        rows: [{ entityKey: "note:c1", grantKeys: [asGrantKey("life-grant:seg")], projection: { _id: "c1" } }],
      });
      snapshot = await adapter.readSnapshot(fence);
      expect(snapshot.viewSegments).toEqual([]);
      expect(snapshot.viewMembers.map((member) => member.entityKey)).toEqual(["note:c1"]);
    } finally {
      engine.close();
      await adapter.purge();
    }
  });
});
