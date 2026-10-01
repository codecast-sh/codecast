// The realm: the process-wide spies the sim runs under
// (docs/architecture/multiplayer-sim-harness.md, section 3.3).
//
// CLOCK. One virtual clock behind Date.now AND performance.now, so the
// projection epoch, the overlay receipt clock, the overlay bounds and the
// quiescence gate all move together and every run is replayable. The legacy
// harness re-exports it.
//
// RANDOM. Math.random and crypto.randomUUID draw from a seeded stream: the
// running server call's while one runs, else the active window's, else the
// world's. Each stream is makeRng(fnv1a32(`${seed}:${name}`)), so a draw in one
// window never moves another window's sequence.
//
// TIMERS. setTimeout and setInterval become deliveries on `timer:<owner>`
// (the active window, or "global"), due at now + delay, through the net the
// world attaches. A window's timer runs inside that window. setImmediate and
// queueMicrotask stay real: the realm yields on them.
//
// STORE FACADE. useInboxStore's getState/setState/subscribe/getInitialState
// point at the active window's store instance while it runs, so every caller
// (including the `store` proxy) reaches that window. runInWindow also swaps
// the module bindings that belong to a window (sim/windowSlots.ts).

import { fnv1a32, inboxEpoch } from "@codecast/shared/contracts";
import { makeRng } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { __createInboxStoreForTests, useInboxStore } from "../../inboxStore";
import type { Net } from "./net";
import {
  assertTransientIdle,
  freshSlots,
  resetMemos,
  restoreSlots,
  saveSlots,
  settleTransients,
  type SlotSnapshot,
} from "./windowSlots";

// -- The virtual clock --

export const T0 = inboxEpoch(1_800_000_000_000) + 25_000;
const MONO0 = 10_000_000;

let vnow = T0;
export const now = (): number => vnow;
export const mono = (): number => MONO0 + (vnow - T0);
export function advance(ms: number): void {
  vnow += ms;
}
export function resetClock(): void {
  vnow = T0;
}

// -- Types --

export type SimStore = ReturnType<typeof __createInboxStoreForTests>;
export type Rng = () => number;

/** What the realm needs of a window: a name (its rng stream and timer channel) and its own store. */
export interface RealmWindow {
  readonly name: string;
  readonly store: SimStore;
}

/** Where timers go: the world's net. */
export type TimerSink = Pick<Net, "enqueue" | "cancel">;

/** The server call running now, for routing its Math.random draws (makeSimBackend's activeCall). */
export type ServerCall = () => { rng: Rng } | null;

export interface RealmOptions {
  timers?: TimerSink;
  serverCall?: ServerCall;
  /** A facade read with no active window throws instead of reaching the base store (trace mode). */
  strictFacade?: boolean;
}

// -- State of the installed realm --

type FacadeApi = Pick<SimStore, "getState" | "setState" | "subscribe" | "getInitialState">;
const FACADE_KEYS = ["getState", "setState", "subscribe", "getInitialState"] as const;

interface WindowState {
  slots: SlotSnapshot;
  rng: Rng;
}

interface Installed {
  seed: number;
  opts: RealmOptions;
  world: Rng;
  windows: Map<RealmWindow, WindowState>;
  baseFacade: FacadeApi;
  baseSlots: SlotSnapshot;
  restores: (() => void)[];
  timers: Map<number, SimTimer>;
  nextTimerId: number;
}

let realm: Installed | null = null;
let active: RealmWindow | null = null;
// The window whose results the memo slots hold. They are dropped when another
// window takes a turn, so a window that runs twice in a row keeps its caches,
// as one browser window does.
let memoOwner: RealmWindow | null = null;

function switchMemos(w: RealmWindow): void {
  if (memoOwner === w) return;
  resetMemos();
  memoOwner = w;
}

function installed(what: string): Installed {
  if (!realm) throw new Error(`sim realm: ${what} needs installRealm() first`);
  return realm;
}

/** A named seeded stream for this realm's seed. */
export function stream(name: string): Rng {
  return makeRng(fnv1a32(`${installed("stream()").seed}:${name}`));
}

// Replaces obj[key] and returns the undo. An inherited property (crypto's
// randomUUID lives on the prototype) is shadowed and the undo deletes the
// shadow; an own one is put back with its original descriptor.
function swap(obj: object, key: string, value: unknown): () => void {
  const own = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: own?.enumerable ?? false });
  return () => {
    if (own) Object.defineProperty(obj, key, own);
    else delete (obj as any)[key];
  };
}

// -- Random --

function currentRng(r: Installed): Rng {
  const call = r.opts.serverCall?.();
  if (call) return call.rng;
  if (active) return r.windows.get(active)!.rng;
  return r.world;
}

/** A v4 UUID whose 16 bytes come from `rng`. */
export function uuidFrom(rng: Rng): string {
  const b = Array.from({ length: 16 }, () => Math.floor(rng() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// -- Timers --

class SimTimer {
  seq: number | null = null;
  cleared = false;
  constructor(
    readonly id: number,
    readonly owner: RealmWindow | null,
    readonly repeat: number | null,
    readonly label: string,
    readonly fire: () => unknown,
  ) {}
  // The node Timeout surface callers touch.
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  hasRef(): boolean {
    return true;
  }
  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

function arm(r: Installed, t: SimTimer, delay: number): void {
  const sink = r.opts.timers;
  if (!sink) throw new Error(`sim realm: ${t.label} armed before a net was attached (attachRealm({ timers }))`);
  const owner = t.owner?.name ?? "global";
  t.seq = sink.enqueue(`timer:${owner}`, {
    due: now() + delay,
    label: t.label,
    producer: `${owner} ${t.label}`,
    run: async () => {
      t.seq = null;
      if (t.cleared) return;
      if (t.repeat !== null) arm(r, t, t.repeat);
      else r.timers.delete(t.id);
      if (t.owner) await runInWindow(t.owner, t.fire);
      else await t.fire();
    },
  });
}

function setTimer(handler: unknown, ms: unknown, args: unknown[], repeat: boolean): SimTimer {
  const r = installed("a timer");
  if (typeof handler !== "function") throw new Error("sim realm: string timer handlers are not supported");
  const delay = Math.max(repeat ? 1 : 0, Math.floor(Number(ms) || 0));
  const name = (handler as Function).name || "anonymous";
  const t = new SimTimer(r.nextTimerId++, active, repeat ? delay : null, `${repeat ? "setInterval" : "setTimeout"}(${name}, ${delay})`, () =>
    (handler as Function)(...args),
  );
  r.timers.set(t.id, t);
  arm(r, t, delay);
  return t;
}

// A timer armed before the realm was installed is a real one: it goes back to
// the real clear.
const realClearTimeout = globalThis.clearTimeout;

function clearTimer(handle: unknown): void {
  const r = realm;
  if (!r || handle == null) return;
  if (!(handle instanceof SimTimer) && typeof handle !== "number") {
    realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    return;
  }
  const t = handle instanceof SimTimer ? handle : r.timers.get(handle);
  if (!t || t.cleared) return;
  t.cleared = true;
  r.timers.delete(t.id);
  if (t.seq !== null) r.opts.timers?.cancel(t.seq);
}

// -- Store facade --

/** Points the useInboxStore facade at `inst`, or back at the base store for null. */
export function bindStoreFacade(inst: SimStore | null): void {
  const r = installed("bindStoreFacade()");
  const facade = useInboxStore as unknown as FacadeApi;
  if (inst) {
    for (const k of FACADE_KEYS) (facade as any)[k] = inst[k];
  } else if (r.opts.strictFacade) {
    const outside = () => {
      throw new Error("sim: store read outside a window");
    };
    for (const k of FACADE_KEYS) (facade as any)[k] = outside;
  } else {
    for (const k of FACADE_KEYS) (facade as any)[k] = r.baseFacade[k];
  }
}

// -- Install --

/**
 * Installs the spies for one run. Timers need a sink and server-call routing
 * needs the backend; the world passes them here or later through attachRealm.
 */
export function installRealm(seed: number, opts: RealmOptions = {}): void {
  if (realm) throw new Error("sim realm: already installed; uninstallRealm() first");
  const facade = useInboxStore as unknown as FacadeApi;
  const baseFacade = Object.fromEntries(FACADE_KEYS.map((k) => [k, facade[k]])) as unknown as FacadeApi;
  resetClock();
  const r: Installed = {
    seed,
    opts: { strictFacade: Boolean(process.env.SIM_TRACE), ...opts },
    world: makeRng(fnv1a32(`${seed}:world`)),
    windows: new Map(),
    baseFacade,
    baseSlots: saveSlots(),
    restores: [],
    timers: new Map(),
    nextTimerId: 1,
  };
  realm = r;
  const g = globalThis as any;
  r.restores.push(
    swap(Date, "now", () => vnow),
    swap(performance, "now", () => mono()),
    swap(Math, "random", () => currentRng(r)()),
    swap(g.crypto, "randomUUID", () => uuidFrom(currentRng(r))),
    swap(g, "setTimeout", (fn: unknown, ms?: unknown, ...args: unknown[]) => setTimer(fn, ms, args, false)),
    swap(g, "setInterval", (fn: unknown, ms?: unknown, ...args: unknown[]) => setTimer(fn, ms, args, true)),
    swap(g, "clearTimeout", clearTimer),
    swap(g, "clearInterval", clearTimer),
  );
  // From here on, a facade read with no active window goes where the options say.
  bindStoreFacade(null);
}

/** Late wiring: the world builds its net and backend after the realm is installed. */
export function attachRealm(opts: Pick<RealmOptions, "timers" | "serverCall">): void {
  Object.assign(installed("attachRealm()").opts, opts);
}

/** Restores every spy, the facade and the module bindings the realm found at install. */
export function uninstallRealm(): void {
  const r = realm;
  if (!r) return;
  if (active) throw new Error(`sim realm: uninstallRealm() while window "${active.name}" is running`);
  for (const t of r.timers.values()) t.cleared = true;
  for (const undo of r.restores.reverse()) undo();
  const facade = useInboxStore as unknown as FacadeApi;
  for (const k of FACADE_KEYS) (facade as any)[k] = r.baseFacade[k];
  restoreSlots(r.baseSlots);
  resetMemos();
  memoOwner = null;
  realm = null;
}

/** Timers still pending (armed or queued), by label: a settled world has only the ones it expects. */
export function pendingTimers(): string[] {
  return [...(realm?.timers.values() ?? [])].map((t) => `${t.owner?.name ?? "global"}: ${t.label}`);
}

// -- Windows --

export function activeWindow(): RealmWindow | null {
  return active;
}

function windowState(r: Installed, w: RealmWindow): WindowState {
  let s = r.windows.get(w);
  if (!s) {
    s = { slots: freshSlots(), rng: makeRng(fnv1a32(`${r.seed}:window:${w.name}`)) };
    r.windows.set(w, s);
  }
  return s;
}

// A setImmediate callback runs only once the microtask queue is empty, so one
// yield settles every pure promise chain. Keep yielding while the window's
// state still moves (work that waited on a macrotask), up to a bound.
const SETTLE_YIELDS = 16;
const yieldMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(w: RealmWindow): Promise<void> {
  for (let i = 0; i < SETTLE_YIELDS; i++) {
    const before = w.store.getState();
    await yieldMacrotask();
    if (w.store.getState() === before) return;
  }
}

/**
 * Runs `fn` as one turn of window `w`: its module bindings and its store are
 * live for the turn, continuations it started settle before the turn ends,
 * and the next window starts from its own bindings. A call for the window
 * already running joins its turn.
 */
export async function runInWindow<T>(w: RealmWindow, fn: () => T | Promise<T>): Promise<T> {
  const r = installed("runInWindow()");
  if (active === w) return await fn();
  if (active) throw new Error(`sim realm: runInWindow("${w.name}") while "${active.name}" is running`);
  const state = windowState(r, w);
  assertTransientIdle();
  restoreSlots(state.slots);
  switchMemos(w);
  bindStoreFacade(w.store);
  active = w;
  try {
    return await fn();
  } finally {
    await settle(w);
    settleTransients();
    state.slots = saveSlots();
    active = null;
    bindStoreFacade(null);
  }
}

/**
 * A synchronous turn of window `w`, for reads and writes that start no async
 * work (a placement read, a compare tick, a cursor write). Same bindings and
 * cleanup as runInWindow, without the settle yields. The legacy suites
 * (inboxSimHarness.ts) read their windows this way.
 */
export function runInWindowSync<T>(w: RealmWindow, fn: () => T): T {
  const r = installed("runInWindowSync()");
  if (active === w) return fn();
  if (active) throw new Error(`sim realm: runInWindowSync("${w.name}") while "${active.name}" is running`);
  const state = windowState(r, w);
  assertTransientIdle();
  restoreSlots(state.slots);
  switchMemos(w);
  bindStoreFacade(w.store);
  active = w;
  try {
    return fn();
  } finally {
    settleTransients();
    state.slots = saveSlots();
    active = null;
    bindStoreFacade(null);
  }
}
