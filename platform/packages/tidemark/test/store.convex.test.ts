import { describe, expect, test, setDefaultTimeout } from 'bun:test';
import { defineSchema, makeFunctionReference, mutationGeneric, queryGeneric } from 'convex/server';
import { v } from 'convex/values';
import { convexTest } from 'convex-test';

import { storeContract } from '../src/stores/contract';
import { convexCursorAt, convexStore, convexTables, LOGS_PER_CALL, remoteStore, serveStoreOp } from '../src/stores/convex';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

/**
 * The contract runs the way a Convex host uses the store: from an action's
 * side, every call forwarded to one internal query or mutation, each its own
 * transaction under convex-test (which runs top-level functions one at a
 * time, as Convex's serializable mutations behave).
 */
const schema = defineSchema(convexTables());
const opArgs = { op: v.string(), args: v.string() };
const modules = {
  './_generated/server.ts': async () => ({}),
  './tidemark.ts': async () => ({
    read: queryGeneric({ args: opArgs, handler: (ctx, a) => serveStoreOp(convexStore(ctx.db), 'read', a.op, a.args) }),
    write: mutationGeneric({ args: opArgs, handler: (ctx, a) => serveStoreOp(convexStore(ctx.db), 'write', a.op, a.args) }),
  }),
};
const read = makeFunctionReference<'query', { op: string; args: string }, string>('tidemark:read');
const write = makeFunctionReference<'mutation', { op: string; args: string }, string>('tidemark:write');

function harness() {
  const t = convexTest(schema, modules);
  const store = remoteStore({ query: (op, args) => t.query(read, { op, args }), mutation: (op, args) => t.mutation(write, { op, args }) });
  return { t, store };
}

describe('store contract: convex', () => {
  for (const c of storeContract(async () => {
    const { store } = harness();
    return { store, addLegacyLeaf: async (...a: Parameters<typeof store.addLegacyLeaf>) => void (await store.addLegacyLeaf(...a)) };
  })) {
    test(c.name, c.run);
  }
});

describe('convex store specifics', () => {
  test('cursors are minted in the database the same way an action computes them', async () => {
    const { store } = harness();
    const at = store.cursorAt(Date.UTC(2026, 0, 1));
    expect(at).toBe(convexCursorAt(Date.UTC(2026, 0, 1)));
    const a = await store.append({ scope: { type: 'p', id: 'x' }, partition: 'default', kind: 'note', summary: 's', at });
    expect(a.at).toBe(at);
  });

  test('host data with keys Convex values refuse round-trips', async () => {
    const { store } = harness();
    const a = await store.append({ scope: { type: 'p', id: 'x' }, partition: 'default', kind: 'note', summary: 's', data: { $weird: 1, _under: [{ $ref: 'x' }] } });
    expect((await store.activity(a.id))?.data).toEqual({ $weird: 1, _under: [{ $ref: 'x' }] });
  });

  test('a read op is refused by the write function and the reverse', async () => {
    const { t } = harness();
    await expect(t.mutation(write, { op: 'activities', args: '[]' })).rejects.toThrow(/not a tidemark write call/);
    await expect(t.query(read, { op: 'append', args: '[]' })).rejects.toThrow(/not a tidemark read call/);
    await expect(t.query(read, { op: 'constructor', args: '[]' })).rejects.toThrow(/not a tidemark read call/);
  });

  test('dropLog deletes one log in batches and leaves every other log alone', async () => {
    const { store } = harness();
    const gone = { type: 'conversation', id: 'gone' };
    const kept = { type: 'conversation', id: 'kept' };
    for (const scope of [gone, kept]) {
      const rows = [];
      for (let i = 0; i < 6; i++) rows.push(await store.append({ scope, partition: 'default', kind: 'note', summary: `${scope.id} ${i}`, at: store.cursorAt(Date.UTC(2026, 0, 1) + i * 60_000) }));
      await store.appendLeaf(scope, 'default', { start: rows[0].at, end: rows[2].at, content: 'leaf', count: 3 }, null);
    }
    const first = await store.dropLog(gone, 'default', 4);
    expect(first).toEqual({ deleted: 4, done: false });
    const second = await store.dropLog(gone, 'default', 4);
    expect(second.done).toBe(true);
    expect(await store.activities({ select: { scope: gone }, partition: 'default', order: 'asc', limit: 100 })).toEqual([]);
    expect(await store.treeIndex(gone, 'default', {})).toEqual([]);
    expect(await store.backlog({ olderThan: store.cursorAt(Date.UTC(2027, 0, 1)), minCount: 1, skip: [] })).toEqual([{ scope: kept, partition: 'default', count: 3 }]);
    expect((await store.activities({ select: { scope: kept }, partition: 'default', order: 'asc', limit: 100 })).length).toBe(6);
  });

  test('a pass finds work from the log rows, a bounded number at a time, largest first', async () => {
    const { store } = harness();
    const T0 = Date.UTC(2026, 0, 1);
    const far = store.cursorAt(T0 + 1e9);
    for (let i = 0; i < LOGS_PER_CALL + 5; i++) await store.append({ scope: { type: 'p', id: `s${i}` }, partition: 'default', kind: 'note', summary: 'x', at: store.cursorAt(T0) });
    const big = { type: 'p', id: 'big' };
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(await store.append({ scope: big, partition: 'default', kind: 'note', summary: `b${i}`, at: store.cursorAt(T0 + i * 60_000) }));
    const listed = await store.backlog({ olderThan: far, minCount: 1, skip: [] });
    expect(listed).toHaveLength(LOGS_PER_CALL);
    expect(listed[0]).toEqual({ scope: big, partition: 'default', count: 6 });
    expect(await store.backlog({ olderThan: far, minCount: 2, skip: [] })).toEqual([{ scope: big, partition: 'default', count: 6 }]);
    // A leaf takes its rows off the count; a row backdated behind the leaf never counts.
    const l0 = await store.appendLeaf(big, 'default', { start: rows[0].at, end: rows[2].at, content: 'a', count: 3 }, null);
    await store.append({ scope: big, partition: 'default', kind: 'note', summary: 'late', at: store.cursorAt(T0) });
    expect(await store.backlog({ olderThan: far, minCount: 2, skip: [] })).toEqual([{ scope: big, partition: 'default', count: 3 }]);
    // Merges: listed while a block is missing, not once every block is built.
    const l1 = await store.appendLeaf(big, 'default', { start: rows[3].at, end: rows[5].at, content: 'b', count: 3 }, 0);
    expect(await store.scopesNeedingMerges({ endedBefore: far, minLeaves: 1, skip: [] })).toEqual([{ scope: big, partition: 'default' }]);
    await store.putBlock(big, 'default', { level: 1, index: 0 }, 'ab', l0!.id, l1!.id);
    expect(await store.scopesNeedingMerges({ endedBefore: far, minLeaves: 1, skip: [] })).toEqual([]);
  });

  test('inside one mutation the store works over ctx.db directly', async () => {
    const { t } = harness();
    const count = await t.run(async (ctx) => {
      const store = convexStore(ctx.db);
      const scope = { type: 'p', id: 'x' };
      for (let i = 0; i < 5; i++) await store.append({ scope, partition: 'default', kind: 'note', summary: `n${i}` });
      const rows = await store.activities({ select: { scope }, partition: 'default', order: 'asc', limit: 10 });
      return new Set(rows.map((r) => r.at)).size;
    });
    expect(count).toBe(5);
  });
});
