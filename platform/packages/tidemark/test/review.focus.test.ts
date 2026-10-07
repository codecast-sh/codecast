/**
 * Adversarial review: focus over many stretches, missing merges, and
 * concurrent compression on the memory store.
 */
import { describe, expect, test, setDefaultTimeout } from 'bun:test';

import type { HistoryView } from '../src/history';
import type { Activity } from '../src/log';
import { scopedViewer } from '../src/scope';
import { blockSpan } from '../src/tree';
import { DAY, HOUR, P, T0, ada, world, type World } from './helpers';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

function audit(view: HistoryView, acts: Activity[], from: number, to: number) {
  const inside = acts.filter((a) => a.atMs >= from && a.atMs < to);
  const missing: string[] = [];
  const twice: string[] = [];
  for (const a of inside) {
    const raw = view.handles.filter((h) => h.handle === `a:${a.id}`).length;
    const blocks = view.handles.filter((h) => h.kind === 'block' && h.range[0] <= a.atMs && a.atMs <= h.range[1]).length;
    if (raw + blocks === 0) missing.push(a.summary);
    if (raw + blocks > 1) twice.push(a.summary);
  }
  return { missing, twice };
}

async function setup(dropSome: boolean): Promise<{ w: World; acts: Activity[] }> {
  const w = world({ compress: { maxActivities: 3 } }, 40);
  const acts = await w.seedDays(ada, 37, 3);
  // A raw tail younger than minAge, so it is never compressed.
  for (let i = 0; i < 3; i++) acts.push(await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `tail ${i}`, at: w.store.cursorAt(w.clock.now() - HOUR + i * 1000) }));
  await w.compress();
  if (dropSome) for (const r of await w.store.treeIndex(ada, P, {})) if (r.level > 0 && r.index! % 2 === 1) w.store.dropBlock(r.id);
  return { w, acts };
}

describe('review: focus never drops or duplicates an activity in the stretch', () => {
  for (const dropSome of [false, true]) {
    test(`stretches at every edge (missing merges: ${dropSome})`, async () => {
      const { w, acts } = await setup(dropSome);
      const viewer = scopedViewer('x', ada);
      const now = w.clock.now();
      const points = [T0 - DAY, T0, T0 + 9 * HOUR, T0 + 10 * HOUR + 1, T0 + DAY, T0 + 5 * DAY + 10 * HOUR, T0 + 16 * DAY, T0 + 36 * DAY + 10 * HOUR, T0 + 37 * DAY, now - 2 * HOUR, now - HOUR + 500, now, now + DAY];
      const failures: string[] = [];
      for (const from of points) for (const to of points) {
        if (from >= to) continue;
        for (const coverLines of [1, 2, 3, 32]) {
          const view = await w.history.focus({ select: { scope: ada }, viewer, from, to, budget: { coverLines } });
          const r = audit(view, acts, from, to);
          if (r.missing.length || r.twice.length) failures.push(`from=${from - T0} to=${to - T0} lines=${coverLines}: missing ${r.missing.slice(0, 3)} twice ${r.twice.slice(0, 3)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe('review: concurrent compressOnce on the memory store', () => {
  test('four passes at once: every activity in exactly one leaf, every slot once', async () => {
    const w = world({ compress: { maxActivities: 3, concurrency: 3 } }, 80);
    const acts = await w.seedDays(ada, 70, 3);
    w.summarizer.delayMs = 1;
    await Promise.all([w.compress(), w.compress(), w.compress(), w.compress()]);
    await Promise.all([w.compress(), w.compress()]);
    const rows = await w.store.treeIndex(ada, P, {});
    const keys = rows.map((r) => `${r.level}:${r.index}`);
    expect(new Set(keys).size).toBe(keys.length);
    const leaves = (await w.store.blocks(rows.filter((r) => r.level === 0).map((r) => r.id))).sort((a, b) => a.index! - b.index!);
    expect(leaves.map((l) => l.index)).toEqual(leaves.map((_, i) => i));
    for (const a of acts) expect(leaves.filter((l) => l.start <= a.at && a.at <= l.end).length).toBe(1);
    // Every merged block spans exactly its children.
    const all = await w.store.blocks(rows.map((r) => r.id));
    const at = new Map(all.map((b) => [`${b.level}:${b.index}`, b]));
    for (const b of all.filter((x) => x.level > 0)) {
      const [lo, hi] = blockSpan({ level: b.level, index: b.index! });
      expect(b.start).toBe(at.get(`0:${lo}`)!.start);
      expect(b.end).toBe(at.get(`0:${hi - 1}`)!.end);
    }
  });

  test('zoomOut build racing compressOnce writes each parent once and spends one merge per parent', async () => {
    const w = world({ compress: { maxActivities: 3, merges: 'cover', coverLines: 64 } }, 80);
    await w.seedDays(ada, 64, 3);
    await w.compress(); // leaves only: 64 leaves, cover 64 lines needs no merges
    expect((await w.store.treeIndex(ada, P, {})).filter((r) => r.level > 0)).toEqual([]);
    w.summarizer.delayMs = 2;
    const viewer = scopedViewer('x', ada);
    const before = w.summarizer.mergeCalls;
    await Promise.all(Array.from({ length: 6 }, () => w.history.zoomOut(`b:0.4@person:ada`, { viewer, build: true })));
    expect(w.summarizer.mergeCalls - before).toBe(1);
  });
});
