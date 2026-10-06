// The runtime SDK, served at /run/sdk.js and imported by apps as "playground".
// convex/lib/runtime.ts holds the contract it implements (SDK_DOCS is what the
// builder is told); convex/runtime.ts is its backend.
//
// The module waits for the shell's `init` before it finishes loading (top
// level await), so app code that imports it sees a real `me` on first render.
// Opened outside the shell, it gives up after a moment and the app runs
// read-only with nobody connected.
//
// One ConvexClient talks to the playground deployment over WebSocket. Each
// distinct query is subscribed once however many components read it, and
// every write is applied optimistically so the app answers the click at once.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { DataDoc, PersonView, SetSharedResult, SharedView } from "../convex/runtime";
import type { PublicVisitor } from "../convex/visitors";
import { CONVEX_URL_PLACEHOLDER } from "../convex/lib/runtime";
import { startPicking } from "./picker";
import { isShellMessage, postToShell, type InitMessage, type PublicVisitorWire, type ShellMessage } from "./protocol";

/** Filled in by the router when it serves this file. */
const CONVEX_URL: string = CONVEX_URL_PLACEHOLDER;
const HANDSHAKE_MS = 4_000;
const READY_RESEND_MS = 250;
const STATE_SEND_MS = 100;
const SHARED_ATTEMPTS = 8;
const MAX_ERROR_REPORTS = 20;

export type Person = { id: string; name: string; avatar: string };
export type Doc = Record<string, any> & { _id: string; _by: Person | null; _at: number };
export type PresentPerson = Person & { isMe: boolean; state: Record<string, unknown> | null };

// ---- Shell link -------------------------------------------------------------

/** The shell's message in this event, or null when it is anyone else's. */
function fromShell(e: MessageEvent): ShellMessage | null {
  return e.source === window.parent && isShellMessage(e.data) ? e.data : null;
}

function handshake(): Promise<InitMessage | null> {
  if (window.parent === window) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ask = () => postToShell({ type: "ready" });
    const resend = setInterval(ask, READY_RESEND_MS);
    const giveUp = setTimeout(() => done(null), HANDSHAKE_MS);
    function onMessage(e: MessageEvent) {
      const message = fromShell(e);
      if (message?.type === "init") done(message);
    }
    function done(init: InitMessage | null) {
      clearInterval(resend);
      clearTimeout(giveUp);
      window.removeEventListener("message", onMessage);
      resolve(init);
    }
    window.addEventListener("message", onMessage);
    ask();
  });
}

let stopPicking: (() => void) | null = null;
window.addEventListener("message", (e) => {
  const message = fromShell(e);
  if (message?.type !== "pick") return;
  stopPicking?.();
  stopPicking = message.on
    ? startPicking(message.theme, {
        picked: (element) => postToShell({ type: "picked", element }),
        cancelled: () => postToShell({ type: "pick-cancelled" }),
      })
    : null;
});

let errorReports = 0;
function reportError(error: unknown) {
  if (errorReports++ >= MAX_ERROR_REPORTS) return;
  const message = error instanceof Error ? error.message : String(error);
  postToShell({ type: "error", message: message.slice(0, 500) });
}
window.addEventListener("error", (e) => reportError(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason));

const init = await handshake();
const client = init ? new ConvexClient(CONVEX_URL, { unsavedChangesWarning: false }) : null;
const creds = init && { visitor_id: init.visitor_id, app_id: init.app_id as Id<"apps">, token: init.token };

// ---- People -----------------------------------------------------------------

function person(v: PublicVisitorWire): Person {
  return { id: v.id, name: v.name, avatar: init?.avatars[v.avatar as AvatarKey] ?? "" };
}

let self: PublicVisitorWire | null = init?.visitor ?? null;

/** The current visitor. Kept live as they rename or change face. */
export const me: Person = self ? person(self) : { id: "", name: "Guest", avatar: "" };

// ---- Live queries -----------------------------------------------------------

type Creds = { visitor_id: string; app_id: Id<"apps">; token: string };
type Query = FunctionReference<"query">;
type ArgsOf<Q extends Query> = Omit<FunctionArgs<Q>, keyof Creds>;

/** One subscription per query and args, shared by every reader, with the
 *  server's answer reshaped once per change so readers get stable refs. */
type Live<T> = { get(): T | undefined; subscribe(onChange: () => void): () => void };
const lives = new Map<string, Live<unknown>>();
const RELEASE_MS = 1_000;

function live<Q extends Query, T>(query: Q, args: ArgsOf<Q>, shape: (raw: FunctionReturnType<Q>) => T): Live<T> {
  const key = `${getFunctionName(query)}:${JSON.stringify(args)}`;
  const known = lives.get(key);
  if (known) return known as Live<T>;
  const listeners = new Set<() => void>();
  let raw: FunctionReturnType<Q> | undefined;
  let shaped: T | undefined;
  let unsubscribe: (() => void) | null = null;
  let release: ReturnType<typeof setTimeout> | undefined;
  const accept = (next: FunctionReturnType<Q> | undefined) => {
    if (next === undefined || next === raw) return;
    raw = next;
    shaped = shape(next);
    for (const l of listeners) l();
  };
  const entry: Live<T> = {
    get: () => shaped,
    subscribe(onChange) {
      listeners.add(onChange);
      clearTimeout(release);
      if (!unsubscribe && client && creds) {
        const watch = client.onUpdate(query, { ...creds, ...args } as FunctionArgs<Q>, accept, (e) => reportError(e));
        unsubscribe = watch.unsubscribe;
        accept(watch.getCurrentValue());
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) release = setTimeout(() => (unsubscribe?.(), (unsubscribe = null)), RELEASE_MS);
      };
    },
  };
  lives.set(key, entry as Live<unknown>);
  return entry;
}

function useLive<T>(entry: Live<T>): T | undefined {
  return useSyncExternalStore(entry.subscribe, entry.get);
}

// ---- Writes -----------------------------------------------------------------

type Mutation = FunctionReference<"mutation">;
type LocalStore = Parameters<NonNullable<Parameters<ConvexClient["mutation"]>[2]>["optimisticUpdate"] & {}>[0];

function connected(): { client: ConvexClient; creds: Creds } {
  if (!client || !creds) throw new Error("This app is not connected to Clayground. Open it from its Clayground link.");
  return { client, creds };
}

/** Run a mutation with the visitor's runtime credentials, applying `optimistic`
 *  locally first. Server refusals become plain Errors with readable messages. */
async function write<M extends Mutation>(
  mutation: M,
  args: Omit<FunctionArgs<M>, keyof Creds>,
  optimistic?: (store: LocalStore, creds: Creds) => void,
): Promise<FunctionReturnType<M>> {
  const { client, creds } = connected();
  try {
    return await client.mutation(mutation, { ...creds, ...args } as FunctionArgs<M>, {
      optimisticUpdate: optimistic && ((store) => optimistic(store, creds)),
    });
  } catch (e) {
    throw e instanceof ConvexError ? new Error((e.data as { message?: string }).message ?? "The write failed.") : e;
  }
}

let tempIds = 0;

// ---- useCollection ----------------------------------------------------------

const shapeDocs = (docs: DataDoc[]): Doc[] => docs.map((d) => ({ ...d, _by: d._by && person(d._by) }));

export function useCollection(name: string) {
  const entry = useMemo(() => live(api.runtime.list, { collection: name }, shapeDocs), [name]);
  const docs = useLive(entry) ?? EMPTY;
  return useMemo(() => {
    const listArgs = (c: Creds) => ({ ...c, collection: name });
    const edit = (store: LocalStore, c: Creds, change: (docs: DataDoc[]) => DataDoc[]) => {
      const current = store.getQuery(api.runtime.list, listArgs(c));
      if (current) store.setQuery(api.runtime.list, listArgs(c), change(current));
    };
    return {
      docs,
      insert: (value: Record<string, unknown>): Promise<string> =>
        write(api.runtime.insert, { collection: name, value }, (store, c) => {
          const pending = { ...value, _id: `pending-${++tempIds}` as Id<"app_data">, _by: self as PublicVisitor | null, _at: Date.now() };
          edit(store, c, (docs) => [...docs, pending]);
        }),
      update: (id: string, patch: Record<string, unknown>): Promise<void> =>
        write(api.runtime.update, { id, patch }, (store, c) =>
          edit(store, c, (docs) => docs.map((d) => (d._id === id ? { ...d, ...patch, _id: d._id, _by: d._by, _at: Date.now() } : d))),
        ).then(() => undefined),
      remove: (id: string): Promise<void> =>
        write(api.runtime.remove, { id }, (store, c) => edit(store, c, (docs) => docs.filter((d) => d._id !== id))).then(
          () => undefined,
        ),
    };
  }, [docs, name]);
}
const EMPTY: Doc[] = [];

// ---- useShared --------------------------------------------------------------

type Shared = { value: unknown; rev: number } | null;
const shapeShared = (s: SharedView): Shared => s && { value: s.value, rev: s.rev };
const sharedLive = (key: string) => live(api.runtime.shared, { key }, shapeShared);

function setSharedLocally(store: LocalStore, c: Creds, key: string, value: unknown, rev: number) {
  store.setQuery(api.runtime.shared, { ...c, key }, { value, rev, by: self as PublicVisitor | null, at: Date.now() });
}

async function setShared<T>(key: string, next: T | ((prev: T) => T), initial: T): Promise<void> {
  if (typeof next !== "function") {
    const rev = (sharedLive(key).get()?.rev ?? 0) + 1;
    await write(api.runtime.setShared, { key, value: next }, (store, c) => setSharedLocally(store, c, key, next, rev));
    return;
  }
  const update = next as (prev: T) => T;
  let current: Shared | undefined = sharedLive(key).get();
  if (current === undefined) current = shapeShared(await connected().client.query(api.runtime.shared, { ...connected().creds, key }));
  for (let attempt = 0; attempt < SHARED_ATTEMPTS; attempt++) {
    const base = current ? (current.value as T) : initial;
    const rev: number = current?.rev ?? 0;
    const value = update(base);
    const result: SetSharedResult = await write(api.runtime.setShared, { key, value, base_rev: rev }, (store, c) =>
      setSharedLocally(store, c, key, value, rev + 1),
    );
    if (result.ok) return;
    current = result.rev === 0 ? null : { value: result.value, rev: result.rev };
  }
  throw new Error(`Too many people are changing "${key}" at once. Try again.`);
}

/** One live value for everyone in the app, like useState shared by the room. */
export function useShared<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => Promise<void>] {
  const entry = useMemo(() => sharedLive(key), [key]);
  const current = useLive(entry);
  const value = current ? (current.value as T) : initial;
  const set = useCallback((next: T | ((prev: T) => T)) => setShared(key, next, initial), [key, initial]);
  return [value, set];
}

// ---- usePresence ------------------------------------------------------------

const shapePeople = (rows: PersonView[]): PresentPerson[] =>
  rows.map((r) => ({ ...person(r.visitor), isMe: r.visitor.id === self?.id, state: r.state }));

let pendingState: Record<string, unknown> | null = null;
let stateTimer: ReturnType<typeof setTimeout> | undefined;
let lastStateSent = 0;

function sendState() {
  const state = pendingState;
  pendingState = null;
  stateTimer = undefined;
  lastStateSent = Date.now();
  if (!state) return;
  write(api.runtime.setState, { state }, (store, c) => {
    const rows = store.getQuery(api.runtime.people, c);
    if (rows) store.setQuery(api.runtime.people, c, rows.map((r) => (r.visitor.id === self?.id ? { ...r, state } : r)));
  }).catch(reportError);
}

/** Share small per-person state (a cursor, a pick); sent at most ~10 times a second. */
function setMyState(state: Record<string, unknown>) {
  connected();
  pendingState = state;
  if (stateTimer) return;
  stateTimer = setTimeout(sendState, Math.max(0, lastStateSent + STATE_SEND_MS - Date.now()));
}

const NOBODY: PresentPerson[] = [];

/** Who is in the app now, with each person's shared state. */
export function usePresence(): { people: PresentPerson[]; setMyState: typeof setMyState } {
  const people = useLive(live(api.runtime.people, {}, shapePeople)) ?? NOBODY;
  return useMemo(() => ({ people, setMyState }), [people]);
}

// Keep `me` current for the life of the page.
live(api.runtime.me, {}, (v) => {
  self = v;
  Object.assign(me, person(v));
  return v;
}).subscribe(() => {});
