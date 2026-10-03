// Realm self-test (docs/architecture/multiplayer-sim-harness.md, unit U7):
// windows really are separate (store, module bindings, random streams,
// timers), and uninstalling leaves the process as it found it.

import { afterEach, describe, expect, test } from "bun:test";
import { store, useInboxStore } from "../../../inboxStore";
import { gestureSourceToken } from "../../../gestureBridge";
import { Net } from "../net";
import {
  activeWindow,
  advance,
  attachRealm,
  createWindowStore,
  installRealm,
  mono,
  now,
  runInWindow,
  stream,
  uuidFrom,
  T0,
  uninstallRealm,
  type RealmWindow,
} from "../realm";
import { freshSlots, restoreSlots, saveSlots, WINDOW_SLOTS, type SlotSnapshot } from "../windowSlots";

const win = (name: string): RealmWindow => ({ name, store: createWindowStore(name) });

function attachNet(): Net {
  const net = new Net({ rng: stream("net"), writes: () => 0, now, advance });
  attachRealm({ timers: net });
  return net;
}

// A value of the same shape as `v` that names `tag`, so two windows' markers
// differ in every binding.
function markValue(v: unknown, tag: string, i: number): unknown {
  const n = tag.charCodeAt(0) * 1000 + i;
  if (typeof v === "number") return n;
  if (typeof v === "boolean") return tag === "A";
  if (v instanceof Map) return new Map([[`${tag}${i}`, n]]);
  // A null binding is a handle, a token or an optional Set; a Set passes
  // through the opaque ones unchanged and is what the optional ones copy.
  if (v instanceof Set || v === null) return new Set([`${tag}${i}`]);
  if (v && typeof v === "object") {
    const entries = Object.entries(v);
    if (entries.length && entries.every(([, x]) => typeof x === "number")) {
      return Object.fromEntries(entries.map(([k], j) => [k, n + j]));
    }
    return { [`${tag}${i}`]: {} };
  }
  return `${tag}${i}`;
}

function marker(tag: string): SlotSnapshot {
  let i = 0;
  const out: SlotSnapshot = {};
  for (const [file, slots] of Object.entries(freshSlots())) {
    out[file] = Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, markValue(v, tag, i++)]));
  }
  return out;
}

afterEach(() => uninstallRealm());

describe("realm", () => {
  test("two store instances bound in turn keep their writes and their window slots apart", async () => {
    const before = saveSlots();
    const baseSessions = useInboxStore.getState().sessions;
    installRealm(1);
    const a = win("A");
    const b = win("B");

    await runInWindow(a, () => {
      useInboxStore.setState({ sessions: { s1: { _id: "s1", title: "in A" } } } as any);
      expect(store.sessions).toHaveProperty("s1"); // the store proxy routes through the facade too
      restoreSlots(marker("A"));
    });
    await runInWindow(b, () => {
      expect(useInboxStore.getState().sessions).toEqual({});
      expect(saveSlots()).toEqual(freshSlots()); // a window that never ran starts fresh
      restoreSlots(marker("B"));
    });
    await runInWindow(a, () => {
      expect(useInboxStore.getState().sessions.s1?.title).toBe("in A");
      expect(saveSlots()).toEqual(marker("A"));
    });
    await runInWindow(b, () => expect(saveSlots()).toEqual(marker("B")));

    // Every window binding the table names took part in the round trip.
    const marked = Object.values(marker("A")).flatMap((s) => Object.keys(s));
    const windowBindings = Object.keys(WINDOW_SLOTS).filter((k) => WINDOW_SLOTS[k] === "window");
    expect(marked.length).toBe(windowBindings.length);

    uninstallRealm();
    expect(useInboxStore.getState().sessions).toBe(baseSessions);
    expect(saveSlots()).toEqual(before);
  });

  test("a real window binding: each window mints and keeps its own gesture token", async () => {
    installRealm(2);
    const a = win("A");
    const b = win("B");
    const tokenA = await runInWindow(a, () => gestureSourceToken());
    const tokenB = await runInWindow(b, () => gestureSourceToken());
    expect(tokenA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(tokenB).not.toBe(tokenA);
    expect(await runInWindow(a, () => gestureSourceToken())).toBe(tokenA);
  });

  test("Math.random from window A's stream is unaffected by draws in window B", async () => {
    const draws = (n: number) => Array.from({ length: n }, () => Math.random());

    installRealm(7);
    const alone = await runInWindow(win("A"), () => draws(4));
    uninstallRealm();

    installRealm(7);
    const a = win("A");
    const b = win("B");
    await runInWindow(b, () => draws(5));
    const first = await runInWindow(a, () => draws(1));
    await runInWindow(b, () => draws(2));
    draws(4); // world draws, outside any window
    const rest = await runInWindow(a, () => draws(3));
    expect([...first, ...rest]).toEqual(alone);
  });

  test("a running server call's stream wins over the window's", async () => {
    installRealm(3);
    const call = stream("call:1");
    const expected = stream("call:1")();
    attachRealm({ serverCall: () => ({ rng: call }) });
    expect(await runInWindow(win("A"), () => Math.random())).toBe(expected);
  });

  test("building a store moves no other stream, whatever runs around it", async () => {
    installRealm(5);
    let calling = false;
    const call = stream("call:1");
    attachRealm({ serverCall: () => (calling ? { rng: call } : null) });
    // Stores built with a server call running, with none, and inside a
    // window's turn: whatever production draws as it builds a store lands on
    // that store's own stream.
    calling = true;
    const a = win("A");
    calling = false;
    const b = win("B");
    await runInWindow(b, () => win("C"));
    expect(Math.random()).toBe(stream("world")());
    calling = true;
    expect(Math.random()).toBe(stream("call:1")());
    calling = false;
    expect(await runInWindow(a, () => Math.random())).toBe(stream("window:A")());
    expect<string>(await runInWindow(b, () => crypto.randomUUID())).toBe(uuidFrom(stream("window:B")));
  });

  test("a setTimeout(fn, 0) armed inside A runs inside A; a delayed one moves the clock", async () => {
    installRealm(4);
    const net = attachNet();
    const a = win("A");
    const b = win("B");
    const ran: string[] = [];
    await runInWindow(a, () => {
      setTimeout(() => ran.push(`0:${activeWindow()?.name}`), 0);
    });
    await runInWindow(b, () => {
      setTimeout(() => ran.push(`500:${activeWindow()?.name}@${now() - T0}`), 500);
      const cancelled = setTimeout(() => ran.push("cancelled"), 10);
      clearTimeout(cancelled);
    });
    setTimeout(() => ran.push(`global:${activeWindow()?.name ?? "none"}`), 0);
    await net.drain();
    expect(ran).toEqual(["0:A", "global:none", "500:B@500"]);
    expect(net.ring.map((d) => d.channel)).toEqual(["timer:A", "timer:global", "timer:B"]);
  });

  test("setInterval repeats inside its window until cleared", async () => {
    installRealm(5);
    const net = attachNet();
    const a = win("A");
    let ticks = 0;
    await runInWindow(a, () => {
      const id = setInterval(() => {
        expect(activeWindow()).toBe(a);
        if (++ticks === 3) clearInterval(id);
      }, 100);
    });
    await net.drain();
    expect(ticks).toBe(3);
    expect(now() - T0).toBe(300);
  });

  test("a store read outside any window throws in strict facade mode", () => {
    installRealm(6, { strictFacade: true });
    expect(() => useInboxStore.getState()).toThrow("sim: store read outside a window");
  });

  test("uninstallRealm restores Date.now, Math.random, setTimeout, the facade and crypto.randomUUID", async () => {
    const originals = {
      dateNow: Date.now,
      perfNow: performance.now,
      random: Math.random,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      randomUUID: crypto.randomUUID,
      getState: useInboxStore.getState,
      setState: useInboxStore.setState,
      subscribe: useInboxStore.subscribe,
      getInitialState: useInboxStore.getInitialState,
    };
    installRealm(8);
    expect(Date.now()).toBe(T0);
    expect(performance.now()).toBe(mono());
    expect(Math.random).not.toBe(originals.random);
    await runInWindow(win("A"), () => expect(useInboxStore.getState).not.toBe(originals.getState));
    uninstallRealm();
    const after = {
      dateNow: Date.now,
      perfNow: performance.now,
      random: Math.random,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      randomUUID: crypto.randomUUID,
      getState: useInboxStore.getState,
      setState: useInboxStore.setState,
      subscribe: useInboxStore.subscribe,
      getInitialState: useInboxStore.getInitialState,
    };
    for (const k of Object.keys(originals) as (keyof typeof originals)[]) expect(after[k], k).toBe(originals[k]);
  });

  test("a turn for one window cannot start inside another's", async () => {
    installRealm(9);
    const a = win("A");
    const b = win("B");
    await expect(runInWindow(a, () => runInWindow(b, () => 1))).rejects.toThrow('runInWindow("B") while "A" is running');
    // The same window joins its own turn.
    expect(await runInWindow(a, () => runInWindow(a, () => 2))).toBe(2);
  });
});
