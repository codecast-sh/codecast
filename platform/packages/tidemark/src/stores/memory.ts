import type { AsOf } from '../asof';
import { systemClock, type Clock } from '../clock';
import { asCursor, type Cursor } from '../cursor';
import { mergeKinds, mergeTaskTags, type Activity, type Block } from '../log';
import type { Memory, MemoryStore } from '../memory';
import type { NewRun, RunEnd, RunStep, RunStore } from '../run';
import { sameScope, scopeKey, selects, type Partition, type Scope } from '../scope';
import type { HistoryStore } from '../store';

/**
 * The reference store: arrays in memory. Its cursor is a fixed-width string,
 * milliseconds then a six-digit sub-millisecond counter, so plain string
 * order is time order and two appends in one millisecond still differ, the
 * way microsecond timestamps do.
 */
const pad = (n: number, width: number) => String(n).padStart(width, '0');
const cursorOf = (ms: number, sub: number): Cursor => asCursor(`${pad(ms, 15)}.${pad(sub, 6)}`);
const msOf = (c: Cursor): number => Number(c.slice(0, 15));
/** The end of year 9999: instants are clamped to [1970, 9999] so the fixed width always holds. */
const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export interface MemoryStoreOptions {
  clock?: Clock;
  /** Custom id minting, for hosts and tests that need their own id shapes. */
  ids?: { activity?: () => string; block?: () => string; memory?: () => string };
}

export type InMemoryStore = HistoryStore &
  MemoryStore & {
    /** Test and migration aid: insert a leaf with no position, as legacy data has. */
    addLegacyLeaf(scope: Scope, partition: Partition, leaf: { start: Cursor; end: Cursor; content: string; count: number; createdAtMs?: number }): Block;
    /** Test aid: drop a block (merged blocks are a cache and may be rebuilt). */
    dropBlock(id: string): void;
  };

export function memoryStore(options: MemoryStoreOptions = {}): InMemoryStore {
  const clock = options.clock ?? systemClock;
  const activities: Array<Activity & { seq: number }> = [];
  const blocks: Block[] = [];
  const memories: Memory[] = [];
  let seq = 0;
  let lastMs = -1;
  let lastSub = 0;
  let nextId = 0;
  const mint = (prefix: string, custom?: () => string) => custom?.() ?? `${prefix}${++nextId}`;

  const cursorAt = (ms: number): Cursor => {
    if (!Number.isFinite(ms)) throw new Error(`cursorAt needs a finite time, got ${ms}`);
    return cursorOf(Math.min(MAX_MS, Math.max(0, Math.floor(ms))), 0);
  };
  const nowCursor = (): Cursor => {
    const ms = Math.max(0, Math.floor(clock.now()));
    lastSub = ms === lastMs ? lastSub + 1 : 1;
    lastMs = ms;
    return cursorOf(ms, lastSub);
  };
  const inLog = (scope: Scope, partition: Partition) => (row: { scope: Scope; partition: Partition }) => row.partition === partition && sameScope(row.scope, scope);
  /** As of an instant a block exists when it had ended and had been written. */
  const visible = (asOf?: AsOf) => (b: Block) => !asOf || (b.end < asOf.cursor && cursorAt(b.createdAtMs) < asOf.cursor);
  const leavesOf = (scope: Scope, partition: Partition) => blocks.filter((b) => b.level === 0 && inLog(scope, partition)(b));
  const strip = ({ seq: _seq, ...a }: Activity & { seq: number }): Activity => ({ ...a });
  const byTime = (a: Activity & { seq: number }, b: Activity & { seq: number }) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq);
  const tipOf = (scope: Scope, partition: Partition) => {
    const leaves = leavesOf(scope, partition);
    let end: Cursor | null = null;
    let lastIndex: number | null = null;
    for (const l of leaves) {
      if (end === null || l.end > end) end = l.end;
      if (l.index !== null && (lastIndex === null || l.index > lastIndex)) lastIndex = l.index;
    }
    return { end, lastIndex, unnumbered: leaves.some((l) => l.index === null) };
  };

  return {
    cursorAt,

    async append(a) {
      const at = a.at ?? nowCursor();
      const row = { ...a, id: mint('a', options.ids?.activity), at, atMs: msOf(at), seq: ++seq };
      activities.push(row);
      return strip(row);
    },

    async activities(q) {
      const kinds = q.kinds ? new Set(q.kinds) : null;
      const rows = activities
        .filter(
          (a) =>
            a.partition === q.partition &&
            selects(q.select, a.scope) &&
            (!q.after || a.at > q.after) &&
            (!q.from || a.at >= q.from) &&
            (!q.before || a.at < q.before) &&
            (!q.until || a.at <= q.until) &&
            (!q.asOf || a.at < q.asOf.cursor) &&
            (!kinds || kinds.has(a.kind)),
        )
        .sort(byTime);
      if (q.order === 'desc') rows.reverse();
      return rows.slice(0, Math.max(0, q.limit)).map(strip);
    },

    async activity(id, asOf) {
      const a = activities.find((x) => x.id === id);
      return a && (!asOf || a.at < asOf.cursor) ? strip(a) : null;
    },

    async search(q) {
      const needle = q.text.toLowerCase();
      const kinds = q.kinds ? new Set(q.kinds) : null;
      return activities
        .filter((a) => a.partition === q.partition && selects(q.select, a.scope) && (!q.asOf || a.at < q.asOf.cursor) && (!q.until || a.at <= q.until) && (!kinds || kinds.has(a.kind)) && a.summary.toLowerCase().includes(needle))
        .sort(byTime)
        .reverse()
        .slice(0, Math.max(0, q.limit))
        .map(strip);
    },

    async backlog(q) {
      const counts = new Map<string, { scope: Scope; partition: Partition; count: number }>();
      const tips = new Map<string, Cursor | null>();
      for (const a of activities) {
        if (q.skip.includes(a.scope.type) || !(a.at < q.olderThan)) continue;
        const key = `${a.partition}\u0000${scopeKey(a.scope)}`;
        if (!tips.has(key)) tips.set(key, tipOf(a.scope, a.partition).end);
        const tip = tips.get(key)!;
        if (tip !== null && !(a.at > tip)) continue;
        const seen = counts.get(key) ?? { scope: a.scope, partition: a.partition, count: 0 };
        seen.count++;
        counts.set(key, seen);
      }
      return [...counts.values()].filter((g) => g.count >= q.minCount);
    },

    async leafTip(scope, partition) {
      return tipOf(scope, partition);
    },

    async appendLeaf(scope, partition, leaf, expectedLastIndex) {
      const tip = tipOf(scope, partition);
      if (tip.unnumbered || tip.lastIndex !== expectedLastIndex) return null;
      const block: Block = {
        id: mint('b', options.ids?.block),
        scope,
        partition,
        level: 0,
        index: (expectedLastIndex ?? -1) + 1,
        start: leaf.start,
        end: leaf.end,
        startMs: msOf(leaf.start),
        endMs: msOf(leaf.end),
        content: leaf.content,
        count: leaf.count,
        kinds: leaf.kinds,
        tasks: leaf.tasks,
        createdAtMs: clock.now(),
      };
      blocks.push(block);
      return { ...block };
    },

    async putBlock(scope, partition, at, content, left, right) {
      const mine = inLog(scope, partition);
      const l = blocks.find((b) => b.id === left && mine(b));
      const r = blocks.find((b) => b.id === right && mine(b));
      if (!l || !r || at.level < 1) return null;
      if (l.level !== at.level - 1 || l.index !== at.index * 2 || r.level !== at.level - 1 || r.index !== at.index * 2 + 1) return null;
      if (blocks.some((b) => mine(b) && b.level === at.level && b.index === at.index)) return null;
      const block: Block = {
        id: mint('b', options.ids?.block),
        scope,
        partition,
        level: at.level,
        index: at.index,
        start: l.start,
        end: r.end,
        startMs: l.startMs,
        endMs: r.endMs,
        content,
        count: l.count + r.count,
        kinds: mergeKinds([l.kinds, r.kinds]),
        tasks: mergeTaskTags([l.tasks, r.tasks]),
        createdAtMs: clock.now(),
      };
      blocks.push(block);
      return { ...block };
    },

    async numberLegacyLeaves(scope, partition) {
      const leaves = leavesOf(scope, partition);
      const better = (b: Block, a: Block) =>
        b.start < a.start || b.end > a.end || b.content.length > a.content.length || (b.content.length === a.content.length && (b.createdAtMs > a.createdAtMs || (b.createdAtMs === a.createdAtMs && b.id > a.id)));
      const doomed = leaves.filter((a) => a.index === null && leaves.some((b) => b.id !== a.id && b.start <= a.start && b.end >= a.end && better(b, a)));
      for (const d of doomed) blocks.splice(blocks.indexOf(d), 1);
      const rest = leavesOf(scope, partition)
        .filter((l) => l.index === null)
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : a.id < b.id ? -1 : 1));
      let next = (tipOf(scope, partition).lastIndex ?? -1) + 1;
      for (const l of rest) l.index = next++;
      return { dropped: doomed.length, numbered: rest.length };
    },

    async scopesNeedingMerges(q) {
      const counts = new Map<string, { scope: Scope; partition: Partition; count: number }>();
      for (const b of blocks) {
        if (b.level !== 0 || b.index === null || !(b.end < q.endedBefore) || q.skip.includes(b.scope.type)) continue;
        const key = `${b.partition}\u0000${scopeKey(b.scope)}`;
        const seen = counts.get(key) ?? { scope: b.scope, partition: b.partition, count: 0 };
        seen.count++;
        counts.set(key, seen);
      }
      return [...counts.values()]
        .filter((g) => g.count > q.minLeaves)
        .sort((a, b) => b.count - a.count)
        .map(({ scope, partition }) => ({ scope, partition }));
    },

    async treeIndex(scope, partition, q) {
      return blocks
        .filter((b) => inLog(scope, partition)(b) && (!q.endedBefore || b.end < q.endedBefore) && visible(q.asOf)(b))
        .map((b) => ({ id: b.id, level: b.level, index: b.index, startMs: b.startMs, endMs: b.endMs }));
    },

    async blocks(ids, asOf) {
      const want = new Set(ids);
      return blocks.filter((b) => want.has(b.id) && visible(asOf)(b)).map((b) => ({ ...b }));
    },

    async block(id, asOf) {
      const b = blocks.find((x) => x.id === id);
      return b && visible(asOf)(b) ? { ...b } : null;
    },

    async blockAt(scope, partition, at, asOf) {
      const b = blocks.find((x) => inLog(scope, partition)(x) && x.level === at.level && x.index === at.index);
      return b && visible(asOf)(b) ? { ...b } : null;
    },

    async leaves(q) {
      return blocks
        .filter((b) => b.level === 0 && b.partition === q.partition && selects(q.select, b.scope) && b.end < q.endedBefore && visible(q.asOf)(b))
        .sort((a, b) => (a.start > b.start ? -1 : a.start < b.start ? 1 : 0))
        .slice(0, Math.max(0, q.limit))
        .map((b) => ({ ...b }));
    },

    async leafHolding(a, asOf) {
      const b = blocks.find((x) => x.level === 0 && x.index !== null && inLog(a.scope, a.partition)(x) && x.start <= a.at && a.at <= x.end);
      return b && visible(asOf)(b) ? { ...b } : null;
    },

    async activitiesIn(leaf, asOf) {
      return activities
        .filter((a) => inLog(leaf.scope, leaf.partition)(a) && a.at >= leaf.start && a.at <= leaf.end && (!asOf || a.at < asOf.cursor))
        .sort(byTime)
        .map(strip);
    },

    addLegacyLeaf(scope, partition, leaf) {
      const block: Block = {
        id: mint('b', options.ids?.block),
        scope,
        partition,
        level: 0,
        index: null,
        start: leaf.start,
        end: leaf.end,
        startMs: msOf(leaf.start),
        endMs: msOf(leaf.end),
        content: leaf.content,
        count: leaf.count,
        createdAtMs: leaf.createdAtMs ?? clock.now(),
      };
      blocks.push(block);
      return { ...block };
    },

    dropBlock(id) {
      const at = blocks.findIndex((b) => b.id === id);
      if (at >= 0) blocks.splice(at, 1);
    },

    async list(q) {
      const keys = q.scopes.map(scopeKey);
      return memories
        .filter((m) => m.agentId === q.agentId && m.partition === q.partition && keys.includes(scopeKey(m.scope)) && !m.archived && m.createdAtMs < q.at && (m.expiresAtMs === undefined || m.expiresAtMs > q.at))
        .sort((a, b) => keys.indexOf(scopeKey(a.scope)) - keys.indexOf(scopeKey(b.scope)) || a.seq - b.seq)
        .map((m) => ({ ...m }));
    },

    async write(m) {
      const peers = memories.filter((x) => x.agentId === m.agentId && x.partition === m.partition && sameScope(x.scope, m.scope));
      const memory: Memory = {
        id: mint('m', options.ids?.memory),
        agentId: m.agentId,
        scope: m.scope,
        partition: m.partition,
        seq: peers.reduce((top, x) => Math.max(top, x.seq), 0) + 1,
        header: m.header,
        content: m.content,
        createdAtMs: m.createdAtMs ?? clock.now(),
        expiresAtMs: m.expiresAtMs,
        archived: false,
      };
      memories.push(memory);
      return { ...memory };
    },

    async edit(id, patch) {
      const m = memories.find((x) => x.id === id);
      if (!m) throw new Error(`No memory ${id}`);
      if (patch.header !== undefined) m.header = patch.header;
      if (patch.content !== undefined) m.content = patch.content;
      if (patch.archived !== undefined) m.archived = patch.archived;
      if (patch.expiresAtMs !== undefined) m.expiresAtMs = patch.expiresAtMs ?? undefined;
    },
  };
}

/** Runs in memory, for tests and examples. `cancel` marks one cancelled. */
export function memoryRunStore(): RunStore & { runs: Map<string, NewRun & { steps: RunStep[]; end?: RunEnd; cancelled: boolean }>; cancel(runId: string): void } {
  const runs = new Map<string, NewRun & { steps: RunStep[]; end?: RunEnd; cancelled: boolean }>();
  const get = (runId: string) => runs.get(runId) ?? (() => { throw new Error(`No run ${runId}`); })();
  return {
    runs,
    cancel: (runId) => void (get(runId).cancelled = true),
    async begin(r) {
      runs.set(r.runId, { ...r, steps: [], cancelled: false });
    },
    async step(runId, s) {
      get(runId).steps.push(s);
    },
    async finish(runId, end) {
      get(runId).end = end;
    },
    async isCancelled(runId) {
      return runs.get(runId)?.cancelled ?? false;
    },
  };
}
