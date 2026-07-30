import { describe, expect, test } from "bun:test";
import {
  createPrincipalDispatchOutbox,
  type MobileDispatchDatabase,
  type MobileDispatchOutboxEntry,
} from "./dispatchOutbox";
import {
  asyncAction,
  DispatchNotWiredError,
  mutativeMiddleware,
} from "@codecast/web/store/mutativeMiddleware";

function memoryDatabase(): MobileDispatchDatabase {
  const rows = new Map<string, { principal_id: string; id: string; entry_json: string; ts: number }>();
  const mutate = (sql: string, params: unknown[]) => {
    if (sql.includes("INSERT INTO mobile_dispatch_outbox")) {
      const [principalId, id, entryJson, ts] = params as [string, string, string, number];
      rows.set(`${principalId}:${id}`, {
        principal_id: principalId,
        id,
        entry_json: entryJson,
        ts,
      });
      return;
    }
    if (sql.includes("DELETE FROM mobile_dispatch_outbox")) {
      const [principalId, id] = params as [string, string];
      rows.delete(`${principalId}:${id}`);
    }
  };
  return {
    async execAsync() {},
    runSync(sql, ...params) {
      mutate(sql, params);
    },
    async runAsync(sql, ...params) {
      mutate(sql, params);
    },
    async getAllAsync(_sql, ...params) {
      const [principalId] = params as [string];
      return [...rows.values()]
        .filter((row) => row.principal_id === principalId)
        .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    },
  };
}

const entry = (id: string, ts: number): MobileDispatchOutboxEntry => ({
  id,
  action: "createSession",
  args: [{ session_id: id, agent_type: "codex" }],
  patches: undefined,
  result: undefined,
  ts,
});

function middlewareHarness(outbox: ReturnType<typeof createPrincipalDispatchOutbox>) {
  let state: any;
  const wrapped = mutativeMiddleware(
    () => ({
      records: {} as Record<string, unknown>,
      createThing: asyncAction(function (this: any, id: string) {
        this.records[id] = { id };
      }),
    }),
    { retryDelays: [] },
  )(
    (next: any) => {
      state = next;
    },
    () => state,
    {},
  );
  state = wrapped;
  wrapped._setOutbox(outbox.enqueue, outbox.remove, outbox.load);
  return wrapped;
}

describe("principal-scoped mobile dispatch outbox", () => {
  test("never loads or removes another principal's rows", async () => {
    const database = memoryDatabase();
    const alice = createPrincipalDispatchOutbox(database, "user-alice");
    const bob = createPrincipalDispatchOutbox(database, "user-bob");

    await alice.enqueue(entry("a", 2));
    await bob.enqueue(entry("b", 1));

    expect((await alice.load()).map((row) => row.id)).toEqual(["a"]);
    expect((await bob.load()).map((row) => row.id)).toEqual(["b"]);

    await alice.remove("b");
    expect((await bob.load()).map((row) => row.id)).toEqual(["b"]);
  });

  test("round-trips replay metadata in stable creation order", async () => {
    const outbox = createPrincipalDispatchOutbox(memoryDatabase(), "user-a");
    await outbox.enqueue({ ...entry("later", 20), attempts: 4 });
    await outbox.enqueue(entry("earlier", 10));

    expect(await outbox.load()).toEqual([
      entry("earlier", 10),
      { ...entry("later", 20), attempts: 4 },
    ]);
  });

  test("rejects an empty principal binding", () => {
    expect(() => createPrincipalDispatchOutbox(memoryDatabase(), "")).toThrow(
      "principal",
    );
  });

  test("surfaces an enqueue storage failure synchronously", () => {
    const database = memoryDatabase();
    database.runSync = () => {
      throw new Error("disk unavailable");
    };
    const outbox = createPrincipalDispatchOutbox(database, "user-a");

    let thrown: unknown;
    try {
      outbox.enqueue(entry("not-durable", 1));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("disk unavailable");
  });

  test("middleware reports parked only after the native row exists", async () => {
    const outbox = createPrincipalDispatchOutbox(memoryDatabase(), "user-a");
    const store = middlewareHarness(outbox);

    await expect(store.createThing("intent-a")).rejects.toEqual(
      new DispatchNotWiredError("createThing", true),
    );
    expect((await outbox.load()).map((row) => row.action)).toEqual([
      "createThing",
    ]);
  });

  test("middleware propagates a failed native insert instead of parked:true", () => {
    const database = memoryDatabase();
    database.runSync = () => {
      throw new Error("disk unavailable");
    };
    const store = middlewareHarness(
      createPrincipalDispatchOutbox(database, "user-a"),
    );

    expect(() => store.createThing("intent-a")).toThrow("disk unavailable");
  });
});
