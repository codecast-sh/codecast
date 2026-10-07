import { describe, expect, test, setDefaultTimeout } from 'bun:test';

const partial = (fields: object) => expect.objectContaining(fields);

import { leafWindow } from '../src/compress';
import { LEAF_PROMPT, MERGE_PROMPT, promptSummarizer, type SummaryResult } from '../src/summarize';
import { blockKey, blockSpan, completeMerges, cover, pendingMerges } from '../src/tree';
import type { Scope } from '../src/scope';
import { DAY, HOUR, P, T0, ada, bram, club, viewerOf, world, type World } from './helpers';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

const far = (w: ReturnType<typeof world>) => w.store.cursorAt(T0 + 10_000 * DAY);
const index = (w: ReturnType<typeof world>, scope = ada) => w.store.treeIndex(scope, P, {});

describe('compressOnce: leaves', () => {
  test('activities younger than two hours stay raw; fewer than three make no leaf', async () => {
    const w = world();
    w.clock.set(T0 + 10 * HOUR);
    for (const h of [1, 2, 3, 7.5, 8.5, 9]) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `at ${h}`, at: w.store.cursorAt(T0 + h * HOUR) });
    await w.store.append({ scope: bram, partition: P, kind: 'note', summary: 'one', at: w.store.cursorAt(T0) });
    await w.store.append({ scope: bram, partition: P, kind: 'note', summary: 'two', at: w.store.cursorAt(T0 + 1) });
    const report = await w.compress();
    expect(report).toEqual(partial({ leaves: 1, activities: 4, leafScopes: 1, failures: 0, deadlineHit: false }));
    const [leaf] = await w.store.blocks((await index(w)).map((r) => r.id));
    expect(leaf.count).toBe(4); // 1h, 2h, 3h and 7.5h are older than two hours at 10h
    expect((await w.store.activitiesIn(leaf)).map((a) => a.summary)).toEqual(['at 1', 'at 2', 'at 3', 'at 7.5']);
    expect(await index(w, bram)).toEqual([]);
    // Nothing new is old enough: a second pass writes nothing.
    expect((await w.compress()).leaves).toBe(0);
  });

  test('a backlog drains into consecutive leaves of at most fifty, in order, each row in exactly one leaf', async () => {
    const w = world({}, 400);
    const rows = await w.seedDays(ada, 41, 3); // 123 activities
    const report = await w.compress();
    expect(report.leaves).toBe(3);
    expect(report.activities).toBe(123);
    const leaves = (await w.store.blocks((await index(w)).filter((r) => r.level === 0).map((r) => r.id))).sort((a, b) => a.index! - b.index!);
    expect(leaves.map((l) => [l.index, l.count])).toEqual([[0, 50], [1, 50], [2, 23]]);
    const covered = (await Promise.all(leaves.map((l) => w.store.activitiesIn(l)))).flat().map((a) => a.id);
    expect(covered).toEqual(rows.map((r) => r.id));
    expect(leaves[0].kinds).toEqual(['note']);
    expect(w.summarizer.leafCalls).toBe(3);
  });

  test('scope types that do not compress are never summarized', async () => {
    const w = world({}, 400);
    await w.seedDays({ type: 'ticket', id: 't1' }, 5);
    await w.seedDays(ada, 5);
    const report = await w.compress();
    expect(report.leafScopes).toBe(1);
    expect(await w.store.treeIndex({ type: 'ticket', id: 't1' }, P, {})).toEqual([]);
    expect(w.summarizer.leafCalls).toBe(1);
  });

  test('a failing summary costs that scope only, and is reported', async () => {
    const warnings: string[] = [];
    const w = world({ logger: { warn: (m) => warnings.push(m) } }, 400);
    await w.seedDays(ada, 5);
    await w.seedDays(bram, 5);
    w.summarizer.failOn = (s) => s.id === 'ada';
    const report = await w.compress();
    expect(report).toEqual(partial({ leaves: 1, failures: 1 }));
    expect(await index(w)).toEqual([]);
    expect((await index(w, bram)).length).toBe(1);
    expect(warnings).toEqual(['leaf compression failed']);
    // The failed scope is retried on the next pass and nothing is lost.
    w.summarizer.failOn = undefined;
    expect((await w.compress()).leaves).toBe(1);
  });

  test('an empty summary is a failure, never an empty leaf', async () => {
    const w = world({ summarizer: { leaf: async () => '   ', merge: async () => '' } }, 400);
    await w.seedDays(ada, 5);
    expect(await w.compress()).toEqual(partial({ leaves: 0, failures: 1 }));
    expect(await index(w)).toEqual([]);
  });

  test('a summary cut off at its output limit is a failure: nothing is written and a later pass retries it', async () => {
    const w = world({ compress: { maxActivities: 3 } }, 400);
    await w.seedDays(ada, 4, 3);
    const { leaf, merge } = w.summarizer;
    let cutLeaves = true;
    let cutMerges = true;
    w.summarizer.leaf = async (input) => (cutLeaves ? { text: 'half a summ', truncated: true } : leaf(input));
    w.summarizer.merge = async (input) => (cutMerges ? { text: 'half a merge', truncated: true } : merge(input));
    expect(await w.compress()).toEqual(partial({ leaves: 0, merged: 0, failures: 1 }));
    expect(await index(w)).toEqual([]);
    // Leaves recover; every merge over them is cut off, so none is written and each counts.
    cutLeaves = false;
    const second = await w.compress();
    expect(second).toEqual(partial({ leaves: 4, merged: 0 }));
    expect(second.failures).toBeGreaterThan(0);
    expect((await index(w)).every((r) => r.level === 0)).toBe(true);
    cutMerges = false;
    expect(await w.compress()).toEqual(partial({ merged: 3, failures: 0 }));
    expect((await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) })).text).not.toContain('half a');
  });

  test('the deadline and the budget check stop new summary calls, and say so', async () => {
    const w = world({}, 400);
    await w.seedDays(ada, 60, 3);
    const late = await w.history.compressOnce({ deadlineAt: Date.now() - 1 });
    expect(late).toEqual(partial({ leaves: 0, merged: 0, deadlineHit: true }));
    expect(w.summarizer.leafCalls).toBe(0);
    let allowance = 2;
    const broke = await w.history.compressOnce({ deadlineAt: Date.now() + 60_000, budgetCheck: () => allowance-- > 0 });
    expect(broke).toEqual(partial({ leaves: 2, budgetHit: true, deadlineHit: false }));
    // The next pass resumes exactly where this one stopped.
    const rest = await w.compress();
    expect(rest.leaves).toBe(2);
    expect((await index(w)).filter((r) => r.level === 0).map((r) => r.index).sort((a, b) => a! - b!)).toEqual([0, 1, 2, 3]);
  });
});

describe('leafWindow: rows sharing one stamp', () => {
  test('a full window whose next row ties its last drops the tied tail', async () => {
    const w = world();
    for (let i = 0; i < 4; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `early ${i}`, at: w.store.cursorAt(T0 + i) });
    for (let i = 0; i < 3; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `tied ${i}`, at: w.store.cursorAt(T0 + 100) });
    await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'last', at: w.store.cursorAt(T0 + 200) });
    const first = await leafWindow(w.store, ada, P, null, far(w), 5);
    expect(first.map((a) => a.summary)).toEqual(['early 0', 'early 1', 'early 2', 'early 3']);
    const second = await leafWindow(w.store, ada, P, first[first.length - 1].at, far(w), 5);
    expect(second.map((a) => a.summary)).toEqual(['tied 0', 'tied 1', 'tied 2', 'last']);
  });

  test('a window that is one tied run takes the whole run, so none of it is skipped', async () => {
    const w = world();
    for (let i = 0; i < 7; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `tied ${i}`, at: w.store.cursorAt(T0) });
    await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'after', at: w.store.cursorAt(T0 + 1) });
    const run = await leafWindow(w.store, ada, P, null, far(w), 3);
    expect(run.map((a) => a.summary)).toEqual(Array.from({ length: 7 }, (_, i) => `tied ${i}`));
  });

  test('rows before a tied run too few for a leaf take the whole run with them', async () => {
    const w = world();
    for (let i = 0; i < 2; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `early ${i}`, at: w.store.cursorAt(T0 + i) });
    for (let i = 0; i < 6; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `tied ${i}`, at: w.store.cursorAt(T0 + 100) });
    await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'last', at: w.store.cursorAt(T0 + 200) });
    const window = await leafWindow(w.store, ada, P, null, far(w), 5, 3);
    expect(window.map((a) => a.summary)).toEqual(['early 0', 'early 1', ...Array.from({ length: 6 }, (_, i) => `tied ${i}`)]);
    // Without a minimum the tied tail still drops, as before.
    expect((await leafWindow(w.store, ada, P, null, far(w), 5)).map((a) => a.summary)).toEqual(['early 0', 'early 1']);
  });

  test('tied rows end up in exactly one leaf each through a whole pass', async () => {
    const w = world({ compress: { maxActivities: 4 } }, 400);
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `row ${i}`, at: w.store.cursorAt(T0 + Math.floor(i / 3) * HOUR) }));
    await w.compress();
    const leaves = (await w.store.blocks((await index(w)).filter((r) => r.level === 0).map((r) => r.id))).sort((a, b) => a.index! - b.index!);
    const covered = (await Promise.all(leaves.map((l) => w.store.activitiesIn(l)))).flat().map((a) => a.id);
    expect(covered).toEqual(rows.map((r) => r.id));
    expect(leaves.reduce((n, l) => n + l.count, 0)).toBe(30);
  });
});

describe('compressOnce: merges', () => {
  test('by default builds every complete block, children first, so any budget can be served', async () => {
    const w = world({ compress: { maxActivities: 3 } }, 400);
    await w.seedDays(ada, 100, 3); // 100 leaves
    await w.seedDays(bram, 1, 3); // one leaf: nothing to merge
    const report = await w.compress();
    expect(report.leaves).toBe(101);
    expect(report.mergeScopes).toBe(1);
    const built = (await index(w)).filter((r) => r.level > 0).map((r) => blockKey({ level: r.level, index: r.index! })).sort();
    expect(built).toEqual(completeMerges(100, () => false).map(blockKey).sort());
    expect(built.length).toBe(50 + 25 + 12 + 6 + 3 + 1);
    expect(report.merged).toBe(built.length);
    // Every merged block spans exactly its children and counts their activities.
    for (const r of (await index(w)).filter((x) => x.level > 0)) {
      const b = (await w.store.block(r.id))!;
      const [lo, hi] = blockSpan({ level: b.level, index: b.index! });
      expect(b.count).toBe((hi - lo) * 3);
      expect(b.start).toBe((await w.store.blockAt(ada, P, { level: 0, index: lo }))!.start);
      expect(b.end).toBe((await w.store.blockAt(ada, P, { level: 0, index: hi - 1 }))!.end);
    }
    // A second pass has nothing left to build.
    expect((await w.compress()).merged).toBe(0);
  });

  test("merges: 'cover' builds exactly what the default cover needs, and only for scopes past the line budget", async () => {
    const w = world({ compress: { maxActivities: 3, merges: 'cover' } }, 400);
    await w.seedDays(ada, 100, 3);
    await w.seedDays(bram, 20, 3); // 20 leaves: fits 32 lines
    const report = await w.compress();
    expect(report.mergeScopes).toBe(1);
    const built = (await index(w)).filter((r) => r.level > 0).map((r) => blockKey({ level: r.level, index: r.index! })).sort();
    expect(built).toEqual(pendingMerges(100, 32, () => false).map(blockKey).sort());
    expect((await index(w, bram)).every((r) => r.level === 0)).toBe(true);
    // A dropped block the cover shows is rebuilt; one hidden under a built parent is not needed.
    const shown = cover(100, 32).find((b) => b.level >= 2)!;
    w.store.dropBlock((await w.store.blockAt(ada, P, shown))!.id);
    expect((await w.compress()).merged).toBe(1);
    w.store.dropBlock((await w.store.blockAt(ada, P, { level: shown.level - 1, index: shown.index * 2 }))!.id);
    expect((await w.compress()).merged).toBe(0);
  });

  test('only leaves that ended before the raw window count toward the cover being built', async () => {
    const w = world({ compress: { maxActivities: 3 } }, 60);
    await w.seedDays(ada, 60, 3); // 60 leaves, the last 14 days of them inside the raw window
    const report = await w.compress();
    expect(report.leaves).toBe(60);
    const ended = (await index(w)).filter((r) => r.level === 0 && r.endMs < w.clock.now() - 14 * DAY).length;
    expect(ended).toBe(46);
    const built = (await index(w)).filter((r) => r.level > 0).map((r) => blockKey({ level: r.level, index: r.index! })).sort();
    expect(built).toEqual(completeMerges(ended, () => false).map(blockKey).sort());
  });

  test('a dropped merged block is rebuilt on the next pass', async () => {
    const w = world({ compress: { maxActivities: 3 } }, 400);
    await w.seedDays(ada, 100, 3);
    await w.compress();
    const victim = (await index(w)).find((r) => r.level === 3)!;
    w.store.dropBlock(victim.id);
    expect((await w.compress()).merged).toBe(1);
    expect(await w.store.blockAt(ada, P, { level: 3, index: victim.index! })).not.toBeNull();
  });

  test('two passes at once never write a slot twice and lose nothing', async () => {
    const w = world({ compress: { maxActivities: 3, concurrency: 4 } }, 400);
    w.summarizer.delayMs = 1;
    const rows = { ada: await w.seedDays(ada, 80, 3), bram: await w.seedDays(bram, 50, 3), club: await w.seedDays(club, 40, 3) };
    const reports = await Promise.all([w.compress(), w.compress(), w.compress()]);
    // Whatever the interleaving, a later quiet pass finishes the job.
    await w.compress();
    for (const [scope, seeded] of [[ada, rows.ada], [bram, rows.bram], [club, rows.club]] as const) {
      const idx = await index(w, scope);
      const keys = idx.map((r) => blockKey({ level: r.level, index: r.index! }));
      expect(new Set(keys).size).toBe(keys.length);
      const leaves = (await w.store.blocks(idx.filter((r) => r.level === 0).map((r) => r.id))).sort((a, b) => a.index! - b.index!);
      expect(leaves.map((l) => l.index)).toEqual(Array.from({ length: leaves.length }, (_, i) => i));
      const covered = (await Promise.all(leaves.map((l) => w.store.activitiesIn(l)))).flat().map((a) => a.id);
      expect(covered).toEqual(seeded.map((r) => r.id));
    }
    expect(reports.reduce((n, r) => n + r.leaves, 0)).toBe(80 + 50 + 40);
    expect(reports.every((r) => r.failures === 0)).toBe(true);
  }, 60_000);

  test('concurrency is bounded', async () => {
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return 'summary';
    };
    const w = world({ summarizer: { leaf: slow, merge: slow }, compress: { concurrency: 3 } }, 400);
    for (let i = 0; i < 10; i++) await w.seedDays({ type: 'person', id: `p${i}` }, 3);
    await w.compress();
    expect(peak).toBe(3);
  });
});

describe('compressOnce: merges keep their share', () => {
  const merged = async (w: World, scope: Scope = ada) => (await index(w, scope)).filter((r) => r.level > 0).map((r) => blockKey({ level: r.level, index: r.index! }));
  /** Scopes whose leaves are built and whose merges are all missing. */
  const pendingMergesIn = async (w: World, scopes: Scope[], days: number) => {
    for (const s of scopes) await w.seedDays(s, days, 3);
    await w.compress();
    for (const s of scopes) for (const r of (await index(w, s)).filter((x) => x.level > 0)) w.store.dropBlock(r.id);
  };
  const people = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i): Scope => ({ type: 'person', id: `${prefix}${i}` }));
  const pass = (w: World, ms: number) => w.history.compressOnce({ deadlineAt: Date.now() + ms });

  test('a leaf backlog longer than the deadline still merges on every call, and the report shows the split', async () => {
    const w = world({ compress: { maxActivities: 3, concurrency: 4 } }, 400);
    await pendingMergesIn(w, [ada], 64); // 63 merges owed
    await Promise.all(people(20).map((s) => w.seedDays(s, 30, 3))); // 600 leaves owed
    w.summarizer.delayMs = 5;
    const report = await pass(w, 150);
    expect(report.leaves).toBeGreaterThan(0);
    expect(report.leaves).toBeLessThan(600);
    expect(report.merged).toBeGreaterThan(0);
    expect(report.deadlineHit).toBe(true);
    expect(report.phases.leaves).toEqual(partial({ count: report.leaves, shareHit: true }));
    expect(report.phases.merges).toEqual(partial({ count: report.merged, shareHit: true }));
    expect(report.phases.merges.ms).toBeGreaterThanOrEqual(150);
  });

  test('under one reserved slot, merges get the last share of the window and calls stay one at a time', async () => {
    let active = 0;
    let peak = 0;
    const w = world({ compress: { maxActivities: 3, concurrency: 1 } }, 400);
    await pendingMergesIn(w, [ada], 32);
    await Promise.all(people(10).map((s) => w.seedDays(s, 30, 3))); // 300 leaves owed
    const { leaf, merge } = w.summarizer;
    const slow = <A,>(fn: (a: A) => Promise<SummaryResult>) => async (a: A) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return fn(a);
    };
    w.summarizer.leaf = slow(leaf);
    w.summarizer.merge = slow(merge);
    const report = await pass(w, 200);
    expect(peak).toBe(1);
    expect(report.merged).toBeGreaterThan(0);
    expect(report.phases.leaves).toEqual(partial({ shareHit: true }));
    // One slot, so the merges ran in the window's tail after the leaves stopped.
    expect(report.phases.leaves.ms).toBeLessThan(report.phases.merges.ms);
  });

  test('repeated short calls finish every merge while the leaves keep up', async () => {
    const w = world({ compress: { maxActivities: 3, concurrency: 4 } }, 400);
    const scopes = [ada, ...people(12)];
    await pendingMergesIn(w, [ada], 64);
    await Promise.all(people(12).map((s) => w.seedDays(s, 32, 3)));
    w.summarizer.delayMs = 5;
    const calls = [];
    for (let i = 0; i < 60; i++) {
      const owed = (await Promise.all(scopes.map(async (s) => completeMerges((await index(w, s)).filter((r) => r.level === 0).length, () => false).length - (await merged(w, s)).length))).reduce((a, b) => a + b, 0);
      const r = await pass(w, 250);
      calls.push(r);
      // Any call that started with a merge it could build built one.
      if (owed > 0) expect(r.merged).toBeGreaterThan(0);
      if (r.leaves === 0 && r.merged === 0) break;
    }
    expect(calls[calls.length - 1]).toEqual(partial({ leaves: 0, merged: 0, failures: 0 }));
    expect((await merged(w)).sort()).toEqual(completeMerges(64, () => false).map(blockKey).sort());
    for (const s of people(12)) expect((await merged(w, s)).sort()).toEqual(completeMerges(32, () => false).map(blockKey).sort());
  }, 120_000);

  test('with no leaf backlog merges use the whole window and every slot', async () => {
    let active = 0;
    let peak = 0;
    const slowMerge = async ({ earlier, later }: { earlier: { range: string }; later: { range: string } }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return `merged [${earlier.range}] + [${later.range}]`;
    };
    const w = world({ compress: { maxActivities: 3, concurrency: 4 } }, 400);
    await pendingMergesIn(w, people(6), 64); // 378 merges, far more than 100ms of work
    w.summarizer.merge = slowMerge;
    const report = await pass(w, 100);
    expect(report.leaves).toBe(0);
    expect(report.phases.leaves.shareHit).toBe(false);
    expect(report.phases.merges.shareHit).toBe(true);
    expect(peak).toBe(4);
    expect(report.phases.merges.ms).toBeGreaterThanOrEqual(100);
  });

  test('merges go oldest parent first, and a turn bound keeps one huge scope from taking them all', async () => {
    const w = world({ compress: { maxActivities: 3, concurrency: 1, mergesPerTurn: 2 } }, 800);
    await w.seedDays(ada, 256, 3); // 255 merges owed, the oldest history
    for (let d = 300; d < 304; d++) for (let i = 0; i < 3; i++) await w.store.append({ scope: bram, partition: P, kind: 'note', summary: `bram ${d} ${i}`, at: w.store.cursorAt(T0 + d * DAY + i * HOUR) });
    await w.compress(); // bram: 3 merges owed, newer
    for (const s of [ada, bram]) for (const r of (await index(w, s)).filter((x) => x.level > 0)) w.store.dropBlock(r.id);
    let allowance = 10;
    const report = await w.history.compressOnce({ deadlineAt: Date.now() + 60_000, budgetCheck: () => allowance-- > 0 });
    expect(report).toEqual(partial({ merged: 10, budgetHit: true, deadlineHit: false }));
    // Turns alternate: ada 2, bram 2, ada 2, bram 1, then ada alone.
    expect((await merged(w, bram)).sort()).toEqual(['1:0', '1:1', '2:0']);
    // ada's seven are the oldest complete subtree and the start of the next, children first.
    expect((await merged(w)).sort()).toEqual(['1:0', '1:1', '1:2', '1:3', '2:0', '2:1', '3:0'].sort());
  });

  test('mergeShare 0 merges only after the leaves, with every slot', async () => {
    const w = world({ compress: { maxActivities: 3, concurrency: 2, mergeShare: 0 } }, 400);
    await pendingMergesIn(w, [ada], 16);
    await w.seedDays(bram, 60, 3);
    w.summarizer.delayMs = 5;
    const late = await pass(w, 60);
    expect(late).toEqual(partial({ merged: 0, deadlineHit: true }));
    expect(late.phases.leaves.shareHit).toBe(true);
  });

  test('a slot a concurrent pass filled still counts as a child, so the parent is built', async () => {
    const w = world({ compress: { maxActivities: 3 } }, 400);
    await pendingMergesIn(w, [ada], 4); // owes 1:0, 1:1, 2:0
    const leaf = async (i: number) => (await w.store.blockAt(ada, P, { level: 0, index: i }))!.id;
    const { merge } = w.summarizer;
    let raced = false;
    w.summarizer.merge = async (input) => {
      if (!raced) {
        raced = true; // another pass lands 1:1 while this one builds 1:0
        await w.store.putBlock(ada, P, { level: 1, index: 1 }, 'theirs', await leaf(2), await leaf(3));
      }
      return merge(input);
    };
    const report = await w.compress();
    expect(report.merged).toBe(2);
    expect((await merged(w)).sort()).toEqual(['1:0', '1:1', '2:0']);
  });

  test('three passes at once over a backlog and missing merges write each slot once', async () => {
    const w = world({ compress: { maxActivities: 3, concurrency: 3 } }, 400);
    await pendingMergesIn(w, [ada, club], 40);
    await w.seedDays(bram, 50, 3);
    w.summarizer.delayMs = 1;
    await Promise.all([pass(w, 60), pass(w, 60), pass(w, 60)]);
    await Promise.all([w.compress(), w.compress()]);
    for (const s of [ada, bram, club]) {
      const keys = (await index(w, s)).map((r) => blockKey({ level: r.level, index: r.index! }));
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect((await merged(w, bram)).sort()).toEqual(completeMerges(50, () => false).map(blockKey).sort());
    expect((await merged(w)).sort()).toEqual(completeMerges(40, () => false).map(blockKey).sort());
  });
});

describe('promptSummarizer', () => {
  test('passes the default prompts and the stamped lines to the model call', async () => {
    const calls: Array<[string, string]> = [];
    const s = promptSummarizer(async (system, user) => (calls.push([system, user]), 'ok'));
    await s.leaf({ scope: ada, lines: ['[2026-01-01 09:00] note: a', '[2026-01-01 10:00] note: b'] });
    await s.merge({ scope: ada, earlier: { range: '2026-01-01', content: 'first' }, later: { range: '2026-01-02 to 2026-01-03', content: 'second' } });
    expect(calls[0]).toEqual([LEAF_PROMPT, '[2026-01-01 09:00] note: a\n[2026-01-01 10:00] note: b']);
    expect(calls[1]).toEqual([MERGE_PROMPT, '[Earlier: 2026-01-01]\nfirst\n\n[Later: 2026-01-02 to 2026-01-03]\nsecond']);
    for (const p of [LEAF_PROMPT, MERGE_PROMPT]) expect(p).toContain('Never add a name, number, commitment, or outcome');
  });

  test('a call that knows its stop reason passes it through', async () => {
    const s = promptSummarizer(async () => ({ text: 'cut', truncated: true }));
    expect(await s.leaf({ scope: ada, lines: ['x'] })).toEqual({ text: 'cut', truncated: true });
  });

  test('a host passes its own prompts', async () => {
    const seen: string[] = [];
    const s = promptSummarizer(async (system) => (seen.push(system), 'ok'), { leaf: 'MY LEAF', merge: 'MY MERGE' });
    await s.leaf({ scope: ada, lines: ['x'] });
    await s.merge({ scope: ada, earlier: { range: 'a', content: 'b' }, later: { range: 'c', content: 'd' } });
    expect(seen).toEqual(['MY LEAF', 'MY MERGE']);
  });
});
