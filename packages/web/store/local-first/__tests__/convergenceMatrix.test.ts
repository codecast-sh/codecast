import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { CompleteViewSource } from "../contracts";
import { LocalFirstEngine, StaleLocalFirstSourceError } from "../engine";
import { LocalViewSession, type LocalViewPublication } from "../localViewSession";
import { defineQueryView } from "../queryView";
import {
  DexiePrincipalStoreAdapter,
  principalDatabaseName,
  type DexieFaultPoint,
} from "../persistence/dexieAdapter";
import {
  asPrincipalEpoch,
  asPrincipalId,
  asSourceEpoch,
  type OpaquePrincipalKey,
} from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

type Row = { _id: string; body: string };
type GrantedEnvelope = {
  contractId: "matrix.notes/v2";
  viewKey: string;
  access: "granted";
  grantKeys: readonly string[];
  viewRevision: number;
  coverage: { kind: "view-revision"; revision: string; revisionOrder: number };
  notes: readonly Row[];
};
type Envelope =
  | { contractId: "matrix.notes/v2"; viewKey: string; access: "unauthenticated" }
  | { contractId: "matrix.notes/v2"; viewKey: string; access: "forbidden"; revokedGrantKeys: readonly string[] }
  | GrantedEnvelope;

const notesView = defineQueryView({
  id: "matrix.notes/v2",
  query: {} as never,
  key: ({ scope }: { scope: string }) => `matrix-notes:${scope}`,
  rows: (granted: GrantedEnvelope) => granted.notes,
  entityKey: (row) => `note:${row._id}`,
});

function granted(scope: string, revision: number, notes: readonly Row[]): Envelope {
  return {
    contractId: "matrix.notes/v2",
    viewKey: `matrix-notes:${scope}`,
    access: "granted",
    grantKeys: [`matrix-grant:${scope}`],
    viewRevision: revision,
    coverage: { kind: "view-revision", revision: String(revision), revisionOrder: revision },
    notes,
  };
}

function forbidden(scope: string): Envelope {
  return {
    contractId: "matrix.notes/v2",
    viewKey: `matrix-notes:${scope}`,
    access: "forbidden",
    revokedGrantKeys: [`matrix-grant:${scope}`],
  };
}

function unauthenticated(scope: string): Envelope {
  return { contractId: "matrix.notes/v2", viewKey: `matrix-notes:${scope}`, access: "unauthenticated" };
}

type FaultHook = (point: DexieFaultPoint) => void | Promise<void>;

async function makeStore() {
  const principalKey = randomUUID() as OpaquePrincipalKey;
  const name = principalDatabaseName(`matrix-${randomUUID()}`, principalKey);
  const principalId = asPrincipalId("matrix-principal");
  let hook: FaultHook | null = null;
  const bootstrap = new DexiePrincipalStoreAdapter(name, principalKey, async (point) => {
    await hook?.(point);
  });
  const metadata = await bootstrap.activateVerified(1, principalId);
  const fence = { principalKey, generation: 1 };
  const adapters: DexiePrincipalStoreAdapter[] = [bootstrap];
  const engines: LocalFirstEngine[] = [];
  let sourceEpoch = 0;
  return {
    fence,
    principalId,
    bootstrap,
    setFaultHook(next: FaultHook | null) { hook = next; },
    openTab(channelFactory: ((name: string) => BroadcastChannel | null) = () => null) {
      const adapter = new DexiePrincipalStoreAdapter(name, principalKey, async (point) => {
        await hook?.(point);
      });
      adapters.push(adapter);
      const engine = new LocalFirstEngine({
        adapter,
        fence,
        principalId,
        principalEpoch: asPrincipalEpoch(1),
        initialHead: metadata.head,
        sourceEpochFactory: () => asSourceEpoch(`matrix-source-${++sourceEpoch}`),
        channelFactory,
      });
      engines.push(engine);
      return engine;
    },
    async snapshot() {
      return await bootstrap.readSnapshot(fence);
    },
    async close() {
      for (const engine of engines) engine.close();
      for (const adapter of adapters.slice(1)) adapter.close();
      await bootstrap.purge();
    },
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

describe("convergence matrix — engine ordering and lifecycle", () => {
  // Matrix ENG-03: a principal switch between capture and apply rejects the
  // apply before anything durable happens.
  test("an apply captured before a principal switch cannot commit after it", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesView, { scope: "p" });
      const captured = source.capture();
      engine.invalidatePrincipal(asPrincipalEpoch(2));
      const headBefore = await store.bootstrap.readHead(store.fence);
      await expect(source.apply(captured, granted("p", 1, [{ _id: "n1", body: "cross" }])))
        .rejects.toBeInstanceOf(StaleLocalFirstSourceError);
      expect(await store.bootstrap.readHead(store.fence)).toBe(headBefore);
      expect((await store.snapshot()).views).toEqual([]);
    } finally {
      await store.close();
    }
  });

  // Matrix ENG-05: supersession detected only AFTER the durable transaction
  // landed must not publish, but the commit itself is durable — and the next
  // reconcile/commit republishes from disk, so nothing is lost.
  test("a commit that goes stale post-transaction stays durable but unpublished", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesView, { scope: "e" });
      let published = 0;
      const commits: number[] = [];
      engine.subscribeCommits((commit) => commits.push(commit.head));
      // Invalidate the source INSIDE the transaction, after the head write —
      // the durable commit succeeds, then the post-commit fence trips.
      store.setFaultHook((point) => {
        if (point === "after-head-write") engine.invalidateSource("matrix-notes:e");
      });
      await expect(source.apply(source.capture(), granted("e", 1, [{ _id: "n1", body: "durable" }]),
        () => { published++; })).rejects.toBeInstanceOf(StaleLocalFirstSourceError);
      store.setFaultHook(null);
      expect(published).toBe(0);
      expect(commits).toEqual([]);
      const snapshot = await store.snapshot();
      expect(snapshot.views).toHaveLength(1);
      expect(snapshot.viewMembers.map((row) => row.entityKey)).toEqual(["note:n1"]);
      // Liveness recovers from the durable head, not the lost notification.
      await engine.reconcileDurableHead();
      expect(commits).toHaveLength(1);
    } finally {
      store.setFaultHook(null);
      await store.close();
    }
  });

  // Matrix ENG-04: duplicate identical complete results are idempotent.
  test("an exact duplicate complete result reapplies without error or corruption", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesView, { scope: "d" });
      const payload = granted("d", 3, [{ _id: "n1", body: "same" }, { _id: "n2", body: "rows" }]);
      await source.apply(source.capture(), payload);
      const before = await store.snapshot();
      await source.apply(source.capture(), payload);
      const after = await store.snapshot();
      expect(after.views[0].revision).toBe("3");
      expect(after.viewMembers.map((m) => m.entityKey)).toEqual(before.viewMembers.map((m) => m.entityKey));
      expect(after.viewProjections.map((p) => p.value)).toEqual(before.viewProjections.map((p) => p.value));
      expect(after.grants.map((g) => g.key)).toEqual(before.grants.map((g) => g.key));
    } finally {
      await store.close();
    }
  });

  // Matrix SRV-03: revocation physically purges a projection view — rows,
  // membership, projections, and grants all gone in one transaction.
  test("forbidden purges projections, membership, and grants atomically", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesView, { scope: "r" });
      await source.apply(source.capture(), granted("r", 1, [{ _id: "n1", body: "secret" }]));
      await source.apply(source.capture(), forbidden("r"));
      const snapshot = await store.snapshot();
      expect(snapshot.views).toEqual([]);
      expect(snapshot.viewMembers).toEqual([]);
      expect(snapshot.viewProjections).toEqual([]);
      expect(snapshot.grants).toEqual([]);
      expect(snapshot.viewWriters[0].lastAccess).toBe("forbidden");
    } finally {
      await store.close();
    }
  });

  // Matrix SRV-07 / NET-01: unauthenticated (auth resolving, offline boot)
  // never erases the durable offline view.
  test("an unauthenticated result leaves the durable offline view untouched", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const seen = collector();
      const session = new LocalViewSession(engine, notesView, { scope: "u" }, seen.publish);
      await session.deliver(granted("u", 2, [{ _id: "n1", body: "offline-visible" }]));
      await session.deliver(unauthenticated("u"));
      expect(seen.latest().status).toBe("granted");
      expect(seen.latest().rows.map((row) => (row.value as Row).body)).toEqual(["offline-visible"]);
      const snapshot = await store.snapshot();
      expect(snapshot.viewMembers).toHaveLength(1);
      session.close();
    } finally {
      await store.close();
    }
  });

  // Matrix NET-02: reconnecting after a long offline gap converges exactly,
  // including deletions, from one complete result.
  test("a single post-reconnect complete result converges membership exactly", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesView, { scope: "n" });
      await source.apply(source.capture(), granted("n", 5, [
        { _id: "a", body: "a" },
        { _id: "b", body: "b" },
        { _id: "c", body: "c" },
      ]));
      await source.apply(source.capture(), granted("n", 40, [
        { _id: "a", body: "a-edited" },
        { _id: "d", body: "d" },
      ]));
      const snapshot = await store.snapshot();
      expect(snapshot.viewMembers.map((m) => m.entityKey).sort()).toEqual(["note:a", "note:d"]);
      expect(snapshot.viewProjections.find((p) => p.entityKey === "note:a")?.value)
        .toEqual({ _id: "a", body: "a-edited" });
      expect(snapshot.viewProjections.find((p) => p.entityKey === "note:b")).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  // Matrix NET-03: interleaved results for different views never interfere.
  test("interleaved applies to two views stay independent", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const sourceA = await CompleteViewSource.open(engine, notesView, { scope: "one" });
      const sourceB = await CompleteViewSource.open(engine, notesView, { scope: "two" });
      await sourceA.apply(sourceA.capture(), granted("one", 1, [{ _id: "a1", body: "one" }]));
      await sourceB.apply(sourceB.capture(), granted("two", 1, [{ _id: "b1", body: "two" }]));
      await sourceA.apply(sourceA.capture(), granted("one", 2, [{ _id: "a2", body: "one2" }]));
      const snapshot = await store.snapshot();
      const byView = (key: string) =>
        snapshot.viewMembers.filter((m) => m.viewKey === key).map((m) => m.entityKey).sort();
      expect(byView("matrix-notes:one")).toEqual(["note:a2"]);
      expect(byView("matrix-notes:two")).toEqual(["note:b1"]);
    } finally {
      await store.close();
    }
  });

  // Matrix LIF-03: a crash inside claimViewWriter's transaction leaves no
  // partial writer state and no head advance.
  test("a crash inside the writer claim rolls back atomically", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const headBefore = await store.bootstrap.readHead(store.fence);
      store.setFaultHook((point) => {
        if (point === "after-operations") throw new Error("claim-crash");
      });
      await expect(CompleteViewSource.open(engine, notesView, { scope: "c" }))
        .rejects.toThrow("claim-crash");
      store.setFaultHook(null);
      expect(await store.bootstrap.readHead(store.fence)).toBe(headBefore);
      expect((await store.snapshot()).viewWriters).toEqual([]);
      // The same session machinery recovers on the next open.
      const source = await CompleteViewSource.open(engine, notesView, { scope: "c" });
      await source.apply(source.capture(), granted("c", 1, [{ _id: "n1", body: "after-crash" }]));
      expect((await store.snapshot()).viewMembers).toHaveLength(1);
    } finally {
      store.setFaultHook(null);
      await store.close();
    }
  });

  // Matrix LIF-04: hydration republishes non-granted access states durably —
  // a reload after revocation renders forbidden, not a ghost or a spinner.
  test("a fresh session over a revoked store publishes forbidden with zero rows", async () => {
    const store = await makeStore();
    const engineA = store.openTab();
    try {
      const seenA = collector();
      const sessionA = new LocalViewSession(engineA, notesView, { scope: "l" }, seenA.publish);
      await sessionA.deliver(granted("l", 1, [{ _id: "n1", body: "pre-revoke" }]));
      await sessionA.deliver(forbidden("l"));
      sessionA.close();

      const engineB = store.openTab();
      const seenB = collector();
      const sessionB = new LocalViewSession(engineB, notesView, { scope: "l" }, seenB.publish);
      await sessionB.settled();
      expect(seenB.latest().status).toBe("forbidden");
      expect(seenB.latest().rows).toEqual([]);
      sessionB.close();
    } finally {
      await store.close();
    }
  });

  // Matrix TAB-03: a tab that misses every broadcast still converges from the
  // durable head on reconcile (focus/visibility path).
  test("reconcileDurableHead republishes cross-tab commits without broadcasts", async () => {
    const store = await makeStore();
    const engineA = store.openTab();
    const engineB = store.openTab();
    try {
      const seenB = collector();
      const sessionB = new LocalViewSession(engineB, notesView, { scope: "t" }, seenB.publish);
      await sessionB.settled();

      // Tab A writes (B receives no broadcast — channels are null).
      const seenA = collector();
      const sessionA = new LocalViewSession(engineA, notesView, { scope: "t" }, seenA.publish);
      await sessionA.deliver(granted("t", 1, [{ _id: "n1", body: "from-a" }]));
      expect(seenB.latest().rows).toEqual([]);

      await engineB.reconcileDurableHead();
      // Republish is asynchronous behind the commit listener, and `settled()` can
      // only await work already in flight — so a single macrotask hop races the
      // republish on a loaded runner and reads back []. Poll for the publication
      // instead of assuming one turn is enough; the assertion stays exact.
      const republishedBodies = async () => {
        await sessionB.settled();
        return seenB.latest().rows.map((row) => (row.value as Row).body);
      };
      let bodies = await republishedBodies();
      for (let attempt = 0; attempt < 100 && bodies.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        bodies = await republishedBodies();
      }
      expect(bodies).toEqual(["from-a"]);
      sessionA.close();
      sessionB.close();
    } finally {
      await store.close();
    }
  });

  // Matrix TAB-06: another principal's broadcasts are ignored even on a
  // promiscuous channel.
  test("cross-principal broadcasts are ignored", async () => {
    const storeA = await makeStore();
    const storeB = await makeStore();
    // One shared bus regardless of channel name — deliberately promiscuous.
    const subscribers: ((event: MessageEvent) => void)[] = [];
    const makeChannel = () => {
      const channel = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage(data: unknown) {
          for (const listener of subscribers) listener({ data } as MessageEvent);
        },
        close() {},
      };
      subscribers.push((event) => channel.onmessage?.(event));
      return channel as unknown as BroadcastChannel;
    };
    const engineA = storeA.openTab(makeChannel);
    const engineB = storeB.openTab(makeChannel);
    try {
      const headB = engineB.head;
      const sourceA = await CompleteViewSource.open(engineA, notesView, { scope: "x" });
      await sourceA.apply(sourceA.capture(), granted("x", 1, [{ _id: "n1", body: "a-only" }]));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(engineB.head).toBe(headB);
      expect((await storeB.snapshot()).views).toEqual([]);
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });

  // Matrix VIEW-05: mount/unmount churn does not grow storage.
  test("open/close churn keeps one writer row and bounded content", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      for (let index = 0; index < 25; index++) {
        const seen = collector();
        const session = new LocalViewSession(engine, notesView, { scope: "churn" }, seen.publish);
        await session.deliver(granted("churn", index + 1, [{ _id: "n1", body: `pass-${index}` }]));
        session.close();
        await session.settled();
      }
      const snapshot = await store.snapshot();
      expect(snapshot.viewWriters).toHaveLength(1);
      expect(snapshot.views).toHaveLength(1);
      expect(snapshot.viewMembers).toHaveLength(1);
      expect(snapshot.viewProjections).toHaveLength(1);
      expect(snapshot.grants).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  // Matrix NET-05: randomized two-tab delivery interleavings always converge
  // to the newest revision the surviving tabs observed.
  test("randomized two-tab interleavings converge to the newest delivered revision", async () => {
    // Deterministic PRNG so a failure seed is a permanent regression.
    function mulberry32(seed: number) {
      let a = seed;
      return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    for (let seed = 1; seed <= 12; seed++) {
      const random = mulberry32(seed);
      const store = await makeStore();
      const engineA = store.openTab();
      const engineB = store.openTab();
      const sessionA = new LocalViewSession(engineA, notesView, { scope: "z" }, () => {});
      const sessionB = new LocalViewSession(engineB, notesView, { scope: "z" }, () => {});
      await sessionA.settled();
      await sessionB.settled();
      let bClosed = false;
      let highestDeliveredToLiveTab = 0;
      for (let revision = 1; revision <= 8; revision++) {
        const payload = granted("z", revision, [{ _id: "n1", body: `rev-${revision}` }]);
        const target = random() < 0.5 || bClosed ? "A" : "B";
        if (target === "A") {
          await sessionA.deliver(payload);
          highestDeliveredToLiveTab = revision;
        } else {
          await sessionB.deliver(payload);
          highestDeliveredToLiveTab = revision;
        }
        if (!bClosed && random() < 0.2) {
          sessionB.close();
          bClosed = true;
        }
      }
      const snapshot = await store.snapshot();
      expect(`${snapshot.views[0]?.revision}@seed${seed}`)
        .toBe(`${highestDeliveredToLiveTab}@seed${seed}`);
      expect(snapshot.viewProjections[0]?.value)
        .toEqual({ _id: "n1", body: `rev-${highestDeliveredToLiveTab}` });
      sessionA.close();
      if (!bClosed) sessionB.close();
      await store.close();
    }
  }, 30000);
});
