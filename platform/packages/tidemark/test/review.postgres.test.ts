/**
 * Adversarial review against the local loopback Postgres only.
 *   TIDEMARK_PG_URL=postgres://localhost:5440/tidemark_test bun test test/review.postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { SQL } from 'bun';

import { asOfAt } from '../src/asof';
import { asCursor } from '../src/cursor';
import { fixedClock } from '../src/clock';
import { leafWindow } from '../src/compress';
import { createHistory, HistoryError } from '../src/history';
import type { Activity } from '../src/log';
import { partitionViewer, scopedViewer, type Scope } from '../src/scope';
import { postgresSchema, postgresStore, type SqlClient } from '../src/stores/postgres';
import { completeMerges } from '../src/tree';
import { countingSummarizer, DAY, HOUR, SCOPES, T0 } from './helpers';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

const url = process.env.TIDEMARK_PG_URL;
const loopback = !!url && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(url).hostname);
if (url && !loopback) throw new Error('loopback only');

describe.skipIf(!loopback)('review: postgres', () => {
  const prefix = `rv_${Math.random().toString(36).slice(2, 8)}_`;
  const tables = ['activities', 'blocks', 'memories'].map((t) => `${prefix}${t}`);
  let db: SQL;
  let one: SQL;
  let client: SqlClient;
  let oddClient: SqlClient;
  const P = 'default';
  const ada: Scope = { type: 'person', id: 'ada' };

  beforeAll(async () => {
    db = new SQL(url!, { max: 8 });
    one = new SQL(url!, { max: 1 });
    client = { query: (text, params) => db.unsafe(text, params) as Promise<any[]> };
    oddClient = { query: (text, params) => one.unsafe(text, params) as Promise<any[]> };
    for (const statement of postgresSchema(prefix).split(';\n')) if (statement.replace(/--.*$/gm, '').trim()) await db.unsafe(statement);
  });
  afterAll(async () => {
    for (const t of tables) await db.unsafe(`DROP TABLE IF EXISTS ${t}`);
    await db.close();
    await one.close();
  });
  const fresh = async () => {
    await db.unsafe(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY`);
    return postgresStore(client, { tablePrefix: prefix });
  };
  const micro = (us: string) => asCursor(`2026-03-01T12:00:00.${us}Z`);

  test('session TimeZone and DateStyle do not change cursors or their comparisons', async () => {
    const store = await fresh();
    const rows: Activity[] = [];
    for (const us of ['123100', '123500', '123900']) rows.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: us, at: micro(us) }));
    await one.unsafe(`SET TimeZone = 'Pacific/Chatham'`);
    await one.unsafe(`SET DateStyle = 'SQL, DMY'`);
    await one.unsafe(`SET IntervalStyle = 'sql_standard'`);
    const odd = postgresStore(oddClient, { tablePrefix: prefix });
    const read = (q: object) => odd.activities({ select: { scope: ada }, partition: P, order: 'asc', limit: 10, ...q });
    const all = await read({});
    expect(all.map((r) => r.at)).toEqual(rows.map((r) => r.at));
    expect(all.map((r) => r.atMs)).toEqual(rows.map((r) => r.atMs));
    expect((await read({ after: rows[1].at })).map((r) => r.summary)).toEqual(['123900']);
    expect(odd.cursorAt(rows[0].atMs)).toBe(store.cursorAt(rows[0].atMs));
    expect((await read({ before: odd.cursorAt(rows[0].atMs + 1) })).length).toBe(3);
    const leaf = await odd.appendLeaf(ada, P, { start: rows[0].at, end: rows[1].at, content: 'x', count: 2 }, null);
    expect(leaf!.end).toBe(rows[1].at);
    expect((await odd.leafTip(ada, P)).end).toBe(rows[1].at);
    expect((await odd.activitiesIn(leaf!)).length).toBe(2);
    // memories at an instant
    const m = await odd.write({ agentId: 'g', scope: ada, partition: P, header: 'h', content: 'c', createdAtMs: Date.UTC(2026, 2, 1, 12) });
    expect(m.createdAtMs).toBe(Date.UTC(2026, 2, 1, 12));
    expect((await odd.list({ agentId: 'g', scopes: [ada], partition: P, at: Date.UTC(2026, 2, 1, 12) - 1 })).length).toBe(0);
    // Reads see what was written strictly before the instant (review finding 7).
    expect((await odd.list({ agentId: 'g', scopes: [ada], partition: P, at: Date.UTC(2026, 2, 1, 12) })).length).toBe(0);
    expect((await odd.list({ agentId: 'g', scopes: [ada], partition: P, at: Date.UTC(2026, 2, 1, 12) + 1 })).length).toBe(1);
    await one.unsafe(`RESET ALL`);
  });

  test('compression through ties at the max-50 boundary and a tied run longer than 50: every row in exactly one leaf', async () => {
    const store = await fresh();
    const clock = fixedClock(Date.UTC(2026, 5, 1));
    const history = createHistory({ store, scopes: SCOPES, summarizer: countingSummarizer(), clock, compress: { maxActivities: 50 } });
    const acts: Activity[] = [];
    let us = 100000;
    const at = (n: number) => asCursor(`2026-03-01T12:00:00.${String(n).padStart(6, '0')}Z`);
    for (let i = 0; i < 48; i++) acts.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: `a${i}`, at: at(us++) }));
    for (let i = 0; i < 5; i++) acts.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: `tie5 ${i}`, at: at(us) }));
    us++;
    for (let i = 0; i < 70; i++) acts.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: `tie70 ${i}`, at: at(us) }));
    us++;
    for (let i = 0; i < 10; i++) acts.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: `b${i}`, at: at(us++) }));
    await history.compressOnce({ deadlineAt: Date.now() + 60_000 });
    const leaves = await db.unsafe(`SELECT id::text AS id FROM ${prefix}blocks WHERE level = 0`);
    const blocks = await store.blocks(leaves.map((l: any) => l.id));
    const holder = new Map<string, number>();
    for (const b of blocks) for (const a of await store.activitiesIn(b)) holder.set(a.id, (holder.get(a.id) ?? 0) + 1);
    const wrong = acts.filter((a) => holder.get(a.id) !== 1).map((a) => `${a.summary}=${holder.get(a.id) ?? 0}`);
    expect(wrong).toEqual([]);
    expect(blocks.reduce((n, b) => n + b.count, 0)).toBe(acts.length);
  });

  test('four concurrent compressOnce passes over two scopes: slots unique, leaves contiguous', async () => {
    const store = await fresh();
    const clock = fixedClock(T0 + 90 * DAY);
    const summarizer = countingSummarizer();
    summarizer.delayMs = 2;
    const history = createHistory({ store, scopes: SCOPES, summarizer, clock, compress: { maxActivities: 3, concurrency: 4 } });
    const bram: Scope = { type: 'person', id: 'bram' };
    const values: string[] = [];
    const params: unknown[] = [];
    for (const s of [ada, bram]) for (let d = 0; d < 60; d++) for (let i = 0; i < 3; i++) {
      params.push(s.id, `${s.id} ${d} ${i}`, new Date(T0 + d * DAY + (9 + i) * HOUR).toISOString());
      const n = params.length;
      values.push(`('default','person',$${n - 2},'note',$${n - 1},$${n}::timestamptz)`);
    }
    await db.unsafe(`INSERT INTO ${prefix}activities (partition_key, scope_type, scope_id, kind, summary, at) VALUES ${values.join(',')}`, params);
    await Promise.all(Array.from({ length: 4 }, () => history.compressOnce({ deadlineAt: Date.now() + 120_000 })));
    const dup = await db.unsafe(`SELECT scope_id, level, block_index, count(*)::int n FROM ${prefix}blocks GROUP BY 1,2,3 HAVING count(*) > 1`);
    expect(dup).toEqual([]);
    const leaves = await db.unsafe(`SELECT scope_id, count(*)::int n, max(block_index)::int top, sum(activity_count)::int acts FROM ${prefix}blocks WHERE level = 0 GROUP BY 1 ORDER BY 1`);
    expect(leaves.map((r: any) => [r.scope_id, r.n, r.top, r.acts])).toEqual([
      ['ada', 60, 59, 180],
      ['bram', 60, 59, 180],
    ]);
  });

  test('a leaf backlog plus missing merges under short concurrent passes: merges every pass, slots unique, tree complete', async () => {
    const store = await fresh();
    const clock = fixedClock(T0 + 200 * DAY);
    const summarizer = countingSummarizer();
    const history = createHistory({ store, scopes: SCOPES, summarizer, clock, compress: { maxActivities: 3, concurrency: 4 } });
    const seed = async (ids: string[], days: number) => {
      const values: string[] = [];
      const params: unknown[] = [];
      for (const id of ids) for (let d = 0; d < days; d++) for (let i = 0; i < 3; i++) {
        params.push(id, `${id} ${d} ${i}`, new Date(T0 + d * DAY + (9 + i) * HOUR).toISOString());
        const n = params.length;
        values.push(`('default','person',$${n - 2},'note',$${n - 1},$${n}::timestamptz)`);
      }
      await db.unsafe(`INSERT INTO ${prefix}activities (partition_key, scope_type, scope_id, kind, summary, at) VALUES ${values.join(',')}`, params);
    };
    await seed(['ada'], 64);
    await history.compressOnce({ deadlineAt: Date.now() + 120_000 });
    await db.unsafe(`DELETE FROM ${prefix}blocks WHERE level > 0`);
    const backlog = Array.from({ length: 8 }, (_, i) => `b${i}`);
    await seed(backlog, 40); // 320 leaves owed
    summarizer.delayMs = 5;
    const reports = await Promise.all(Array.from({ length: 4 }, () => history.compressOnce({ deadlineAt: Date.now() + 250 })));
    expect(reports.some((r) => r.phases.leaves.shareHit)).toBe(true);
    expect(reports.reduce((n, r) => n + r.merged, 0)).toBeGreaterThan(0);
    summarizer.delayMs = 0;
    for (let i = 0; i < 5; i++) await Promise.all([history.compressOnce({ deadlineAt: Date.now() + 120_000 }), history.compressOnce({ deadlineAt: Date.now() + 120_000 })]);
    const dup = await db.unsafe(`SELECT scope_id, level, block_index, count(*)::int n FROM ${prefix}blocks GROUP BY 1,2,3 HAVING count(*) > 1`);
    expect(dup).toEqual([]);
    const merged = await db.unsafe(`SELECT scope_id, count(*)::int n FROM ${prefix}blocks WHERE level > 0 GROUP BY 1 ORDER BY 1`);
    expect(Object.fromEntries(merged.map((r: any) => [r.scope_id, r.n]))).toEqual({ ada: completeMerges(64, () => false).length, ...Object.fromEntries(backlog.map((id) => [id, completeMerges(40, () => false).length])) });
  });

  test('hostile strings in every field are data, not SQL', async () => {
    const store = await fresh();
    const evil = `x'); DROP TABLE ${prefix}blocks; --`;
    const scope: Scope = { type: `person'--`, id: evil };
    const a = await store.append({ scope, partition: evil, kind: evil, summary: `100%_\\ done ${evil}`, at: micro('000001') });
    expect((await store.activities({ select: { scope }, partition: evil, kinds: [evil], order: 'asc', limit: 5 })).map((r) => r.id)).toEqual([a.id]);
    expect((await store.activities({ select: { types: [scope.type] }, partition: evil, order: 'asc', limit: 5 })).length).toBe(1);
    expect((await store.activities({ select: { anyOf: [scope] }, partition: evil, order: 'asc', limit: 5 })).length).toBe(1);
    expect((await store.activities({ select: { all: true, except: [evil] }, partition: evil, order: 'asc', limit: 5 })).length).toBe(1);
    expect((await store.search!({ select: { scope }, partition: evil, text: '100%_\\', limit: 5 })).length).toBe(1);
    expect((await store.search!({ select: { scope }, partition: evil, text: '100x', limit: 5 })).length).toBe(0);
    expect((await store.search!({ select: { scope }, partition: evil, text: '%', limit: 5 })).length).toBe(1);
    expect((await store.search!({ select: { scope }, partition: evil, text: '_', limit: 5 })).length).toBe(1);
    expect((await db.unsafe(`SELECT count(*)::int n FROM ${prefix}blocks`))[0].n).toBe(0);
  });

  test('a NUL byte in a scope id or a query crashes the read instead of steering the model', async () => {
    const store = await fresh();
    const history = createHistory({ store, scopes: SCOPES, clock: fixedClock(Date.UTC(2026, 5, 1)) });
    const viewer = partitionViewer('op');
    const outcome = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof HistoryError ? 'steer' : `crash: ${String(e).slice(0, 80)}`));
    const results = {
      view: await outcome(history.view({ select: { scope: { type: 'person', id: 'a\u0000b' } }, viewer })),
      search: await outcome(history.search({ select: { scope: ada }, viewer, query: 'a\u0000b' })),
      activity: await outcome(history.open('a:1\u0000', { viewer })),
      story: await outcome(history.open('s:k\u0000|1|2', { viewer })),
      block: await outcome(history.open('b:0.0@person:a\u0000', { viewer })),
    };
    expect(Object.entries(results).filter(([, v]) => v.startsWith('crash'))).toEqual([]);
  });

  test('as-of at the exact stamp of a tied run, and leafHolding on a tie', async () => {
    const store = await fresh();
    const rows: Activity[] = [];
    for (let i = 0; i < 3; i++) rows.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: `t${i}`, at: micro('000500') }));
    const cut = { at: 0, cursor: micro('000500'), registry: {} };
    expect(await store.activities({ select: { scope: ada }, partition: P, order: 'asc', limit: 5, asOf: cut })).toEqual([]);
    expect(await store.activity(rows[0].id, cut)).toBeNull();
    const leaf = await store.appendLeaf(ada, P, { start: rows[0].at, end: rows[2].at, content: 'tie', count: 3 }, null);
    expect(await store.block(leaf!.id, cut)).toBeNull();
    for (const r of rows) expect((await store.leafHolding(r))?.id).toBe(leaf!.id);
    expect((await leafWindow(store, ada, P, null, micro('000501'), 2)).length).toBe(3);
    expect((await leafWindow(store, ada, P, null, micro('000500'), 2)).length).toBe(0);
    expect(asOfAt(store, Date.UTC(2026, 2, 1, 12)).cursor).toBe(micro('000000'));
  });

  test('numberLegacyLeaves keeps time order and the memory store agrees', async () => {
    const store = await fresh();
    const add = (start: string, end: string, content: string, created: number) =>
      db.unsafe(
        `INSERT INTO ${prefix}blocks (partition_key, scope_type, scope_id, level, block_index, start_at, end_at, content, activity_count, created_at) VALUES ('default','person','ada',0,NULL,$1::timestamptz,$2::timestamptz,$3,1,to_timestamp($4::float8/1000.0))`,
        [start, end, content, created],
      );
    await add(micro('000300'), micro('000400'), 'third', 1);
    await add(micro('000100'), micro('000200'), 'first', 1);
    await add(micro('000100'), micro('000200'), 'first dup shorter', 2); // longer content wins: 'first dup shorter' is longer, so 'first' is dropped
    await add(micro('000150'), micro('000350'), 'straddle', 1); // partial overlap with both
    const out = await store.numberLegacyLeaves!(ada, P);
    const rows = await db.unsafe(`SELECT content, block_index::int i FROM ${prefix}blocks ORDER BY block_index`);
    expect(out.dropped).toBe(1);
    expect(rows.map((r: any) => `${r.i}:${r.content}`)).toEqual(['0:first dup shorter', '1:straddle', '2:third']);
  });
});
