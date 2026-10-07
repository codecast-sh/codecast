/**
 * Adversarial review: history reads over the memory store. Each test asserts
 * the behaviour the spec promises; a failure is a defect.
 */
import { describe, expect, test, setDefaultTimeout } from 'bun:test';

import { historyTools } from '../src/agent';
import { asOfAt } from '../src/asof';
import { resolveBudget } from '../src/budget';
import { bucketKinds } from '../src/collapse';
import { HistoryError, type HistoryView } from '../src/history';
import type { Activity } from '../src/log';
import { loadMemories } from '../src/memory';
import { partitionViewer, scopedViewer, type Scope } from '../src/scope';
import { DAY, HOUR, P, T0, ada, bram, world } from './helpers';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

/** Every activity is visible in the view: as its own raw line, inside a story line, or inside a rendered block's span. */
function covered(view: HistoryView, acts: Activity[]): string[] {
  const missing: string[] = [];
  for (const a of acts) {
    const hit = view.handles.some((h) => h.handle === `a:${a.id}` || ((h.kind === 'block' || h.kind === 'story') && h.range[0] <= a.atMs && a.atMs <= h.range[1]));
    if (!hit) missing.push(a.summary);
  }
  return missing;
}

const steer = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HistoryError) return e.message;
    throw e;
  }
  return '(no error)';
};

describe('review: one continuous timeline in a scoped read', () => {
  test('a leaf that straddles the 14-day raw boundary: its older activities vanish from the view', async () => {
    const w = world({}, 40);
    const now = w.clock.now();
    const acts = [
      await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'old A', at: w.store.cursorAt(now - 15 * DAY) }),
      await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'old B', at: w.store.cursorAt(now - 15 * DAY + HOUR) }),
      await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'newer C', at: w.store.cursorAt(now - 13 * DAY) }),
    ];
    await w.compress();
    expect((await w.store.treeIndex(ada, P, {})).length).toBe(1);
    const view = await w.history.view({ select: { scope: ada }, viewer: scopedViewer('x', ada) });
    expect({ missing: covered(view, acts), truncated: view.truncated }).toEqual({ missing: [], truncated: undefined });
  });

  test('fewer than minActivities left after the last leaf, older than the raw window: never shown', async () => {
    const w = world({}, 40);
    const now = w.clock.now();
    const acts = [
      await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'lonely 1', at: w.store.cursorAt(now - 20 * DAY) }),
      await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'lonely 2', at: w.store.cursorAt(now - 20 * DAY + HOUR) }),
    ];
    await w.compress();
    const view = await w.history.view({ select: { scope: ada }, viewer: scopedViewer('x', ada) });
    expect(covered(view, acts)).toEqual([]);
  });

  test('a compress:false scope type older than the raw window reads as empty', async () => {
    const w = world({}, 40);
    const ticket: Scope = { type: 'ticket', id: 't1' };
    const acts = [await w.store.append({ scope: ticket, partition: P, kind: 'note', summary: 'ticket opened', at: w.store.cursorAt(w.clock.now() - 20 * DAY) })];
    await w.compress();
    const view = await w.history.view({ select: { scope: ticket }, viewer: scopedViewer('x', ticket) });
    expect(covered(view, acts)).toEqual([]);
  });

  test('rawWindow age 0 with an uncompressed recent tail: the tail vanishes and truncated is not set', async () => {
    const w = world({}, 40);
    const now = w.clock.now();
    const acts = [];
    for (let i = 0; i < 3; i++) acts.push(await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `recent ${i}`, at: w.store.cursorAt(now - HOUR + i) }));
    const view = await w.history.view({ select: { scope: ada }, viewer: scopedViewer('x', ada), budget: { rawWindow: { kind: 'age', ms: 0 } } });
    // Either shown, or the read says it cut something.
    expect(covered(view, acts).length === 0 || !!view.truncated).toBe(true);
  });
});

describe('review: compression of tied runs', () => {
  test('a run of more than 1000 rows sharing one stamp: the rest of the run is never summarized', async () => {
    const w = world({}, 40);
    const at = w.store.cursorAt(w.clock.now() - 30 * DAY);
    for (let i = 0; i < 1100; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `tied ${i}`, at });
    for (let i = 0; i < 3; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `later ${i}`, at: w.store.cursorAt(w.clock.now() - 29 * DAY + i) });
    await w.compress();
    const leaves = (await w.store.treeIndex(ada, P, {})).filter((r) => r.level === 0);
    const total = (await w.store.blocks(leaves.map((l) => l.id))).reduce((n, b) => n + b.count, 0);
    expect(total).toBe(1103);
  });
});

describe('review: stories', () => {
  test('a story printed by a scoped read of an off-feed scope type cannot be opened', async () => {
    const ticket: Scope = { type: 'ticket', id: 't1' };
    const w = world({ collapse: { aggregateKey: bucketKinds(['ping']) } }, 1);
    for (let i = 0; i < 4; i++) await w.store.append({ scope: ticket, partition: P, kind: 'ping', summary: `ping ${i}`, at: w.store.cursorAt(w.clock.now() - 3 * HOUR + i * 60_000) });
    const viewer = scopedViewer('x', ticket);
    const view = await w.history.view({ select: { scope: ticket }, viewer });
    const story = view.handles.find((h) => h.kind === 'story');
    expect(story).toBeDefined();
    expect(await steer(w.history.open(story!.handle, { viewer }))).toBe('(no error)');
  });

  test('another scope\'s events of the same kind starve a story the viewer can read', async () => {
    const w = world({ collapse: { aggregateKey: bucketKinds(['ping']) } }, 1);
    const t = w.clock.now() - 3 * HOUR;
    await w.store.append({ scope: ada, partition: P, kind: 'ping', summary: 'ada first', at: w.store.cursorAt(t) });
    for (let i = 0; i < 600; i++) await w.store.append({ scope: bram, partition: P, kind: 'ping', summary: `bram ${i}`, at: w.store.cursorAt(t + 1 + i) });
    await w.store.append({ scope: ada, partition: P, kind: 'ping', summary: 'ada second', at: w.store.cursorAt(t + 2000) });
    await w.store.append({ scope: ada, partition: P, kind: 'ping', summary: 'ada third', at: w.store.cursorAt(t + 3000) });
    const viewer = scopedViewer('x', ada);
    const view = await w.history.view({ select: { scope: ada }, viewer });
    const story = view.handles.find((h) => h.kind === 'story')!;
    expect(view.text).toContain('(x3)');
    const opened = await w.history.open(story.handle, { viewer });
    expect(opened.stats.raw).toBe(3);
  });

  test('a story from one scope opens with other scopes\' events mixed in (partition viewer)', async () => {
    const w = world({ collapse: { aggregateKey: bucketKinds(['ping']) } }, 1);
    const t = w.clock.now() - 3 * HOUR;
    for (let i = 0; i < 3; i++) await w.store.append({ scope: ada, partition: P, kind: 'ping', summary: `ada ${i}`, at: w.store.cursorAt(t + i * 1000) });
    await w.store.append({ scope: bram, partition: P, kind: 'ping', summary: 'bram inside', at: w.store.cursorAt(t + 500) });
    const viewer = partitionViewer('op');
    const view = await w.history.view({ select: { scope: ada }, viewer });
    const story = view.handles.find((h) => h.kind === 'story')!;
    expect(view.text).toContain('(x3)');
    const opened = await w.history.open(story.handle, { viewer });
    expect(opened.text).not.toContain('bram inside');
  });
});

describe('review: line budget ceiling', () => {
  test('resolveBudget: a coverLines of 1e9 with no ceiling set anywhere is cut to the documented default 96', () => {
    expect(resolveBudget({ coverLines: 1e9 }).coverLines).toBe(96);
  });

  test('read_history lines: 5000 renders more than the 96 the tool description promises', async () => {
    const w = world({ compress: { maxActivities: 3, merges: 'complete' } }, 220);
    await w.seedDays(ada, 200, 3);
    await w.compress();
    const run = { runId: 'r', agentId: 'helper', scope: ada, partition: P, reason: 'test' };
    const [tool] = historyTools(w.history, { run, viewer: scopedViewer('helper', ada), profile: { id: 'helper' }, clock: w.clock });
    expect(tool.description).toContain('1 to 96');
    const out = await tool.run({ lines: 5000 } as never, { callId: 'c', charge: () => {}, remainingUsd: () => Infinity } as never);
    const blocks = (out as { content: string }).content.split('\n').filter((l) => l.startsWith('[block:')).length;
    expect(blocks).toBeLessThanOrEqual(96);
  });
});

describe('review: budget fills from the newest end', () => {
  test('a story line placed at its first event is dropped while older single lines are kept: the newest event is lost', async () => {
    const w = world({ collapse: { aggregateKey: bucketKinds(['ping']) } }, 1);
    const t = w.clock.now() - 50 * 60_000;
    await w.store.append({ scope: ada, partition: P, kind: 'ping', summary: 'ping first', at: w.store.cursorAt(t) });
    for (let i = 0; i < 4; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `note ${i} ${'x'.repeat(80)}`, at: w.store.cursorAt(t + (i + 1) * 60_000) });
    const newest = await w.store.append({ scope: ada, partition: P, kind: 'ping', summary: 'ping newest', at: w.store.cursorAt(t + 10 * 60_000) });
    const full = await w.history.view({ select: { scope: ada }, viewer: scopedViewer('x', ada) });
    const lineTokens = full.sections[0].lines.map((l) => Math.ceil(l.text.length / 4));
    // Budget for exactly the four notes, so the story line (index 0) falls off.
    const notes = lineTokens.slice(1).reduce((a, b) => a + b, 0);
    const view = await w.history.view({ select: { scope: ada }, viewer: scopedViewer('x', ada), budget: { tokens: Math.floor(((notes + 2) * 100) / 50), split: { raw: 50, recent: 30, older: 20 } } });
    expect(covered(view, [newest])).toEqual([]);
  });
});

describe('review: handle forgery', () => {
  test('forged handles into an unreadable scope all read as not-found, and build spends nothing', async () => {
    const w = world({ compress: { maxActivities: 3 } }, 40);
    await w.seedDays(bram, 8, 3);
    await w.compress();
    const viewer = scopedViewer('x', ada);
    const leaf = (await w.store.blockAt(bram, P, { level: 0, index: 0 }))!;
    const before = w.summarizer.mergeCalls;
    const msgs = new Set<string>();
    const norm = (m: string, h: string) => m.replace(h, '<h>');
    for (const h of [`b:0.0@person:bram`, `b:0.99@person:bram`, `b:#${leaf.id}`, `b:#nope`, 'a:a1', 'a:nope', `b:1.0@person:bram`]) {
      msgs.add(norm(await steer(w.history.open(h, { viewer })), h));
      msgs.add(norm(await steer(w.history.zoomOut(h, { viewer, build: true })), h));
    }
    expect(w.summarizer.mergeCalls).toBe(before);
    expect([...msgs]).toHaveLength(1);
  });

  test('a story handle over another scope reads the same as an empty one', async () => {
    const w = world({ collapse: { aggregateKey: bucketKinds(['ping']) } }, 1);
    const t = w.clock.now() - 3 * HOUR;
    for (let i = 0; i < 3; i++) await w.store.append({ scope: bram, partition: P, kind: 'ping', summary: `bram ${i}`, at: w.store.cursorAt(t + i) });
    const viewer = scopedViewer('x', ada);
    const a = await steer(w.history.open(`s:ping|${t}|${t + 10}`, { viewer }));
    const b = await steer(w.history.open(`s:ping|${t - 1e6}|${t - 1e5}`, { viewer }));
    expect(a.replace(/s:[^"]+/, '')).toBe(b.replace(/s:[^"]+/, ''));
  });
});

describe('review: as-of', () => {
  test('a memory created exactly at the replay cutoff loads (spec: reads see rows with time < at)', async () => {
    const w = world({}, 10);
    const cut = w.clock.now() - DAY;
    await w.store.write({ agentId: 'helper', scope: ada, partition: P, header: 'future fact', content: 'written at the cutoff', createdAtMs: cut });
    const run = { runId: 'r', agentId: 'helper', scope: ada, partition: P, reason: 'replay', asOf: asOfAt(w.store, cut) };
    const loaded = await loadMemories(w.store, run, w.clock.now());
    expect(loaded.map((m) => m.header)).toEqual([]);
  });

  test('view, focus, search, open under asOf never show a row stamped at or after the cutoff', async () => {
    const w = world({ compress: { maxActivities: 3 } }, 60);
    await w.seedDays(ada, 50, 3);
    await w.compress();
    const cutMs = T0 + 30 * DAY + 10 * HOUR; // mid-day: day 30 #0 and #1 before, #2 at 11:00 after
    const asOf = asOfAt(w.store, cutMs);
    const viewer = scopedViewer('x', ada);
    const late = (v: HistoryView) => v.handles.filter((h) => h.range[1] >= cutMs);
    expect(late(await w.history.view({ select: { scope: ada }, viewer, asOf }))).toEqual([]);
    expect(late(await w.history.focus({ select: { scope: ada }, viewer, asOf, from: T0, to: T0 + 60 * DAY }))).toEqual([]);
    expect(late(await w.history.search({ select: { scope: ada }, viewer, asOf, query: 'day' }))).toEqual([]);
    const v = await w.history.view({ select: { scope: ada }, viewer, asOf, budget: { coverLines: 4 } });
    for (const h of v.handles.filter((x) => x.kind === 'block')) {
      expect(late(await w.history.open(h.handle, { viewer, asOf }))).toEqual([]);
      expect(late(await w.history.zoomOut(h.handle, { viewer, asOf, build: true }))).toEqual([]);
    }
  });
});

describe('review: search filters after the limit', () => {
  test('a kinds lens on search applies after the store limit: an older hit of the asked kind is never found', async () => {
    const w = world({}, 1);
    const t = w.clock.now() - 3 * HOUR;
    await w.store.append({ scope: ada, partition: P, kind: 'call', summary: 'budget call', at: w.store.cursorAt(t) });
    for (let i = 0; i < 25; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `budget note ${i}`, at: w.store.cursorAt(t + 1000 + i) });
    const view = await w.history.search({ select: { scope: ada }, viewer: scopedViewer('x', ada), query: 'budget', kinds: new Set(['call']) });
    expect(view.stats.raw).toBe(1);
  });

  test('a cross-scope search by a viewer that reads one scope is starved by scopes it cannot read', async () => {
    const w = world({}, 1);
    const t = w.clock.now() - 3 * HOUR;
    await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'budget ada', at: w.store.cursorAt(t) });
    for (let i = 0; i < 25; i++) await w.store.append({ scope: bram, partition: P, kind: 'note', summary: `budget bram ${i}`, at: w.store.cursorAt(t + 1000 + i) });
    const view = await w.history.search({ select: { all: true }, viewer: scopedViewer('x', ada), query: 'budget' });
    expect(view.stats.raw).toBe(1);
  });
});
