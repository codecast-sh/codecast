import { describe, expect, it } from "bun:test";
import {
  action,
  asyncAction,
  isPermanentDispatchError,
  mutativeMiddleware,
  outboxFailureDisposition,
  StaleDispatchBindingError,
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
};

function makeHarness(retryDelays: number[] = []) {
  const outbox = new Map<string, Entry>();
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
    }),
    { retryDelays }, // default [] — fail fast, no real-time sleeps in tests
  )(set, get, {});
  state = wrapped;
  wrapped._setOutbox(
    (e: Entry) => outbox.set(e.id, e),
    (id: string) => outbox.delete(id),
    async () => [...outbox.values()],
  );
  return { wrapped, outbox };
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
});
