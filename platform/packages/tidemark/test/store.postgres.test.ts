/**
 * The store contract against a real Postgres, plus the cases only Postgres
 * can show (microsecond stamps a JS Date would collapse, concurrent sessions).
 *
 * Runs only when TIDEMARK_PG_URL is set, and only against a loopback host:
 * it creates and drops its own prefixed tables.
 *
 *   TIDEMARK_PG_URL=postgres://localhost:5440/tidemark_test bun test test/store.postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { SQL } from 'bun';
import { readFileSync } from 'node:fs';

import { asOfAt } from '../src/asof';
import { asCursor } from '../src/cursor';
import { leafWindow } from '../src/compress';
import type { Activity } from '../src/log';
import type { Scope } from '../src/scope';
import { storeContract } from '../src/stores/contract';
import { postgresSchema, postgresStore, type SqlClient } from '../src/stores/postgres';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

const url = process.env.TIDEMARK_PG_URL;
const loopback = !!url && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(url).hostname);
if (url && !loopback) throw new Error('TIDEMARK_PG_URL must point at a loopback Postgres; refusing any other host.');

test('postgres.sql is the schema for the default prefix', () => {
  expect(readFileSync(new URL('../src/stores/postgres.sql', import.meta.url), 'utf8')).toBe(postgresSchema());
});

test('a table prefix that is not a plain identifier is refused', () => {
  expect(() => postgresSchema('x; DROP TABLE y;')).toThrow();
  expect(() => postgresStore({ query: async () => [] }, { tablePrefix: 'Bad-Prefix' })).toThrow();
});

describe.skipIf(!loopback)('store contract: postgres', () => {
  const prefix = `tm_${Math.random().toString(36).slice(2, 8)}_`;
  const tables = ['activities', 'blocks', 'memories'].map((t) => `${prefix}${t}`);
  let db: SQL;
  let client: SqlClient;
  const P = 'default';
  const ada: Scope = { type: 'person', id: 'ada' };

  beforeAll(async () => {
    db = new SQL(url!, { max: 8 });
    client = { query: (text, params) => db.unsafe(text, params) as Promise<any[]> };
    for (const statement of postgresSchema(prefix).split(';\n')) {
      if (statement.replace(/--.*$/gm, '').trim()) await db.unsafe(statement);
    }
  });
  afterAll(async () => {
    for (const t of tables) await db.unsafe(`DROP TABLE IF EXISTS ${t}`);
    await db.close();
  });
  const fresh = async () => {
    await db.unsafe(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY`);
    return postgresStore(client, { tablePrefix: prefix });
  };

  for (const c of storeContract(async () => {
    const store = await fresh();
    return {
      store,
      addLegacyLeaf: async (scope, partition, leaf) => {
        await db.unsafe(
          `INSERT INTO ${prefix}blocks (partition_key, scope_type, scope_id, level, block_index, start_at, end_at, content, activity_count, created_at)
           VALUES ($1, $2, $3, 0, NULL, $4::timestamptz, $5::timestamptz, $6, $7, to_timestamp($8::float8 / 1000.0))`,
          [partition, scope.type, scope.id, leaf.start, leaf.end, leaf.content, leaf.count, leaf.createdAtMs ?? Date.now()],
        );
      },
    };
  })) {
    test(c.name, c.run, 30_000);
  }

  // Activities sit in the future: a block is visible as of an instant only
  // once it has been written, and these blocks are written now.
  const micro = (us: string) => asCursor(`2099-03-01T12:00:00.${us}Z`);

  test('cursors keep microseconds: three rows inside one millisecond stay ordered and distinct', async () => {
    const store = await fresh();
    // All three share millisecond .123; a JS Date would read them as one instant.
    const stamps = ['123100', '123500', '123900'];
    const rows: Activity[] = [];
    for (const [i, us] of stamps.entries()) rows.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: `row ${i}`, at: micro(us) }));
    expect(rows.map((r) => r.at)).toEqual(stamps.map(micro));
    expect(new Set(rows.map((r) => r.atMs)).size).toBe(1);
    const read = (q: object) => store.activities({ select: { scope: ada }, partition: P, order: 'asc', limit: 10, ...q }).then((r) => r.map((x) => x.summary));
    expect(await read({})).toEqual(['row 0', 'row 1', 'row 2']);
    expect(await read({ after: rows[0].at })).toEqual(['row 1', 'row 2']);
    expect(await read({ after: rows[1].at })).toEqual(['row 2']);
    expect(await read({ before: rows[1].at })).toEqual(['row 0']);
    expect(await read({ from: rows[1].at, before: rows[2].at })).toEqual(['row 1']);
    // The millisecond boundary a Date would produce sits before all three and after none.
    expect(await read({ after: store.cursorAt(rows[0].atMs) })).toEqual(['row 0', 'row 1', 'row 2']);
    expect(await read({ before: store.cursorAt(rows[0].atMs) })).toEqual([]);
    expect(await read({ before: store.cursorAt(rows[0].atMs + 1) })).toEqual(['row 0', 'row 1', 'row 2']);
    // As-of at a microsecond instant is strict at that precision.
    expect(await read({ asOf: { at: rows[0].atMs, cursor: micro('123500'), registry: {} } })).toEqual(['row 0']);
  });

  test('the leaf tip is exact to the microsecond, so the next window starts after it and compression advances', async () => {
    const store = await fresh();
    const stamps = ['000100', '000200', '000300', '000400', '000500', '000600'];
    const rows: Activity[] = [];
    for (const [i, us] of stamps.entries()) rows.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: `row ${i}`, at: micro(us) }));
    const leaf = await store.appendLeaf(ada, P, { start: rows[0].at, end: rows[2].at, content: 'first three', count: 3 }, null);
    expect(leaf?.end).toBe(micro('000300'));
    const tip = await store.leafTip(ada, P);
    expect(tip.end).toBe(micro('000300'));
    const next = await leafWindow(store, ada, P, tip.end, store.cursorAt(Date.UTC(2099, 2, 2)), 50);
    expect(next.map((r) => r.summary)).toEqual(['row 3', 'row 4', 'row 5']);
    expect((await store.activitiesIn(leaf!)).map((r) => r.summary)).toEqual(['row 0', 'row 1', 'row 2']);
    expect((await store.leafHolding(rows[2]))?.id).toBe(leaf!.id);
    expect(await store.leafHolding(rows[3])).toBeNull();
    // Visible as of one microsecond after it ended, not at the instant it ended.
    expect(await store.block(leaf!.id, { at: 0, cursor: micro('000300'), registry: {} })).toBeNull();
    expect((await store.block(leaf!.id, { at: 0, cursor: micro('000301'), registry: {} }))?.id).toBe(leaf!.id);
  });

  test('a full window never ends inside a run of rows sharing one microsecond stamp', async () => {
    const store = await fresh();
    for (let i = 0; i < 4; i++) await store.append({ scope: ada, partition: P, kind: 'note', summary: `early ${i}`, at: micro(`00010${i}`) });
    for (let i = 0; i < 3; i++) await store.append({ scope: ada, partition: P, kind: 'note', summary: `tied ${i}`, at: micro('000200') });
    const far = store.cursorAt(Date.UTC(2099, 2, 2));
    // Max 5 would cut the tied run after its first row; the window stops before the run instead.
    expect((await leafWindow(store, ada, P, null, far, 5)).map((r) => r.summary)).toEqual(['early 0', 'early 1', 'early 2', 'early 3']);
    expect((await leafWindow(store, ada, P, micro('000103'), far, 5)).map((r) => r.summary)).toEqual(['tied 0', 'tied 1', 'tied 2']);
    // A window that is nothing but one tied run takes the whole run.
    expect((await leafWindow(store, ada, P, micro('000103'), far, 2)).map((r) => r.summary)).toEqual(['tied 0', 'tied 1', 'tied 2']);
  });

  test('concurrent sessions: many appendLeaf and putBlock calls for one slot land once', async () => {
    const store = await fresh();
    const rows: Activity[] = [];
    for (let i = 0; i < 6; i++) rows.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: `row ${i}`, at: micro(`00010${i}`) }));
    const first = await Promise.all(Array.from({ length: 16 }, (_, i) => store.appendLeaf(ada, P, { start: rows[0].at, end: rows[2].at, content: `a${i}`, count: 3 }, null)));
    expect(first.filter(Boolean).length).toBe(1);
    const second = await Promise.all(Array.from({ length: 16 }, (_, i) => store.appendLeaf(ada, P, { start: rows[3].at, end: rows[5].at, content: `b${i}`, count: 3 }, 0)));
    expect(second.filter(Boolean).length).toBe(1);
    const [l, r] = [first.find(Boolean)!, second.find(Boolean)!];
    const merged = await Promise.all(Array.from({ length: 16 }, (_, i) => store.putBlock(ada, P, { level: 1, index: 0 }, `m${i}`, l.id, r.id)));
    expect(merged.filter(Boolean).length).toBe(1);
    const counts = await db.unsafe(`SELECT level, block_index, count(*)::int AS n FROM ${prefix}blocks GROUP BY 1, 2 ORDER BY 1, 2`);
    expect(counts.map((c: any) => `${c.level}:${c.block_index}=${c.n}`)).toEqual(['0:0=1', '0:1=1', '1:0=1']);
  });

  test('ids that are not this store\'s never reach a cast: they read as missing', async () => {
    const store = await fresh();
    for (const id of ['', 'abc', '1; DROP TABLE x', '-1', '99999999999999999999999', "1' OR '1'='1"]) {
      expect(await store.block(id)).toBeNull();
      expect(await store.activity(id)).toBeNull();
      expect(await store.blocks([id])).toEqual([]);
      expect(await store.putBlock(ada, P, { level: 1, index: 0 }, 'x', id, id)).toBeNull();
    }
  });

  test('as-of built from a wall-clock instant bounds activities and blocks alike', async () => {
    const store = await fresh();
    const t = Date.UTC(2099, 2, 1, 12);
    const rows: Activity[] = [];
    for (let i = 0; i < 4; i++) rows.push(await store.append({ scope: ada, partition: P, kind: 'note', summary: `row ${i}`, at: store.cursorAt(t + i * 1000) }));
    const leaf = await store.appendLeaf(ada, P, { start: rows[0].at, end: rows[1].at, content: 'two', count: 2 }, null);
    const cut = asOfAt(store, t + 1000);
    expect((await store.activities({ select: { scope: ada }, partition: P, order: 'asc', limit: 10, asOf: cut })).map((r) => r.summary)).toEqual(['row 0']);
    expect(await store.block(leaf!.id, cut)).toBeNull();
    expect((await store.block(leaf!.id, asOfAt(store, t + 1001)))?.id).toBe(leaf!.id);
  });
});
