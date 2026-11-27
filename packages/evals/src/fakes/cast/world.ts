import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';

import { writeJsonAtomic } from '../../paths';

// What the fake remembers between one call and the next inside a run: who is
// calling, what it created, what it sent. A run starts from a seed (the
// replay's identity and the ids prod would mint next) and every answered
// write lands here, so a later call sees it: `task show` on a task the turn
// created, a comment counted on it, `cast state` printing the pin it set.
// The file sits in the run dir, so each rep has its own world.

export interface FakeTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  description?: string;
  plan?: string;
  project?: string;
  found_during?: string;
  /** The call it was filed from (`--from-call`), the object it sits under (`--under`), who answers for it. */
  from_call?: string;
  under?: string;
  assignee?: string;
  comments: Array<{ type: string; text: string; seq: number }>;
}

export interface Role {
  session: string;
  title: string;
}

/** One board doc, element by element, as the server stores it: each write stamps its rev and its writer (`s:<session>` or a person's `u:<id>`). */
export interface FakeBoard {
  doc: string;
  title: string;
  rev: number;
  elements: Record<string, { kind: string; fields: Record<string, any>; deleted?: boolean; rev: number; by?: string; at?: number }>;
  comments: Array<{ key: string; text: string; author_name: string; by?: string; anchor?: string; parent?: string; resolved?: boolean }>;
  cursor?: { key?: string; point?: string; status?: string };
  checkpoints: Array<{ rev: number; label: string }>;
  /** Every write in order: which verb, at which call, the ops it made. */
  log: Array<{ seq: number; rev: number; verb: string; ops: unknown[] }>;
}

/** The live call a replay is fed from. */
export interface FakeCall {
  id: string;
  title: string;
  started: string;
  speakers: string[];
}

/** What the listings print before the run made anything: lines read once from a real workspace. */
export interface FakeListings {
  priorities?: string[];
  goals?: string;
  plans?: string[];
  tasks?: string[];
}

export interface FakeWorld {
  /** The calling session's short id, as prod would resolve it. */
  self: string;
  /** The workspace's roles by handle (no @): the standing session `role wake @x` reaches, and the title a role signs with. */
  roles: Record<string, Role>;
  /** The workspace's people by handle (no @): the name a direct message is addressed to. */
  people: Record<string, string>;
  /** The next id each prefix mints (ct-, tr-, sd-, msg). */
  next: Record<string, number>;
  /** The task this session is bound to: `task start` binds, `task create` links new work to it. */
  bound?: string;
  pin?: { text: string; status: string };
  brief?: string;
  tasks: Record<string, FakeTask>;
  triggers: Record<string, { id: string; title: string; schedule: string; status: string }>;
  decisions: Record<string, { id: string; question: string; options: string[]; status: string; recommended?: string }>;
  /** Every outbound message, in order: a send, a role wake, a chat post. */
  sent: Array<{ seq: number; kind: string; to: string; text: string }>;
  /** Calls answered so far; orders comments and sends. */
  seq: number;
  /** Every session, task, trigger and decision id the replay's record or prompt names: what exists besides what the world made. Unset when the world has no record to go on. */
  known?: string[];
  /** The team's chat channels by name, from the record's `chat channels`; unset when the record has none. */
  channels?: string[];
  /** Fidelity scoring's world: every well-formed id a real call named existed, so the fake takes any. */
  open?: boolean;
  board?: FakeBoard;
  call?: FakeCall;
  listings?: FakeListings;
  plans: Record<string, { id: string; title: string; goal?: string; from_call?: string; status?: string }>;
  priorities: Record<string, { id: string; title: string; owner?: string; from_call?: string; status?: string }>;
}

export interface WorldSeed {
  self?: string;
  roles?: Record<string, Role>;
  people?: Record<string, string>;
  next?: Record<string, number>;
  bound?: string;
  brief?: string;
  known?: string[];
  channels?: string[];
  open?: boolean;
  board?: FakeBoard;
  call?: FakeCall;
  listings?: FakeListings;
}

export const DEFAULT_NEXT: Record<string, number> = { 'ct-': 96001, 'tr-': 7301, 'sd-': 3101, 'pl-': 1201, 'pri-': 301, msg: 1 };

/** A map with no prototype: a key the agent types (`__proto__`, `constructor`) is only ever a key. */
const bare = <T>(from: Record<string, T> | undefined): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, from ?? {});

/** Every map in a world made prototype-free, as a world arrives from JSON or a seed. */
function bareWorld(w: FakeWorld): FakeWorld {
  return {
    ...w, roles: bare(w.roles), people: bare(w.people), next: bare(w.next), tasks: bare(w.tasks), triggers: bare(w.triggers), decisions: bare(w.decisions),
    plans: bare(w.plans), priorities: bare(w.priorities),
    ...(w.board ? { board: { ...w.board, elements: bare(w.board.elements) } } : {}),
  };
}

export function newWorld(seed: WorldSeed = {}): FakeWorld {
  return bareWorld({
    self: seed.self ?? 'jx7f4k3',
    roles: seed.roles ?? {},
    people: seed.people ?? {},
    next: { ...DEFAULT_NEXT, ...seed.next },
    ...(seed.bound ? { bound: seed.bound } : {}),
    ...(seed.brief !== undefined ? { brief: seed.brief } : {}),
    ...(seed.known ? { known: seed.known } : {}),
    ...(seed.channels ? { channels: seed.channels } : {}),
    ...(seed.open ? { open: true } : {}),
    ...(seed.board ? { board: structuredClone(seed.board) } : {}),
    ...(seed.call ? { call: seed.call } : {}),
    ...(seed.listings ? { listings: seed.listings } : {}),
    plans: {},
    priorities: {},
    tasks: {},
    triggers: {},
    decisions: {},
    sent: [],
    seq: 0,
  });
}

export function mint(w: FakeWorld, prefix: string): string {
  const n = w.next[prefix] ?? 1;
  w.next[prefix] = n + 1;
  return `${prefix}${n}`;
}

export function loadWorld(path: string, seed?: WorldSeed): FakeWorld {
  return existsSync(path) ? bareWorld(JSON.parse(readFileSync(path, 'utf8')) as FakeWorld) : newWorld(seed);
}

export const saveWorld = (path: string, w: FakeWorld): void => writeJsonAtomic(path, w);

/**
 * Runs fn holding a lock beside the world file, so two calls in flight (a
 * background command, a `&` in one line) never both load the same world and
 * save over each other. A lock older than 30s is a dead holder's.
 */
export function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  for (let waited = 0; ; waited += 20) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch { /* the holder just released it */ }
      if (waited > 20_000) throw new Error(`the fake's world is locked: ${lock}`);
      Bun.sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
