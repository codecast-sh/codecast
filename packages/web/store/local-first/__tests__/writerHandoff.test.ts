import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { CompleteViewSource } from "../contracts";
import { LocalFirstEngine } from "../engine";
import { LocalViewSession, type LocalViewPublication } from "../localViewSession";
import { defineQueryView } from "../queryView";
import {
  DexiePrincipalStoreAdapter,
  principalDatabaseName,
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
type Envelope =
  | { contractId: "notes.byScope/v2"; viewKey: string; access: "unauthenticated" }
  | {
      contractId: "notes.byScope/v2";
      viewKey: string;
      access: "forbidden";
      revokedGrantKeys: readonly string[];
    }
  | {
      contractId: "notes.byScope/v2";
      viewKey: string;
      access: "granted";
      grantKeys: readonly string[];
      viewRevision: number;
      coverage: { kind: "view-revision"; revision: string; revisionOrder: number };
      notes: readonly Row[];
    };

const notesView = defineQueryView({
  id: "notes.byScope/v2",
  query: {} as never,
  key: ({ scope }: { scope: string }) => `notes:${scope}`,
  rows: (granted: Extract<Envelope, { access: "granted" }>) => granted.notes,
  entityKey: (row) => `note:${row._id}`,
});

function granted(scope: string, revision: number, notes: readonly Row[]): Envelope {
  return {
    contractId: "notes.byScope/v2",
    viewKey: `notes:${scope}`,
    access: "granted",
    grantKeys: [`notes-grant:${scope}`],
    viewRevision: revision,
    coverage: { kind: "view-revision", revision: String(revision), revisionOrder: revision },
    notes,
  };
}

function forbidden(scope: string): Envelope {
  return {
    contractId: "notes.byScope/v2",
    viewKey: `notes:${scope}`,
    access: "forbidden",
    revokedGrantKeys: [`notes-grant:${scope}`],
  };
}

/** One shared durable database observed by one or more engines ("tabs"). */
async function makeStore() {
  const principalKey = randomUUID() as OpaquePrincipalKey;
  const name = principalDatabaseName(`handoff-${randomUUID()}`, principalKey);
  const principalId = asPrincipalId("handoff-principal");
  const bootstrap = new DexiePrincipalStoreAdapter(name, principalKey);
  const metadata = await bootstrap.activateVerified(1, principalId);
  const fence = { principalKey, generation: 1 };
  const adapters: DexiePrincipalStoreAdapter[] = [bootstrap];
  const engines: LocalFirstEngine[] = [];
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
        sourceEpochFactory: () => asSourceEpoch(`handoff-source-${++sourceEpoch}`),
        channelFactory: () => null,
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
    publish: (publication: LocalViewPublication<Row>) => {
      publications.push(publication);
    },
    latest: () => publications[publications.length - 1],
  };
}

describe("source supersession and writer handoff", () => {
  // Matrix ENG-01: closing a superseded source must not kill its successor.
  test("closing a superseded source leaves the successor source applicable", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const stale = await CompleteViewSource.open(engine, notesView, { scope: "home" });
      const successor = await CompleteViewSource.open(engine, notesView, { scope: "home" });
      // The stale source closes AFTER the successor claimed the same view key —
      // exactly what happens when a session with an in-flight apply unmounts
      // while its replacement (same conversation) is already open.
      stale.close();
      await successor.apply(successor.capture(), granted("home", 1, [{ _id: "n1", body: "alive" }]));
      const snapshot = await store.snapshot();
      expect(snapshot.viewMembers.map((row) => row.entityKey)).toEqual(["note:n1"]);
    } finally {
      await store.close();
    }
  });

  // Matrix TAB-01 (regression guard): a fenced tab must not thrash writer
  // claims while the durable view is already caught up to its delivery.
  test("a fenced tab does not re-claim when durable state already covers its delivery", async () => {
    const store = await makeStore();
    const engineA = store.openTab();
    const engineB = store.openTab();
    try {
      const seenA = collector();
      const sessionA = new LocalViewSession(engineA, notesView, { scope: "home" }, seenA.publish);
      await sessionA.settled();
      const seenB = collector();
      const sessionB = new LocalViewSession(engineB, notesView, { scope: "home" }, seenB.publish);
      await sessionB.settled();

      await sessionB.deliver(granted("home", 1, [{ _id: "n1", body: "from-b" }]));
      const writerEpochAfterB = (await store.snapshot()).viewWriters[0].writerEpoch;

      await sessionA.deliver(granted("home", 1, [{ _id: "n1", body: "from-b" }]));
      const snapshot = await store.snapshot();
      expect(snapshot.viewWriters[0].writerEpoch).toBe(writerEpochAfterB);
      expect(snapshot.views[0].revision).toBe("1");
      sessionA.close();
      sessionB.close();
    } finally {
      await store.close();
    }
  });

  // Matrix TAB-01: when the writer tab dies, a surviving tab holding a newer
  // authorized result must take over the durable view instead of silently
  // discarding every subsequent server result.
  test("a surviving tab re-claims the writer for a newer result after the writer tab closes", async () => {
    const store = await makeStore();
    const engineA = store.openTab();
    const engineB = store.openTab();
    try {
      const seenA = collector();
      const sessionA = new LocalViewSession(engineA, notesView, { scope: "home" }, seenA.publish);
      await sessionA.settled();
      const seenB = collector();
      const sessionB = new LocalViewSession(engineB, notesView, { scope: "home" }, seenB.publish);
      await sessionB.settled();

      await sessionB.deliver(granted("home", 1, [{ _id: "n1", body: "first" }]));
      sessionB.close();
      engineB.close();

      await sessionA.deliver(granted("home", 2, [{ _id: "n1", body: "second" }]));
      const snapshot = await store.snapshot();
      expect(snapshot.views[0].revision).toBe("2");
      expect(snapshot.viewProjections.map((row) => row.value)).toEqual([
        { _id: "n1", body: "second" },
      ]);
      expect(seenA.latest().rows.map((row) => (row.value as Row).body)).toEqual(["second"]);
      sessionA.close();
    } finally {
      await store.close();
    }
  });

  // Matrix SRV-01: a projection whose joined fields drift without a revision
  // advance (user rename) must still converge — the fenced live source is by
  // construction ordered, so its latest content wins at equal coverage.
  test("equal-revision content drift from the fenced live source updates the view", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesView, { scope: "home" });
      await source.apply(source.capture(), granted("home", 5, [{ _id: "n1", body: "old-name" }]));
      await source.apply(source.capture(), granted("home", 5, [{ _id: "n1", body: "new-name" }]));
      const snapshot = await store.snapshot();
      expect(snapshot.views[0].revision).toBe("5");
      expect(snapshot.viewProjections.map((row) => row.value)).toEqual([
        { _id: "n1", body: "new-name" },
      ]);
    } finally {
      await store.close();
    }
  });

  // Matrix SRV-02 (client half): after access loss, a mounted session must
  // recover when access is restored with NEWER coverage.
  test("a mounted session recovers from forbidden when re-granted at newer coverage", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const seen = collector();
      const session = new LocalViewSession(engine, notesView, { scope: "home" }, seen.publish);
      await session.deliver(granted("home", 1, [{ _id: "n1", body: "visible" }]));
      await session.deliver(forbidden("home"));
      expect(seen.latest().status).toBe("forbidden");
      expect(seen.latest().rows).toEqual([]);

      await session.deliver(granted("home", 2, [{ _id: "n1", body: "restored" }]));
      expect(seen.latest().status).toBe("granted");
      expect(seen.latest().rows.map((row) => (row.value as Row).body)).toEqual(["restored"]);
      session.close();
    } finally {
      await store.close();
    }
  });

  // Matrix SRV-02 (security half, pinned): a granted result at EQUAL coverage
  // cannot resurrect a forbidden view — a stale cached query result at the old
  // revision must never restore revoked content.
  test("a re-grant at equal coverage stays blocked", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const seen = collector();
      const session = new LocalViewSession(engine, notesView, { scope: "home" }, seen.publish);
      await session.deliver(granted("home", 1, [{ _id: "n1", body: "visible" }]));
      await session.deliver(forbidden("home"));
      await session.deliver(granted("home", 1, [{ _id: "n1", body: "stale-cache" }]));
      expect(seen.latest().status).toBe("forbidden");
      expect(seen.latest().rows).toEqual([]);
      const snapshot = await store.snapshot();
      expect(snapshot.views).toEqual([]);
      expect(snapshot.viewMembers).toEqual([]);
      session.close();
    } finally {
      await store.close();
    }
  });
});
