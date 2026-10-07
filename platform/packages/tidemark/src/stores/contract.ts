import type { AsOf } from '../asof';
import { asOfAt } from '../asof';
import type { Cursor } from '../cursor';
import type { Activity, Block, NewActivity } from '../log';
import type { MemoryStore } from '../memory';
import type { Partition, Scope } from '../scope';
import type { HistoryStore } from '../store';

/**
 * The conformance suite every store passes. It is runner-neutral: each case
 * is a name and an async function that throws on failure, so a host runs it
 * under whatever test runner it has:
 *
 *   for (const c of storeContract(makeStore)) test(c.name, c.run);
 *
 * `make` returns a fresh, empty store for each case.
 */
export interface ContractHarness {
  store: HistoryStore & Partial<MemoryStore>;
  /** Insert a leaf with no position, as legacy data has. Without it the legacy cases are skipped. */
  addLegacyLeaf?(scope: Scope, partition: Partition, leaf: { start: Cursor; end: Cursor; content: string; count: number; createdAtMs?: number }): Promise<void> | void | Block;
  close?(): Promise<void> | void;
}

export interface ContractCase {
  name: string;
  run(): Promise<void>;
}

function fail(message: string): never {
  throw new Error(message);
}
function ok(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message);
}
function eq<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${message}\n  expected ${e}\n  actual   ${a}`);
}

const P = 'default';
const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ada: Scope = { type: 'person', id: 'ada' };
const bram: Scope = { type: 'person', id: 'bram' };
const club: Scope = { type: 'group', id: 'club' };

const act = (scope: Scope, summary: string, extra: Partial<NewActivity> = {}): NewActivity => ({ scope, partition: P, kind: 'note', summary, ...extra });

/** Append `n` activities one minute apart from `fromMs`, returning them oldest first. */
async function seed(store: HistoryStore, scope: Scope, n: number, fromMs = T0, partition: Partition = P, kind = 'note'): Promise<Activity[]> {
  const out: Activity[] = [];
  for (let i = 0; i < n; i++) out.push(await store.append({ scope, partition, kind, summary: `${scope.id} ${i}`, at: store.cursorAt(fromMs + i * MIN) }));
  return out;
}

/** Append one leaf over consecutive activities, at the scope's next position. */
async function leafOver(store: HistoryStore, acts: Activity[], content = `summary of ${acts.length}`): Promise<Block> {
  const { scope, partition } = acts[0];
  const tip = await store.leafTip(scope, partition);
  const leaf = await store.appendLeaf(scope, partition, { start: acts[0].at, end: acts[acts.length - 1].at, content, count: acts.length, kinds: [...new Set(acts.map((a) => a.kind))].sort() }, tip.lastIndex);
  ok(leaf, 'appendLeaf at the read tail must land');
  return leaf;
}

/** `leaves` leaves of `per` activities each, back to back from T0. */
async function seedLeaves(store: HistoryStore, scope: Scope, leaves: number, per = 3, partition: Partition = P): Promise<Block[]> {
  const acts = await seed(store, scope, leaves * per, T0, partition);
  const out: Block[] = [];
  for (let i = 0; i < leaves; i++) out.push(await leafOver(store, acts.slice(i * per, (i + 1) * per), `leaf ${i}`));
  return out;
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const sorted = (xs: string[]) => [...xs].sort();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const summaries = (rows: Activity[]) => rows.map((r) => r.summary);
const all = (store: HistoryStore, scope: Scope, extra: Partial<Parameters<HistoryStore['activities']>[0]> = {}) => store.activities({ select: { scope }, partition: P, order: 'asc', limit: 1000, ...extra });

export function storeContract(make: () => Promise<ContractHarness>): ContractCase[] {
  const cases: ContractCase[] = [];
  const add = (name: string, body: (h: ContractHarness) => Promise<void>) =>
    cases.push({
      name,
      run: async () => {
        const h = await make();
        try {
          await body(h);
        } finally {
          await h.close?.();
        }
      },
    });

  add('log: append returns the row and it reads back by id', async ({ store }) => {
    // A host may type ids (a uuid column), so the focused task id is uuid-shaped.
    const focusedTaskId = '00000000-0000-4000-8000-000000000001';
    const a = await store.append(act(ada, 'said hello', { data: { n: 1 }, actor: { name: 'Ada', agentId: 'helper' }, ref: { table: 'messages', id: 'm1' }, tasks: [{ taskId: 't1', weight: 2 }], focusedTaskId, at: store.cursorAt(T0) }));
    ok(a.id && a.at, 'append returns an id and a cursor');
    eq(a.atMs, T0, 'atMs is the instant in milliseconds');
    const back = await store.activity(a.id);
    eq(back, a, 'activity(id) returns the same row');
    eq(back?.data, { n: 1 }, 'data round-trips');
    eq(back?.ref, { table: 'messages', id: 'm1' }, 'ref round-trips');
    eq(back?.tasks, [{ taskId: 't1', weight: 2 }], 'tasks round-trip');
    eq(await store.activity('no-such-id'), null, 'an unknown id is null, not an error');
  });

  add('log: order, limit and kinds', async ({ store }) => {
    await seed(store, ada, 5);
    await store.append(act(ada, 'a call', { kind: 'call', at: store.cursorAt(T0 + 10 * MIN) }));
    eq(summaries(await all(store, ada)), ['ada 0', 'ada 1', 'ada 2', 'ada 3', 'ada 4', 'a call'], 'ascending is oldest first');
    eq(summaries(await all(store, ada, { order: 'desc', limit: 2 })), ['a call', 'ada 4'], 'descending takes the newest');
    eq(summaries(await all(store, ada, { kinds: ['call'] })), ['a call'], 'kinds filters');
    eq(summaries(await all(store, ada, { kinds: [] })), [], 'an empty kinds list selects nothing');
    eq(await all(store, ada, { limit: 0 }), [], 'limit 0 returns nothing');
  });

  add('cursor: after and before are strict, from is inclusive', async ({ store }) => {
    const rows = await seed(store, ada, 4);
    eq(summaries(await all(store, ada, { after: rows[1].at })), ['ada 2', 'ada 3'], 'after is strict');
    eq(summaries(await all(store, ada, { from: rows[1].at })), ['ada 1', 'ada 2', 'ada 3'], 'from is inclusive');
    eq(summaries(await all(store, ada, { before: rows[2].at })), ['ada 0', 'ada 1'], 'before is strict');
    eq(summaries(await all(store, ada, { before: store.cursorAt(T0 + 2 * MIN) })), ['ada 0', 'ada 1'], 'a row at an instant is not before that instant');
    eq(summaries(await all(store, ada, { until: rows[1].at })), ['ada 0', 'ada 1'], 'until is inclusive');
    eq(summaries(await all(store, ada, { from: rows[2].at, until: rows[2].at })), ['ada 2'], 'from and until on one cursor select exactly its rows');
    eq(summaries(await all(store, ada, { from: store.cursorAt(T0 + 2 * MIN) })), ['ada 2', 'ada 3'], 'a row at an instant is from that instant');
    eq(summaries(await all(store, ada, { after: store.cursorAt(T0 + 2 * MIN - 1), before: store.cursorAt(T0 + 2 * MIN + 1) })), ['ada 2'], 'one millisecond either side brackets it');
  });

  add('cursor: instants outside 1970 to 9999 clamp to the ends instead of failing', async ({ store }) => {
    const rows = await seed(store, ada, 2);
    eq(summaries(await all(store, ada, { from: store.cursorAt(-1e15), before: store.cursorAt(1e18) })), ['ada 0', 'ada 1'], 'a far range reads everything');
    eq(summaries(await all(store, ada, { before: store.cursorAt(-5) })), [], 'before the epoch is nothing');
    ok(rows.length === 2, 'seeded');
  });

  add('cursor: rows sharing one stamp keep insertion order and move together', async ({ store }) => {
    const at = store.cursorAt(T0 + MIN);
    await store.append(act(ada, 'before', { at: store.cursorAt(T0) }));
    for (const s of ['tie a', 'tie b', 'tie c']) await store.append(act(ada, s, { at }));
    await store.append(act(ada, 'after', { at: store.cursorAt(T0 + 2 * MIN) }));
    const rows = await all(store, ada);
    eq(summaries(rows), ['before', 'tie a', 'tie b', 'tie c', 'after'], 'ties keep insertion order');
    eq(summaries(await all(store, ada, { order: 'desc' })), ['after', 'tie c', 'tie b', 'tie a', 'before'], 'descending reverses ties too');
    ok(rows[1].at === rows[2].at && rows[2].at === rows[3].at, 'tied rows carry equal cursors');
    eq(summaries(await all(store, ada, { after: rows[2].at })), ['after'], 'after a tied cursor skips the whole run');
    eq(summaries(await all(store, ada, { from: rows[2].at, before: store.cursorAt(T0 + 2 * MIN) })), ['tie a', 'tie b', 'tie c'], 'from a tied cursor takes the whole run');
    eq(summaries(await all(store, ada, { from: rows[2].at, until: rows[2].at })), ['tie a', 'tie b', 'tie c'], 'from and until on a tied cursor take exactly the run');
  });

  add('cursor: a cursor read back from a row bounds exactly, below a millisecond', async ({ store }) => {
    // Appended at the store's own clock in a burst: several land inside one
    // millisecond. A bound that lost sub-millisecond precision would re-read
    // or skip a neighbour.
    const rows: Activity[] = [];
    for (let i = 0; i < 12; i++) rows.push(await store.append(act(ada, `burst ${i}`)));
    const read = await all(store, ada);
    eq(ids(read), ids(rows), 'the burst reads back in append order');
    for (let i = 0; i < rows.length; i++) {
      const later = rows.filter((r, j) => j > i && r.at !== rows[i].at);
      eq(ids(await all(store, ada, { after: rows[i].at })), ids(later), `after row ${i} returns exactly the rows after it`);
      const fromHere = rows.filter((r, j) => j >= i || r.at === rows[i].at);
      eq(ids(await all(store, ada, { from: rows[i].at })), ids(fromHere), `from row ${i} includes it`);
    }
  });

  add('selectors: scope, anyOf, types, all-except', async ({ store }) => {
    await seed(store, ada, 1, T0);
    await seed(store, bram, 1, T0 + MIN);
    await seed(store, club, 1, T0 + 2 * MIN);
    const read = async (select: Parameters<HistoryStore['activities']>[0]['select']) => summaries(await store.activities({ select, partition: P, order: 'asc', limit: 100 }));
    eq(await read({ scope: bram }), ['bram 0'], 'one scope');
    eq(await read({ anyOf: [ada, club] }), ['ada 0', 'club 0'], 'anyOf');
    eq(await read({ anyOf: [] }), [], 'an empty anyOf selects nothing');
    eq(await read({ types: ['person'] }), ['ada 0', 'bram 0'], 'types');
    eq(await read({ all: true }), ['ada 0', 'bram 0', 'club 0'], 'all');
    eq(await read({ all: true, except: ['group'] }), ['ada 0', 'bram 0'], 'all except');
    eq(await read({ scope: { type: 'person', id: 'ada:x' } }), [], 'a scope id is compared whole');
  });

  add('partition: no read crosses the wall', async ({ store }) => {
    const mine = await seed(store, ada, 6, T0, 'north');
    const theirs = await seed(store, ada, 6, T0, 'south');
    const north = await leafOver(store, mine.slice(0, 3), 'north leaf');
    const south = await leafOver(store, theirs.slice(0, 3), 'south leaf');
    const read = (partition: Partition) => store.activities({ select: { all: true }, partition, order: 'asc', limit: 100 });
    eq(ids(await read('north')), ids(mine), 'activities stay in their partition');
    eq(ids(await read('elsewhere')), [], 'an unknown partition is empty');
    eq((await store.leafTip(ada, 'north')).lastIndex, 0, 'each partition has its own tree');
    eq(ids(await store.treeIndex(ada, 'north', {})), [north.id], 'treeIndex stays in its partition');
    eq(ids(await store.leaves({ select: { all: true }, partition: 'south', endedBefore: store.cursorAt(T0 + 60 * MIN), limit: 10 })), [south.id], 'leaves stay in their partition');
    eq((await store.blockAt(ada, 'south', { level: 0, index: 0 }))?.id, south.id, 'blockAt reads its own partition');
    eq(await store.blockAt(ada, 'elsewhere', { level: 0, index: 0 }), null, 'blockAt finds nothing across the wall');
    eq(ids(await store.activitiesIn(north)), ids(mine.slice(0, 3)), 'a leaf opens only its own partition rows');
    eq((await store.leafHolding(theirs[1]))?.id, south.id, 'leafHolding stays in the activity partition');
    const backlog = await store.backlog({ olderThan: store.cursorAt(T0 + 60 * MIN), minCount: 1, skip: [] });
    eq(backlog.map((g) => `${g.partition}:${g.count}`).sort(), ['north:3', 'south:3'], 'backlog counts each partition apart');
    if (store.search) eq((await store.search({ select: { all: true }, partition: 'north', text: 'ada', limit: 100 })).length, 6, 'search stays in its partition');
    // A merged block cannot be built from another partition's leaves.
    const north1 = await leafOver(store, mine.slice(3, 6), 'north leaf 1');
    eq(await store.putBlock(ada, 'north', { level: 1, index: 0 }, 'crossed', north.id, south.id), null, 'putBlock refuses a child from another partition');
    eq(await store.putBlock(ada, 'south', { level: 1, index: 0 }, 'crossed', north.id, north1.id), null, 'putBlock refuses children that are not in the named partition');
  });

  add('as-of: reads see only what is strictly older than the instant', async ({ store }) => {
    // Blocks are stamped by the store's clock when written, so the activities
    // sit in the future: every instant below finds the blocks already written.
    const T = Math.ceil((Date.now() + DAY) / MIN) * MIN;
    const rows = await seed(store, ada, 9, T);
    const first = await leafOver(store, rows.slice(0, 3), 'first');
    const second = await leafOver(store, rows.slice(3, 6), 'second');
    const merged = await store.putBlock(ada, P, { level: 1, index: 0 }, 'both', first.id, second.id);
    ok(merged, 'the merge lands');
    const at = (ms: number): AsOf => asOfAt(store, ms);
    const cut = at(T + 4 * MIN); // rows 0..3 are older; row 4 is at the instant
    eq(summaries(await all(store, ada, { asOf: cut })), ['ada 0', 'ada 1', 'ada 2', 'ada 3'], 'activities are bounded strictly');
    eq((await store.activity(rows[3].id, cut))?.id, rows[3].id, 'an older activity opens');
    eq(await store.activity(rows[4].id, cut), null, 'an activity at the instant does not exist yet');
    eq(await store.activity(rows[8].id, cut), null, 'a later activity does not exist yet');
    eq((await store.block(first.id, cut))?.id, first.id, 'a leaf that ended before the instant is visible');
    eq(await store.block(second.id, cut), null, 'a leaf that ends after the instant is not');
    eq(await store.block(merged.id, cut), null, 'a merged block reaching past the instant is not');
    eq(ids(await store.blocks([first.id, second.id, merged.id], cut)), [first.id], 'blocks() applies the same bound');
    eq(await store.blockAt(ada, P, { level: 1, index: 0 }, cut), null, 'blockAt applies the same bound');
    eq((await store.blockAt(ada, P, { level: 1, index: 0 }, at(T + 6 * MIN)))?.id, merged.id, 'a merged block whose leaves all ended before the instant is visible');
    eq(await store.block(first.id, at(T + 2 * MIN)), null, 'a leaf ending exactly at the instant is not visible');
    eq(ids(await store.activitiesIn(second, at(T + 5 * MIN))), ids(rows.slice(3, 5)), 'opening a leaf never shows rows at or after the instant');
    eq(await store.leafHolding(rows[4], cut), null, 'leafHolding does not return a leaf that ends after the instant');
    eq(ids(await store.treeIndex(ada, P, { endedBefore: cut.cursor })), [first.id], 'treeIndex bounded by the instant holds only what had ended');
    if (store.search) eq(summaries(await store.search({ select: { scope: ada }, partition: P, text: 'ada', limit: 100, asOf: cut })), ['ada 3', 'ada 2', 'ada 1', 'ada 0'], 'search is bounded and newest first');
  });

  add('as-of: a block written after the instant does not exist yet, even over a stretch that had ended', async ({ store }) => {
    const rows = await seed(store, ada, 12, Math.floor((Date.now() - HOUR) / MIN) * MIN);
    const early = [await leafOver(store, rows.slice(0, 3), 'leaf 0'), await leafOver(store, rows.slice(3, 6), 'leaf 1')];
    const earlyMerge = await store.putBlock(ada, P, { level: 1, index: 0 }, 'leaves 0-1', early[0].id, early[1].id);
    ok(earlyMerge, 'the early merge lands');
    await pause(25);
    const cut = asOfAt(store, Date.now());
    await pause(25);
    const late = [await leafOver(store, rows.slice(6, 9), 'leaf 2'), await leafOver(store, rows.slice(9, 12), 'leaf 3')];
    const lateMerge = await store.putBlock(ada, P, { level: 1, index: 1 }, 'leaves 2-3', late[0].id, late[1].id);
    ok(lateMerge, 'the late merge lands');
    const top = await store.putBlock(ada, P, { level: 2, index: 0 }, 'leaves 0-3', earlyMerge.id, lateMerge.id);
    ok(top, 'the top merge lands');
    ok(rows[11].at < cut.cursor, 'every summarized activity is older than the instant');

    const existed = sorted(ids([...early, earlyMerge]));
    const everything = [...early, earlyMerge, ...late, lateMerge, top];
    eq(sorted(ids(await store.blocks(ids(everything), cut))), existed, 'blocks() hides what was written after the instant');
    eq(await store.block(late[0].id, cut), null, 'a leaf written later does not exist yet');
    eq(await store.block(top.id, cut), null, 'a merge written later over leaves that existed does not exist yet');
    eq(await store.blockAt(ada, P, { level: 1, index: 1 }, cut), null, 'blockAt applies the same bound');
    eq((await store.blockAt(ada, P, { level: 1, index: 0 }, cut))?.id, earlyMerge.id, 'a merge written before the instant is visible');
    eq(sorted(ids(await store.treeIndex(ada, P, { asOf: cut }))), existed, 'treeIndex as of the instant holds only what had been written');
    eq(sorted(ids(await store.treeIndex(ada, P, { endedBefore: cut.cursor, asOf: cut }))), existed, 'with an end bound too');
    eq(ids(await store.leaves({ select: { scope: ada }, partition: P, endedBefore: cut.cursor, limit: 10, asOf: cut })), ids([early[1], early[0]]), 'leaves() as of the instant, newest first');
    eq(await store.leafHolding(rows[7], cut), null, 'no leaf held an activity whose leaf was written later');
    eq((await store.leafHolding(rows[1], cut))?.id, early[0].id, 'a leaf written before the instant still holds its activities');
    eq(ids(await store.activitiesIn(late[0], cut)), ids(rows.slice(6, 9)), 'the raw entries under a later leaf were there all along');

    await pause(25);
    const later = asOfAt(store, Date.now());
    eq(sorted(ids(await store.blocks(ids(everything), later))), sorted(ids(everything)), 'once written, every block is visible');
    eq(sorted(ids(await store.treeIndex(ada, P, { asOf: later }))), sorted(ids(everything)), 'and in the tree');
  });

  add('leaves: appendLeaf lands only at the tail the caller read', async ({ store }) => {
    eq(await store.leafTip(ada, P), { end: null, lastIndex: null, unnumbered: false }, 'an empty scope has no tip');
    const rows = await seed(store, ada, 9);
    const leaf = (i: number) => ({ start: rows[i * 3].at, end: rows[i * 3 + 2].at, content: `leaf ${i}`, count: 3 });
    eq(await store.appendLeaf(ada, P, leaf(0), 0), null, 'a tail that does not exist is refused');
    const first = await store.appendLeaf(ada, P, leaf(0), null);
    eq([first?.level, first?.index, first?.count], [0, 0, 3], 'the first leaf takes position 0');
    eq(await store.appendLeaf(ada, P, leaf(1), null), null, 'a stale tail (none) is refused');
    const second = await store.appendLeaf(ada, P, leaf(1), 0);
    eq(second?.index, 1, 'the next leaf takes the next position');
    eq(await store.appendLeaf(ada, P, leaf(2), 0), null, 'a stale tail (0) is refused');
    eq(await store.appendLeaf(ada, P, leaf(2), 5), null, 'a tail from the future is refused');
    const tip = await store.leafTip(ada, P);
    eq([tip.lastIndex, tip.unnumbered], [1, false], 'the tip follows');
    ok(tip.end === rows[5].at, 'the tip end is the last covered activity cursor, exactly');
    eq((await store.leafTip(bram, P)).lastIndex, null, 'another scope is untouched');
  });

  add('leaves: two appends racing for one position, exactly one lands', async ({ store }) => {
    const rows = await seed(store, ada, 6);
    const leaf = { start: rows[0].at, end: rows[2].at, content: 'racer', count: 3 };
    for (let round = 0; round < 5; round++) {
      const tip = await store.leafTip(ada, P);
      const landed = await Promise.all(Array.from({ length: 6 }, (_, i) => store.appendLeaf(ada, P, { ...leaf, content: `racer ${round}.${i}` }, tip.lastIndex)));
      eq(landed.filter(Boolean).length, 1, `round ${round}: exactly one racer lands`);
    }
    const index = await store.treeIndex(ada, P, {});
    eq(index.map((r) => r.index).sort(), [0, 1, 2, 3, 4], 'positions are dense with no duplicate');
  });

  add('leaves: the tip is the exact end cursor, so the next window never re-reads a row', async ({ store }) => {
    // The freeze this guards against: a tip that lost sub-millisecond digits
    // sits just before the last row it covered, the next window re-reads that
    // row, and compression stalls on the overlap.
    const rows: Activity[] = [];
    for (let i = 0; i < 9; i++) rows.push(await store.append(act(ada, `burst ${i}`)));
    await leafOver(store, rows.slice(0, 5));
    const tip = await store.leafTip(ada, P);
    ok(tip.end === rows[4].at, 'the tip is the covered row cursor, exactly');
    const next = await all(store, ada, { after: tip.end! });
    eq(ids(next), ids(rows.filter((r, j) => j > 4 && r.at !== rows[4].at)), 'the next window starts strictly after the covered row');
    ok(!ids(next).includes(rows[4].id), 'the covered row is not read again');
  });

  add('backlog: counts what is older than the bound and newer than the tip', async ({ store }) => {
    const rows = await seed(store, ada, 10);
    await seed(store, bram, 2);
    await seed(store, { type: 'ticket', id: 't1' }, 10);
    const olderThan = store.cursorAt(T0 + 8 * MIN); // rows 0..7 of ada
    const list = async (minCount = 3, skip: string[] = []) => (await store.backlog({ olderThan, minCount, skip })).map((g) => `${g.scope.type}:${g.scope.id}=${g.count}`).sort();
    eq(await list(), ['person:ada=8', 'ticket:t1=8'], 'a scope under the minimum is not listed');
    eq(await list(3, ['ticket']), ['person:ada=8'], 'skipped types are never listed');
    eq(await list(2), ['person:ada=8', 'person:bram=2', 'ticket:t1=8'], 'the minimum is inclusive');
    await leafOver(store, rows.slice(0, 5));
    eq(await list(3, ['ticket']), ['person:ada=3'], 'only rows newer than the tip count');
    await leafOver(store, rows.slice(5, 7));
    eq(await list(3, ['ticket']), [], 'a remainder under the minimum drops the scope');
  });

  add('blocks: putBlock needs both children at their positions', async ({ store }) => {
    const [l0, l1, l2, l3] = await seedLeaves(store, ada, 4);
    const [other] = await seedLeaves(store, bram, 1);
    const put = (level: number, index: number, left: string, right: string, content = 'merged') => store.putBlock(ada, P, { level, index }, content, left, right);
    eq(await put(1, 0, l0.id, 'missing'), null, 'a missing child refuses the block');
    eq(await put(1, 0, 'missing', l1.id), null, 'a missing left child refuses the block');
    eq(await put(1, 0, l1.id, l0.id), null, 'children in the wrong order are refused');
    eq(await put(1, 0, l0.id, l2.id), null, 'children that are not siblings are refused');
    eq(await put(1, 1, l0.id, l1.id), null, 'children of another slot are refused');
    eq(await put(1, 0, l0.id, other.id), null, 'a child from another scope is refused');
    eq(await put(2, 0, l0.id, l1.id), null, 'leaves cannot be children of a level 2 block');
    eq(await put(0, 0, l0.id, l1.id), null, 'level 0 is not a merged block');
    const left = await put(1, 0, l0.id, l1.id, 'left pair');
    ok(left, 'a block with both children lands');
    eq([left.level, left.index, left.count, left.content], [1, 0, 6, 'left pair'], 'position, count and content');
    ok(left.start === l0.start && left.end === l1.end, 'bounds are the children bounds, exactly');
    eq([left.startMs, left.endMs], [l0.startMs, l1.endMs], 'display bounds follow');
    const right = await put(1, 1, l2.id, l3.id, 'right pair');
    ok(right, 'the sibling lands');
    const top = await put(2, 0, left.id, right.id, 'all four');
    eq([top?.level, top?.index, top?.count], [2, 0, 12], 'a block is built from merged children the same way');
    ok(top!.start === l0.start && top!.end === l3.end, 'the top block spans its whole stretch');
  });

  add('blocks: a slot holds one block; a second copy is ignored, even under a race', async ({ store }) => {
    const [l0, l1] = await seedLeaves(store, ada, 2);
    const landed = await Promise.all(Array.from({ length: 6 }, (_, i) => store.putBlock(ada, P, { level: 1, index: 0 }, `copy ${i}`, l0.id, l1.id)));
    const winners = landed.filter(Boolean) as Block[];
    eq(winners.length, 1, 'exactly one copy lands');
    eq(await store.putBlock(ada, P, { level: 1, index: 0 }, 'late copy', l0.id, l1.id), null, 'a later copy is ignored');
    const kept = await store.blockAt(ada, P, { level: 1, index: 0 });
    eq(kept?.content, winners[0].content, 'the first content stands');
    eq((await store.treeIndex(ada, P, {})).filter((r) => r.level === 1).length, 1, 'the slot holds one row');
  });

  add('blocks: kinds and tasks combine the children', async ({ store }) => {
    const a = await store.append(act(ada, 'one', { kind: 'note', tasks: [{ taskId: 't1', weight: 1 }], at: store.cursorAt(T0) }));
    const b = await store.append(act(ada, 'two', { kind: 'call', tasks: [{ taskId: 't1', weight: 3 }, { taskId: 't2', weight: 1 }], at: store.cursorAt(T0 + MIN) }));
    const l0 = await store.appendLeaf(ada, P, { start: a.at, end: a.at, content: 'x', count: 1, kinds: ['note'], tasks: a.tasks }, null);
    const l1 = await store.appendLeaf(ada, P, { start: b.at, end: b.at, content: 'y', count: 1, kinds: ['call'], tasks: b.tasks }, 0);
    eq(l0?.kinds, ['note'], 'a leaf keeps its kinds');
    const top = await store.putBlock(ada, P, { level: 1, index: 0 }, 'xy', l0!.id, l1!.id);
    eq(top?.kinds, ['call', 'note'], 'kinds are every child kind, sorted, once each');
    eq([...(top?.tasks ?? [])].sort((x, y) => x.taskId.localeCompare(y.taskId)), [{ taskId: 't1', weight: 3 }, { taskId: 't2', weight: 1 }], 'each task at its highest weight');
  });

  add('tree: index, blocks by id, blockAt, leaves', async ({ store }) => {
    const leaves = await seedLeaves(store, ada, 4);
    await seedLeaves(store, bram, 2);
    const pair = await store.putBlock(ada, P, { level: 1, index: 0 }, 'pair', leaves[0].id, leaves[1].id);
    const index = await store.treeIndex(ada, P, {});
    eq(index.map((r) => `${r.level}:${r.index}`).sort(), ['0:0', '0:1', '0:2', '0:3', '1:0'], 'the index holds every position of the scope and no other');
    eq(index.find((r) => r.id === leaves[2].id)?.endMs, leaves[2].endMs, 'index rows carry display bounds');
    const cut = await store.treeIndex(ada, P, { endedBefore: leaves[2].end });
    eq(cut.map((r) => `${r.level}:${r.index}`).sort(), ['0:0', '0:1', '1:0'], 'endedBefore is strict on the block end');
    eq(ids(await store.blocks([leaves[3].id, pair!.id, 'no-such-id'])).sort(), [leaves[3].id, pair!.id].sort(), 'blocks() returns what exists');
    eq(await store.blocks([]), [], 'blocks([]) is empty');
    eq(await store.block('no-such-id'), null, 'an unknown block id is null, not an error');
    eq((await store.block(pair!.id))?.content, 'pair', 'block(id) reads content');
    eq((await store.blockAt(ada, P, { level: 0, index: 3 }))?.id, leaves[3].id, 'blockAt finds a leaf');
    eq(await store.blockAt(ada, P, { level: 0, index: 4 }), null, 'blockAt past the tip is null');
    eq(await store.blockAt(ada, P, { level: 1, index: 1 }), null, 'blockAt an unbuilt slot is null');
    const feed = await store.leaves({ select: { all: true }, partition: P, endedBefore: store.cursorAt(T0 + 600 * MIN), limit: 100 });
    eq(feed.length, 6, 'the feed reads every scope leaves');
    ok(feed.every((b) => b.level === 0), 'and leaves only, never a merged block');
    const mine = await store.leaves({ select: { scope: ada }, partition: P, endedBefore: store.cursorAt(T0 + 600 * MIN), limit: 3 });
    eq(mine.map((b) => b.index), [3, 2, 1], 'leaves come newest first, limited');
    eq((await store.leaves({ select: { scope: ada }, partition: P, endedBefore: leaves[1].end, limit: 10 })).map((b) => b.index), [0], 'endedBefore is strict');
    eq((await store.leaves({ select: { all: true, except: ['person'] }, partition: P, endedBefore: store.cursorAt(T0 + 600 * MIN), limit: 10 })).length, 0, 'the selector applies to leaves');
  });

  add('tree: a leaf opens to exactly its activities, and an activity finds its leaf', async ({ store }) => {
    const rows = await seed(store, ada, 7);
    const first = await leafOver(store, rows.slice(0, 3));
    const second = await leafOver(store, rows.slice(3, 6));
    await seed(store, bram, 7); // same instants, another scope
    eq(ids(await store.activitiesIn(first)), ids(rows.slice(0, 3)), 'both ends are inclusive');
    eq(ids(await store.activitiesIn(second)), ids(rows.slice(3, 6)), 'neighbouring leaves do not share a row');
    eq((await store.leafHolding(rows[0]))?.id, first.id, 'the first covered row finds its leaf');
    eq((await store.leafHolding(rows[5]))?.id, second.id, 'the last covered row finds its leaf');
    eq(await store.leafHolding(rows[6]), null, 'a row no leaf covers finds none');
  });

  add('merges: scopes long enough to need them, longest first', async ({ store }) => {
    await seedLeaves(store, ada, 5);
    await seedLeaves(store, bram, 3);
    await seedLeaves(store, club, 7);
    const far = store.cursorAt(T0 + 6000 * MIN);
    const list = async (q: { endedBefore: Cursor; minLeaves: number; skip?: string[] }) => (await store.scopesNeedingMerges({ skip: [], ...q })).map((s) => s.scope.id);
    eq(await list({ endedBefore: far, minLeaves: 3 }), ['club', 'ada'], 'more than the minimum, longest first');
    eq(await list({ endedBefore: far, minLeaves: 7 }), [], 'the minimum is exclusive');
    eq(await list({ endedBefore: far, minLeaves: 3, skip: ['group'] }), ['ada'], 'skipped types are never listed');
    // Each leaf spans 3 minutes; only leaves that ended before the bound count.
    eq((await list({ endedBefore: store.cursorAt(T0 + 12 * MIN), minLeaves: 3 })).sort(), ['ada', 'club'], 'four leaves of each long scope ended before minute 12');
    eq(await list({ endedBefore: store.cursorAt(T0 + 9 * MIN), minLeaves: 3 }), [], 'three ended leaves are not more than three');
  });

  add('legacy: unnumbered leaves are deduplicated and numbered in time order', async (h) => {
    const { store } = h;
    if (!store.numberLegacyLeaves || !h.addLegacyLeaf) return;
    const rows = await seed(store, ada, 12);
    const c = (i: number) => rows[i].at;
    await leafOver(store, rows.slice(0, 3), 'numbered already');
    await h.addLegacyLeaf(ada, P, { start: c(3), end: c(5), content: 'short', count: 3, createdAtMs: T0 });
    await h.addLegacyLeaf(ada, P, { start: c(3), end: c(5), content: 'the longer copy', count: 3, createdAtMs: T0 });
    await h.addLegacyLeaf(ada, P, { start: c(4), end: c(5), content: 'a much longer summary of a contained window', count: 2, createdAtMs: T0 });
    // These two share one boundary activity: consecutive, not duplicates.
    await h.addLegacyLeaf(ada, P, { start: c(9), end: c(11), content: 'later', count: 3, createdAtMs: T0 });
    await h.addLegacyLeaf(ada, P, { start: c(6), end: c(9), content: 'earlier', count: 4, createdAtMs: T0 });
    eq((await store.leafTip(ada, P)).unnumbered, true, 'the tip reports unnumbered leaves');
    eq(await store.appendLeaf(ada, P, { start: c(11), end: c(11), content: 'x', count: 1 }, 0), null, 'no leaf is appended while any is unnumbered');
    eq(await store.numberLegacyLeaves(ada, P), { dropped: 2, numbered: 3 }, 'contained copies drop, the rest are numbered');
    const index = await store.treeIndex(ada, P, {});
    const leaves = await store.blocks(ids(index));
    eq(leaves.sort((a, b) => a.index! - b.index!).map((b) => `${b.index}:${b.content}`), ['0:numbered already', '1:the longer copy', '2:earlier', '3:later'], 'numbered after the existing leaf, in time order, keeping the longest copy');
    eq((await store.leafTip(ada, P)).unnumbered, false, 'nothing is left unnumbered');
    eq(await store.numberLegacyLeaves(ada, P), { dropped: 0, numbered: 0 }, 'running it again changes nothing');
    ok(await store.appendLeaf(ada, P, { start: c(11), end: c(11), content: 'next', count: 1 }, 3), 'the scope appends again');
  });

  add('search: substring, case-blind, newest first, literal wildcards', async ({ store }) => {
    if (!store.search) return;
    for (const [i, s] of ['Planted the Garden', 'garden party moved', '100% sure', 'a_b', 'axb', 'nothing here'].entries()) await store.append(act(ada, s, { at: store.cursorAt(T0 + i * MIN) }));
    await store.append(act(bram, 'garden elsewhere', { at: store.cursorAt(T0) }));
    const find = async (text: string, limit = 10) => summaries(await store.search!({ select: { scope: ada }, partition: P, text, limit }));
    eq(await find('GARDEN'), ['garden party moved', 'Planted the Garden'], 'case-blind, newest first, in the selected scope');
    eq(await find('garden', 1), ['garden party moved'], 'limited');
    eq(await find('100%'), ['100% sure'], 'a percent sign is literal');
    eq(await find('a_b'), ['a_b'], 'an underscore is literal');
    eq(await find('zzz'), [], 'no hit is empty');
    await store.append(act(ada, 'garden call', { kind: 'call', at: store.cursorAt(T0 - MIN) }));
    eq(summaries(await store.search!({ select: { scope: ada }, partition: P, text: 'garden', limit: 1, kinds: ['call'] })), ['garden call'], 'kinds filter before the limit');
    eq(summaries(await store.search!({ select: { scope: ada }, partition: P, text: 'garden', limit: 10, until: store.cursorAt(T0) })), ['Planted the Garden', 'garden call'], 'until is inclusive and bounds the search');
  });

  add('memory: scoped rows with seq, expiry and archive', async ({ store }) => {
    if (!store.write || !store.list || !store.edit) return;
    const w = (scope: Scope, header: string, extra: { agentId?: string; partition?: Partition; expiresAtMs?: number; createdAtMs?: number } = {}) =>
      store.write!({ agentId: extra.agentId ?? 'helper', scope, partition: extra.partition ?? P, header, content: `${header} body`, createdAtMs: extra.createdAtMs ?? T0, expiresAtMs: extra.expiresAtMs });
    const g: Scope = { type: 'global', id: 'global' };
    const m1 = await w(ada, 'likes tea');
    const m2 = await w(ada, 'on holiday', { expiresAtMs: T0 + 10 * MIN });
    const m3 = await w(g, 'be brief');
    await w(ada, 'later note', { createdAtMs: T0 + 20 * MIN });
    await w(ada, 'other agent', { agentId: 'someone-else' });
    await w(ada, 'other partition', { partition: 'south' });
    await w(bram, 'other scope');
    eq([m1.seq, m2.seq, m3.seq], [1, 2, 1], 'seq counts per agent and scope');
    const list = async (at: number, scopes: Scope[] = [ada, g]) => (await store.list!({ agentId: 'helper', scopes, partition: P, at })).map((m) => m.header);
    eq(await list(T0 + 5 * MIN), ['likes tea', 'on holiday', 'be brief'], 'scopes in the order asked, then seq; other agents, partitions and scopes stay out');
    eq(await list(T0 + 5 * MIN, [g, ada]), ['be brief', 'likes tea', 'on holiday'], 'scope order follows the request');
    eq(await list(T0 + 10 * MIN), ['likes tea', 'be brief'], 'a memory is gone at its expiry instant');
    eq(await list(T0 + 20 * MIN), ['likes tea', 'be brief'], 'a memory does not load at its creation instant (reads see what is strictly older)');
    eq(await list(T0 + 20 * MIN + 1), ['likes tea', 'later note', 'be brief'], 'it loads from the next instant');
    eq(await list(T0), [], 'nothing loads at or before the instant it was written');
    eq(await list(T0 + 5 * MIN, []), [], 'no scopes, no memories');
    await store.edit!(m1.id, { archived: true });
    await store.edit!(m2.id, { expiresAtMs: null, header: 'on holiday all month' });
    eq(await list(T0 + 30 * MIN), ['on holiday all month', 'later note', 'be brief'], 'archive hides, clearing an expiry keeps');
    const many = await Promise.all(Array.from({ length: 5 }, (_, i) => w(club, `racer ${i}`)));
    eq(many.map((m) => m.seq).sort(), [1, 2, 3, 4, 5], 'racing writers get distinct seqs');
  });

  return cases;
}
