// The runtime SDK, served at /run/sdk and imported by apps as "playground".
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
import { matchesWhere, type Where } from "../convex/lib/appData";
import type { PlaygroundErrorData } from "../convex/lib/errors";
import { SDK_LOADED_FLAG } from "../convex/lib/bootCatcher";
import type { Id } from "../convex/_generated/dataModel";
import type { DataDoc, PersonView, SharedView } from "../convex/runtime";
import type { PublicVisitor } from "../convex/visitors";
import { capture } from "./capture";
import { startPicking } from "./picker";
import { spotlight } from "./spotlight";
import { isShellMessage, postToShell, type AppLink, type InitMessage, type PublicVisitorWire, type ShellMessage } from "./protocol";
import { updateShared, type SharedState } from "./sharedUpdate";

/** The bundle holds CONVEX_URL_PLACEHOLDER here (scripts/build-sdk.ts); the
 *  router fills in its deployment when it serves the file. */
const CONVEX_URL = process.env.PLAYGROUND_CONVEX_URL!;
/** Without a shell that answers by then, the app runs on its own. */
const HANDSHAKE_MS = 4_000;
const PAINT_WAIT_MS = 3_000;
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
    const version = /\/v\/(\d+)\//.exec(location.pathname);
    const ask = () => postToShell({ type: "ready", version: version ? Number(version[1]) : null });
    const resend = setInterval(ask, READY_RESEND_MS);
    const giveUp = setTimeout(() => done(null), HANDSHAKE_MS);
    function onMessage(e: MessageEvent) {
      const message = fromShell(e);
      if (message?.type === "init") done(message);
      // The shell is here and still learning who this is: wait as long as it takes.
      else if (message?.type === "hold") clearTimeout(giveUp);
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
  if (message?.type === "token") return renew(message.token);
  if (message?.type === "spotlight") return postToShell({ type: "spotlit", found: spotlight(message.selector, message.color) });
  if (message?.type === "capture") return void capture(message.width, message.height).then((image) => postToShell({ type: "captured", image }));
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
/** Errors the shell has heard about, so an uncaught one is not told twice. */
const reported = new WeakSet<object>();
function reportError(error: unknown) {
  if (typeof error === "object" && error !== null) {
    if (reported.has(error)) return;
    reported.add(error);
  }
  if (errorReports++ >= MAX_ERROR_REPORTS) return;
  const message = error instanceof Error ? error.message : String(error);
  postToShell({ type: "error", message: message.slice(0, 500) });
}
window.addEventListener("error", (e) => reportError(e.error ?? e.message));
// The page's boot catcher (convex/lib/runtime BOOT_CATCHER) hands over here.
(window as unknown as Record<string, boolean>)[SDK_LOADED_FLAG] = true;
window.addEventListener("unhandledrejection", (e) => reportError(e.reason));

const init = await handshake();
const client = init ? new ConvexClient(CONVEX_URL, { unsavedChangesWarning: false }) : null;
const creds = init && { visitor_id: init.visitor_id, app_id: init.app_id as Id<"apps">, token: init.token };
/** Looking only (a past version, a gallery preview): the app shows its data
 *  and writes nothing. It follows the token, so a frame the shell moves
 *  between looking and using changes with its next token. */
const watching = () => creds?.token.startsWith("w") === true;
let lastRefusal = 0;
const REFUSAL_GAP_MS = 1_000;

/** Refuse a write quietly: nothing changes and the app hears nothing (the
 *  write never settles, so it has no error to print and no success to
 *  claim). The shell is told, once a moment, and says why. */
function refuse(): Promise<never> {
  if (Date.now() - lastRefusal > REFUSAL_GAP_MS) postToShell({ type: "refused" });
  lastRefusal = Date.now();
  return new Promise(() => {});
}

// ---- People -----------------------------------------------------------------

function person(v: PublicVisitorWire): Person {
  return { id: v.id, name: v.name, avatar: init?.avatars[v.avatar as AvatarKey] ?? "" };
}

let self: PublicVisitorWire | null = init?.visitor ?? null;

/** The current visitor. Kept live as they rename or change face. */
export const me: Person = self ? person(self) : { id: "", name: "Guest", avatar: "" };

/** The app's own name and links, for an invite or a share button. */
export const app: AppLink = init?.app ?? { name: document.title, link: location.href, room: location.href };

// ---- Live queries -----------------------------------------------------------

type Creds = { visitor_id: string; app_id: Id<"apps">; token: string };
type Query = FunctionReference<"query">;
type ArgsOf<Q extends Query> = Omit<FunctionArgs<Q>, keyof Creds>;

/** One subscription per query and args, shared by every reader, with the
 *  server's answer reshaped once per change so readers get stable refs. */
type Live<T> = {
  get(): T | undefined;
  subscribe(onChange: () => void): () => void;
  resubscribe(): void;
  /** Read by a component (or subscribed), and the server has not answered yet. */
  waiting(): boolean;
  /** A component reads it: the app is not drawn until it has its answer. */
  want(): void;
};
const lives = new Map<string, Live<unknown>>();
/** Called whenever a live query gets its first answer. */
const firstAnswers = new Set<() => void>();

/** The shell's fresh token: every later call carries it, and every live
 *  query moves to it, keeping its last answer until the next arrives. */
function renew(token: string) {
  if (!creds) return;
  creds.token = token;
  for (const entry of lives.values()) entry.resubscribe();
}
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
  let answered = false;
  let wanted = false;
  const accept = (next: FunctionReturnType<Q> | undefined) => {
    if (next === undefined || next === raw) return;
    if (!answered) {
      answered = true;
      for (const f of firstAnswers) f();
    }
    raw = next;
    shaped = shape(next);
    for (const l of listeners) l();
  };
  const watch = () => {
    if (!client || !creds) return;
    const w = client.onUpdate(query, { ...creds, ...args } as FunctionArgs<Q>, accept, (e) => reportError(e));
    unsubscribe = w.unsubscribe;
    accept(w.getCurrentValue());
  };
  const entry: Live<T> = {
    get: () => shaped,
    waiting: () => (wanted || unsubscribe !== null) && !answered,
    want: () => void (wanted = true),
    resubscribe() {
      if (!unsubscribe) return;
      const old = unsubscribe;
      watch();
      old();
    },
    subscribe(onChange) {
      listeners.add(onChange);
      clearTimeout(release);
      if (!unsubscribe) watch();
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
  entry.want();
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
 *  locally first. A server refusal becomes a plain Error with a readable
 *  message; one the app could act on (too fast, too big, too full) is also
 *  told to the room, so an app that swallows it still leaves a trace. */
async function write<M extends Mutation>(
  mutation: M,
  args: Omit<FunctionArgs<M>, keyof Creds>,
  optimistic?: (store: LocalStore, creds: Creds) => void,
): Promise<FunctionReturnType<M>> {
  if (watching()) return refuse();
  const { client, creds } = connected();
  try {
    return await client.mutation(mutation, { ...creds, ...args } as FunctionArgs<M>, {
      optimisticUpdate: optimistic && ((store) => optimistic(store, creds)),
    });
  } catch (e) {
    if (!(e instanceof ConvexError)) throw e;
    const data = e.data as Partial<PlaygroundErrorData>;
    const refused = new Error(data.message ?? "The write failed.");
    if (data.code === "rate_limited" || data.code === "invalid") reportError(new Error(`A write was refused: ${refused.message}`));
    reported.add(refused);
    throw refused;
  }
}

let tempIds = 0;

// ---- useCollection ----------------------------------------------------------

const shapeDocs = (docs: DataDoc[]): Doc[] => docs.map((d) => ({ ...d, _by: d._by && person(d._by) }));

/** Every live read of `name` this page holds (one per `where`), changed in place. */
function editLists(store: LocalStore, name: string, change: (docs: DataDoc[], where: Where | null) => DataDoc[]) {
  for (const { args, value } of store.getAllQueries(api.runtime.list)) {
    if (args.collection === name && value) store.setQuery(api.runtime.list, args, change(value, (args.where as Where | undefined) ?? null));
  }
}

/** A live collection: its newest docs (only those matching `where`, when
 *  given), whether the first answer has arrived, and its writes. */
export function useCollection(name: string, options: { where?: Where } = {}) {
  const whereKey = JSON.stringify(options.where ?? null);
  const entry = useMemo(
    () => live(api.runtime.list, options.where ? { collection: name, where: options.where } : { collection: name }, shapeDocs),
    [name, whereKey],
  );
  const answer = useLive(entry);
  const docs = answer ?? EMPTY;
  const ready = answer !== undefined || !client;
  return useMemo(() => {
    const edit = (store: LocalStore, change: (docs: DataDoc[], where: Where | null) => DataDoc[]) => editLists(store, name, change);
    return {
      docs,
      ready,
      insert: (value: Record<string, unknown>): Promise<string> =>
        write(api.runtime.insert, { collection: name, value }, (store) => {
          const pending = { ...value, _id: `pending-${++tempIds}` as Id<"app_data">, _by: self as PublicVisitor | null, _at: Date.now() };
          edit(store, (docs, where) => (matchesWhere(value, where) ? [...docs, pending] : docs));
        }),
      update: (id: string, patch: Record<string, unknown>): Promise<void> =>
        write(api.runtime.update, { id, patch }, (store) =>
          edit(store, (docs, where) =>
            docs
              .map((d) => (d._id === id ? { ...d, ...patch, _id: d._id, _by: d._by, _at: Date.now() } : d))
              .filter((d) => d._id !== id || matchesWhere(d, where)),
          ),
        ).then(() => undefined),
      remove: (id: string): Promise<void> =>
        write(api.runtime.remove, { id }, (store) => edit(store, (docs) => docs.filter((d) => d._id !== id))).then(() => undefined),
      /** Remove every doc matching `where` ({} clears the collection); resolves to how many went. */
      removeWhere: async (where: Where): Promise<number> => {
        let removed = 0;
        for (;;) {
          const page = await write(api.runtime.removeWhere, { collection: name, where }, (store) =>
            edit(store, (docs) => docs.filter((d) => !matchesWhere(d, where))),
          );
          removed += page.removed;
          if (!page.more) return removed;
        }
      },
    };
  }, [docs, ready, name]);
}
const EMPTY: Doc[] = [];

// ---- useShared --------------------------------------------------------------

// useShared and useMine are one keyed value each: everyone's, or the
// caller's own (the server scopes a `mine` key to the visitor's token).

type Slot = { key: string; mine?: true };
const slotOf = (key: string, mine: boolean): Slot => (mine ? { key, mine: true } : { key });
const shapeShared = (s: SharedView): SharedState => s && { value: s.value, rev: s.rev };
const keyedLive = (slot: Slot) => live(api.runtime.shared, slot, shapeShared);

function setKeyedLocally(store: LocalStore, c: Creds, slot: Slot, value: unknown, rev: number) {
  store.setQuery(api.runtime.shared, { ...c, ...slot }, { value, rev, by: self as PublicVisitor | null, at: Date.now() });
}

async function setKeyed<T>(slot: Slot, next: T | ((prev: T) => T), initial: T): Promise<void> {
  if (typeof next !== "function") {
    const rev = (keyedLive(slot).get()?.rev ?? 0) + 1;
    await write(api.runtime.setShared, { ...slot, value: next }, (store, c) => setKeyedLocally(store, c, slot, next, rev));
    return;
  }
  let current: SharedState | undefined = keyedLive(slot).get();
  if (current === undefined) current = shapeShared(await connected().client.query(api.runtime.shared, { ...connected().creds, ...slot }));
  await updateShared(current, initial, next as (prev: T) => T, (value, rev) =>
    write(api.runtime.setShared, { ...slot, value, base_rev: rev }, (store, c) => setKeyedLocally(store, c, slot, value, rev + 1)),
    SHARED_ATTEMPTS,
  );
}

type Keyed<T> = [T, (next: T | ((prev: T) => T)) => Promise<void>, boolean];

function useKeyed<T>(key: string, initial: T, mine: boolean): Keyed<T> {
  const slot = useMemo(() => slotOf(key, mine), [key, mine]);
  const current = useLive(useMemo(() => keyedLive(slot), [slot]));
  const value = current ? (current.value as T) : initial;
  const set = useCallback((next: T | ((prev: T) => T)) => setKeyed(slot, next, initial), [slot, initial]);
  return [value, set, current !== undefined || !client];
}

/** One live value for everyone in the app, like useState shared by the room;
 *  the third item says whether the stored value has arrived. */
export function useShared<T>(key: string, initial: T): Keyed<T> {
  return useKeyed(key, initial, false);
}

/** A value that is the current person's own, kept for them across reloads
 *  and versions, and shown to nobody else by the SDK. */
export function useMine<T>(key: string, initial: T): Keyed<T> {
  return useKeyed(key, initial, true);
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
  if (watching()) return;
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

// ---- Painted ----------------------------------------------------------------

/** `n` frames from now; a hidden page draws nothing, so there it is now. */
const frames = (n: number): Promise<void> =>
  new Promise((done) => (!n || document.hidden ? done() : requestAnimationFrame(() => void frames(n - 1).then(done))));

/** Resolve once `ready()` holds, checked now and whenever `watch` reports a
 *  change, or at `deadline` (a performance.now() stamp). */
function once(ready: () => boolean, watch: (check: () => void) => () => void, deadline: number): Promise<void> {
  return new Promise((done) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stop();
      done();
    };
    const timer = setTimeout(finish, deadline - performance.now());
    const stop = watch(() => ready() && finish());
    if (ready()) finish();
  });
}

/** Tell the shell once the app has drawn itself with its data: it has
 *  rendered, every live query it reads has its first answer, its web fonts
 *  have loaded (so the reveal and the gallery still never show a fallback
 *  face swapping out), and that has been painted. The shell reveals a new version on this, so the swap never
 *  lands on an empty page. A stuck app is let go after a while. */
async function announcePainted() {
  const deadline = performance.now() + PAINT_WAIT_MS;
  const root = document.getElementById("root") ?? document.body;
  await once(() => root.childElementCount > 0, (check) => {
    const seen = new MutationObserver(check);
    seen.observe(root, { childList: true });
    return () => seen.disconnect();
  }, deadline);
  await once(() => ![...lives.values()].some((l) => l.waiting()), (check) => {
    firstAnswers.add(check);
    return () => firstAnswers.delete(check);
  }, deadline);
  await Promise.race([document.fonts.ready, new Promise((done) => setTimeout(done, deadline - performance.now()))]);
  await frames(2);
  postToShell({ type: "painted" });
}

if (init) void announcePainted();

// Keep `me` current for the life of the page.
live(api.runtime.me, {}, (v) => {
  self = v;
  Object.assign(me, person(v));
  return v;
}).subscribe(() => {});
