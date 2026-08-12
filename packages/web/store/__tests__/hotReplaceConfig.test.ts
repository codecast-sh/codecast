import { describe, expect, it } from "bun:test";
import { action, mutativeMiddleware } from "../mutativeMiddleware";

// Editing the store used to reload the whole app. store/inboxStore.ts exports a
// hook and actions rather than components, so React Fast Refresh cannot make it
// an update boundary, and vite's search for one dead-ends twice over: lib/sounds
// imports the store straight back, and lib/errorToast reaches src/boot.tsx,
// which is the entry and has no importers. Vite's fallback is a full page
// reload, which costs a fresh Convex WebSocket handshake before any data returns.
//
// The module self-accepts instead (plugins/storeHmr.ts appends the accept call)
// and reuses the surviving store, with _hotReplaceConfig swapping in the new
// action bodies. Two things must hold for that to be safe: live data survives,
// and so do the runtime bindings this closure owns — dispatch and its epoch, IDB
// write-through, the durable outbox. A swap that quietly unwired dispatch would
// park every later write with no visible failure.

function makeStore(config: any) {
  let state: any;
  // Models zustand's setState: a partial merges, `replace` swaps wholesale.
  const set = (next: any, replace?: boolean) => {
    state = replace ? next : { ...state, ...next };
  };
  const get = () => state;
  state = mutativeMiddleware(config, { retryDelays: [] })(set, get, {});
  return get;
}

describe("_hotReplaceConfig", () => {
  it("runs the edited action body against the state that was already there", () => {
    const get = makeStore(() => ({
      counter: 0,
      label: "before",
      bump: action(function (this: any) {
        this.counter += 1;
      }),
    }));

    get().bump();
    get().bump();
    expect(get().counter).toBe(2);

    // The edit: a different body, and different initial values.
    get()._hotReplaceConfig(() => ({
      counter: 0,
      label: "after",
      bump: action(function (this: any) {
        this.counter += 10;
      }),
    }));

    // Live data wins over the re-evaluated initial values — an edit to one
    // action must not reset the app's state.
    expect(get().counter).toBe(2);
    expect(get().label).toBe("before");

    get().bump();
    expect(get().counter).toBe(12);
  });

  it("keeps the dispatch binding, so a write after the swap still reaches the server", async () => {
    const dispatched: string[] = [];
    const config = () => ({
      items: {} as Record<string, any>,
      poke: action(function (this: any, id: string) {
        this.items[id] = { _id: id };
      }),
    });
    const get = makeStore(config);
    get()._setDispatch(async (name: string) => {
      dispatched.push(name);
    });

    get().poke("a");
    await Promise.resolve();
    expect(dispatched).toEqual(["poke"]);

    get()._hotReplaceConfig(config);

    // Nothing rewired dispatch in between: the middleware closure — and with it
    // the binding, its epoch and the outbox — outlived the swap.
    expect(get()._isDispatchWired()).toBe(true);
    get().poke("b");
    await Promise.resolve();
    expect(dispatched).toEqual(["poke", "poke"]);
    expect(get().items.a).toEqual({ _id: "a" });
    expect(get().items.b).toEqual({ _id: "b" });
  });

  it("seeds state fields the edit introduced", () => {
    const get = makeStore(() => ({
      counter: 0,
      bump: action(function (this: any) {
        this.counter += 1;
      }),
    }));
    get().bump();

    get()._hotReplaceConfig(() => ({
      counter: 0,
      addedByTheEdit: "seeded",
      bump: action(function (this: any) {
        this.counter += 1;
      }),
    }));

    // A field that did not exist yet has no live value to preserve, so it takes
    // the initial one — otherwise every read of it after the swap is undefined.
    expect(get().addedByTheEdit).toBe("seeded");
    expect(get().counter).toBe(1);
  });
});
