// A stand-in for the runtime SDK ("playground") when an app version is
// mounted outside a browser (scripts/lib/mount.ts). Same surface as
// runtime/sdk.ts, kept in memory, with the backend's own value checks and
// write rate, so an app that would be refused live is refused here too.
// Every write is tallied so the eval can tell whether using the app actually
// shared anything.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { checkDoc, checkPresenceState, checkShared, checkWhere, matchesWhere, type Where } from "../../convex/lib/appData";
import { DATA_LIST_MAX, RATE } from "../../convex/lib/limits";

export type Person = { id: string; name: string; avatar: string };
type Doc = Record<string, unknown> & { _id: string; _by: Person | null; _at: number };

const AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'/%3E";
export const me: Person = { id: "v-me", name: "Test Otter", avatar: AVATAR };
export const app = { name: "Test app", link: "https://clayground.test/test-app-k3x9", room: "https://clayground.test/test-app-k3x9?room" };
const friend: Person = { id: "v-friend", name: "Calm Heron", avatar: AVATAR };

/** What the app did with the SDK, read by the mount report. */
export const tally = { insert: 0, update: 0, remove: 0, setShared: 0, setMyState: 0, refused: [] as string[], writesInFirstMinute: 0 };
const started = Date.now();

function gate(problem: string | null): void {
  if (Date.now() - started < 60_000) tally.writesInFirstMinute++;
  if (tally.writesInFirstMinute > RATE.dataWrite.max) problem ??= `more than ${RATE.dataWrite.max} writes a minute`;
  if (problem) {
    tally.refused.push(problem);
    throw new Error(problem);
  }
}

type Store<T> = { value: T; listeners: Set<() => void> };
function store<T>(value: T): Store<T> {
  return { value, listeners: new Set() };
}
function set<T>(s: Store<T>, value: T) {
  s.value = value;
  for (const l of s.listeners) l();
}
function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(
    useCallback((l: () => void) => (s.listeners.add(l), () => s.listeners.delete(l)), [s]),
    () => s.value,
  );
}

const collections = new Map<string, Store<Doc[]>>();
const collection = (name: string) => collections.get(name) ?? collections.set(name, store<Doc[]>([])).get(name)!;
let ids = 0;

export function useCollection(name: string, options: { where?: Where } = {}) {
  const s = collection(name);
  const all = useStore(s);
  const whereKey = JSON.stringify(options.where ?? null);
  if (options.where) {
    const checked = checkWhere(options.where);
    if (!checked.ok) tally.refused.push(checked.problem);
  }
  const docs = useMemo(() => (options.where ? all.filter((d) => matchesWhere(d, options.where)) : all).slice(-DATA_LIST_MAX), [all, whereKey]);
  return useMemo(
    () => ({
      docs,
      ready: true,
      insert: async (value: Record<string, unknown>) => {
        tally.insert++;
        const checked = checkDoc(value);
        gate(checked.ok ? null : checked.problem);
        const doc = { ...(checked.ok ? checked.value : {}), _id: `d${++ids}`, _by: me, _at: Date.now() };
        set(s, [...s.value, doc]);
        return doc._id;
      },
      update: async (id: string, patch: Record<string, unknown>) => {
        tally.update++;
        const row = s.value.find((d) => d._id === id);
        const checked = checkDoc({ ...row, ...patch });
        gate(!row ? `no doc ${id}` : checked.ok ? null : checked.problem);
        set(s, s.value.map((d) => (d._id === id ? { ...d, ...patch, _id: d._id, _by: d._by, _at: Date.now() } : d)));
      },
      remove: async (id: string) => {
        tally.remove++;
        gate(s.value.some((d) => d._id === id) ? null : `no doc ${id}`);
        set(s, s.value.filter((d) => d._id !== id));
      },
      removeWhere: async (where: Where) => {
        tally.remove++;
        const checked = checkWhere(where);
        gate(checked.ok ? null : checked.problem);
        const before = s.value.length;
        set(s, s.value.filter((d) => !matchesWhere(d, where)));
        return before - s.value.length;
      },
    }),
    [docs, s],
  );
}

const shared = new Map<string, Store<{ value: unknown } | null>>();
const sharedStore = (key: string) => shared.get(key) ?? shared.set(key, store<{ value: unknown } | null>(null)).get(key)!;

type Keyed<T> = [T, (next: T | ((prev: T) => T)) => Promise<void>, boolean];

export function useShared<T>(key: string, initial: T): Keyed<T> {
  return useKeyed(`shared:${key}`, initial);
}

export function useMine<T>(key: string, initial: T): Keyed<T> {
  return useKeyed(`mine:${key}`, initial);
}

function useKeyed<T>(key: string, initial: T): Keyed<T> {
  const s = sharedStore(key);
  const current = useStore(s);
  const value = current ? (current.value as T) : initial;
  const setValue = useCallback(
    async (next: T | ((prev: T) => T)) => {
      tally.setShared++;
      const base = s.value ? (s.value.value as T) : initial;
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(base) : next;
      const checked = checkShared(resolved);
      gate(checked.ok ? null : checked.problem);
      set(s, { value: resolved });
    },
    [s, initial],
  );
  return [value, setValue, true];
}

const people = store([
  { ...me, isMe: true, state: null as Record<string, unknown> | null },
  { ...friend, isMe: false, state: { x: 0.4, y: 0.6 } as Record<string, unknown> | null },
]);

/** Like the real SDK, presence is sent on a timer, never inside the caller's render. */
function setMyState(state: Record<string, unknown>) {
  tally.setMyState++;
  const checked = checkPresenceState(state);
  if (!checked.ok) {
    tally.refused.push(checked.problem);
    return;
  }
  setTimeout(() => set(people, people.value.map((p) => (p.isMe ? { ...p, state } : p))), 0);
}

export function usePresence() {
  const list = useStore(people);
  return useMemo(() => ({ people: list, setMyState }), [list]);
}
