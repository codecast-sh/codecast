import { describe, expect, it } from "bun:test";
import {
  action,
  mutativeMiddleware,
  outboxFailureDisposition,
  MAX_OUTBOX_BOOT_ATTEMPTS,
} from "../mutativeMiddleware";

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

function makeHarness() {
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
    }),
    { retryDelays: [] }, // fail fast — no real-time sleeps in tests
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
