import { describe, expect, it } from "bun:test";
import {
  action,
  applySyncTable,
  createLocalFirstStore,
  createPersistence,
  makeCollectionSig,
  makeUseTrackedStore,
  rowSigExcluding,
  stableRefId,
  sync,
  useCoarseNow,
  type PlatformConfig,
} from "./index";

// End to end through the public surface: an optimistic write lands
// synchronously, dispatches, and defends itself against the contradicting
// server push that follows.

const SERVER_ID = "a".repeat(32);

const CONFIG: PlatformConfig = {
  dbName: "platform-smoke",
  dbVersion: 1,
  registry: {
    items: {
      persistence: { kind: "collection", key: "items" },
      localFirst: true,
      dispatchTable: { table: "item_rows", kind: "collection" },
    },
    pending: { persistence: { kind: "meta", key: "pending" } },
  },
  syncRegistry: { items: { isDelta: true } },
};

type State = {
  items: Record<string, any>;
  pending: Record<string, any>;
  create: (id: string, title: string) => void;
  rename: (id: string, title: string) => void;
  syncItems: (rows: any[]) => void;
};

function makeStore() {
  const dispatched: any[] = [];
  const platform = createLocalFirstStore<State>(CONFIG, () => ({
    items: {},
    pending: {},
    create: action(function (this: any, id: string, title: string) {
      this.items[id] = { _id: id, title };
    }),
    rename: action(function (this: any, id: string, title: string) {
      this.items[id].title = title;
    }),
    syncItems: sync(function (this: any, rows: any[]) {
      platform.syncEngine.syncTable(this, "items", rows);
    }),
  }));
  platform.useStore.getState()._setDispatch(async (a, args, patches) => {
    dispatched.push({ action: a, args, patches });
    return {};
  });
  return { platform, dispatched };
}

describe("public surface", () => {
  it("exports the engine, the recipes and the render-cost tools", () => {
    expect(typeof createLocalFirstStore).toBe("function");
    expect(typeof createPersistence).toBe("function");
    expect(typeof applySyncTable).toBe("function");
    expect(typeof makeUseTrackedStore).toBe("function");
    expect(typeof useCoarseNow).toBe("function");
    expect(typeof makeCollectionSig).toBe("function");
    expect(typeof rowSigExcluding).toBe("function");
    expect(typeof stableRefId).toBe("function");
  });

  it("keeps an optimistic write until the server echoes it", async () => {
    const { platform, dispatched } = makeStore();
    const store = platform.useStore;

    store.getState().create(SERVER_ID, "draft");
    expect(store.getState().pending[`items:${SERVER_ID}`]).toMatchObject({ type: "include" });

    store.getState().rename(SERVER_ID, "mine");
    expect(store.getState().items[SERVER_ID].title).toBe("mine");
    expect(store.getState().pending[`items:${SERVER_ID}:title`]).toMatchObject({ value: "mine" });

    // The write reached the server as a patch on the mapped table.
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatched.at(-1).patches).toEqual({ item_rows: { [SERVER_ID]: { title: "mine" } } });

    // A contradicting push loses.
    store.getState().syncItems([{ _id: SERVER_ID, title: "theirs", updated_at: 1 }]);
    expect(store.getState().items[SERVER_ID].title).toBe("mine");

    // The echo retires the lock.
    store.getState().syncItems([{ _id: SERVER_ID, title: "mine", updated_at: 2 }]);
    expect(store.getState().items[SERVER_ID].title).toBe("mine");
    expect(store.getState().pending[`items:${SERVER_ID}:title`]).toBeUndefined();
  });

  it("reports persistence as unavailable outside a browser", () => {
    const persistence = createPersistence(CONFIG, {
      getState: () => ({}),
      setState: () => {},
    });
    expect(persistence.available).toBe(false);
    expect(persistence.cache).toBeNull();
  });
});
