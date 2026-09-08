// The census has to wrap `subscribe` on the INNER zustand api, before create()
// copies it onto the bound hook. Wrapping the copy afterwards counts only the
// imperative useInboxStore.subscribe() callers and misses every React
// subscription — the ones that scale with the number of rows on screen, which
// is the whole point of the count. These tests pin both paths.
import { afterEach, describe, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { installStoreListenerCensus, readStoreListenerCount } from "../storeListenerCensus";
import { resetSyncTransactionForTests } from "../syncTransaction";

type CensusState = { n: number };
type CensusApi = {
  subscribe: (listener: (state: CensusState, previous: CensusState) => void) => () => void;
  setState: (partial: Partial<CensusState>) => void;
};

/** Rebuilds what create() does, so the test exercises the real wiring order. */
function createCensusStore(): { api: CensusApi; hook: { subscribe: unknown } } {
  const api = createStore<CensusState>(() => ({ n: 0 })) as unknown as CensusApi;
  installStoreListenerCensus(api);
  const hook = ((selector: (state: CensusState) => unknown) =>
    useStore(api as never, selector)) as unknown as { subscribe: unknown };
  Object.assign(hook, api);
  return { api, hook };
}

afterEach(() => resetSyncTransactionForTests());

describe("store listener census", () => {
  test("counts subscriptions made through the inner api, which is what React reads", () => {
    const { api } = createCensusStore();
    expect(readStoreListenerCount()).toBe(0);

    const unsubscribe = api.subscribe(() => undefined);
    expect(readStoreListenerCount()).toBe(1);

    unsubscribe();
    expect(readStoreListenerCount()).toBe(0);
  });

  test("counts the hook copy and the inner api as one pool", () => {
    const { api, hook } = createCensusStore();
    const subscribe = hook.subscribe as (listener: () => void) => () => void;

    const viaHook = subscribe(() => undefined);
    const viaApi = api.subscribe(() => undefined);
    expect(readStoreListenerCount()).toBe(2);

    viaHook();
    viaApi();
    expect(readStoreListenerCount()).toBe(0);
  });

  test("does not double-decrement when React calls the same cleanup twice", () => {
    const { api } = createCensusStore();
    const keep = api.subscribe(() => undefined);
    const unsubscribe = api.subscribe(() => undefined);
    expect(readStoreListenerCount()).toBe(2);

    unsubscribe();
    unsubscribe();
    expect(readStoreListenerCount()).toBe(1);

    keep();
    expect(readStoreListenerCount()).toBe(0);
  });

  test("still delivers state to a counted listener, and stops on release", () => {
    const { api } = createCensusStore();
    let seen = 0;
    const unsubscribe = api.subscribe((state) => { seen = state.n; });

    api.setState({ n: 7 });
    expect(seen).toBe(7);

    unsubscribe();
    api.setState({ n: 9 });
    expect(seen).toBe(7);
  });

  test("installing twice on the same api does not double-wrap subscribe", () => {
    const { api } = createCensusStore();
    installStoreListenerCensus(api);

    const unsubscribe = api.subscribe(() => undefined);
    expect(readStoreListenerCount()).toBe(1);
    unsubscribe();
    expect(readStoreListenerCount()).toBe(0);
  });
});
