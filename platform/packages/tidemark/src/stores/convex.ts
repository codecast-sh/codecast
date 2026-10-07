import { defineTable } from 'convex/server';
import { v } from 'convex/values';

import type { AsOf } from '../asof';
import { systemClock, type Clock } from '../clock';
import { asCursor, type Cursor } from '../cursor';
import { mergeKinds, mergeTaskTags, type Activity, type Block, type NewLeaf } from '../log';
import type { Memory, MemoryStore } from '../memory';
import { scopeKey, type Partition, type Scope, type ScopeSelector } from '../scope';
import type { ActivityQuery, HistoryStore } from '../store';
import type { TreeBlock } from '../tree';

/**
 * A Convex store. Three parts, because Convex splits who may touch the
 * database:
 *
 * - `convexTables(prefix)`: the tables, spread into the host's `defineSchema`.
 * - `convexStore(db)`: the store over a query's or mutation's `ctx.db`. Every
 *   call runs inside that one function, so a mutation's reads and writes are
 *   one serializable transaction: two racing `appendLeaf`s for one position,
 *   or two `putBlock`s for one slot, conflict and one retries to a refusal.
 *   That is what makes a slot unique; there is no unique index in Convex.
 * - `remoteStore(transport)`: the same store from an action, which has no
 *   `db`. Each call is forwarded as `(op, JSON args)` to one internal query
 *   (reads) or one internal mutation (writes) the host registers with
 *   `serveStoreOp`. Arguments and results travel as JSON text, so host data
 *   with keys Convex values refuse (`$x`, `_x`) round-trips untouched.
 *
 * The cursor is the memory store's: fifteen digits of milliseconds, a dot,
 * six digits of sub-millisecond counter, so string order is time order and
 * two appends in one millisecond still differ. Rows sharing a cursor keep
 * insertion order through the index's `_creationTime` tiebreak.
 * `_creationTime` itself is never the cursor: a host backdates imports.
 */

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const cursorOf = (ms: number, sub: number): Cursor => asCursor(`${pad(ms, 15)}.${pad(sub, 6)}`);
const msOf = (c: string): number => Number(c.slice(0, 15));
const subOf = (c: string): number => Number(c.slice(16));
/** The end of year 9999: instants clamp to [1970, 9999] so the fixed width always holds. */
const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** The cursor of an instant. Pure, so an action mints the same cursors the database stores. */
export function convexCursorAt(ms: number): Cursor {
  if (!Number.isFinite(ms)) throw new Error(`cursorAt needs a finite time, got ${ms}`);
  return cursorOf(Math.min(MAX_MS, Math.max(0, Math.floor(ms))), 0);
}

const PREFIX = /^[a-z][a-z0-9_]{0,40}$/;

export interface ConvexTableNames {
  activities: string;
  blocks: string;
  logs: string;
  memories: string;
}

export function convexTableNames(prefix = 'tidemark_'): ConvexTableNames {
  if (!PREFIX.test(prefix)) throw new Error(`Invalid table prefix "${prefix}"`);
  return { activities: `${prefix}activities`, blocks: `${prefix}blocks`, logs: `${prefix}logs`, memories: `${prefix}memories` };
}

const scopeFields = { partition: v.string(), scope_key: v.string(), scope_type: v.string(), scope_id: v.string() };

/** The store's tables, to spread into `defineSchema({ ...convexTables(), … })`. */
export function convexTables(prefix = 'tidemark_') {
  const t = convexTableNames(prefix);
  return {
    [t.activities]: defineTable({
      ...scopeFields,
      kind: v.string(),
      summary: v.string(),
      at: v.string(),
      at_ms: v.number(),
      /** data, actor, ref, tasks and focusedTaskId as JSON text. */
      extra: v.optional(v.string()),
    })
      .index('by_scope_at', ['partition', 'scope_key', 'at'])
      .index('by_type_at', ['partition', 'scope_type', 'at'])
      .index('by_partition_at', ['partition', 'at']),
    [t.blocks]: defineTable({
      ...scopeFields,
      level: v.number(),
      index: v.union(v.number(), v.null()),
      start: v.string(),
      end: v.string(),
      start_ms: v.number(),
      end_ms: v.number(),
      content: v.string(),
      count: v.number(),
      kinds: v.optional(v.array(v.string())),
      tasks: v.optional(v.string()),
      created_at_ms: v.number(),
    })
      .index('by_slot', ['partition', 'scope_key', 'level', 'index'])
      .index('by_scope_start', ['partition', 'scope_key', 'level', 'start'])
      .index('by_scope_end', ['partition', 'scope_key', 'level', 'end'])
      .index('by_type_start', ['partition', 'scope_type', 'level', 'start'])
      .index('by_partition_start', ['partition', 'level', 'start']),
    /**
     * One row per log, so a compression pass reads only the logs with work
     * and never scans activities or leaves to find them: `unsummarized`
     * counts activities newer than the newest leaf (`tip_end`), `leaves` the
     * numbered leaves, `merged` the merged blocks, and `needs_merges` is set
     * while fewer blocks exist than the leaves can make.
     */
    [t.logs]: defineTable({
      ...scopeFields,
      unsummarized: v.number(),
      tip_end: v.union(v.string(), v.null()),
      leaves: v.number(),
      merged: v.number(),
      needs_merges: v.boolean(),
    })
      .index('by_log', ['partition', 'scope_key'])
      .index('by_unsummarized', ['unsummarized'])
      .index('by_needs_merges', ['needs_merges', 'leaves']),
    [t.memories]: defineTable({
      ...scopeFields,
      agent_id: v.string(),
      seq: v.number(),
      header: v.string(),
      content: v.string(),
      created_at_ms: v.number(),
      expires_at_ms: v.optional(v.number()),
      archived: v.boolean(),
    }).index('by_agent_scope', ['agent_id', 'partition', 'scope_key', 'seq']),
  };
}

export interface ConvexStoreOptions {
  tablePrefix?: string;
  /** The clock `append` stamps with when no `at` is given. Inside Convex, Date.now() is the function's start. */
  clock?: Clock;
}

export type ConvexHistoryStore = HistoryStore &
  MemoryStore & {
    /** Test and migration aid: insert a leaf with no position, as legacy data has. */
    addLegacyLeaf(scope: Scope, partition: Partition, leaf: { start: Cursor; end: Cursor; content: string; count: number; createdAtMs?: number }): Promise<Block>;
    /**
     * Delete a log: up to `limit` of its activities and blocks per call, its
     * log row last. `done` once nothing of it is left; call again until then.
     * For a host whose scope is gone (a deleted conversation).
     */
    dropLog(scope: Scope, partition: Partition, limit: number): Promise<{ deleted: number; done: boolean }>;
  };

/**
 * The part of a Convex `ctx.db` the store uses, as methods so a reader or a
 * writer of any app's data model, from any Convex version, fits. Writes need
 * a mutation's db.
 */
export interface ConvexDb {
  query(table: string): any;
  get(id: any): Promise<any>;
  normalizeId(table: string, id: string): any;
  insert?(table: string, value: any): Promise<any>;
  patch?(id: any, value: any): Promise<void>;
  delete?(id: any): Promise<void>;
}

type Db = ConvexDb;
type Writer = Required<ConvexDb>;
type Row = Record<string, any> & { _id: string; _creationTime: number };

/** Above this a `limit` reads the whole range; Convex bounds a function's reads anyway. */
const TAKE_ALL = 1_000_000;
/** Logs one `backlog` or `scopesNeedingMerges` call returns at most: the largest first, the rest on the next pass. */
export const LOGS_PER_CALL = 100;
/** Most activities one log's backlog count reads; a larger backlog reports this many. */
export const COUNT_CAP = 500;
/**
 * Most activities one `backlog` call reads across all its logs, so a call
 * stays inside Convex's per-function read limits whatever the hosts store in
 * `data`. Logs past it wait for a later pass.
 */
export const BACKLOG_READS = 2000;

/** How many merged blocks `leaves` leaves make when every one is built. */
const completeBlocks = (leaves: number): number => {
  let n = 0;
  for (let width = 2; width <= leaves; width *= 2) n += Math.floor(leaves / width);
  return n;
};
/** Most rows one search reads before it gives up looking (newest first). */
export const SEARCH_SCAN_LIMIT = 5000;

const parse = <T>(text: string | undefined): T | undefined => (text === undefined ? undefined : (JSON.parse(text) as T));

function toActivity(r: Row): Activity {
  const extra = parse<Pick<Activity, 'data' | 'actor' | 'ref' | 'tasks' | 'focusedTaskId'>>(r.extra) ?? {};
  return { id: r._id, scope: { type: r.scope_type, id: r.scope_id }, partition: r.partition, kind: r.kind, summary: r.summary, ...extra, at: asCursor(r.at), atMs: r.at_ms };
}

function toBlock(r: Row): Block {
  return {
    id: r._id,
    scope: { type: r.scope_type, id: r.scope_id },
    partition: r.partition,
    level: r.level,
    index: r.index,
    start: asCursor(r.start),
    end: asCursor(r.end),
    startMs: r.start_ms,
    endMs: r.end_ms,
    content: r.content,
    count: r.count,
    ...(r.kinds ? { kinds: r.kinds } : {}),
    ...(r.tasks ? { tasks: parse(r.tasks) } : {}),
    createdAtMs: r.created_at_ms,
  };
}

function toMemory(r: Row): Memory {
  return {
    id: r._id,
    agentId: r.agent_id,
    scope: { type: r.scope_type, id: r.scope_id },
    partition: r.partition,
    seq: r.seq,
    header: r.header,
    content: r.content,
    createdAtMs: r.created_at_ms,
    ...(r.expires_at_ms !== undefined ? { expiresAtMs: r.expires_at_ms } : {}),
    archived: r.archived,
  };
}

interface Bound {
  c: string;
  incl: boolean;
}

/** The tightest lower and upper bound of several, exclusive winning a tie. */
function tightest(lows: Array<Bound | null>, highs: Array<Bound | null>): { lo: Bound | null; hi: Bound | null } {
  let lo: Bound | null = null;
  for (const b of lows) if (b && (!lo || b.c > lo.c || (b.c === lo.c && !b.incl))) lo = b;
  let hi: Bound | null = null;
  for (const b of highs) if (b && (!hi || b.c < hi.c || (b.c === hi.c && !b.incl))) hi = b;
  return { lo, hi };
}

const ranged = (q: any, field: string, lo: Bound | null, hi: Bound | null) => {
  let r = q;
  if (lo) r = lo.incl ? r.gte(field, lo.c) : r.gt(field, lo.c);
  if (hi) r = hi.incl ? r.lte(field, hi.c) : r.lt(field, hi.c);
  return r;
};

const take = async (query: any, limit: number): Promise<Row[]> => (limit <= 0 ? [] : limit >= TAKE_ALL ? query.collect() : query.take(Math.floor(limit)));

/** The store over one Convex function's `ctx.db`. Writes need a mutation's db. */
export function convexStore(db: Db, options: ConvexStoreOptions = {}): ConvexHistoryStore {
  const t = convexTableNames(options.tablePrefix);
  const clock = options.clock ?? systemClock;
  const w = () => db as Writer;
  const q = (table: string) => db.query(table);
  const get = async (table: string, id: string): Promise<Row | null> => {
    if (typeof id !== 'string') return null;
    const normal = db.normalizeId(table, id);
    return normal ? ((await db.get(normal)) as Row | null) : null;
  };
  const scopeOf = (scope: Scope, partition: Partition) => ({ partition, scope_key: scopeKey(scope), scope_type: scope.type, scope_id: scope.id });
  /** As of an instant a block exists when it had ended and had been written. */
  const visible = (asOf?: AsOf | null) => (r: Row) => !asOf || (r.end < asOf.cursor && convexCursorAt(r.created_at_ms) < asOf.cursor);

  /** Activities of one index, in the given order, bounded and filtered. */
  const scan = (index: string, eqs: Array<[string, unknown]>, lo: Bound | null, hi: Bound | null, order: 'asc' | 'desc', filter?: (f: any) => any) => {
    let query = q(t.activities)
      .withIndex(index, (ix: any) => ranged(eqs.reduce((acc, [k, val]) => acc.eq(k, val), ix), 'at', lo, hi))
      .order(order);
    if (filter) query = query.filter(filter);
    return query;
  };

  const byTime = (order: 'asc' | 'desc') => (a: Row, b: Row) => {
    const d = a.at < b.at ? -1 : a.at > b.at ? 1 : a._creationTime - b._creationTime;
    return order === 'asc' ? d : -d;
  };

  /** Rows of a selector, ordered, limited. anyOf merges one ordered read per scope. */
  async function select(select: ScopeSelector, partition: Partition, lo: Bound | null, hi: Bound | null, order: 'asc' | 'desc', limit: number, filter?: (f: any) => any): Promise<Row[]> {
    if (limit <= 0) return [];
    if ('scope' in select) return take(scan('by_scope_at', [['partition', partition], ['scope_key', scopeKey(select.scope)]], lo, hi, order, filter), limit);
    if ('anyOf' in select) {
      const keys = [...new Set(select.anyOf.map(scopeKey))];
      const parts = await Promise.all(keys.map((k) => take(scan('by_scope_at', [['partition', partition], ['scope_key', k]], lo, hi, order, filter), limit)));
      return parts.flat().sort(byTime(order)).slice(0, limit);
    }
    if ('types' in select) {
      const types = [...new Set(select.types)];
      const parts = await Promise.all(types.map((type) => take(scan('by_type_at', [['partition', partition], ['scope_type', type]], lo, hi, order, filter), limit)));
      return parts.flat().sort(byTime(order)).slice(0, limit);
    }
    const except = select.except ?? [];
    const both = (f: any) => {
      const walls = except.map((type) => f.neq(f.field('scope_type'), type));
      const all = filter ? [...walls, filter(f)] : walls;
      return all.length === 0 ? true : all.length === 1 ? all[0] : f.and(...all);
    };
    return take(scan('by_partition_at', [['partition', partition]], lo, hi, order, except.length > 0 || filter ? both : undefined), limit);
  }

  const kindFilter = (kinds?: readonly string[] | null) => (kinds ? (f: any) => f.or(...kinds.map((k) => f.eq(f.field('kind'), k))) : undefined);

  const logOf = async (scope: Scope, partition: Partition): Promise<Row | null> =>
    q(t.logs)
      .withIndex('by_log', (ix: any) => ix.eq('partition', partition).eq('scope_key', scopeKey(scope)))
      .unique();

  const leafRows = (scope: Scope, partition: Partition) => q(t.blocks).withIndex('by_slot', (ix: any) => ix.eq('partition', partition).eq('scope_key', scopeKey(scope)).eq('level', 0));

  const tipOf = async (scope: Scope, partition: Partition) => {
    const newestEnd: Row | null = await q(t.blocks)
      .withIndex('by_scope_end', (ix: any) => ix.eq('partition', partition).eq('scope_key', scopeKey(scope)).eq('level', 0))
      .order('desc')
      .first();
    const lastNumbered: Row | null = await leafRows(scope, partition).order('desc').first();
    const unnumbered: Row | null = await q(t.blocks)
      .withIndex('by_slot', (ix: any) => ix.eq('partition', partition).eq('scope_key', scopeKey(scope)).eq('level', 0).eq('index', null))
      .first();
    return { end: newestEnd ? asCursor(newestEnd.end) : null, lastIndex: lastNumbered && lastNumbered.index !== null ? (lastNumbered.index as number) : null, unnumbered: unnumbered !== null };
  };

  /**
   * Recount a log's row from its blocks and activities, the backlog up to
   * COUNT_CAP. Only the rare paths use it (legacy leaves); the hot ones
   * (append, appendLeaf, putBlock) move the counts by what they wrote.
   */
  async function settleLog(scope: Scope, partition: Partition): Promise<void> {
    const log = await logOf(scope, partition);
    const tip = await tipOf(scope, partition);
    const newer = await take(scan('by_scope_at', [['partition', partition], ['scope_key', scopeKey(scope)]], tip.end ? { c: tip.end, incl: false } : null, null, 'asc'), COUNT_CAP);
    const leaves = tip.lastIndex === null ? 0 : tip.lastIndex + 1;
    const merged = log?.merged ?? 0;
    const fields = { unsummarized: newer.length + (tip.unnumbered ? 1 : 0), tip_end: tip.end, leaves, merged, needs_merges: merged < completeBlocks(leaves) };
    if (log) await w().patch(log._id, fields);
    else await w().insert(t.logs, { ...scopeOf(scope, partition), ...fields });
  }

  const cursorAt = convexCursorAt;

  return {
    cursorAt,

    async append(a) {
      const scope = scopeOf(a.scope, a.partition);
      let at: string = a.at ?? '';
      if (!at) {
        const ms = Math.min(MAX_MS, Math.max(0, Math.floor(clock.now())));
        // The newest row of this log stamped in this millisecond. Reading it
        // puts the range in the mutation's read set, so two racing appends in
        // one millisecond conflict and the retry takes the next counter.
        const last: Row | null = await scan('by_scope_at', [['partition', a.partition], ['scope_key', scope.scope_key]], { c: cursorOf(ms, 0), incl: true }, { c: cursorOf(ms + 1, 0), incl: false }, 'desc').first();
        at = cursorOf(ms, last ? subOf(last.at) + 1 : 1);
      }
      const extra: Record<string, unknown> = {};
      if (a.data !== undefined) extra.data = a.data;
      if (a.actor !== undefined) extra.actor = a.actor;
      if (a.ref !== undefined) extra.ref = a.ref;
      if (a.tasks !== undefined) extra.tasks = a.tasks;
      if (a.focusedTaskId !== undefined) extra.focusedTaskId = a.focusedTaskId;
      const id = await w().insert(t.activities, {
        ...scope,
        kind: a.kind,
        summary: a.summary,
        at,
        at_ms: msOf(at),
        ...(Object.keys(extra).length > 0 ? { extra: JSON.stringify(extra) } : {}),
      });
      const log = await logOf(a.scope, a.partition);
      if (!log) await w().insert(t.logs, { ...scope, unsummarized: 1, tip_end: null, leaves: 0, merged: 0, needs_merges: false });
      // A row backdated to before the newest leaf is never summarized, so it is not counted.
      else if (log.tip_end === null || at > log.tip_end) await w().patch(log._id, { unsummarized: log.unsummarized + 1 });
      return toActivity((await db.get(id)) as Row);
    },

    async activities(query: ActivityQuery) {
      if (query.kinds && query.kinds.length === 0) return [];
      const { lo, hi } = tightest(
        [query.after ? { c: query.after, incl: false } : null, query.from ? { c: query.from, incl: true } : null],
        [query.before ? { c: query.before, incl: false } : null, query.until ? { c: query.until, incl: true } : null, query.asOf ? { c: query.asOf.cursor, incl: false } : null],
      );
      if (lo && hi && (lo.c > hi.c || (lo.c === hi.c && !(lo.incl && hi.incl)))) return [];
      return (await select(query.select, query.partition, lo, hi, query.order, query.limit, kindFilter(query.kinds))).map(toActivity);
    },

    async activity(id, asOf) {
      const r = await get(t.activities, id);
      return r && (!asOf || r.at < asOf.cursor) ? toActivity(r) : null;
    },

    async search(s) {
      if (s.kinds && s.kinds.length === 0) return [];
      const needle = s.text.toLowerCase();
      const { hi } = tightest([], [s.until ? { c: s.until, incl: true } : null, s.asOf ? { c: s.asOf.cursor, incl: false } : null]);
      // Convex search indexes match whole tokens; the contract asks for a
      // case-blind substring, so this reads newest first and stops at the
      // limit or after SEARCH_SCAN_LIMIT rows.
      const rows = await select(s.select, s.partition, null, hi, 'desc', SEARCH_SCAN_LIMIT, kindFilter(s.kinds));
      return rows
        .filter((r) => String(r.summary).toLowerCase().includes(needle))
        .slice(0, Math.max(0, s.limit))
        .map(toActivity);
    },

    async backlog(b) {
      const out: Array<{ scope: Scope; partition: Partition; count: number }> = [];
      // Only logs that could qualify, the largest backlogs first and at most
      // LOGS_PER_CALL of them, so one call's reads stay bounded however many
      // logs exist; the rest are read on a later pass.
      const candidates: Row[] = await q(t.logs)
        .withIndex('by_unsummarized', (ix: any) => ix.gte('unsummarized', Math.max(1, b.minCount)))
        .order('desc')
        .filter((f: any) => (b.skip.length === 0 ? true : f.and(...b.skip.map((type) => f.neq(f.field('scope_type'), type)))))
        .take(LOGS_PER_CALL);
      let reads = BACKLOG_READS;
      for (const log of candidates) {
        if (reads <= 0) break;
        const rows = await take(
          scan('by_scope_at', [['partition', log.partition], ['scope_key', log.scope_key]], log.tip_end ? { c: log.tip_end, incl: false } : null, { c: b.olderThan, incl: false }, 'asc'),
          Math.min(COUNT_CAP, reads),
        );
        reads -= rows.length;
        if (rows.length >= b.minCount && rows.length > 0) out.push({ scope: { type: log.scope_type, id: log.scope_id }, partition: log.partition, count: rows.length });
      }
      return out;
    },

    leafTip: tipOf,

    async appendLeaf(scope, partition, leaf: NewLeaf, expectedLastIndex) {
      const tip = await tipOf(scope, partition);
      if (tip.unnumbered || tip.lastIndex !== (expectedLastIndex ?? null)) return null;
      const id = await w().insert(t.blocks, {
        ...scopeOf(scope, partition),
        level: 0,
        index: (expectedLastIndex ?? -1) + 1,
        start: leaf.start,
        end: leaf.end,
        start_ms: msOf(leaf.start),
        end_ms: msOf(leaf.end),
        content: leaf.content,
        count: leaf.count,
        ...(leaf.kinds ? { kinds: leaf.kinds } : {}),
        ...(leaf.tasks ? { tasks: JSON.stringify(leaf.tasks) } : {}),
        created_at_ms: clock.now(),
      });
      // The leaf holds `count` of the rows that were newer than the old tip.
      const log = await logOf(scope, partition);
      const leaves = (expectedLastIndex ?? -1) + 2;
      const merged = log?.merged ?? 0;
      const fields = { unsummarized: Math.max(0, (log?.unsummarized ?? 0) - leaf.count), tip_end: log?.tip_end && log.tip_end > leaf.end ? log.tip_end : leaf.end, leaves, merged, needs_merges: merged < completeBlocks(leaves) };
      if (log) await w().patch(log._id, fields);
      else await w().insert(t.logs, { ...scopeOf(scope, partition), ...fields });
      return toBlock((await db.get(id)) as Row);
    },

    async putBlock(scope, partition, at: TreeBlock, content, left, right) {
      if (at.level < 1) return null;
      const key = scopeKey(scope);
      const [l, r] = await Promise.all([get(t.blocks, left), get(t.blocks, right)]);
      const mine = (b: Row | null): b is Row => !!b && b.partition === partition && b.scope_key === key;
      if (!mine(l) || !mine(r)) return null;
      if (l.level !== at.level - 1 || l.index !== at.index * 2 || r.level !== at.level - 1 || r.index !== at.index * 2 + 1) return null;
      const taken = await q(t.blocks)
        .withIndex('by_slot', (ix: any) => ix.eq('partition', partition).eq('scope_key', key).eq('level', at.level).eq('index', at.index))
        .first();
      if (taken) return null;
      const kinds = mergeKinds([l.kinds, r.kinds]);
      const tasks = mergeTaskTags([parse(l.tasks), parse(r.tasks)]);
      const id = await w().insert(t.blocks, {
        ...scopeOf(scope, partition),
        level: at.level,
        index: at.index,
        start: l.start,
        end: r.end,
        start_ms: l.start_ms,
        end_ms: r.end_ms,
        content,
        count: l.count + r.count,
        ...(kinds ? { kinds } : {}),
        ...(tasks ? { tasks: JSON.stringify(tasks) } : {}),
        created_at_ms: clock.now(),
      });
      const log = await logOf(scope, partition);
      if (log) await w().patch(log._id, { merged: log.merged + 1, needs_merges: log.merged + 1 < completeBlocks(log.leaves) });
      return toBlock((await db.get(id)) as Row);
    },

    async numberLegacyLeaves(scope, partition) {
      const leaves: Row[] = await leafRows(scope, partition).collect();
      const better = (b: Row, a: Row) =>
        b.start < a.start || b.end > a.end || b.content.length > a.content.length || (b.content.length === a.content.length && (b.created_at_ms > a.created_at_ms || (b.created_at_ms === a.created_at_ms && b._id > a._id)));
      const doomed = leaves.filter((a) => a.index === null && leaves.some((b) => b._id !== a._id && b.start <= a.start && b.end >= a.end && better(b, a)));
      for (const d of doomed) await w().delete(d._id);
      const gone = new Set(doomed.map((d) => d._id));
      const rest = leaves
        .filter((l) => l.index === null && !gone.has(l._id))
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : a._id < b._id ? -1 : 1));
      const last = leaves.filter((l) => l.index !== null).reduce<number>((top, l) => Math.max(top, l.index), -1);
      let next = last + 1;
      for (const l of rest) await w().patch(l._id , { index: next++ });
      await settleLog(scope, partition);
      return { dropped: doomed.length, numbered: rest.length };
    },

    async scopesNeedingMerges(m) {
      // Logs with a merge left to build, the most leaves first, at most
      // LOGS_PER_CALL. Each count reads only enough leaves to pass the minimum.
      const long: Row[] = await q(t.logs)
        .withIndex('by_needs_merges', (ix: any) => ix.eq('needs_merges', true).gt('leaves', m.minLeaves))
        .order('desc')
        .filter((f: any) => (m.skip.length === 0 ? true : f.and(...m.skip.map((type) => f.neq(f.field('scope_type'), type)))))
        .take(LOGS_PER_CALL);
      const out: Array<{ scope: Scope; partition: Partition }> = [];
      for (const log of long) {
        const ended: Row[] = await q(t.blocks)
          .withIndex('by_scope_end', (ix: any) => ix.eq('partition', log.partition).eq('scope_key', log.scope_key).eq('level', 0).lt('end', m.endedBefore))
          .filter((f: any) => f.neq(f.field('index'), null))
          .take(m.minLeaves + 1);
        if (ended.length > m.minLeaves) out.push({ scope: { type: log.scope_type, id: log.scope_id }, partition: log.partition });
      }
      return out;
    },

    async treeIndex(scope, partition, ti) {
      const rows: Row[] = await q(t.blocks)
        .withIndex('by_slot', (ix: any) => ix.eq('partition', partition).eq('scope_key', scopeKey(scope)))
        .collect();
      return rows.filter((b) => (!ti.endedBefore || b.end < ti.endedBefore) && visible(ti.asOf)(b)).map((b) => ({ id: b._id, level: b.level, index: b.index, startMs: b.start_ms, endMs: b.end_ms }));
    },

    async blocks(ids, asOf) {
      const rows = await Promise.all([...new Set(ids)].map((id) => get(t.blocks, id)));
      return rows.filter((r): r is Row => r !== null && visible(asOf)(r)).map(toBlock);
    },

    async block(id, asOf) {
      const r = await get(t.blocks, id);
      return r && visible(asOf)(r) ? toBlock(r) : null;
    },

    async blockAt(scope, partition, at, asOf) {
      const r: Row | null = await q(t.blocks)
        .withIndex('by_slot', (ix: any) => ix.eq('partition', partition).eq('scope_key', scopeKey(scope)).eq('level', at.level).eq('index', at.index))
        .first();
      return r && visible(asOf)(r) ? toBlock(r) : null;
    },

    async leaves(l) {
      if (l.limit <= 0) return [];
      // A leaf counts once it had ended and, as of an instant, had been written:
      // a millisecond stamp is written before cursor c when it is below
      // c's millisecond, or at it when c sits later inside that millisecond.
      const writtenBy = l.asOf ? msOf(l.asOf.cursor) + (subOf(l.asOf.cursor) > 0 ? 1 : 0) : null;
      const ended = (f: any) =>
        writtenBy === null
          ? f.lt(f.field('end'), l.endedBefore)
          : f.and(f.lt(f.field('end'), l.endedBefore), f.lt(f.field('end'), l.asOf!.cursor), f.lt(f.field('created_at_ms'), writtenBy));
      const read = (index: string, eqs: Array<[string, unknown]>) =>
        take(
          q(t.blocks)
            .withIndex(index, (ix: any) => eqs.reduce((acc, [k, val]) => acc.eq(k, val), ix))
            .order('desc')
            .filter(ended),
          l.limit,
        );
      const newestFirst = (rows: Row[]) => rows.sort((a, b) => (a.start > b.start ? -1 : a.start < b.start ? 1 : 0)).slice(0, l.limit);
      const s = l.select;
      let rows: Row[];
      if ('scope' in s) rows = await read('by_scope_start', [['partition', l.partition], ['scope_key', scopeKey(s.scope)], ['level', 0]]);
      else if ('anyOf' in s) rows = newestFirst((await Promise.all([...new Set(s.anyOf.map(scopeKey))].map((k) => read('by_scope_start', [['partition', l.partition], ['scope_key', k], ['level', 0]])))).flat());
      else if ('types' in s) rows = newestFirst((await Promise.all([...new Set(s.types)].map((type) => read('by_type_start', [['partition', l.partition], ['scope_type', type], ['level', 0]])))).flat());
      else {
        const except = s.except ?? [];
        rows = await take(
          q(t.blocks)
            .withIndex('by_partition_start', (ix: any) => ix.eq('partition', l.partition).eq('level', 0))
            .order('desc')
            .filter((f: any) => (except.length === 0 ? ended(f) : f.and(ended(f), ...except.map((type) => f.neq(f.field('scope_type'), type))))),
          l.limit,
        );
      }
      return rows.map(toBlock);
    },

    async leafHolding(a, asOf) {
      // Numbered leaves never overlap, so the holder is the latest-starting
      // numbered leaf that starts at or before the activity.
      const r: Row | null = await q(t.blocks)
        .withIndex('by_scope_start', (ix: any) => ix.eq('partition', a.partition).eq('scope_key', scopeKey(a.scope)).eq('level', 0).lte('start', a.at))
        .order('desc')
        .filter((f: any) => f.neq(f.field('index'), null))
        .first();
      return r && a.at <= r.end && visible(asOf)(r) ? toBlock(r) : null;
    },

    async activitiesIn(leaf, asOf) {
      const { lo, hi } = tightest([{ c: leaf.start, incl: true }], [{ c: leaf.end, incl: true }, asOf ? { c: asOf.cursor, incl: false } : null]);
      return (await take(scan('by_scope_at', [['partition', leaf.partition], ['scope_key', scopeKey(leaf.scope)]], lo, hi, 'asc'), TAKE_ALL)).map(toActivity);
    },

    async addLegacyLeaf(scope, partition, leaf) {
      const id = await w().insert(t.blocks, {
        ...scopeOf(scope, partition),
        level: 0,
        index: null,
        start: leaf.start,
        end: leaf.end,
        start_ms: msOf(leaf.start),
        end_ms: msOf(leaf.end),
        content: leaf.content,
        count: leaf.count,
        created_at_ms: leaf.createdAtMs ?? clock.now(),
      });
      await settleLog(scope, partition);
      return toBlock((await db.get(id)) as Row);
    },

    async dropLog(scope, partition, limit) {
      const key = scopeKey(scope);
      let left = Math.max(1, Math.floor(limit));
      let deleted = 0;
      const doomed: Row[] = [
        ...(await q(t.blocks)
          .withIndex('by_slot', (ix: any) => ix.eq('partition', partition).eq('scope_key', key))
          .take(left)),
      ];
      left -= doomed.length;
      if (left > 0) doomed.push(...(await take(scan('by_scope_at', [['partition', partition], ['scope_key', key]], null, null, 'asc'), left)));
      for (const r of doomed) await w().delete(r._id);
      deleted += doomed.length;
      if (doomed.length < Math.max(1, Math.floor(limit))) {
        const log = await logOf(scope, partition);
        if (log) {
          await w().delete(log._id);
          deleted++;
        }
        return { deleted, done: true };
      }
      return { deleted, done: false };
    },

    async list(m) {
      const out: Memory[] = [];
      for (const key of [...new Set(m.scopes.map(scopeKey))]) {
        const rows: Row[] = await q(t.memories)
          .withIndex('by_agent_scope', (ix: any) => ix.eq('agent_id', m.agentId).eq('partition', m.partition).eq('scope_key', key))
          .collect();
        for (const r of rows) if (!r.archived && r.created_at_ms < m.at && (r.expires_at_ms === undefined || r.expires_at_ms > m.at)) out.push(toMemory(r));
      }
      return out;
    },

    async write(m) {
      const key = scopeKey(m.scope);
      const top: Row | null = await q(t.memories)
        .withIndex('by_agent_scope', (ix: any) => ix.eq('agent_id', m.agentId).eq('partition', m.partition).eq('scope_key', key))
        .order('desc')
        .first();
      const id = await w().insert(t.memories, {
        ...scopeOf(m.scope, m.partition),
        agent_id: m.agentId,
        seq: (top?.seq ?? 0) + 1,
        header: m.header,
        content: m.content,
        created_at_ms: m.createdAtMs ?? clock.now(),
        ...(m.expiresAtMs !== undefined ? { expires_at_ms: m.expiresAtMs } : {}),
        archived: false,
      });
      return toMemory((await db.get(id)) as Row);
    },

    async edit(id, patch) {
      const r = await get(t.memories, id);
      if (!r) throw new Error(`No memory ${id}`);
      const fields: Record<string, unknown> = {};
      if (patch.header !== undefined) fields.header = patch.header;
      if (patch.content !== undefined) fields.content = patch.content;
      if (patch.archived !== undefined) fields.archived = patch.archived;
      if (patch.expiresAtMs !== undefined) fields.expires_at_ms = patch.expiresAtMs ?? undefined;
      await w().patch(r._id , fields);
    },
  };
}

// ------------------------------------------------------------ from actions

/** Calls served by the host's internal query. */
export const READ_OPS = ['activities', 'activity', 'search', 'backlog', 'leafTip', 'scopesNeedingMerges', 'treeIndex', 'blocks', 'block', 'blockAt', 'leaves', 'leafHolding', 'activitiesIn', 'list'] as const;
/** Calls served by the host's internal mutation. */
export const WRITE_OPS = ['append', 'appendLeaf', 'putBlock', 'numberLegacyLeaves', 'addLegacyLeaf', 'dropLog', 'write', 'edit'] as const;

export type ReadOp = (typeof READ_OPS)[number];
export type WriteOp = (typeof WRITE_OPS)[number];

/**
 * Answer one forwarded call inside the host's function. Register it twice:
 *
 *   export const read = internalQuery({ args: { op: v.string(), args: v.string() }, returns: v.string(),
 *     handler: (ctx, a) => serveStoreOp(convexStore(ctx.db), 'read', a.op, a.args) });
 *   export const write = internalMutation({ …same…, handler: (ctx, a) => serveStoreOp(convexStore(ctx.db), 'write', a.op, a.args) });
 *
 * Keep both internal: the viewer checks live in the history reader, which
 * runs in the action, so a client must never reach the store directly.
 */
export async function serveStoreOp(store: ConvexHistoryStore, kind: 'read' | 'write', op: string, args: string): Promise<string> {
  const allowed: readonly string[] = kind === 'read' ? READ_OPS : WRITE_OPS;
  if (!allowed.includes(op)) throw new Error(`"${op}" is not a tidemark ${kind} call`);
  const parsed = JSON.parse(args) as unknown[];
  if (!Array.isArray(parsed)) throw new Error('tidemark store arguments are a JSON array');
  const result = await (store as any)[op](...parsed);
  return JSON.stringify(result ?? null);
}

export interface StoreTransport {
  /** Runs the host's internal read query: `ctx.runQuery(internal.x.read, { op, args })`. */
  query(op: ReadOp, args: string): Promise<string>;
  /** Runs the host's internal write mutation. */
  mutation(op: WriteOp, args: string): Promise<string>;
}

/**
 * The store from an action. Each call is one query or one mutation, so each
 * write is its own transaction, exactly the granularity compression needs:
 * a leaf append or a block insert is atomic, and the pass between them may
 * stop anywhere.
 */
export function remoteStore(transport: StoreTransport): ConvexHistoryStore {
  // JSON turns an omitted trailing argument into null, which every op reads as absent.
  const read = (op: ReadOp) => async (...args: unknown[]) => JSON.parse(await transport.query(op, JSON.stringify(args)));
  const write = (op: WriteOp) => async (...args: unknown[]) => JSON.parse(await transport.mutation(op, JSON.stringify(args)));
  const store: Record<string, unknown> = { cursorAt: convexCursorAt };
  for (const op of READ_OPS) store[op] = read(op);
  for (const op of WRITE_OPS) store[op] = write(op);
  store.edit = async (...args: unknown[]) => {
    await write('edit')(...args);
  };
  return store as unknown as ConvexHistoryStore;
}
