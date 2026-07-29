import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
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

async function makeEngine() {
  const principalKey = randomUUID() as OpaquePrincipalKey;
  const name = principalDatabaseName(`session-${randomUUID()}`, principalKey);
  const adapter = new DexiePrincipalStoreAdapter(name, principalKey, () => {});
  const principalId = asPrincipalId("session-principal");
  const metadata = await adapter.activateVerified(1, principalId);
  let sourceEpoch = 0;
  const engine = new LocalFirstEngine({
    adapter,
    fence: { principalKey, generation: 1 },
    principalId,
    principalEpoch: asPrincipalEpoch(1),
    initialHead: metadata.head,
    sourceEpochFactory: () => asSourceEpoch(`session-source-${++sourceEpoch}`),
    channelFactory: () => null,
  });
  return {
    engine,
    async close() {
      engine.close();
      await adapter.purge();
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

describe("LocalViewSession", () => {
  test("applies delivered envelopes in order and publishes visible rows", async () => {
    const fixture = await makeEngine();
    try {
      const seen = collector();
      const session = new LocalViewSession(fixture.engine, notesView, { scope: "home" }, seen.publish);
      await session.deliver(granted("home", 1, [{ _id: "n1", body: "first" }]));
      await session.deliver(granted("home", 2, [
        { _id: "n1", body: "first" },
        { _id: "n2", body: "second" },
      ]));
      expect(seen.latest().status).toBe("granted");
      expect(seen.latest().rows.map((row) => row.entityKey)).toEqual(["note:n1", "note:n2"]);
      expect((seen.latest().rows[1].value as Row).body).toBe("second");
      session.close();
    } finally {
      await fixture.close();
    }
  });

  test("durable rows publish on open before any server delivery", async () => {
    const fixture = await makeEngine();
    try {
      const writerSeen = collector();
      const writer = new LocalViewSession(fixture.engine, notesView, { scope: "home" }, writerSeen.publish);
      await writer.deliver(granted("home", 3, [{ _id: "n7", body: "durable" }]));
      writer.close();

      const seen = collector();
      const reader = new LocalViewSession(fixture.engine, notesView, { scope: "home" }, seen.publish);
      await reader.settled();
      expect(seen.latest().status).toBe("granted");
      expect(seen.latest().rows.map((row) => row.entityKey)).toEqual(["note:n7"]);
      reader.close();
    } finally {
      await fixture.close();
    }
  });

  test("a forbidden envelope clears the view and publishes the access state", async () => {
    const fixture = await makeEngine();
    try {
      const seen = collector();
      const session = new LocalViewSession(fixture.engine, notesView, { scope: "home" }, seen.publish);
      await session.deliver(granted("home", 1, [{ _id: "n1", body: "first" }]));
      await session.deliver({
        contractId: "notes.byScope/v2",
        viewKey: "notes:home",
        access: "forbidden",
        revokedGrantKeys: ["notes-grant:home"],
      } satisfies Envelope);
      expect(seen.latest().status).toBe("forbidden");
      expect(seen.latest().rows).toEqual([]);
      session.close();
    } finally {
      await fixture.close();
    }
  });

  test("deliveries after close are ignored", async () => {
    const fixture = await makeEngine();
    try {
      const seen = collector();
      const session = new LocalViewSession(fixture.engine, notesView, { scope: "home" }, seen.publish);
      await session.settled();
      const before = seen.publications.length;
      session.close();
      await session.deliver(granted("home", 1, [{ _id: "n1", body: "first" }]));
      expect(seen.publications.length).toBe(before);
    } finally {
      await fixture.close();
    }
  });

  test("engine commit events republish without a new delivery", async () => {
    const fixture = await makeEngine();
    try {
      const commits: { head: number; affectedKeys: readonly string[] }[] = [];
      const unsubscribe = fixture.engine.subscribeCommits((commit) => commits.push(commit));
      const seen = collector();
      const session = new LocalViewSession(fixture.engine, notesView, { scope: "home" }, seen.publish);
      await session.deliver(granted("home", 1, [{ _id: "n1", body: "first" }]));
      expect(commits.length).toBeGreaterThan(0);
      expect(commits[commits.length - 1].affectedKeys).toContain("view:notes:home");
      unsubscribe();
      session.close();
    } finally {
      await fixture.close();
    }
  });
});
