import { describe, expect, test, setDefaultTimeout } from 'bun:test';

const partial = (fields: object) => expect.objectContaining(fields);

import { asOfAt, HISTORY_TABLES } from '../src/asof';
import { fixedClock } from '../src/clock';
import { aggregate, bucketKinds, spanStamp, tally } from '../src/collapse';
import { assembleContext, historySection, memorySection } from '../src/context';
import { mergeKinds, mergeTaskTags, type Activity } from '../src/log';
import { defaultMemoryScopes, loadMemories, memoryWriteScope, renderMemories } from '../src/memory';
import { partitionOwned } from '../src/ownership';
import { dayRange, estimateTokens, formatStamp, plainRenderer } from '../src/render';
import { GLOBAL, parseScopeKey, partitionViewer, sameScope, scopeKey, scopeRegistry, scopedViewer, selects, singleScope, storeSelector } from '../src/scope';
import { memoryStore } from '../src/stores/memory';
import { DAY, HOUR, P, SCOPES, T0, ada, bram, club, viewerOf, world } from './helpers';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

describe('scope', () => {
  test('keys round-trip; only the first colon separates', () => {
    expect(scopeKey(ada)).toBe('person:ada');
    expect(parseScopeKey('person:ada')).toEqual(ada);
    expect(parseScopeKey('channel:team:general')).toEqual({ type: 'channel', id: 'team:general' });
    for (const bad of ['', 'person', ':ada', 'person:']) expect(parseScopeKey(bad)).toBeNull();
    expect(sameScope(ada, { type: 'person', id: 'ada' })).toBe(true);
    expect(sameScope(ada, bram)).toBe(false);
  });

  test('the registry applies defaults and lists what is off', () => {
    const r = scopeRegistry(SCOPES);
    expect(r.def('person')).toEqual({ type: 'person', compress: true, inGlobalFeed: true, writesGlobalMemory: false, runnable: true });
    expect(r.def('never-registered').compress).toBe(true);
    expect(r.uncompressed()).toEqual(['ticket']);
    expect(r.offFeed()).toEqual(['ticket']);
  });

  test('selectors: the feed gains the off-feed types; a single scope is recognized', () => {
    const r = scopeRegistry(SCOPES);
    expect(storeSelector({ all: true, except: ['group'] }, r)).toEqual({ all: true, except: ['group', 'ticket'] });
    expect(storeSelector({ scope: ada }, r)).toEqual({ scope: ada });
    expect(singleScope({ scope: ada })).toEqual(ada);
    expect(singleScope({ anyOf: [ada] })).toEqual(ada);
    expect(singleScope({ anyOf: [ada, bram] })).toBeNull();
    expect(singleScope({ all: true })).toBeNull();
    expect(selects({ types: ['group'] }, club)).toBe(true);
    expect(selects({ all: true, except: ['group'] }, club)).toBe(false);
    expect(selects({ anyOf: [] }, ada)).toBe(false);
  });

  test('viewers', async () => {
    expect(await scopedViewer('a', ada).canRead(ada)).toBe(true);
    expect(await scopedViewer('a', ada).canRead(bram)).toBe(false);
    expect(await scopedViewer('a', [ada, bram]).canRead(bram)).toBe(true);
    expect(scopedViewer('a', ada).partition).toBe('default');
    expect(await partitionViewer('a', 'north').canRead(club)).toBe(true);
  });
});

describe('render, log, collapse, ownership helpers', () => {
  test('stamps, ranges and token estimates', () => {
    expect(formatStamp(T0 + 9 * HOUR + 5 * 60_000)).toBe('2026-01-01 09:05');
    expect(formatStamp(T0, 'America/Los_Angeles')).toBe('2025-12-31 16:00');
    expect(formatStamp(T0, 'UTC')).toBe('2026-01-01 00:00');
    expect(dayRange(T0, T0 + HOUR)).toBe('2026-01-01');
    expect(dayRange(T0, T0 + 3 * DAY)).toBe('2026-01-01 to 2026-01-04');
    expect(spanStamp(T0, T0 + HOUR)).toBe('2026-01-01 00:00-01:00');
    expect(spanStamp(T0, T0 + DAY)).toBe('2026-01-01 00:00 to 2026-01-02 00:00');
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });

  test('the plain renderer', () => {
    const a = { id: '1', scope: ada, partition: P, kind: 'note', summary: 'hello', at: '' as Activity['at'], atMs: T0, actor: { name: 'Ada' }, data: { k: 1 } };
    const ctx = { now: T0, viewer: viewerOf(ada) };
    expect(plainRenderer.line(a, undefined, ctx)).toEqual({ text: '[2026-01-01 00:00] note: hello' });
    expect(plainRenderer.full!(a, undefined, ctx)).toBe('[2026-01-01 00:00] note by Ada: hello\n{"k":1}');
    expect(plainRenderer.full!({ ...a, actor: undefined, data: {} }, undefined, ctx)).toBe('[2026-01-01 00:00] note: hello');
  });

  test('task tags and kinds combine across rows', () => {
    expect(mergeTaskTags([[{ taskId: 'a', weight: 1 }], null, [{ taskId: 'a', weight: 3 }, { taskId: 'b', weight: 2 }], undefined])).toEqual([{ taskId: 'a', weight: 3 }, { taskId: 'b', weight: 2 }]);
    expect(mergeTaskTags([null, []])).toBeUndefined();
    expect(mergeKinds([['b', 'a'], undefined, ['a', 'c']])).toEqual(['a', 'b', 'c']);
    expect(mergeKinds([])).toBeUndefined();
  });

  test('aggregate keeps unbucketed rows apart and places a bucket at its first row', () => {
    const at = (ms: number, kind: string, summary: string): Activity => ({ id: `${ms}`, scope: ada, partition: P, kind, summary, at: '' as Activity['at'], atMs: T0 + ms });
    const groups = aggregate([at(0, 'ping', 'a'), at(1, 'note', 'n'), at(2, 'ping', 'a'), at(3, 'ping', 'b'), at(4, 'ping', 'c'), at(5, 'ping', 'd'), at(2 * HOUR, 'ping', 'later')], { aggregateKey: bucketKinds(['ping']) });
    expect(groups.map((g) => [g.kind, g.count, g.bucketed, g.summaries])).toEqual([['ping', 5, true, ['a', 'b', 'c']], ['note', 1, false, ['n']], ['ping', 1, true, ['later']]]);
    expect([groups[0].first.atMs - T0, groups[0].last.atMs - T0]).toEqual([0, 5]);
    expect(aggregate([at(0, 'ping', 'a'), at(1, 'ping', 'b')]).length).toBe(2);
  });

  test('tally counts by kind, largest first', () => {
    expect(tally([])).toBeNull();
    const census = tally([{ kind: 'a', firstMs: 5, lastMs: 5, count: 1 }, { kind: 'b', firstMs: 1, lastMs: 9, count: 3 }, { kind: 'a', firstMs: 2, lastMs: 3, count: 1 }])!;
    expect(census).toEqual({ total: 5, firstMs: 1, lastMs: 9, kinds: [{ kind: 'b', count: 3, firstMs: 1, lastMs: 9 }, { kind: 'a', count: 2, firstMs: 2, lastMs: 5 }] });
  });

  test('ownership passes everything through with no policy, no run, or an owning run', () => {
    const rows = [{ id: '1', scope: ada, partition: P, kind: 'message_in', summary: 'hi', at: '' as Activity['at'], atMs: T0 }];
    const policy = { ownedKinds: new Set(['message_in']), withholds: () => true };
    const run = { runId: 'r', agentId: 'a', scope: GLOBAL, partition: P, reason: 'tick' };
    expect(partitionOwned(rows, undefined, run).census).toBeNull();
    expect(partitionOwned(rows, policy, undefined).census).toBeNull();
    expect(partitionOwned(rows, { ...policy, withholds: () => false }, run).visible).toEqual(rows);
    const withheld = partitionOwned(rows, policy, run);
    expect(withheld.visible).toEqual([]);
    expect(withheld.census).toEqual({ total: 1, firstMs: T0, lastMs: T0, kinds: [{ kind: 'message_in', count: 1 }] });
    expect(partitionOwned([], policy, run).census).toBeNull();
  });

  test('as-of carries the store cursor for its instant', () => {
    const store = memoryStore();
    const cut = asOfAt(store, T0);
    expect(cut).toEqual({ at: T0, cursor: store.cursorAt(T0), registry: HISTORY_TABLES });
    expect(HISTORY_TABLES.activities).toBe('appendOnly');
    expect(() => store.cursorAt(NaN)).toThrow();
  });
});

describe('memory', () => {
  const registry = scopeRegistry(SCOPES);
  const run = (scope = ada, asOfMs?: number) => {
    const store = memoryStore();
    return { runId: 'r', agentId: 'helper', scope, partition: P, reason: 'tick', asOf: asOfMs === undefined ? undefined : asOfAt(store, asOfMs) };
  };

  test('a memory is written at the run scope by default; global only where the scope type allows it', () => {
    expect(memoryWriteScope(run(), registry)).toEqual(ada);
    expect(() => memoryWriteScope(run(), registry, { global: true })).toThrow('cannot write global memories');
    expect(memoryWriteScope(run(GLOBAL), registry)).toEqual(GLOBAL);
    expect(memoryWriteScope(run(GLOBAL), registry, { global: true })).toEqual(GLOBAL);
    const open = scopeRegistry([{ type: 'person', writesGlobalMemory: true }]);
    expect(memoryWriteScope(run(), open, { global: true })).toEqual(GLOBAL);
  });

  test('a run reads its own scope and global, as of its replay instant; expired and archived memories do not load', async () => {
    const store = memoryStore({ clock: fixedClock(T0) });
    const w = (scope: typeof ada, header: string, extra = {}) => store.write({ agentId: 'helper', scope, partition: P, header, content: `${header}.`, createdAtMs: T0, ...extra });
    await w(ada, 'prefers mornings');
    await w(ada, 'away this week', { expiresAtMs: T0 + 7 * DAY });
    await w(GLOBAL, 'keep replies short');
    await w(bram, 'not for this run');
    const gone = await w(ada, 'retracted');
    await store.edit(gone.id, { archived: true });
    await w(ada, 'learned later', { createdAtMs: T0 + 30 * DAY });
    expect(await defaultMemoryScopes(run())).toEqual([ada, GLOBAL]);
    expect(await defaultMemoryScopes(run(GLOBAL))).toEqual([GLOBAL]);
    const headers = async (now: number, r = run()) => (await loadMemories(store, r, now)).map((m) => m.header);
    expect(await headers(T0 + DAY)).toEqual(['prefers mornings', 'away this week', 'keep replies short']);
    expect(await headers(T0 + 40 * DAY)).toEqual(['prefers mornings', 'learned later', 'keep replies short']);
    // A replay reads memory as it stood then, whatever the wall clock says.
    expect(await headers(T0 + 40 * DAY, run(ada, T0 + DAY))).toEqual(['prefers mornings', 'away this week', 'keep replies short']);
    expect(await (async () => (await loadMemories(store, run(), T0 + DAY, () => [bram])).map((m) => m.header))()).toEqual(['not for this run']);
    expect(renderMemories(await loadMemories(store, run(), T0 + DAY))).toBe('### person:ada\n[1] prefers mornings\nprefers mornings.\n\n[2] away this week (until 2026-01-08 00:00)\naway this week.\n\n### global:global\n[1] keep replies short\nkeep replies short.');
    expect(renderMemories([])).toBeNull();
  });
});

describe('assembleContext', () => {
  const run = { runId: 'r', agentId: 'helper', scope: ada, partition: P, reason: 'tick' };

  test('stable sections come first in a long-lived block, volatile ones after; empty sections vanish', async () => {
    const ctx = await assembleContext(run, [
      { key: 'history', tier: 'volatile', render: () => 'what happened' },
      { key: 'identity', tier: 'stable', render: () => 'You are a helper.' },
      { key: 'rules', title: 'Rules', tier: 'stable', render: async () => 'Be kind.' },
      { key: 'nothing', tier: 'stable', render: () => null },
      { key: 'blank', tier: 'volatile', render: () => '' },
    ]);
    expect(ctx.systemBlocks).toEqual([{ text: 'You are a helper.\n\n## Rules\nBe kind.', ttl: '1h' }, { text: 'what happened' }]);
    expect(ctx.system).toBe('You are a helper.\n\n## Rules\nBe kind.\n\nwhat happened');
    expect(ctx.sizes).toEqual({ identity: 5, rules: 5, history: 4 });
    expect(await assembleContext(run, [])).toEqual({ system: '', systemBlocks: [], sizes: {} });
  });

  test('the history and memory sections render the run scope with the budget handed down', async () => {
    const w = world({ compress: { maxActivities: 3 } }, 120);
    await w.seedDays(ada, 100, 3);
    await w.compress();
    await w.store.write({ agentId: 'helper', scope: ada, partition: P, header: 'likes tea', content: 'Green, no sugar.', createdAtMs: T0 });
    const sections = [memorySection(w.store, { clock: w.clock }), historySection(w.history, { viewer: viewerOf(ada) })];
    const wide = await assembleContext(run, sections, {});
    const narrow = await assembleContext(run, sections, { coverLines: 4 });
    expect(wide.systemBlocks[0]).toEqual({ text: '## Memory\n### person:ada\n[1] likes tea\nGreen, no sugar.', ttl: '1h' });
    expect(wide.system).toContain('## Older History (summary)');
    expect(narrow.sizes.history).toBeLessThan(wide.sizes.history);
    expect(narrow.sizes.memory).toBe(wide.sizes.memory);
  });
});
