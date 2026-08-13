// Endpoint discovery decides WHICH TRANSPORT a terminal gets, so its outcomes
// are behaviour, not plumbing: a wrong answer either hands you a shell on the
// wrong machine or makes a perfectly watchable pane look unreachable.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

// jsdom-free stand-ins: the module only touches these two storages and fetch.
const store = new Map<string, string>();
const session = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as any).sessionStorage = {
  getItem: (k: string) => session.get(k) ?? null,
  setItem: (k: string, v: string) => void session.set(k, v),
  removeItem: (k: string) => void session.delete(k),
};

const { getTerminalEndpoint, lastDiscoveryFailure } = await import("../terminal/endpoint");

const THIS_MACHINE = { port: 41234, token: "tok", deviceId: "dev-here", tmux: true };

/** A loopback probe that answers only for the machine we say is here. */
function probeAnswers(ok: boolean) {
  (globalThis as any).fetch = mock(async (url: string) => {
    if (String(url).includes("/term/sessions")) {
      return ok
        ? { ok: true, json: async () => ({ tmux: true, sessions: [] }) }
        : { ok: false, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

/** A convex client whose targeted lookup finds nothing — the shape a machine
 *  that is asleep, or simply not this one, produces. */
const noDevices = { mutation: async () => ({ commands: [] }), query: async () => null } as any;

beforeEach(() => {
  store.clear();
  session.clear();
});
afterEach(() => {
  delete (globalThis as any).fetch;
});

describe("getTerminalEndpoint", () => {
  test("a cached endpoint that still answers is the local machine", async () => {
    session.set("cast_term_endpoint", JSON.stringify(THIS_MACHINE));
    probeAnswers(true);
    expect(await getTerminalEndpoint(noDevices)).toEqual(THIS_MACHINE);
    expect(lastDiscoveryFailure()).toBe("none");
  });

  test("asking for THIS machine by id hits the cache", async () => {
    session.set("cast_term_endpoint", JSON.stringify(THIS_MACHINE));
    probeAnswers(true);
    expect(await getTerminalEndpoint(noDevices, { deviceId: "dev-here" })).toEqual(THIS_MACHINE);
  });

  test("asking for ANOTHER machine resolves immediately, without discovery", async () => {
    // The live cache proves which machine the browser is on, so a different id
    // cannot be local. Spending the discovery budget to prove that would just
    // delay the relay by seconds every time a remote split opens.
    session.set("cast_term_endpoint", JSON.stringify(THIS_MACHINE));
    probeAnswers(true);
    const convex = { mutation: mock(async () => ({ commands: [] })), query: async () => null } as any;
    expect(await getTerminalEndpoint(convex, { deviceId: "dev-elsewhere" })).toBeNull();
    expect(lastDiscoveryFailure()).toBe("other-device");
    expect(convex.mutation).not.toHaveBeenCalled();
  });

  test("a cached endpoint for another machine is never handed back", async () => {
    // The most dangerous failure: probing the cache succeeds, and returning it
    // would attach a shell on the wrong machine.
    session.set("cast_term_endpoint", JSON.stringify({ ...THIS_MACHINE, deviceId: "dev-other" }));
    probeAnswers(true);
    expect(await getTerminalEndpoint(noDevices, { deviceId: "dev-here" })).toBeNull();
  });

  test("a targeted miss reports other-device, not a daemon failure", async () => {
    // Nothing cached, and the one device asked never answers: that is "the
    // pane is elsewhere", which is the relay's cue rather than an error.
    probeAnswers(false);
    expect(await getTerminalEndpoint(noDevices, { deviceId: "dev-elsewhere" })).toBeNull();
    expect(lastDiscoveryFailure()).toBe("other-device");
  });

  test("a broadcast miss with no devices still reports no-devices", async () => {
    probeAnswers(false);
    expect(await getTerminalEndpoint(noDevices)).toBeNull();
    expect(lastDiscoveryFailure()).toBe("no-devices");
  });

  test("a targeted miss does not evict a good local endpoint from the cache", async () => {
    // The cache is the browser's memory of its OWN machine. A question about
    // some other machine says nothing about it.
    session.set("cast_term_endpoint", JSON.stringify(THIS_MACHINE));
    probeAnswers(true);
    await getTerminalEndpoint(noDevices, { deviceId: "dev-elsewhere" });
    expect(session.get("cast_term_endpoint")).toBe(JSON.stringify(THIS_MACHINE));
  });

  test("the force-relay dev override makes every pane look remote", async () => {
    // Without it the relay transport is untestable on a single machine: the
    // loopback probe always wins.
    store.set("CAST_TERM_FORCE_RELAY", "1");
    session.set("cast_term_endpoint", JSON.stringify(THIS_MACHINE));
    probeAnswers(true);
    expect(await getTerminalEndpoint(noDevices)).toBeNull();
    expect(lastDiscoveryFailure()).toBe("other-device");
  });
});
