import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { LocalFirstCommandRuntime } from "../commands";
import { CompleteViewSource } from "../contracts";
import { compareLogTs, compareSourceCoverage, CoverageIntegrityError } from "../coverage";
import { LocalFirstEngine } from "../engine";
import { LocalViewSession, type LocalViewPublication } from "../localViewSession";
import { defineQueryView } from "../queryView";
import { TransitionStamper } from "../transitionStamper";
import {
  PrincipalStoreFenceError,
  PrincipalStoreIdentityError,
  type CommandReceiptRecord,
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
  type OpaquePrincipalKey,
} from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

type Row = { _id: string; body: string };
type Envelope =
  | { contractId: "notes/v2"; viewKey: string; access: "unauthenticated" }
  | {
      contractId: "notes/v2";
      viewKey: string;
      access: "forbidden";
      revokedGrantKeys: readonly string[];
    }
  | {
      contractId: "notes/v2";
      viewKey: string;
      access: "granted";
      grantKeys: readonly string[];
      viewRevision: number;
      commandIds?: readonly string[];
      notes: readonly Row[];
    };

const notesV2 = defineQueryView({
  id: "notes/v2",
  query: {} as never,
  key: ({ scope }: { scope: string }) => `lts-notes:${scope}`,
  rows: (granted: Extract<Envelope, { access: "granted" }>) => granted.notes,
  entityKey: (row) => `note:${row._id}`,
});

const notesV3 = defineQueryView({
  id: "notes/v3",
  supersedes: "notes/v2",
  envelopeContractId: "notes/v2",
  coverageSource: "stamped-log-ts",
  query: {} as never,
  key: ({ scope }: { scope: string }) => `lts-notes:${scope}`,
  rows: (granted: Extract<Envelope, { access: "granted" }>) => granted.notes,
  entityKey: (row) => `note:${row._id}`,
});

function granted(
  scope: string,
  revision: number,
  notes: readonly Row[],
  commandIds?: readonly string[],
): Envelope {
  return {
    contractId: "notes/v2",
    viewKey: `lts-notes:${scope}`,
    access: "granted",
    grantKeys: [`lts-grant:${scope}`],
    viewRevision: revision,
    ...(commandIds ? { commandIds } : {}),
    notes,
  };
}

async function makeStore() {
  const principalKey = randomUUID() as OpaquePrincipalKey;
  const name = principalDatabaseName(`lts-${randomUUID()}`, principalKey);
  const principalId = asPrincipalId("lts-principal");
  const bootstrap = new DexiePrincipalStoreAdapter(name, principalKey);
  const metadata = await bootstrap.activateVerified(1, principalId);
  const fence: PrincipalStoreFence = { principalKey, generation: 1 };
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
        sourceEpochFactory: () => asSourceEpoch(`lts-source-${++sourceEpoch}`),
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
    publish: (publication: LocalViewPublication<Row>) => publications.push(publication),
    latest: () => publications[publications.length - 1],
  };
}

describe("log-ts coverage ordering", () => {
  test("u64 decimal strings compare numerically and reject malformed values", () => {
    expect(compareLogTs("9", "10")).toBe(-1);
    expect(compareLogTs("0010", "10")).toBe(0);
    expect(compareLogTs("18446744073709551615", "2")).toBe(1);
    expect(() => compareLogTs("-1", "2")).toThrow(CoverageIntegrityError);
    expect(() => compareLogTs("1.5", "2")).toThrow(CoverageIntegrityError);
  });

  test("kinds never order against each other", () => {
    expect(compareSourceCoverage(
      { kind: "view-revision", revision: "5", revisionOrder: 5 },
      { kind: "log-ts", ts: "100" },
    )).toBe("incomparable");
    expect(compareSourceCoverage({ kind: "log-ts", ts: "7" }, { kind: "log-ts", ts: "7" })).toBe("equal");
    expect(compareSourceCoverage({ kind: "log-ts", ts: "7" }, { kind: "log-ts", ts: "8" })).toBe("newer");
    expect(compareSourceCoverage({ kind: "log-ts", ts: "8" }, { kind: "log-ts", ts: "7" })).toBe("older");
  });
});

describe("log-ts durable semantics", () => {
  test("monotonic applies land, older timestamps are fenced, equal duplicates are idempotent", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesV3, { scope: "m" });
      await source.apply(source.capture(), granted("m", 1, [{ _id: "n1", body: "one" }]),
        undefined, { stampedLogTs: "100" });
      await source.apply(source.capture(), granted("m", 1, [{ _id: "n1", body: "two" }]),
        undefined, { stampedLogTs: "250" });
      let snapshot = await store.snapshot();
      expect(snapshot.views[0].coverage).toEqual({
        kind: "log-ts", ts: "250", commandIds: [],
      });
      expect(snapshot.viewProjections[0].value).toEqual({ _id: "n1", body: "two" });

      await expect(source.apply(source.capture(), granted("m", 1, [{ _id: "n1", body: "stale" }]),
        undefined, { stampedLogTs: "200" })).rejects.toBeInstanceOf(PrincipalStoreFenceError);

      // Identical content at the identical log position is an idempotent no-op.
      await source.apply(source.capture(), granted("m", 1, [{ _id: "n1", body: "two" }]),
        undefined, { stampedLogTs: "250" });
      snapshot = await store.snapshot();
      expect(snapshot.viewProjections[0].value).toEqual({ _id: "n1", body: "two" });
    } finally {
      await store.close();
    }
  });

  // The tripwire the campaign retired for watermark coverage (SRV-01) returns
  // at FULL strength here: equal log positions are the same server snapshot.
  test("equal log-ts with divergent content is rejected as corruption", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesV3, { scope: "c" });
      await source.apply(source.capture(), granted("c", 1, [{ _id: "n1", body: "truth" }]),
        undefined, { stampedLogTs: "500" });
      await expect(source.apply(source.capture(), granted("c", 1, [{ _id: "n1", body: "imposter" }]),
        undefined, { stampedLogTs: "500" })).rejects.toBeInstanceOf(PrincipalStoreIdentityError);
      const snapshot = await store.snapshot();
      expect(snapshot.viewProjections[0].value).toEqual({ _id: "n1", body: "truth" });
    } finally {
      await store.close();
    }
  });

  test("a stamped contract refuses granted results without a stamp", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const source = await CompleteViewSource.open(engine, notesV3, { scope: "s" });
      await expect(source.apply(source.capture(), granted("s", 1, [{ _id: "n1", body: "x" }])))
        .rejects.toThrow("requires a transition timestamp");
    } finally {
      await store.close();
    }
  });
});

describe("contract supersession (v2 → v3 migration)", () => {
  test("a v3 claim migrates the durable view: content re-bootstraps, coverage domain resets", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      // v2 era: watermark-covered content persisted.
      const v2 = await CompleteViewSource.open(engine, notesV2, { scope: "mig" });
      await v2.apply(v2.capture(), granted("mig", 7, [{ _id: "n1", body: "v2-era" }]));
      v2.close();
      let snapshot = await store.snapshot();
      expect(snapshot.views[0].contractId).toBe("notes/v2");

      // v3 claim supersedes: old content dropped for a fresh bootstrap...
      const v3 = await CompleteViewSource.open(engine, notesV3, { scope: "mig" });
      snapshot = await store.snapshot();
      expect(snapshot.views).toEqual([]);
      expect(snapshot.viewMembers).toEqual([]);
      expect(snapshot.viewWriters[0]).toMatchObject({ contractId: "notes/v3" });
      expect(snapshot.viewWriters[0].lastCoverage).toBeUndefined();

      // ...and the first stamped result lands as the initial coverage.
      await v3.apply(v3.capture(), granted("mig", 7, [{ _id: "n1", body: "v3-era" }]),
        undefined, { stampedLogTs: "42" });
      snapshot = await store.snapshot();
      expect(snapshot.views[0]).toMatchObject({ contractId: "notes/v3" });
      expect(snapshot.views[0].coverage).toEqual({ kind: "log-ts", ts: "42", commandIds: [] });
      expect(snapshot.viewProjections[0].value).toEqual({ _id: "n1", body: "v3-era" });
    } finally {
      await store.close();
    }
  });

  test("an undeclared contract change is still rejected", async () => {
    const store = await makeStore();
    const engine = store.openTab();
    try {
      const v2 = await CompleteViewSource.open(engine, notesV2, { scope: "guard" });
      await v2.apply(v2.capture(), granted("guard", 1, [{ _id: "n1", body: "x" }]));
      const undeclared = defineQueryView({
        id: "notes/v4-undeclared",
        envelopeContractId: "notes/v2",
        coverageSource: "stamped-log-ts",
        query: {} as never,
        key: ({ scope }: { scope: string }) => `lts-notes:${scope}`,
        rows: (g: Extract<Envelope, { access: "granted" }>) => g.notes,
        entityKey: (row) => `note:${row._id}`,
      });
      await expect(CompleteViewSource.open(engine, undeclared, { scope: "guard" }))
        .rejects.toBeInstanceOf(PrincipalStoreIdentityError);
    } finally {
      await store.close();
    }
  });
});

describe("write reconciliation via echoed command ids", () => {
  async function fixtureWithCommand(store: Awaited<ReturnType<typeof makeStore>>) {
    const engine = store.openTab();
    const source = await CompleteViewSource.open(engine, notesV3, { scope: "w" });
    await source.apply(source.capture(), granted("w", 1, [{ _id: "n1", body: "base" }]),
      undefined, { stampedLogTs: "10" });
    const runtime = new LocalFirstCommandRuntime(store.bootstrap, store.fence, store.principalId);
    const command = await runtime.queue({
      id: "cmd-echo-1",
      contractId: "notes.command/v3",
      commandType: "notes.add/v3",
      conflictKey: "lts-notes:w",
      operationSchemaVersion: 1,
      targetGrantKeys: [asGrantKey("lts-grant:w")],
      targetEntityKeys: [],
      replayPolicy: "server-deduplicated",
      payload: { body: "mine" },
      requiredCoverage: {
        kind: "command-id",
        contractId: "notes/v3",
        viewKey: "lts-notes:w",
      },
      optimisticOperations: [{
        kind: "upsert-projection",
        viewKey: "lts-notes:w",
        entityKey: "note:optimistic",
        value: { _id: "optimistic", body: "mine" },
      }],
    });
    const receipt: CommandReceiptRecord = {
      commandId: command.id,
      principalId: store.principalId,
      commandType: command.commandType,
      outcome: "acknowledged",
      receivedAt: 20,
      coverage: [{
        kind: "command-id",
        contractId: "notes/v3",
        viewKey: "lts-notes:w",
        commandId: command.id,
      }],
      retryUntil: null,
    };
    return { engine, source, runtime, command, receipt };
  }

  test("receipt first: the overlay retires exactly when the echo lands", async () => {
    const store = await makeStore();
    try {
      const { source, runtime, command, receipt } = await fixtureWithCommand(store);
      const sent = await runtime.markSending(command);
      const settled = await runtime.settleReceipt(sent, receipt);
      expect(settled).toMatchObject({
        status: "acknowledged-awaiting-coverage",
        optimisticActive: true,
      });

      // A refire WITHOUT the echo (raced ahead of the receipt write) does not
      // retire the overlay...
      await source.apply(source.capture(), granted("w", 1, [{ _id: "n1", body: "base" }]),
        undefined, { stampedLogTs: "30" });
      expect((await store.bootstrap.readCommand(store.fence, command.id))?.status)
        .toBe("acknowledged-awaiting-coverage");

      // ...and the refire whose snapshot echoes the id retires it atomically.
      await source.apply(source.capture(), granted("w", 1, [
        { _id: "n1", body: "base" },
        { _id: "server-row", body: "mine" },
      ], [command.id]), undefined, { stampedLogTs: "40" });
      expect((await store.bootstrap.readCommand(store.fence, command.id)))
        .toMatchObject({ status: "reconciled", optimisticActive: false });
    } finally {
      await store.close();
    }
  });

  test("echo first: settling the receipt against an already-echoing view reconciles immediately", async () => {
    const store = await makeStore();
    try {
      const { source, runtime, command, receipt } = await fixtureWithCommand(store);
      const sent = await runtime.markSending(command);
      await source.apply(source.capture(), granted("w", 1, [
        { _id: "n1", body: "base" },
        { _id: "server-row", body: "mine" },
      ], [command.id]), undefined, { stampedLogTs: "35" });
      const settled = await runtime.settleReceipt(sent, receipt);
      expect(settled).toMatchObject({ status: "reconciled", optimisticActive: false });
    } finally {
      await store.close();
    }
  });
});

describe("transition stamper", () => {
  function fakeClient() {
    let value: unknown;
    let ts: { toString(): string } | undefined;
    const listeners = new Set<() => void>();
    const client = {
      watchQuery: () => ({
        localQueryResult: () => {
          if (value instanceof Error) throw value;
          return value;
        },
        onUpdate: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
      sync: { getMaxObservedTimestamp: () => ts },
    };
    return {
      client: client as never,
      push(nextValue: unknown, nextTs: string | undefined) {
        value = nextValue;
        ts = nextTs === undefined ? undefined : { toString: () => nextTs };
        for (const listener of listeners) listener();
      },
      seed(nextValue: unknown, nextTs: string | undefined) {
        value = nextValue;
        ts = nextTs === undefined ? undefined : { toString: () => nextTs };
      },
      listeners,
    };
  }

  test("stamps the cached result at registration and every update after", () => {
    const fake = fakeClient();
    fake.seed({ hello: 1 }, "77");
    const stamper = new TransitionStamper(fake.client);
    const stamped: Array<{ result: unknown; logTs: string }> = [];
    const unsubscribe = stamper.register({} as never, {}, (s) => stamped.push(s));
    expect(stamped).toEqual([{ result: { hello: 1 }, logTs: "77" }]);
    fake.push({ hello: 2 }, "90");
    expect(stamped[1]).toEqual({ result: { hello: 2 }, logTs: "90" });
    unsubscribe();
    fake.push({ hello: 3 }, "95");
    expect(stamped).toHaveLength(2);
  });

  test("never stamps without a result or without an observed timestamp", () => {
    const fake = fakeClient();
    const stamper = new TransitionStamper(fake.client);
    const stamped: unknown[] = [];
    stamper.register({} as never, {}, (s) => stamped.push(s));
    expect(stamped).toEqual([]);
    fake.seed({ early: true }, undefined);
    fake.push({ early: true }, undefined);
    expect(stamped).toEqual([]);
    fake.push({ ready: true }, "12");
    expect(stamped).toHaveLength(1);
  });

  test("query errors surface through onError without a stamp", () => {
    const fake = fakeClient();
    fake.seed(new Error("query blew up"), "50");
    const stamper = new TransitionStamper(fake.client);
    const stamped: unknown[] = [];
    const errors: unknown[] = [];
    stamper.register({} as never, {}, (s) => stamped.push(s), (e) => errors.push(e));
    expect(stamped).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("stamped session end to end", () => {
  test("stamped deliveries publish, hand off across tabs, and migrate from v2", async () => {
    const store = await makeStore();
    const engineA = store.openTab();
    const engineB = store.openTab();
    try {
      // v2-era durable state exists first.
      const v2 = await CompleteViewSource.open(engineA, notesV2, { scope: "e2e" });
      await v2.apply(v2.capture(), granted("e2e", 3, [{ _id: "n1", body: "v2" }]));
      v2.close();

      const seenA = collector();
      const sessionA = new LocalViewSession(engineA, notesV3, { scope: "e2e" }, seenA.publish);
      await sessionA.deliverStamped(granted("e2e", 3, [{ _id: "n1", body: "fresh" }]), "1000");
      expect(seenA.latest().status).toBe("granted");
      expect(seenA.latest().rows.map((row) => (row.value as Row).body)).toEqual(["fresh"]);

      // Tab B steals the writer; tab A's strictly-newer stamped delivery
      // hands the view back (writer-handoff under log-ts coverage).
      const seenB = collector();
      const sessionB = new LocalViewSession(engineB, notesV3, { scope: "e2e" }, seenB.publish);
      await sessionB.deliverStamped(granted("e2e", 3, [{ _id: "n1", body: "from-b" }]), "1100");
      sessionB.close();
      engineB.close();
      await sessionA.deliverStamped(granted("e2e", 3, [{ _id: "n1", body: "newest" }]), "1200");
      const snapshot = await store.snapshot();
      expect(snapshot.views[0].coverage).toMatchObject({ kind: "log-ts", ts: "1200" });
      expect(snapshot.viewProjections[0].value).toEqual({ _id: "n1", body: "newest" });
      sessionA.close();
    } finally {
      await store.close();
    }
  });
});
