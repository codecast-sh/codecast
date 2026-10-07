import type { AsOf } from '../asof';
import { asCursor, type Cursor } from '../cursor';
import type { Activity, Block } from '../log';
import type { Memory, MemoryStore } from '../memory';
import { scopeKey, type Partition, type Scope, type ScopeSelector } from '../scope';
import type { HistoryStore } from '../store';

/**
 * The driver, injected: one function that runs a statement with `$1…`
 * parameters and returns rows. It fits postgres.js (`sql.unsafe`), Bun.sql
 * (`sql.unsafe`) and pg (`(t, p) => pool.query(t, p).then(r => r.rows)`), so
 * this module imports no driver.
 *
 * Every statement is a single statement and needs no session state, so it is
 * safe behind a transaction-pooling proxy.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params: unknown[]): Promise<T[]>;
}

export interface PostgresStoreOptions {
  /** Table name prefix. Default `tidemark_`. */
  tablePrefix?: string;
}

const PREFIX = /^[a-z_][a-z0-9_]{0,40}$/;
const NUMERIC_ID = /^\d{1,18}$/;

/**
 * The DDL for a prefix, as plain SQL the host applies with its own migrator.
 * `postgres.sql` beside this file is this text for the default prefix.
 */
export function postgresSchema(tablePrefix = 'tidemark_'): string {
  if (!PREFIX.test(tablePrefix)) throw new Error(`Invalid table prefix "${tablePrefix}"`);
  const p = tablePrefix;
  return `-- tidemark history and memory tables. Apply with your own migrator.
-- Activities and blocks are append-only. "at" keeps microseconds; cursors are
-- its exact text and are only ever compared inside the database.

CREATE TABLE IF NOT EXISTS ${p}activities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partition_key text NOT NULL DEFAULT 'default',
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  kind text NOT NULL,
  summary text NOT NULL,
  data jsonb,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor jsonb,
  ref_table text,
  ref_id text,
  tasks jsonb,
  focused_task_id text
);
CREATE INDEX IF NOT EXISTS ${p}activities_scope_at ON ${p}activities (partition_key, scope_type, scope_id, at, id);
CREATE INDEX IF NOT EXISTS ${p}activities_partition_at ON ${p}activities (partition_key, at, id);

-- level 0 = leaf (a summary of raw activities). A merged block at
-- (level, block_index) covers leaves [index * 2^level, (index + 1) * 2^level).
-- The unique slot index is what makes a duplicate block impossible; a legacy
-- leaf with no position has a NULL index and is outside it.
CREATE TABLE IF NOT EXISTS ${p}blocks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partition_key text NOT NULL DEFAULT 'default',
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  level integer NOT NULL DEFAULT 0 CHECK (level >= 0),
  block_index bigint CHECK (block_index >= 0),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  content text NOT NULL,
  activity_count integer NOT NULL,
  kinds jsonb,
  tasks jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (level = 0 OR block_index IS NOT NULL),
  CHECK (start_at <= end_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}blocks_slot ON ${p}blocks (partition_key, scope_type, scope_id, level, block_index);
CREATE INDEX IF NOT EXISTS ${p}blocks_scope_end ON ${p}blocks (partition_key, scope_type, scope_id, level, end_at);
CREATE INDEX IF NOT EXISTS ${p}blocks_leaf_end ON ${p}blocks (partition_key, level, end_at);

CREATE TABLE IF NOT EXISTS ${p}memories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id text NOT NULL,
  partition_key text NOT NULL DEFAULT 'default',
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  seq integer NOT NULL,
  header text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  archived boolean NOT NULL DEFAULT false,
  UNIQUE (agent_id, partition_key, scope_type, scope_id, seq)
);
`;
}

/** Fixed-width UTC text with microseconds: exact, canonical, and valid timestamptz input. */
const cursorSql = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const msSql = (col: string) => `floor(extract(epoch from ${col}) * 1000)::float8`;

interface ActivityRow {
  id: string;
  partition_key: string;
  scope_type: string;
  scope_id: string;
  kind: string;
  summary: string;
  data: unknown;
  at: string;
  at_ms: number | string;
  actor: unknown;
  ref_table: string | null;
  ref_id: string | null;
  tasks: unknown;
  focused_task_id: string | null;
}

interface BlockRow {
  id: string;
  partition_key: string;
  scope_type: string;
  scope_id: string;
  level: number;
  block_index: number | string | null;
  start_at: string;
  end_at: string;
  start_ms: number | string;
  end_ms: number | string;
  content: string;
  activity_count: number;
  kinds: unknown;
  tasks: unknown;
  created_ms: number | string;
}

/** Drivers differ on whether jsonb arrives parsed. */
const json = <T>(v: unknown): T | undefined => (v == null ? undefined : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

function toActivity(r: ActivityRow): Activity {
  return {
    id: String(r.id),
    scope: { type: r.scope_type, id: r.scope_id },
    partition: r.partition_key,
    kind: r.kind,
    summary: r.summary,
    data: json(r.data),
    at: asCursor(r.at),
    atMs: Number(r.at_ms),
    actor: json(r.actor),
    ref: r.ref_table != null && r.ref_id != null ? { table: r.ref_table, id: r.ref_id } : undefined,
    tasks: json(r.tasks),
    focusedTaskId: r.focused_task_id ?? undefined,
  };
}

function toBlock(r: BlockRow): Block {
  return {
    id: String(r.id),
    scope: { type: r.scope_type, id: r.scope_id },
    partition: r.partition_key,
    level: Number(r.level),
    index: r.block_index == null ? null : Number(r.block_index),
    start: asCursor(r.start_at),
    end: asCursor(r.end_at),
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    content: r.content,
    count: Number(r.activity_count),
    kinds: json(r.kinds),
    tasks: json(r.tasks),
    createdAtMs: Number(r.created_ms),
  };
}

/** Collects parameters and hands back their `$n` placeholders. */
function binder() {
  const params: unknown[] = [];
  return {
    params,
    add: (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    },
  };
}

export function postgresStore(sql: SqlClient, options: PostgresStoreOptions = {}): HistoryStore & MemoryStore {
  const prefix = options.tablePrefix ?? 'tidemark_';
  if (!PREFIX.test(prefix)) throw new Error(`Invalid table prefix "${prefix}"`);
  const A = `${prefix}activities`;
  const B = `${prefix}blocks`;
  const M = `${prefix}memories`;

  const activityCols = (t = '') => {
    const c = (name: string) => (t ? `${t}.${name}` : name);
    return `${c('id')}::text AS id, ${c('partition_key')}, ${c('scope_type')}, ${c('scope_id')}, ${c('kind')}, ${c('summary')}, ${c('data')}, ${cursorSql(c('at'))} AS at, ${msSql(c('at'))} AS at_ms, ${c('actor')}, ${c('ref_table')}, ${c('ref_id')}, ${c('tasks')}, ${c('focused_task_id')}`;
  };
  const blockCols = `id::text AS id, partition_key, scope_type, scope_id, level, block_index, ${cursorSql('start_at')} AS start_at, ${cursorSql('end_at')} AS end_at, ${msSql('start_at')} AS start_ms, ${msSql('end_at')} AS end_ms, content, activity_count, kinds, tasks, ${msSql('created_at')} AS created_ms`;

  type Bind = ReturnType<typeof binder>;
  // JSON travels as text and is cast in SQL: drivers disagree on how a string
  // bound straight to a jsonb parameter is encoded.
  const jsonParam = (b: Bind, v: unknown) => `(${b.add(v == null ? null : JSON.stringify(v))}::text)::jsonb`;
  const ts = (b: Bind, c: Cursor) => `${b.add(c)}::timestamptz`;
  const textList = (b: Bind, values: readonly string[]) => `(SELECT jsonb_array_elements_text(${jsonParam(b, values)}))`;
  const inScope = (b: Bind, scope: Scope, partition: Partition, t = '') => {
    const c = t ? `${t}.` : '';
    return `${c}partition_key = ${b.add(partition)} AND ${c}scope_type = ${b.add(scope.type)} AND ${c}scope_id = ${b.add(scope.id)}`;
  };
  /** A selector as one parenthesized predicate, always inside the caller's partition. */
  const selected = (b: Bind, select: ScopeSelector, partition: Partition): string => {
    // Checked before anything is bound: an unused parameter has no type.
    if ('anyOf' in select && select.anyOf.length === 0) return '(false)';
    const wall = `partition_key = ${b.add(partition)}`;
    if ('scope' in select) return `(${wall} AND scope_type = ${b.add(select.scope.type)} AND scope_id = ${b.add(select.scope.id)})`;
    if ('anyOf' in select) {
      return `(${wall} AND (scope_type, scope_id) IN (SELECT e->>0, e->>1 FROM jsonb_array_elements(${jsonParam(b, select.anyOf.map((s) => [s.type, s.id]))}) e))`;
    }
    if ('types' in select) return `(${wall} AND scope_type IN ${textList(b, select.types)})`;
    return `(${wall} AND scope_type NOT IN ${textList(b, select.except ?? [])})`;
  };
  const visible = (b: Bind, asOf: AsOf | undefined, col: string) => (asOf ? ` AND ${col} < ${ts(b, asOf.cursor)}` : '');
  /** As of an instant a block exists when it had ended and had been written. */
  const blockVisible = (b: Bind, asOf: AsOf | undefined) => (asOf ? ` AND ${B}.end_at < ${ts(b, asOf.cursor)} AND ${B}.created_at < ${ts(b, asOf.cursor)}` : '');
  const idList = (b: Bind, ids: readonly string[]) => `(SELECT (jsonb_array_elements_text(${jsonParam(b, ids.filter((id) => NUMERIC_ID.test(id)))}))::bigint)`;


  return {
    cursorAt(ms) {
      if (!Number.isFinite(ms)) throw new Error(`cursorAt needs a finite time, got ${ms}`);
      // Milliseconds padded to microseconds: the same fixed-width form rows carry.
      // Clamped to [1970, 9999], the range a fixed-width cursor holds.
      const clamped = Math.min(Date.UTC(9999, 11, 31, 23, 59, 59, 999), Math.max(0, Math.floor(ms)));
      return asCursor(`${new Date(clamped).toISOString().slice(0, 23)}000Z`);
    },

    async append(a) {
      const b = binder();
      const rows = await sql.query<ActivityRow>(
        `INSERT INTO ${A} (partition_key, scope_type, scope_id, kind, summary, data, at, actor, ref_table, ref_id, tasks, focused_task_id)
         VALUES (${b.add(a.partition)}, ${b.add(a.scope.type)}, ${b.add(a.scope.id)}, ${b.add(a.kind)}, ${b.add(a.summary)}, ${jsonParam(b, a.data)},
                 COALESCE(${b.add(a.at ?? null)}::timestamptz, clock_timestamp()), ${jsonParam(b, a.actor)}, ${b.add(a.ref?.table ?? null)}, ${b.add(a.ref?.id ?? null)}, ${jsonParam(b, a.tasks)}, ${b.add(a.focusedTaskId ?? null)})
         RETURNING ${activityCols()}`,
        b.params,
      );
      return toActivity(rows[0]);
    },

    async activities(q) {
      const b = binder();
      const where = [selected(b, q.select, q.partition)];
      if (q.after) where.push(`at > ${ts(b, q.after)}`);
      if (q.from) where.push(`at >= ${ts(b, q.from)}`);
      if (q.before) where.push(`at < ${ts(b, q.before)}`);
      if (q.until) where.push(`at <= ${ts(b, q.until)}`);
      if (q.asOf) where.push(`at < ${ts(b, q.asOf.cursor)}`);
      if (q.kinds) where.push(`kind IN ${textList(b, q.kinds)}`);
      const dir = q.order === 'desc' ? 'DESC' : 'ASC';
      const rows = await sql.query<ActivityRow>(`SELECT ${activityCols()} FROM ${A} WHERE ${where.join(' AND ')} ORDER BY at ${dir}, id ${dir} LIMIT ${b.add(Math.max(0, Math.floor(q.limit)))}`, b.params);
      return rows.map(toActivity);
    },

    async activity(id, asOf) {
      if (!NUMERIC_ID.test(id)) return null;
      const b = binder();
      const rows = await sql.query<ActivityRow>(`SELECT ${activityCols()} FROM ${A} WHERE id = ${b.add(id)}::bigint${visible(b, asOf, 'at')}`, b.params);
      return rows[0] ? toActivity(rows[0]) : null;
    },

    async search(q) {
      const b = binder();
      const pattern = `%${q.text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const rows = await sql.query<ActivityRow>(
        `SELECT ${activityCols()} FROM ${A} WHERE ${selected(b, q.select, q.partition)} AND summary ILIKE ${b.add(pattern)}${visible(b, q.asOf, 'at')}${q.until ? ` AND at <= ${ts(b, q.until)}` : ''}${q.kinds ? ` AND kind IN ${textList(b, q.kinds)}` : ''} ORDER BY at DESC, id DESC LIMIT ${b.add(Math.max(0, Math.floor(q.limit)))}`,
        b.params,
      );
      return rows.map(toActivity);
    },

    async backlog(q) {
      const b = binder();
      const rows = await sql.query<{ partition_key: string; scope_type: string; scope_id: string; count: number }>(
        `SELECT a.partition_key, a.scope_type, a.scope_id, count(*)::int AS count
         FROM ${A} a
         LEFT JOIN (SELECT partition_key, scope_type, scope_id, max(end_at) AS tip FROM ${B} WHERE level = 0 GROUP BY 1, 2, 3) t
           ON t.partition_key = a.partition_key AND t.scope_type = a.scope_type AND t.scope_id = a.scope_id
         WHERE a.at < ${ts(b, q.olderThan)} AND a.scope_type NOT IN ${textList(b, q.skip)} AND (t.tip IS NULL OR a.at > t.tip)
         GROUP BY a.partition_key, a.scope_type, a.scope_id
         HAVING count(*) >= ${b.add(q.minCount)}`,
        b.params,
      );
      return rows.map((r) => ({ scope: { type: r.scope_type, id: r.scope_id }, partition: r.partition_key, count: Number(r.count) }));
    },

    async leafTip(scope, partition) {
      const b = binder();
      const [row] = await sql.query<{ tip: string | null; last_index: number | string | null; unnumbered: boolean | null }>(
        `SELECT ${cursorSql('max(end_at)')} AS tip, max(block_index) AS last_index, bool_or(block_index IS NULL) AS unnumbered FROM ${B} WHERE ${inScope(b, scope, partition)} AND level = 0`,
        b.params,
      );
      return { end: row?.tip ? asCursor(row.tip) : null, lastIndex: row?.last_index == null ? null : Number(row.last_index), unnumbered: row?.unnumbered ?? false };
    },

    async appendLeaf(scope, partition, leaf, expectedLastIndex) {
      // The position comes from the tail the caller read, and the row lands
      // only while that tail is still the tail. Two runs appending the same
      // position collide on the slot index, and one of them inserts nothing.
      const b = binder();
      const rows = await sql.query<BlockRow>(
        `INSERT INTO ${B} (partition_key, scope_type, scope_id, level, block_index, start_at, end_at, content, activity_count, kinds, tasks)
         SELECT ${b.add(partition)}, ${b.add(scope.type)}, ${b.add(scope.id)}, 0, ${b.add((expectedLastIndex ?? -1) + 1)}::bigint,
                ${ts(b, leaf.start)}, ${ts(b, leaf.end)}, ${b.add(leaf.content)}, ${b.add(leaf.count)}::int, ${jsonParam(b, leaf.kinds)}, ${jsonParam(b, leaf.tasks)}
         WHERE (SELECT max(block_index) FROM ${B} WHERE ${inScope(b, scope, partition)} AND level = 0) IS NOT DISTINCT FROM ${b.add(expectedLastIndex)}::bigint
           AND NOT EXISTS (SELECT 1 FROM ${B} WHERE ${inScope(b, scope, partition)} AND level = 0 AND block_index IS NULL)
         ON CONFLICT DO NOTHING
         RETURNING ${blockCols}`,
        b.params,
      );
      return rows[0] ? toBlock(rows[0]) : null;
    },

    async putBlock(scope, partition, at, content, left, right) {
      if (!NUMERIC_ID.test(left) || !NUMERIC_ID.test(right) || at.level < 1) return null;
      // Bounds and counts come from the halves as stored, so the block spans
      // exactly what they span; it lands only while both halves still sit at
      // their positions, and the slot index refuses a second copy.
      const b = binder();
      const rows = await sql.query<BlockRow>(
        `INSERT INTO ${B} (partition_key, scope_type, scope_id, level, block_index, start_at, end_at, content, activity_count, kinds, tasks)
         SELECT l.partition_key, l.scope_type, l.scope_id, ${b.add(at.level)}::int, ${b.add(at.index)}::bigint, l.start_at, r.end_at, ${b.add(content)}, l.activity_count + r.activity_count,
                (SELECT jsonb_agg(DISTINCT k ORDER BY k) FROM jsonb_array_elements_text(coalesce(l.kinds, '[]'::jsonb) || coalesce(r.kinds, '[]'::jsonb)) k),
                (SELECT jsonb_agg(jsonb_build_object('taskId', m.task_id, 'weight', m.weight))
                   FROM (SELECT t->>'taskId' AS task_id, max((t->>'weight')::float8) AS weight
                           FROM jsonb_array_elements(coalesce(l.tasks, '[]'::jsonb) || coalesce(r.tasks, '[]'::jsonb)) t GROUP BY 1) m)
         FROM ${B} l, ${B} r
         WHERE l.id = ${b.add(left)}::bigint AND r.id = ${b.add(right)}::bigint
           AND ${inScope(b, scope, partition, 'l')} AND ${inScope(b, scope, partition, 'r')}
           AND l.level = ${b.add(at.level - 1)}::int AND r.level = l.level
           AND l.block_index = ${b.add(at.index * 2)}::bigint AND r.block_index = l.block_index + 1
         ON CONFLICT DO NOTHING
         RETURNING ${blockCols}`,
        b.params,
      );
      return rows[0] ? toBlock(rows[0]) : null;
    },

    async numberLegacyLeaves(scope, partition) {
      // One statement, so a scope is never half numbered. A numbered leaf is
      // never dropped or renumbered: merged blocks are keyed by its position.
      const b = binder();
      const mine = (t: string) => `${inScope(b, scope, partition, t)} AND ${t}.level = 0`;
      const [row] = await sql.query<{ dropped: number; numbered: number }>(
        `WITH doomed AS (
           SELECT a.id FROM ${B} a
           WHERE ${mine('a')} AND a.block_index IS NULL
             AND EXISTS (
               SELECT 1 FROM ${B} b
               WHERE b.partition_key = a.partition_key AND b.scope_type = a.scope_type AND b.scope_id = a.scope_id AND b.level = 0
                 AND b.id <> a.id AND b.start_at <= a.start_at AND b.end_at >= a.end_at
                 AND (b.start_at < a.start_at
                   OR b.end_at > a.end_at
                   OR length(b.content) > length(a.content)
                   OR (length(b.content) = length(a.content) AND b.created_at > a.created_at)
                   OR (length(b.content) = length(a.content) AND b.created_at = a.created_at AND b.id > a.id))
             )
         ), dropped AS (
           DELETE FROM ${B} WHERE id IN (SELECT id FROM doomed) RETURNING id
         ), numbered AS (
           UPDATE ${B} c SET block_index = n.idx
           FROM (
             SELECT k.id,
                    (SELECT coalesce(max(x.block_index), -1) FROM ${B} x WHERE ${mine('x')})
                    + row_number() OVER (ORDER BY k.start_at, k.end_at, k.id) AS idx
             FROM ${B} k
             WHERE ${mine('k')} AND k.block_index IS NULL AND k.id NOT IN (SELECT id FROM doomed)
           ) n
           WHERE c.id = n.id AND c.block_index IS NULL
           RETURNING c.id
         )
         SELECT (SELECT count(*) FROM dropped)::int AS dropped, (SELECT count(*) FROM numbered)::int AS numbered`,
        b.params,
      );
      return { dropped: Number(row?.dropped ?? 0), numbered: Number(row?.numbered ?? 0) };
    },

    async scopesNeedingMerges(q) {
      const b = binder();
      const rows = await sql.query<{ partition_key: string; scope_type: string; scope_id: string }>(
        `SELECT partition_key, scope_type, scope_id FROM ${B}
         WHERE level = 0 AND block_index IS NOT NULL AND end_at < ${ts(b, q.endedBefore)} AND scope_type NOT IN ${textList(b, q.skip)}
         GROUP BY partition_key, scope_type, scope_id
         HAVING count(*) > ${b.add(q.minLeaves)}
         ORDER BY count(*) DESC`,
        b.params,
      );
      return rows.map((r) => ({ scope: { type: r.scope_type, id: r.scope_id }, partition: r.partition_key }));
    },

    async treeIndex(scope, partition, q) {
      const b = binder();
      const rows = await sql.query<{ id: string; level: number; block_index: number | string | null; start_ms: number | string; end_ms: number | string }>(
        `SELECT id::text AS id, level, block_index, ${msSql('start_at')} AS start_ms, ${msSql('end_at')} AS end_ms FROM ${B} WHERE ${inScope(b, scope, partition)}${q.endedBefore ? ` AND end_at < ${ts(b, q.endedBefore)}` : ''}${blockVisible(b, q.asOf)}`,
        b.params,
      );
      return rows.map((r) => ({ id: String(r.id), level: Number(r.level), index: r.block_index == null ? null : Number(r.block_index), startMs: Number(r.start_ms), endMs: Number(r.end_ms) }));
    },

    async blocks(ids, asOf) {
      if (ids.length === 0) return [];
      const b = binder();
      const rows = await sql.query<BlockRow>(`SELECT ${blockCols} FROM ${B} WHERE id IN ${idList(b, ids)}${blockVisible(b, asOf)}`, b.params);
      return rows.map(toBlock);
    },

    async block(id, asOf) {
      if (!NUMERIC_ID.test(id)) return null;
      const b = binder();
      const rows = await sql.query<BlockRow>(`SELECT ${blockCols} FROM ${B} WHERE id = ${b.add(id)}::bigint${blockVisible(b, asOf)}`, b.params);
      return rows[0] ? toBlock(rows[0]) : null;
    },

    async blockAt(scope, partition, at, asOf) {
      const b = binder();
      const rows = await sql.query<BlockRow>(`SELECT ${blockCols} FROM ${B} WHERE ${inScope(b, scope, partition)} AND level = ${b.add(at.level)}::int AND block_index = ${b.add(at.index)}::bigint${blockVisible(b, asOf)}`, b.params);
      return rows[0] ? toBlock(rows[0]) : null;
    },

    async leaves(q) {
      const b = binder();
      const rows = await sql.query<BlockRow>(
        `SELECT ${blockCols} FROM ${B} WHERE ${selected(b, q.select, q.partition)} AND level = 0 AND end_at < ${ts(b, q.endedBefore)}${blockVisible(b, q.asOf)} ORDER BY ${B}.start_at DESC, ${B}.id DESC LIMIT ${b.add(Math.max(0, Math.floor(q.limit)))}`,
        b.params,
      );
      return rows.map(toBlock);
    },

    async leafHolding(a, asOf) {
      const b = binder();
      const rows = await sql.query<BlockRow>(
        `SELECT ${blockCols} FROM ${B} WHERE ${inScope(b, a.scope, a.partition)} AND level = 0 AND block_index IS NOT NULL AND ${B}.start_at <= ${ts(b, a.at)} AND ${B}.end_at >= ${ts(b, a.at)}${blockVisible(b, asOf)} ORDER BY block_index LIMIT 1`,
        b.params,
      );
      return rows[0] ? toBlock(rows[0]) : null;
    },

    async activitiesIn(leaf, asOf) {
      const b = binder();
      const rows = await sql.query<ActivityRow>(
        `SELECT ${activityCols()} FROM ${A} WHERE ${inScope(b, leaf.scope, leaf.partition)} AND ${A}.at >= ${ts(b, leaf.start)} AND ${A}.at <= ${ts(b, leaf.end)}${visible(b, asOf, `${A}.at`)} ORDER BY ${A}.at, id`,
        b.params,
      );
      return rows.map(toActivity);
    },

    async list(q) {
      if (q.scopes.length === 0) return [];
      const b = binder();
      const at = `to_timestamp(${b.add(q.at)}::float8 / 1000.0)`;
      const rows = await sql.query<{ id: string; agent_id: string; partition_key: string; scope_type: string; scope_id: string; seq: number; header: string; content: string; created_ms: number | string; expires_ms: number | string | null; archived: boolean }>(
        `SELECT id::text AS id, agent_id, partition_key, scope_type, scope_id, seq, header, content, ${msSql('created_at')} AS created_ms, ${msSql('expires_at')} AS expires_ms, archived
         FROM ${M}
         WHERE agent_id = ${b.add(q.agentId)} AND ${selected(b, { anyOf: q.scopes }, q.partition)} AND NOT archived
           AND created_at < ${at} AND (expires_at IS NULL OR expires_at > ${at})`,
        b.params,
      );
      const order = q.scopes.map(scopeKey);
      return rows
        .map(
          (r): Memory => ({
            id: String(r.id),
            agentId: r.agent_id,
            scope: { type: r.scope_type, id: r.scope_id },
            partition: r.partition_key,
            seq: Number(r.seq),
            header: r.header,
            content: r.content,
            createdAtMs: Number(r.created_ms),
            expiresAtMs: r.expires_ms == null ? undefined : Number(r.expires_ms),
            archived: r.archived,
          }),
        )
        .sort((x, y) => order.indexOf(scopeKey(x.scope)) - order.indexOf(scopeKey(y.scope)) || x.seq - y.seq);
    },

    async write(m) {
      // seq is the next number at this agent and scope; a racing writer that
      // takes it first makes this insert a no-op, and it tries the next.
      for (let attempt = 0; attempt < 8; attempt++) {
        const b = binder();
        const mine = `agent_id = ${b.add(m.agentId)} AND partition_key = ${b.add(m.partition)} AND scope_type = ${b.add(m.scope.type)} AND scope_id = ${b.add(m.scope.id)}`;
        const rows = await sql.query<{ id: string; seq: number; created_ms: number | string }>(
          `INSERT INTO ${M} (agent_id, partition_key, scope_type, scope_id, seq, header, content, created_at, expires_at)
           SELECT ${b.add(m.agentId)}, ${b.add(m.partition)}, ${b.add(m.scope.type)}, ${b.add(m.scope.id)},
                  (SELECT coalesce(max(seq), 0) + 1 FROM ${M} WHERE ${mine}), ${b.add(m.header)}, ${b.add(m.content)},
                  COALESCE(to_timestamp(${b.add(m.createdAtMs ?? null)}::float8 / 1000.0), clock_timestamp()), to_timestamp(${b.add(m.expiresAtMs ?? null)}::float8 / 1000.0)
           ON CONFLICT DO NOTHING
           RETURNING id::text AS id, seq, ${msSql('created_at')} AS created_ms`,
          b.params,
        );
        if (rows[0]) {
          return { id: String(rows[0].id), agentId: m.agentId, scope: m.scope, partition: m.partition, seq: Number(rows[0].seq), header: m.header, content: m.content, createdAtMs: Number(rows[0].created_ms), expiresAtMs: m.expiresAtMs, archived: false };
        }
      }
      throw new Error('Could not take a memory sequence number after 8 attempts');
    },

    async edit(id, patch) {
      if (!NUMERIC_ID.test(id)) throw new Error(`No memory ${id}`);
      const b = binder();
      const sets: string[] = [];
      if (patch.header !== undefined) sets.push(`header = ${b.add(patch.header)}`);
      if (patch.content !== undefined) sets.push(`content = ${b.add(patch.content)}`);
      if (patch.archived !== undefined) sets.push(`archived = ${b.add(patch.archived)}::boolean`);
      if (patch.expiresAtMs !== undefined) sets.push(`expires_at = to_timestamp(${b.add(patch.expiresAtMs)}::float8 / 1000.0)`);
      if (sets.length === 0) return;
      const rows = await sql.query(`UPDATE ${M} SET ${sets.join(', ')} WHERE id = ${b.add(id)}::bigint RETURNING id`, b.params);
      if (rows.length === 0) throw new Error(`No memory ${id}`);
    },
  };
}
