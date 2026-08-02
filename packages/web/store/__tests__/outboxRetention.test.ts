import { describe, expect, it } from "bun:test";
import {
  action,
  asyncAction,
  DispatchNotWiredError,
  isPermanentDispatchError,
  mutativeMiddleware,
  outboxFailureDisposition,
  receiptAsyncAction,
  StaleDispatchBindingError,
  sync,
  MAX_OUTBOX_BOOT_ATTEMPTS,
} from "../mutativeMiddleware";
import {
  capturePrincipalDispatchAuthorization,
  registerPrincipalDispatchRuntime,
  updatePrincipalDispatchCorrelation,
} from "../local-first/dispatchGate";

// The dispatch outbox is the only durable copy of a server-bound write that
// failed in-session (e.g. the network died mid-outage). The original drain
// policy gave each entry exactly one boot-time attempt and removed it
// REGARDLESS of outcome — so a reload during the same outage destroyed the
// write permanently, with no error surfaced. Root of the "remove label
// silently didn't stick" repro on ct-37090. These tests pin the retention
// policy: failed replays survive to the next boot with the attempt counted,
// up to MAX_OUTBOX_BOOT_ATTEMPTS.

type Entry = {
  id: string;
  action: string;
  args: any;
  patches: any;
  result: any;
  ts: number;
  attempts?: number;
  operationSchemaVersion?: number;
};

function makeHarness(
  retryDelays: number[] = [],
  options: { localFirstWritesEnabled?: boolean; online?: boolean } = {},
) {
  const outbox = new Map<string, Entry>();
  const receiptRejections: Array<{ action: string; localResult: unknown }> = [];
  const receiptAcknowledgements: Array<{
    action: string;
    continuation: unknown;
    serverResult: unknown;
    commandId: string;
  }> = [];
  let state: any;
  const set = (next: any) => { state = next; };
  const get = () => state;
  const wrapped = mutativeMiddleware(
    () => ({
      items: {} as Record<string, any>,
      poke: action(function (this: any, id: string) {
        this.items[id] = { _id: id };
      }),
      pokeAsync: asyncAction(function (this: any, id: string) {
        this.items[id] = { _id: id };
      }),
      pokeReceipt: receiptAsyncAction(function (this: any, id: string) {
        this.items[id] = { _id: id };
      }),
      addComment: receiptAsyncAction(function (this: any, id: string) {
        this.items[id] = { _id: id };
        return { id };
      }),
      // Promoted BY final mode — demotes to action() semantics when the
      // write master is off (see FLAG_PROMOTED_RECEIPT_ACTIONS).
      updateBucket: receiptAsyncAction(function (this: any, id: string) {
        this.items[id] = { _id: id };
        return { id };
      }),
      toggle: action(function (this: any) {
        this.enabled = !this.enabled;
      }),
      _handleReceiptRejection: sync(function (
        this: any,
        actionName: string,
        localResult: unknown,
      ) {
        receiptRejections.push({ action: actionName, localResult });
        return ["items"];
      }),
      _handleReceiptAcknowledgement: sync(function (
        this: any,
        actionName: string,
        continuation: unknown,
        serverResult: unknown,
        commandId: string,
      ) {
        receiptAcknowledgements.push({
          action: actionName,
          continuation,
          serverResult,
          commandId,
        });
      }),
    }),
    {
      retryDelays,
      localFirstWritesEnabled: () => options.localFirstWritesEnabled ?? false,
      online: () => options.online ?? true,
    }, // default [] — fail fast, no real-time sleeps in tests
  )(set, get, {});
  state = wrapped;
  wrapped._setOutbox(
    (e: Entry) => outbox.set(e.id, e),
    (id: string) => outbox.delete(id),
    async () => [...outbox.values()],
  );
  return {
    wrapped,
    outbox,
    receiptRejections,
    receiptAcknowledgements,
    getState: () => state,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

const seedEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: "e1",
  action: "poke",
  args: ["a"],
  patches: undefined,
  result: null,
  ts: 1,
  ...overrides,
});

describe("outboxFailureDisposition", () => {
  it("keeps a first-time failure with the attempt counted", () => {
    const d = outboxFailureDisposition(seedEntry());
    expect(d.keep).toBe(true);
    expect(d.entry.attempts).toBe(1);
  });

  it("gives up once the boot-attempt cap is reached", () => {
    const d = outboxFailureDisposition(seedEntry({ attempts: MAX_OUTBOX_BOOT_ATTEMPTS - 1 }));
    expect(d.keep).toBe(false);
  });
});

describe("drainOutbox retention", () => {
  it("keeps shipped receipt actions envelope-backed in BOTH write postures", () => {
    // addComment shipped receipt-backed before final mode; a rollback must
    // return to that proven prod behavior, not to the pre-receipt era.
    for (const writesEnabled of [false, true]) {
      const harness = makeHarness([], { localFirstWritesEnabled: writesEnabled });
      void harness.wrapped.addComment("c1").catch(() => {});
      const entry = [...harness.outbox.values()][0]!;
      expect(entry.operationSchemaVersion).toBe(1);
      expect(entry.result).toMatchObject({
        receiptActionVersion: 1,
        commandId: entry.id,
        localResult: { id: "c1" },
      });
    }
  });

  it("promotes flag-gated actions to receipts only behind the write master", () => {
    // updateBucket is promoted BY final mode: flag off = its pre-release
    // fire-and-forget action() semantics (no envelope, no caller promise).
    const legacy = makeHarness([], { localFirstWritesEnabled: false });
    const legacyReturn = legacy.wrapped.updateBucket("legacy");
    expect(legacyReturn).toEqual({ id: "legacy" });
    expect([...legacy.outbox.values()][0]).toMatchObject({
      operationSchemaVersion: 1,
      result: { id: "legacy" },
    });

    const finalMode = makeHarness([], { localFirstWritesEnabled: true });
    void (finalMode.wrapped.updateBucket("final") as Promise<unknown>).catch(() => {});
    const entry = [...finalMode.outbox.values()][0]!;
    expect(entry.operationSchemaVersion).toBe(1);
    expect(entry.result).toMatchObject({
      receiptActionVersion: 1,
      commandId: entry.id,
      localResult: { id: "final" },
    });
  });

  it("rejects a final-mode offline write before optimistic paint when persistence is reduced", () => {
    const { wrapped, outbox, getState } = makeHarness([], {
      localFirstWritesEnabled: true,
      online: false,
    });
    expect(() => wrapped.addComment("offline")).toThrow(
      "Offline edits are unavailable",
    );
    expect(getState().items).toEqual({});
    expect(outbox.size).toBe(0);
  });

  it("parks an unknown operation schema without dispatching or deleting it", async () => {
    const { wrapped, outbox } = makeHarness();
    outbox.set("future", seedEntry({
      id: "future",
      operationSchemaVersion: 99,
    }));
    let calls = 0;
    wrapped._setDispatch(async () => {
      calls++;
      return "ok";
    });
    await settle();
    expect(calls).toBe(0);
    expect(outbox.has("future")).toBe(true);
  });

  it("timestamps queued actions monotonically so dependent writes replay in call order", () => {
    const { wrapped, outbox } = makeHarness();
    const originalNow = Date.now;
    Date.now = () => 1234;
    try {
      wrapped.poke("first");
      wrapped.poke("second");
    } finally {
      Date.now = originalNow;
    }
    const entries = [...outbox.values()];
    expect(entries).toHaveLength(2);
    expect(entries[1]!.ts).toBeGreaterThan(entries[0]!.ts);
  });

  it("keeps a stranded entry across an offline boot instead of dropping it", async () => {
    const { wrapped, outbox } = makeHarness();
    outbox.set("e1", seedEntry());

    wrapped._setDispatch(() => Promise.reject(new Error("offline")));
    await settle();

    expect(outbox.get("e1")?.attempts).toBe(1);
  });

  it("delivers a retained entry once the network is back", async () => {
    const { wrapped, outbox } = makeHarness();
    outbox.set("e1", seedEntry({ attempts: 2 }));

    const delivered: string[] = [];
    wrapped._setDispatch((actionName: string) => {
      delivered.push(actionName);
      return Promise.resolve("ok");
    });
    await settle();

    expect(delivered).toEqual(["poke"]);
    expect(outbox.size).toBe(0);
  });

  it("drops an entry that keeps failing after the boot-attempt cap", async () => {
    const { wrapped, outbox } = makeHarness();
    outbox.set("e1", seedEntry());

    for (let boot = 0; boot < MAX_OUTBOX_BOOT_ATTEMPTS; boot++) {
      wrapped._setDispatch(() => Promise.reject(new Error("offline")));
      await settle();
    }

    expect(outbox.size).toBe(0);
  });

  it("retains the entry when an in-session dispatch exhausts its retries", async () => {
    const { wrapped, outbox } = makeHarness();
    wrapped._setDispatch(() => Promise.reject(new Error("offline")));
    await settle();

    wrapped.poke("a");
    await settle();

    expect(outbox.size).toBe(1);
    const entry = [...outbox.values()][0];
    expect(entry.action).toBe("poke");
    expect(entry.args).toEqual(["a"]);
  });
});

// A user-authored send must reach the server eventually — losing one silently
// drops something the user typed. These pin the "never drop a sendMessage"
// guarantee and the reconnect re-drive that lands a stranded send without
// forcing a reload (root of the "pending message stuck forever" repro).
describe("must-deliver retention (user sends never drop)", () => {
  it("never gives up on a sendMessage entry, even past the boot cap", () => {
    const d = outboxFailureDisposition(
      seedEntry({ action: "sendMessage", attempts: MAX_OUTBOX_BOOT_ATTEMPTS + 3 }),
    );
    expect(d.keep).toBe(true);
    expect(d.entry.attempts).toBe(MAX_OUTBOX_BOOT_ATTEMPTS + 4);
  });

  it("retains a sendMessage across far more failed boots than the cap", async () => {
    const { wrapped, outbox } = makeHarness();
    outbox.set("e1", seedEntry({ action: "sendMessage" }));

    for (let boot = 0; boot < MAX_OUTBOX_BOOT_ATTEMPTS + 4; boot++) {
      wrapped._setDispatch(() => Promise.reject(new Error("offline")));
      await settle();
    }

    expect(outbox.has("e1")).toBe(true);
    expect(outbox.get("e1")?.action).toBe("sendMessage");
  });

  // A fork create carries the same stakes as a send: giving it up strands a
  // fork stub the user is already typing into (the jx79314 incident, ct-40175).
  // It rides convCommand, so retention keys off the dispatched command name.
  it("never gives up on a convCommand forkFromMessage entry", () => {
    const d = outboxFailureDisposition(
      seedEntry({
        action: "convCommand",
        args: ["jx7parent", "forkFromMessage", { message_uuid: "u1", session_id: "s1" }],
        attempts: MAX_OUTBOX_BOOT_ATTEMPTS + 3,
      }),
    );
    expect(d.keep).toBe(true);
  });

  it("never gives up on user-authored comment writes", () => {
    for (const actionName of ["addComment", "editComment", "deleteComment", "askAgentInThread"]) {
      const d = outboxFailureDisposition(
        seedEntry({
          action: actionName,
          attempts: MAX_OUTBOX_BOOT_ATTEMPTS + 3,
        }),
      );
      expect(d.keep).toBe(true);
    }
  });

  it("still gives up on other convCommands at the boot cap", () => {
    const d = outboxFailureDisposition(
      seedEntry({ action: "convCommand", args: ["jx7c", "setTitle", {}], attempts: MAX_OUTBOX_BOOT_ATTEMPTS - 1 }),
    );
    expect(d.keep).toBe(false);
  });
});

// An asyncAction contractually returns a promise of the server result. When
// dispatch wasn't wired yet it historically returned `undefined` — callers'
// immediate `.then(...)` then threw synchronously, skipping their own error
// handling entirely (the fork flow lost its discard+toast this way and the
// stub silently degraded, ct-40175). Unwired asyncActions must reject.
describe("unwired asyncAction", () => {
  it("returns a rejected promise (parked) instead of undefined", async () => {
    const { wrapped, outbox } = makeHarness();
    // No _setDispatch call — dispatch is not wired; outbox IS installed.
    const p = wrapped.pokeAsync("x");
    expect(p).toBeInstanceOf(Promise);
    // Typed + parked: callers distinguish "pending, will deliver" from real
    // failure (the fork flow keeps its stub on parked; analytics ignores it).
    const err = await p.then(
      () => { throw new Error("expected rejection"); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DispatchNotWiredError);
    expect((err as DispatchNotWiredError).parked).toBe(true);
    expect((err as Error).message).toMatch(/parked for later delivery/);
    // The write is still durably parked for the next drain.
    expect(outbox.size).toBe(1);
  });

  it("plain action() keeps returning its local result when unwired", () => {
    const { wrapped } = makeHarness();
    expect(() => wrapped.poke("y")).not.toThrow();
  });

  it("does not claim parked:true before an asynchronous enqueue succeeds", async () => {
    const { wrapped, outbox } = makeHarness();
    wrapped._setOutbox(
      async () => {
        await Promise.resolve();
        throw new Error("IndexedDB write failed");
      },
      (id: string) => outbox.delete(id),
      async () => [...outbox.values()],
    );

    const error = await (wrapped.pokeAsync("not-durable") as Promise<unknown>).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DispatchNotWiredError);
    expect((error as Error).message).toBe("IndexedDB write failed");
    expect(outbox.size).toBe(0);
  });
});

describe("receipt-aware asyncAction", () => {
  const acknowledged = (commandId: string, result: unknown) => ({
    receiptVersion: 1,
    commandId,
    commandName: "test.create/v2",
    status: "acknowledged",
    result,
    coverage: [],
    retryUntil: null,
  });

  it("keeps an unwired create pending and resolves its original continuation after drain", async () => {
    const { wrapped, outbox } = makeHarness();

    let settled = false;
    const pending = (wrapped.pokeReceipt("created") as Promise<unknown>)
      .finally(() => { settled = true; });
    await settle();

    expect(settled).toBe(false);
    expect(outbox.size).toBe(1);
    const [entry] = [...outbox.values()];
    expect(entry.action).toBe("pokeReceipt");
    expect(entry.result).toMatchObject({
      receiptActionVersion: 1,
      commandId: entry.id,
    });

    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
      Promise.resolve(acknowledged(result.commandId, { id: "server-created" })));

    await expect(pending).resolves.toEqual({ id: "server-created" });
    expect(outbox.size).toBe(0);
  });

  it("re-drains immediately when dispatch wiring races the durable enqueue", async () => {
    const { wrapped, outbox } = makeHarness();
    let releaseEnqueue!: () => void;
    const enqueueGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    wrapped._setOutbox(
      async (entry: Entry) => {
        await enqueueGate;
        outbox.set(entry.id, entry);
      },
      (id: string) => outbox.delete(id),
      async () => [...outbox.values()],
    );

    const pending = wrapped.pokeReceipt("created") as Promise<unknown>;
    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
      Promise.resolve(acknowledged(result.commandId, { id: "server-created" })));
    await settle();
    // The boot drain ran before the delayed enqueue became visible.
    expect(outbox.size).toBe(0);

    releaseEnqueue();
    await expect(Promise.race([
      pending,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("receipt drain did not refire")), 250)),
    ])).resolves.toEqual({ id: "server-created" });
    expect(outbox.size).toBe(0);
  });

  it("keeps a live transport failure pending until the exact parked command is replayed", async () => {
    const { wrapped, outbox } = makeHarness();
    wrapped._setDispatch(() => Promise.reject(new Error("offline")));
    await settle();

    let settled = false;
    const pending = (wrapped.pokeReceipt("created") as Promise<unknown>)
      .finally(() => { settled = true; });
    await settle();

    expect(settled).toBe(false);
    expect(outbox.size).toBe(1);
    const [entry] = [...outbox.values()];

    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
      Promise.resolve(acknowledged(result.commandId, { id: "server-created" })));

    await expect(pending).resolves.toEqual({ id: "server-created" });
    expect(entry.result.commandId).toBe(entry.id);
    expect(outbox.size).toBe(0);
  });

  it("retains receipt-backed work across a thrown permanent error until a receipt arrives", async () => {
    const {
      wrapped,
      outbox,
      receiptRejections,
    } = makeHarness();
    wrapped._setDispatch(() =>
      Promise.reject(
        new Error(
          "[CONVEX M(dispatch:dispatch)] Uncaught Error: Not authenticated",
        ),
      ));
    await settle();

    let settled = false;
    const pending = (wrapped.pokeReceipt("created") as Promise<unknown>)
      .finally(() => { settled = true; });
    await settle();

    expect(settled).toBe(false);
    expect(receiptRejections).toEqual([]);
    expect(outbox.size).toBe(1);

    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
      Promise.resolve(acknowledged(result.commandId, { id: "server-created" })));

    await expect(pending).resolves.toEqual({ id: "server-created" });
    expect(outbox.size).toBe(0);
  });

  it("keeps the waiter pending when the dispatch binding rotates after success", async () => {
    const { wrapped, outbox } = makeHarness();
    let resolveFirst!: (value: unknown) => void;
    const firstResponse = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    let firstCalls = 0;
    wrapped._setDispatch(() => {
      firstCalls++;
      return firstResponse;
    });
    await settle();

    let settled = false;
    const pending = (wrapped.pokeReceipt("created") as Promise<unknown>)
      .finally(() => { settled = true; });
    const [entry] = [...outbox.values()];
    while (firstCalls === 0) await Promise.resolve();
    let releaseSuccessor!: () => void;
    const successorGate = new Promise<void>((resolve) => {
      releaseSuccessor = resolve;
    });
    // dispatchWithRetry's await continuation was registered first. This
    // callback rotates the binding after that inner promise has validated the
    // response but before the middleware's outer success continuation runs.
    void firstResponse.then(() => {
      wrapped._setDispatch(
        (_action: string, _args: unknown, _patches: unknown, result: any) =>
          successorGate.then(() =>
            acknowledged(result.commandId, { id: "server-created" })),
      );
    });
    resolveFirst(acknowledged(
      entry.result.commandId,
      { id: "server-created" },
    ));
    await settle();

    expect(settled).toBe(false);
    expect(outbox.size).toBe(1);

    releaseSuccessor();
    await expect(pending).resolves.toEqual({ id: "server-created" });
    expect(outbox.size).toBe(0);
  });

  it("surfaces a durable command rejection and retires the parked entry", async () => {
    const { wrapped, outbox } = makeHarness();
    const pending = wrapped.pokeReceipt("invalid") as Promise<unknown>;
    const [entry] = [...outbox.values()];

    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
      Promise.resolve({
        receiptVersion: 1,
        commandId: result.commandId,
        commandName: "test.create/v2",
        status: "rejected",
        rejection: { code: "INVALID_ARGUMENT", message: "Nope" },
        coverage: [],
        retryUntil: null,
      }));

    await expect(pending).rejects.toMatchObject({
      name: "CommandReceiptRejectedError",
      code: "INVALID_ARGUMENT",
      message: "Nope",
    });
    expect(entry.result.commandId).toBe(entry.id);
    expect(outbox.size).toBe(0);
  });

  it("commits the optimistic rollback before removing its terminal receipt", async () => {
    const { wrapped, outbox } = makeHarness();
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    let persistenceCalls = 0;
    wrapped._setIDBWrite(() => {
      persistenceCalls++;
      return persistenceGate;
    });

    const entry = seedEntry({
      id: "rejected-awaits-rollback-disk",
      action: "pokeReceipt",
      result: {
        receiptActionVersion: 1,
        commandId: "rejected-awaits-rollback-disk",
        localResult: { clientId: "optimistic-row" },
      },
    });
    outbox.set(entry.id, entry);
    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
      Promise.resolve({
        receiptVersion: 1,
        commandId: result.commandId,
        commandName: "test.create/v2",
        status: "rejected",
        rejection: { code: "FORBIDDEN", message: "Nope" },
        coverage: [],
        retryUntil: null,
      }));

    await settle();
    expect(persistenceCalls).toBe(1);
    expect(outbox.has(entry.id)).toBe(true);

    releasePersistence();
    await settle();
    expect(outbox.has(entry.id)).toBe(false);
  });

  it("retains a rejected receipt until its missing optimistic rollback is available", async () => {
    const { wrapped, outbox, receiptRejections } = makeHarness();
    const rollback = wrapped._handleReceiptRejection;
    const entry = seedEntry({
      id: "rejected-without-rollback",
      action: "pokeReceipt",
      result: {
        receiptActionVersion: 1,
        commandId: "rejected-without-rollback",
        localResult: { clientId: "optimistic-row" },
      },
    });
    outbox.set(entry.id, entry);
    wrapped._handleReceiptRejection = undefined;
    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
      Promise.resolve({
        receiptVersion: 1,
        commandId: result.commandId,
        commandName: "test.create/v2",
        status: "rejected",
        rejection: { code: "FORBIDDEN", message: "Nope" },
        coverage: [],
        retryUntil: null,
      }));

    await settle();
    expect(receiptRejections).toEqual([]);
    expect(outbox.get(entry.id)?.attempts).toBe(1);

    wrapped._handleReceiptRejection = rollback;
    wrapped._drainOutbox();
    await settle();
    expect(receiptRejections).toEqual([{
      action: "pokeReceipt",
      localResult: { clientId: "optimistic-row" },
    }]);
    expect(outbox.size).toBe(0);
  });

  it("retains a rejected receipt when its optimistic rollback throws", async () => {
    const { wrapped, outbox, receiptRejections } = makeHarness();
    const rollback = wrapped._handleReceiptRejection;
    const entry = seedEntry({
      id: "rejected-rollback-throws",
      action: "pokeReceipt",
      result: {
        receiptActionVersion: 1,
        commandId: "rejected-rollback-throws",
        localResult: { clientId: "optimistic-row" },
      },
    });
    outbox.set(entry.id, entry);
    wrapped._handleReceiptRejection = () => {
      throw new Error("rollback unavailable");
    };
    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
      Promise.resolve({
        receiptVersion: 1,
        commandId: result.commandId,
        commandName: "test.create/v2",
        status: "rejected",
        rejection: { code: "FORBIDDEN", message: "Nope" },
        coverage: [],
        retryUntil: null,
      }));

    await settle();
    expect(receiptRejections).toEqual([]);
    expect(outbox.get(entry.id)?.attempts).toBe(1);

    wrapped._handleReceiptRejection = rollback;
    wrapped._drainOutbox();
    await settle();
    expect(receiptRejections).toHaveLength(1);
    expect(outbox.size).toBe(0);
  });

  it("survives a principal runtime rebind but cannot resolve from another outbox namespace", async () => {
    const { wrapped, outbox: accountAOutbox } = makeHarness();
    let settled = false;
    const pending = (wrapped.pokeReceipt("account-a") as Promise<unknown>)
      .finally(() => { settled = true; });
    await settle();
    const [accountAEntry] = [...accountAOutbox.values()];

    wrapped._clearRuntimeBindings();
    const accountBOutbox = new Map<string, Entry>();
    wrapped._setOutbox(
      (entry: Entry) => accountBOutbox.set(entry.id, entry),
      (id: string) => accountBOutbox.delete(id),
      async () => [...accountBOutbox.values()],
    );
    wrapped._setDispatch(() => Promise.reject(new Error("B must not see A's command")));
    await settle();
    expect(settled).toBe(false);
    expect(accountBOutbox.size).toBe(0);

    wrapped._setOutbox(
      (entry: Entry) => accountAOutbox.set(entry.id, entry),
      (id: string) => accountAOutbox.delete(id),
      async () => [...accountAOutbox.values()],
    );
    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
      Promise.resolve(acknowledged(result.commandId, { id: "account-a-result" })));

    await expect(pending).resolves.toEqual({ id: "account-a-result" });
    expect(accountAEntry.result.commandId).toBe(accountAEntry.id);
    expect(accountAOutbox.size).toBe(0);
  });

  it("never drops a persisted receipt-aware create at the boot cap", () => {
    const entry = seedEntry({
      action: "createDoc",
      result: {
        receiptActionVersion: 1,
        commandId: "create-doc-command",
      },
      attempts: MAX_OUTBOX_BOOT_ATTEMPTS + 3,
    });
    expect(outboxFailureDisposition(entry).keep).toBe(true);
  });

  it("interprets a rejected V2 receipt from a pre-envelope comment outbox row", async () => {
    const { wrapped, outbox, receiptRejections } = makeHarness();
    const localResult = {
      conversationId: "conversation-1",
      content: "optimistic",
      clientId: "commentstub-old",
    };
    outbox.set("legacy-comment", seedEntry({
      id: "legacy-comment",
      action: "addComment",
      result: localResult,
    }));

    wrapped._setDispatch(() => Promise.resolve({
      receiptVersion: 1,
      commandId: "legacy-comments-create:commentstub-old",
      commandName: "comments.create/v2",
      status: "rejected",
      rejection: { code: "FORBIDDEN", message: "Access revoked" },
      coverage: [],
      retryUntil: null,
    }));
    await settle();

    expect(receiptRejections).toEqual([{
      action: "addComment",
      localResult,
    }]);
    expect(outbox.size).toBe(0);
  });

  it("uses a routing-aware reload and retires navigation only after the target boot", async () => {
    const { wrapped, outbox } = makeHarness();
    const originalWindow = (globalThis as any).window;
    const assigned: string[] = [];
    const location = {
      pathname: "/docs",
      assign(href: string) {
        assigned.push(href);
        location.pathname = href;
      },
    };
    (globalThis as any).window = {
      location,
    };
    try {
      outbox.set("create-doc", seedEntry({
        id: "create-doc",
        action: "createDoc",
        args: [{ title: "Durable" }, { version: 1, kind: "navigate" }],
        result: {
          receiptActionVersion: 1,
          commandId: "create-doc",
          localResult: {
            continuation: { version: 1, kind: "navigate" },
          },
        },
      }));
      wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, result: any) =>
        Promise.resolve(acknowledged(result.commandId, { id: "doc-server-id" })));
      await settle();

      expect(assigned).toEqual(["/docs/doc-server-id"]);
      expect(outbox.size).toBe(1);

      // Simulate the target boot. The pathname proves the routing effect
      // completed, so replay retires the exact receipt without navigating twice.
      wrapped._drainOutbox();
      await settle();

      expect(assigned).toEqual(["/docs/doc-server-id"]);
      expect(outbox.size).toBe(0);
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });

  it("applies a persisted create-label continuation before cleanup and retains a malformed acknowledgement", async () => {
    const {
      wrapped,
      outbox,
      receiptAcknowledgements,
    } = makeHarness();
    let acknowledgementsAtRemove = -1;
    wrapped._setOutbox(
      (entry: Entry) => outbox.set(entry.id, entry),
      (id: string) => {
        acknowledgementsAtRemove = receiptAcknowledgements.length;
        outbox.delete(id);
      },
      async () => [...outbox.values()],
    );
    const result = {
      receiptActionVersion: 1,
      commandId: "create-label",
      localResult: {
        continuation: {
          version: 1,
          kind: "assignBucket",
          conversationIds: ["conv0000000000000000000000000000"],
        },
      },
    };
    outbox.set("create-label", seedEntry({
      id: "create-label",
      action: "createBucket",
      result,
    }));
    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, envelope: any) =>
      Promise.resolve(acknowledged(envelope.commandId, { bucketId: "bucket-server-id" })));
    await settle();

    expect(receiptAcknowledgements).toEqual([{
      action: "createBucket",
      continuation: result.localResult.continuation,
      serverResult: { bucketId: "bucket-server-id" },
      commandId: "create-label",
    }]);
    expect(acknowledgementsAtRemove).toBe(1);
    expect(outbox.size).toBe(0);

    outbox.set("create-label", seedEntry({
      id: "create-label",
      action: "createBucket",
      result,
    }));
    wrapped._setDispatch((_action: string, _args: unknown, _patches: unknown, envelope: any) =>
      Promise.resolve(acknowledged(envelope.commandId, {})));
    await settle();

    expect(receiptAcknowledgements).toHaveLength(1);
    expect(outbox.get("create-label")?.attempts).toBe(1);
  });
});

// A permanent rejection means the server RAN the write and refused it —
// replaying the identical payload can only repeat the refusal. Before this
// classification, a "Not authorized" convCommand parked in the outbox re-fired
// its full retry ladder on every boot/reconnect/30s interval drain, forever
// (the setSessionModel loop that flooded prod logs on 2026-07-13). These pin:
// no ladder retries, dropped from the outbox on every path, must-deliver
// notwithstanding — a served refusal IS delivery.
describe("permanent rejections", () => {
  // Real shape per convex-js createHybridErrorStacktrace: server errorMessage
  // prefixed with the udf path, "Called by client" appended.
  const refusal = () =>
    Promise.reject(new Error("[CONVEX M(dispatch:dispatch)] Uncaught Error: Not authorized\n  Called by client"));

  it("classifies server refusals as permanent and overload as transient", () => {
    expect(isPermanentDispatchError(new Error("[CONVEX M(x)] Uncaught Error: Not authorized"))).toBe(true);
    expect(isPermanentDispatchError(new Error("[CONVEX M(x)] Uncaught ConvexError: nope"))).toBe(true);
    expect(isPermanentDispatchError(new Error("ArgumentValidationError: Value does not match validator"))).toBe(true);
    expect(isPermanentDispatchError(new Error("Your request timed out performing too many system operations."))).toBe(false);
    expect(isPermanentDispatchError(new Error("Your request couldn't be completed. Try again later."))).toBe(false);
    expect(isPermanentDispatchError(new Error("offline"))).toBe(false);
  });

  it("dispatches exactly once — no ladder retries on a refusal", async () => {
    const { wrapped } = makeHarness([1, 1, 1]); // ladder present but must not be used
    let attempts = 0;
    wrapped._setDispatch(() => {
      attempts++;
      return refusal();
    });
    await settle();

    wrapped.poke("a");
    await settle();
    expect(attempts).toBe(1);
  });

  it("drops a refused entry from the outbox on the live dispatch path", async () => {
    const { wrapped, outbox } = makeHarness();
    wrapped._setDispatch(refusal);
    await settle();

    wrapped.poke("a");
    await settle();
    expect(outbox.size).toBe(0);
  });

  it("drops a refused entry on an opportunistic drain, even a sendMessage", async () => {
    const { wrapped, outbox } = makeHarness();
    wrapped._setDispatch(refusal);
    await settle();

    outbox.set("e1", seedEntry({ action: "sendMessage" }));
    wrapped._drainOutbox(); // countAttempts=false path — used to keep it as-is forever
    await settle();
    expect(outbox.size).toBe(0);
  });

  it("drops a refused entry on a boot drain without burning boot attempts", async () => {
    const { wrapped, outbox } = makeHarness();
    outbox.set("e1", seedEntry());

    wrapped._setDispatch(refusal); // boot drain fires on wiring
    await settle();
    expect(outbox.size).toBe(0);
  });
});

// Actions fired while no dispatch is wired (boot, HMR rewire, account-switch
// window). asyncAction() promises "a Promise that resolves to the server
// dispatch result" — returning undefined here crashed the compose popup's
// send path (beginOptimisticSession's fire() chains .then on createSession's
// return). And the write itself must park in the outbox, per the contract the
// enqueue comment states: drainOutbox re-drives it the moment _setDispatch runs.
describe("actions before dispatch is wired", () => {
  it("does not persist a React click event injected into a zero-argument action", async () => {
    const { wrapped, outbox, getState } = makeHarness();
    wrapped._setOutbox(
      (entry: Entry) => outbox.set(entry.id, structuredClone(entry)),
      (id: string) => outbox.delete(id),
      async () => [...outbox.values()],
    );
    const syntheticClick = {
      nativeEvent: new Event("click"),
      preventDefault() {},
      stopPropagation() {},
    };

    // React calls a directly-bound onClick callback with its SyntheticEvent.
    // The local toggle still runs, but browser event objects are never part of
    // the durable/network action contract.
    wrapped.toggle(syntheticClick);
    await settle();

    expect(getState().enabled).toBe(true);
    expect(outbox.size).toBe(1);
    expect([...outbox.values()][0].args).toEqual([]);
  });

  it("asyncAction still returns a Promise and parks the entry for the boot drain", async () => {
    const { wrapped, outbox } = makeHarness();

    const p = wrapped.pokeAsync("a");
    expect(typeof p?.then).toBe("function");
    await expect(p).rejects.toMatchObject({
      name: "DispatchNotWiredError",
      parked: true,
    });
    expect(outbox.size).toBe(1);
    expect([...outbox.values()][0].action).toBe("pokeAsync");

    const delivered: string[] = [];
    wrapped._setDispatch((actionName: string) => {
      delivered.push(actionName);
      return Promise.resolve("ok");
    });
    await settle();
    expect(delivered).toEqual(["pokeAsync"]);
    expect(outbox.size).toBe(0);
  });

  it("plain action parks the entry durably instead of dropping the write", async () => {
    const { wrapped, outbox } = makeHarness();

    wrapped.poke("a");
    await settle();

    expect(outbox.size).toBe(1);
    expect([...outbox.values()][0].action).toBe("poke");
  });
});

describe("opportunistic re-drive (_drainOutbox)", () => {
  it("delivers a stranded send on reconnect without a reload, counting no attempt", async () => {
    const { wrapped, outbox } = makeHarness();
    let online = false;
    const delivered: string[] = [];
    wrapped._setDispatch((actionName: string) => {
      if (!online) return Promise.reject(new Error("offline"));
      delivered.push(actionName);
      return Promise.resolve("ok");
    });
    await settle();

    // A send strands while the socket is down: parked in the outbox.
    outbox.set("e1", seedEntry({ action: "sendMessage" }));

    // An opportunistic tick while still offline keeps it AS-IS — no attempt
    // counted, so reconnect churn can't erode a write's boot budget.
    wrapped._drainOutbox();
    await settle();
    expect(outbox.has("e1")).toBe(true);
    expect(outbox.get("e1")?.attempts ?? 0).toBe(0);

    // Connectivity returns; the next tick lands it — no reload needed.
    online = true;
    wrapped._drainOutbox();
    await settle();
    expect(delivered).toEqual(["sendMessage"]);
    expect(outbox.size).toBe(0);
  });
});

// The boot-replay signal the hidden-set reconcile crawls wait on. Their CLEAR
// pass un-hides every local row the server's hidden set omits, so reading the
// server before the parked hides ship resurrects a kill the user made offline.
describe("boot outbox drain signal (_hasBootOutboxDrained)", () => {
  it("reports drained only after a replay pass, and resets on a principal rebind", async () => {
    const { wrapped, outbox } = makeHarness();
    outbox.set("e1", seedEntry());
    // Unwired: nothing has been replayed, so consumers must keep waiting.
    expect(wrapped._hasBootOutboxDrained()).toBe(false);

    wrapped._setDispatch(async () => "ok");
    await settle();
    expect(outbox.size).toBe(0);
    expect(wrapped._hasBootOutboxDrained()).toBe(true);

    // An account switch clears the runtime bindings. The successor principal has
    // its own outbox rows and has replayed none of them, so a `true` carried
    // across would tell the crawls a replay they never saw already happened.
    wrapped._clearRuntimeBindings();
    expect(wrapped._hasBootOutboxDrained()).toBe(false);
  });

  it("stays closed when a failed replay is re-queued", async () => {
    const { wrapped, outbox } = makeHarness();
    outbox.set("e1", seedEntry());

    wrapped._setDispatch(async () => { throw new Error("offline"); });
    await settle();

    expect(outbox.has("e1")).toBe(true);
    expect(wrapped._hasBootOutboxDrained()).toBe(false);
  });

  it("invalidates readiness for a new enqueue and reopens only after a later empty verification", async () => {
    const { wrapped, outbox } = makeHarness();
    let commit: (() => void) | null = null;
    wrapped._setOutbox(
      (entry: Entry) => new Promise<void>((resolve) => {
        commit = () => {
          outbox.set(entry.id, entry);
          resolve();
        };
      }),
      (id: string) => { outbox.delete(id); },
      async () => [...outbox.values()],
    );
    wrapped._setDispatch(async () => "ok");
    await settle();
    expect(wrapped._hasBootOutboxDrained()).toBe(true);

    wrapped.poke("race");
    expect(wrapped._hasBootOutboxDrained()).toBe(false);

    commit?.();
    await settle();
    expect(outbox.size).toBe(0);
    expect(wrapped._hasBootOutboxDrained()).toBe(true);
  });
});

describe("principal-bound dispatch ownership", () => {
  it("A→B invalidates an in-flight A dispatch without letting A cleanup clear B", async () => {
    registerPrincipalDispatchRuntime({
      canDispatch: true,
      dispatchPrincipalEpoch: 1,
      subscribe: () => () => {},
    });
    updatePrincipalDispatchCorrelation(1);

    const { wrapped, outbox: accountAOutbox } = makeHarness();
    const ownerA = {};
    const authorizationA = capturePrincipalDispatchAuthorization();
    expect(authorizationA).not.toBeNull();
    let releaseAccountA!: () => void;
    let markAccountAStarted!: () => void;
    const accountAStarted = new Promise<void>((resolve) => { markAccountAStarted = resolve; });
    const accountAResponse = new Promise<string>((resolve) => {
      releaseAccountA = () => resolve("account-a-response");
    });
    wrapped._setDispatch(async () => {
      markAccountAStarted();
      return await accountAResponse;
    }, { owner: ownerA, authorization: authorizationA });

    const actionPromise = wrapped.pokeAsync("account-a-item") as Promise<unknown>;
    await accountAStarted;
    expect(accountAOutbox.size).toBe(1);

    // The render-time correlation update is the synchronous security gate.
    // Persistence and dispatch are then rebound to B's independent namespace.
    updatePrincipalDispatchCorrelation(2);
    const authorizationB = capturePrincipalDispatchAuthorization();
    expect(authorizationB?.principalEpoch).toBe(2);
    const accountBOutbox = new Map<string, Entry>();
    wrapped._setOutbox(
      (entry: Entry) => accountBOutbox.set(entry.id, entry),
      (id: string) => accountBOutbox.delete(id),
      async () => [...accountBOutbox.values()],
    );
    const ownerB = {};
    const deliveredByB: string[] = [];
    wrapped._setDispatch(async (actionName: string) => {
      deliveredByB.push(actionName);
      return "account-b-response";
    }, { owner: ownerB, authorization: authorizationB });

    releaseAccountA();
    await expect(actionPromise).rejects.toBeInstanceOf(StaleDispatchBindingError);
    // A's response cannot remove A's durable recovery entry, and it is never
    // visible in B's separately bound outbox.
    expect(accountAOutbox.size).toBe(1);
    expect(accountBOutbox.size).toBe(0);
    expect(deliveredByB).toEqual([]);

    // A delayed React cleanup owns only A's binding and cannot erase the newer
    // B binding installed by another mount.
    wrapped._clearDispatch(ownerA);
    await expect(wrapped._dispatch("probe-b", [])).resolves.toBe("account-b-response");
    expect(deliveredByB).toEqual(["probe-b"]);

    wrapped._clearDispatch(ownerB);
    updatePrincipalDispatchCorrelation(null);
    registerPrincipalDispatchRuntime(null);
  });

  it("a drain superseded mid-load exits quietly and the successor delivers", async () => {
    // Boot race seen on every page load: _setDispatch fires a drain, the
    // outbox load is still awaiting when principal verification rebinds
    // dispatch (epoch++), and the drain's own staleness check throws. Every
    // drain call site is fire-and-forget, so that throw surfaced as an
    // "Unhandled rejection" toast. A superseded drain is expected lifecycle —
    // the successor binding runs its own drain — so it must end silently.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { wrapped } = makeHarness();
      const outbox = new Map<string, Entry>([["e1", seedEntry()]]);
      let releaseLoad!: () => void;
      const loadGate = new Promise<void>((r) => { releaseLoad = r; });
      wrapped._setOutbox(
        (e: Entry) => outbox.set(e.id, e),
        (id: string) => outbox.delete(id),
        async () => { await loadGate; return [...outbox.values()]; },
      );

      const delivered: string[] = [];
      const ownerA = {};
      wrapped._setDispatch(async () => { throw new Error("stale binding must never dispatch"); }, { owner: ownerA });
      // Rebind while the first drain is parked on the outbox load.
      const ownerB = {};
      wrapped._setDispatch(async (actionName: string) => { delivered.push(actionName); return "ok"; }, { owner: ownerB });

      releaseLoad();
      await settle();

      // The superseded drain neither rejected anything nor consumed the entry;
      // the successor's re-drain delivered it.
      expect(unhandled).toEqual([]);
      expect(delivered).toEqual(["poke"]);
      expect(outbox.size).toBe(0);
      wrapped._clearDispatch(ownerB);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// The ct-40059 black hole: a principal-runtime transition clears or stales the
// module-level binding while the page stays interactive, and an action fired in
// that window used to skip the durable enqueue entirely — optimistic bubble
// renders, nothing reaches the server, no error anywhere ("Message hasn't
// reached the agent" with an empty outbox and no Convex row). These pin the
// durable-first contract: every action is parked regardless of binding state,
// and a later binding delivers it.
describe("unwired/stale-binding sends are parked, never lost", () => {
  it("parks an action fired with no binding; the next binding delivers it", async () => {
    const { wrapped, outbox } = makeHarness();
    // No _setDispatch — the binding was cleared (e.g. stopProtectedIO) while
    // the composer stayed interactive.
    wrapped.poke("a");
    await settle();
    expect(outbox.size).toBe(1);
    expect([...outbox.values()][0].action).toBe("poke");

    const delivered: string[] = [];
    wrapped._setDispatch((actionName: string) => {
      delivered.push(actionName);
      return Promise.resolve("ok");
    });
    await settle();
    expect(delivered).toEqual(["poke"]);
    expect(outbox.size).toBe(0);
  });

  it("parks a send fired on a stale-authorization binding; a fresh binding delivers it", async () => {
    registerPrincipalDispatchRuntime({
      canDispatch: true,
      dispatchPrincipalEpoch: 1,
      subscribe: () => () => {},
    });
    updatePrincipalDispatchCorrelation(1);
    try {
      const { wrapped, outbox } = makeHarness();
      const owner = {};
      const authorization = capturePrincipalDispatchAuthorization();
      let staleDispatches = 0;
      wrapped._setDispatch(async () => { staleDispatches++; return "ok"; }, { owner, authorization });

      // The correlation moves (token re-verification, principal epoch bump)
      // without the binding ever being reinstalled — the stranded state.
      updatePrincipalDispatchCorrelation(2);
      wrapped.poke("stranded");
      await settle();
      expect(staleDispatches).toBe(0);
      expect(outbox.size).toBe(1);

      // The ensure-wired heal re-binds with current authorization; the boot
      // drain of the new binding delivers the parked send.
      const delivered: string[] = [];
      wrapped._setDispatch(async (actionName: string) => {
        delivered.push(actionName);
        return "ok";
      }, { owner, authorization: capturePrincipalDispatchAuthorization() });
      await settle();
      expect(delivered).toEqual(["poke"]);
      expect(outbox.size).toBe(0);
      wrapped._clearDispatch(owner);
    } finally {
      updatePrincipalDispatchCorrelation(null);
      registerPrincipalDispatchRuntime(null);
    }
  });

  it("_isDispatchWired tracks binding presence and authorization currency", () => {
    registerPrincipalDispatchRuntime({
      canDispatch: true,
      dispatchPrincipalEpoch: 1,
      subscribe: () => () => {},
    });
    updatePrincipalDispatchCorrelation(1);
    try {
      const { wrapped } = makeHarness();
      expect(wrapped._isDispatchWired()).toBe(false);

      const owner = {};
      wrapped._setDispatch(async () => "ok", { owner, authorization: capturePrincipalDispatchAuthorization() });
      expect(wrapped._isDispatchWired()).toBe(true);

      updatePrincipalDispatchCorrelation(2);
      expect(wrapped._isDispatchWired()).toBe(false);

      wrapped._setDispatch(async () => "ok", { owner, authorization: capturePrincipalDispatchAuthorization() });
      expect(wrapped._isDispatchWired()).toBe(true);

      wrapped._clearDispatch(owner);
      expect(wrapped._isDispatchWired()).toBe(false);
    } finally {
      updatePrincipalDispatchCorrelation(null);
      registerPrincipalDispatchRuntime(null);
    }
  });
});
