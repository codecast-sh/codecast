import { describe, expect, test, setDefaultTimeout } from 'bun:test';

const partial = (fields: object) => expect.objectContaining(fields);

import { asOfAt } from '../src/asof';
import { bucketKinds } from '../src/collapse';
import { HistoryError, type HistoryView } from '../src/history';
import { blockSpan } from '../src/tree';
import { DAY, HOUR, P, T0, ada, blockLines, bram, club, feedViewer, positions, rawLines, tiled, viewerOf, world, type World } from './helpers';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

/** One leaf a day: three activities a day, three to a leaf. */
const daily = { compress: { maxActivities: 3 } };

/** A scope with `days` days of history, compressed, read `after` days later. */
async function aged(days: number, after = 20, deps = {}): Promise<World> {
  const w = world({ ...daily, ...deps }, days + after);
  await w.seedDays(ada, days, 3);
  await w.compress();
  return w;
}

const steer = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HistoryError) return e.message;
    throw e;
  }
  throw new Error('expected a HistoryError');
};

const dropMerges = async (w: World, pick: (r: { level: number; index: number | null }) => boolean = () => true) => {
  for (const r of await w.store.treeIndex(ada, P, {})) if (r.level > 0 && pick(r)) w.store.dropBlock(r.id);
};

describe('invariant 1: the cover never drops the first leaf, and a missing merge keeps the span whole', () => {
  test('at 0, 1, 2 and each side of every power of two, the cover tiles [0, T) within the line budget', async () => {
    for (const T of [0, 1, 2, 31, 32, 33, 63, 64, 65, 127, 128, 129]) {
      const w = await aged(T);
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
      const at = positions(view);
      expect(at.length).toBe(Math.min(T, 32));
      if (T > 0) expect(tiled(at)).toEqual([0, T]);
      expect(view.stats.overLines).toBeUndefined();
      expect(view.truncated).toBeUndefined();
      expect(view.stats.raw).toBe(0); // everything is older than the raw window
    }
  }, 120_000);

  test('with no merge built at all, every leaf renders: more lines, never less history', async () => {
    for (const T of [33, 64, 65, 129]) {
      const w = await aged(T);
      await dropMerges(w);
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
      expect(tiled(positions(view))).toEqual([0, T]);
      expect(positions(view).every((b) => b.level === 0)).toBe(true);
      expect(view.stats.overLines).toBe(T - 32);
    }
  }, 60_000);

  test('one missing merge opens into its two halves and nothing else moves', async () => {
    const w = await aged(129);
    const whole = positions(await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) }));
    const coarse = whole.find((b) => b.level >= 2)!;
    await dropMerges(w, (r) => r.level === coarse.level && r.index === coarse.index);
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    const at = positions(view);
    expect(tiled(at)).toEqual([0, 129]);
    expect(at.length).toBe(33);
    expect(at).toContainEqual({ level: coarse.level - 1, index: coarse.index * 2 });
    expect(at).toContainEqual({ level: coarse.level - 1, index: coarse.index * 2 + 1 });
  });

  test('the oldest block starts at the first activity ever logged', async () => {
    const w = await aged(200);
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    const lines = blockLines(view);
    expect(lines.length).toBe(32);
    expect(Math.min(...lines.map((l) => l.range![0]))).toBe(T0 + 9 * HOUR);
  });

  test('any line budget from 1 up tiles the whole span', async () => {
    const w = await aged(200);
    await dropMerges(w, () => false);
    for (const coverLines of [1, 2, 3, 5, 8, 100, 200, 1000]) {
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { coverLines } });
      expect(tiled(positions(view))).toEqual([0, 200]);
    }
  });
});

describe('invariant 2: raw and compressed are one continuous timeline', () => {
  test('scoped: raw lines cover the window, blocks cover exactly what ended before it', async () => {
    const w = await aged(200, 0);
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    const boundary = w.clock.now() - 14 * DAY;
    const raw = rawLines(view);
    expect(raw.length).toBe(14 * 3);
    expect(Math.min(...raw.map((l) => l.range![0]))).toBeGreaterThanOrEqual(boundary);
    expect(tiled(positions(view))).toEqual([0, 186]);
    expect(Math.max(...blockLines(view).map((l) => l.range![1]))).toBeLessThan(boundary);
    expect(view.sections.map((s) => s.title)).toEqual(['## Recent Activity', '## Earlier History (compressed)', '## Older History (summary)']);
  });

  test('feed: the blocks begin exactly where the oldest kept raw line ends', async () => {
    const w = world(daily, 60);
    for (const s of [ada, bram, club]) await w.seedDays(s, 60, 3);
    await w.compress();
    const view = await w.history.view({ select: { all: true }, viewer: feedViewer(), budget: { tokens: 4000 } });
    expect(view.truncated?.raw).toBe(true);
    const raw = rawLines(view);
    const oldest = (await w.store.activity(raw[0].handle!.slice(2)))!;
    const shown = blockLines(view);
    expect(shown.length).toBeGreaterThan(3);
    // Nothing summarized overlaps what is shown raw...
    for (const l of shown) expect(l.range![1]).toBeLessThan(oldest.atMs);
    // ...and the summaries are the newest leaves that ended before it, with none skipped.
    const expected = await w.store.leaves({ select: { all: true }, partition: P, endedBefore: oldest.at, limit: shown.length });
    expect(new Set(shown.map((l) => l.handle))).toEqual(new Set(expected.map((b) => `b:0.${b.index}@${b.scope.type}:${b.scope.id}`)));
    // The newest summarized day is the day before the oldest raw day, for every scope.
    const newestBlockDay = Math.max(...shown.map((l) => Math.floor((l.range![1] - T0) / DAY)));
    expect(newestBlockDay).toBe(Math.floor((oldest.atMs - T0) / DAY) - 1);
  });

  test('scoped: when the token budget cuts the raw window short, blocks move up to meet it', async () => {
    const w = await aged(200, 0);
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { tokens: 400, coverLines: 400 } });
    expect(view.truncated?.raw).toBe(true);
    const oldestRaw = Math.min(...rawLines(view).map((l) => l.range![0]));
    const newestBlockEnd = Math.max(...blockLines(view).map((l) => l.range![1]));
    expect(newestBlockEnd).toBeLessThan(oldestRaw);
    expect(oldestRaw - newestBlockEnd).toBeLessThan(DAY); // the day before, not two weeks back
  });
});

describe('invariant 3: the cross-scope feed reads leaves only', () => {
  test('merged blocks exist in the scopes and never appear in the feed', async () => {
    const w = world(daily, 120);
    for (const s of [ada, bram]) await w.seedDays(s, 100, 3);
    await w.compress();
    expect((await w.store.treeIndex(ada, P, {})).some((r) => r.level > 0)).toBe(true);
    const view = await w.history.view({ select: { all: true }, viewer: feedViewer(), budget: { rawWindow: { kind: 'age', ms: 14 * DAY } } });
    expect(blockLines(view).length).toBe(200);
    expect(blockLines(view).every((l) => l.level === 0)).toBe(true);
    // The same holds for any multi-scope selector.
    const some = await w.history.view({ select: { anyOf: [ada, bram] }, viewer: feedViewer(), budget: { rawWindow: { kind: 'age', ms: 14 * DAY } } });
    expect(blockLines(some).length).toBe(200);
    expect(blockLines(some).every((l) => l.level === 0)).toBe(true);
  });

  test('scope types kept off the feed stay off it, raw and summarized', async () => {
    const w = world(daily, 30);
    await w.seedDays({ type: 'ticket', id: 't1' }, 5);
    await w.seedDays(ada, 5);
    await w.compress();
    const view = await w.history.view({ select: { all: true }, viewer: feedViewer() });
    expect(view.text).toContain('ada day 0');
    expect(view.text).not.toContain('t1 day');
  });
});

describe('invariant 4: budgets fill from the newest end; raw lines drop oldest first, summaries coarsen and then drop from the middle, never the first', () => {
  test('raw lines: a smaller budget keeps a suffix of what a larger one keeps', async () => {
    const w = await aged(200, 0);
    const texts = (v: HistoryView) => rawLines(v).map((l) => l.text);
    const full = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    let previous = texts(full);
    for (const tokens of [800, 400, 200, 100, 40]) {
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { tokens } });
      const kept = texts(view);
      expect(kept.length).toBeLessThan(previous.length);
      expect(kept).toEqual(previous.slice(previous.length - kept.length));
      expect(kept[kept.length - 1]).toBe(texts(full)[texts(full).length - 1]);
      expect(view.truncated?.raw).toBe(true);
      previous = kept;
    }
  });

  /** Block positions in reading order, oldest first. */
  const reading = (view: HistoryView) => positions(view).sort((a, b) => blockSpan(a)[0] - blockSpan(b)[0]);

  test('blocks: a token budget too small for the cover coarsens it first, so the whole span still renders', async () => {
    const w = await aged(200);
    for (const tokens of [3000, 1500, 800]) {
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { tokens } });
      expect(tiled(positions(view))).toEqual([0, 200]);
      expect(view.stats.coarsenedTo).toBeLessThan(32);
      expect(positions(view).length).toBe(view.stats.coarsenedTo!);
      expect(view.truncated).toBeUndefined();
    }
  });

  test('blocks: past the coarsest cover the middle drops, never the first block, and the read says what was cut', async () => {
    const w = await aged(200);
    for (const tokens of [400, 200, 100, 50, 10, 1, 0]) {
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { tokens } });
      const at = reading(view);
      expect(blockSpan(at[0])[0]).toBe(0);
      expect(view.stats.coarsenedTo).toBe(1);
      expect(view.truncated?.older).toBe(true);
      expect(view.stats.droppedBlocks).toBeGreaterThan(0);
      expect(view.text).toContain('The first summary reaches back to the beginning');
      // What follows the first block is one stretch ending at the newest leaf.
      if (at.length > 1) {
        expect(tiled(at.slice(1))[1]).toBe(200);
        expect(blockSpan(at[1])[0]).toBeGreaterThan(blockSpan(at[0])[1]);
      }
    }
  });

  test('a budget smaller than one block still shows the first block, clipped, and says so', async () => {
    const w = await aged(200);
    const full = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { coverLines: 1 } });
    const first = reading(full)[0];
    for (const tokens of [50, 10, 0]) {
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { tokens } });
      expect(reading(view)).toEqual([first]);
      expect(view.truncated?.firstClipped).toBe(true);
      const line = blockLines(view)[0];
      expect(line.text).toContain(`clipped to fit this read; open ${line.handle} for the whole summary`);
      expect(line.text).toContain('2026-01-01');
    }
    // A cover that is a single leaf is clipped the same way.
    const young = world(daily, 30);
    await young.seedDays(ada, 1, 3);
    await young.compress();
    const one = await young.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { tokens: 0 } });
    expect(positions(one)).toEqual([{ level: 0, index: 0 }]);
    expect(one.truncated).toEqual({ firstClipped: true });
  });

  test('the whole read stays inside its token ceiling, but for the first block', async () => {
    const w = await aged(200, 0);
    for (const tokens of [0, 1, 50, 500, 5000]) {
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { tokens } });
      // Lines are budgeted; titles and notes are fixed overhead. A clipped first block keeps its frame and the start of its summary.
      const lines = view.sections.flatMap((s) => s.lines);
      const lineTokens = lines.reduce((n, l) => n + Math.ceil(l.text.length / 4), 0);
      if (view.truncated?.firstClipped) expect(lines.filter((l) => l.kind === 'block').length).toBe(1);
      else expect(lineTokens).toBeLessThanOrEqual(tokens);
      expect(blockSpan(reading(view)[0])[0]).toBe(0);
    }
    const none = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { tokens: 0 } });
    expect(none.stats).toEqual(partial({ raw: 0, recentBlocks: 0, olderBlocks: 1 }));
    expect(rawLines(none)).toEqual([]);
  });

  test('a nonsense budget never widens a read', async () => {
    const w = await aged(100);
    const base = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    for (const budget of [{ coverLines: NaN }, { coverLines: Infinity }, { coverLines: -5 }, { coverLines: 0 }, { tokens: NaN }, { split: { raw: 500, recent: 500, older: 500 } }, { split: { raw: -1, recent: 50, older: 50 } }, { rawWindow: { kind: 'age' as const, ms: NaN } }]) {
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget });
      expect(tiled(positions(view))[0]).toBe(0);
      expect(view.stats.tokens).toBeLessThanOrEqual(Math.max(base.stats.tokens, 100_000));
      expect(positions(view).length).toBeLessThanOrEqual(1024);
    }
    // Negative tokens are no tokens: only the first block renders, clipped.
    const negative = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { tokens: -1 } });
    expect(blockLines(negative).length).toBe(1);
    expect(negative.truncated?.firstClipped).toBe(true);
    // Zero lines is read as one; 100 leaves cannot be one aligned block, so the fewest that tile them render.
    const one = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { coverLines: 0 } });
    expect(positions(one)).toEqual([{ level: 6, index: 0 }, { level: 5, index: 2 }, { level: 2, index: 24 }]);
    expect(one.stats.overLines).toBe(2);
    expect(positions(await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { coverLines: 2.9 } })).length).toBe(3); // 2 lines asked; 3 is the fewest that tile 100 leaves
  });
});

describe('invariant 5: a lens read includes no blocks', () => {
  test('filtering by kind returns raw lines of that kind and no summary of anything', async () => {
    const w = world(daily, 200);
    await w.seedDays(ada, 200, 3);
    await w.store.append({ scope: ada, partition: P, kind: 'call', summary: 'a call last week', at: w.store.cursorAt(T0 + 195 * DAY) });
    await w.store.append({ scope: ada, partition: P, kind: 'call', summary: 'a call long ago', at: w.store.cursorAt(T0 + 5 * DAY) });
    await w.compress();
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), kinds: new Set(['call']) });
    expect(rawLines(view).map((l) => l.text)).toEqual(['[2026-07-15 00:00] call: a call last week']);
    expect(blockLines(view)).toEqual([]);
    expect(view.handles.some((h) => h.kind === 'block')).toBe(false);
    expect(view.text).not.toContain('summaries');
    const focused = await w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), kinds: new Set(['call']), from: T0, to: T0 + 200 * DAY });
    expect(blockLines(focused)).toEqual([]);
    expect(rawLines(focused).map((l) => l.text)).toEqual(['[2026-01-06 00:00] call: a call long ago', '[2026-07-15 00:00] call: a call last week']);
  });
});

describe('invariant 6: summaries are labeled as secondhand, once, where they first appear', () => {
  test('the note leads the first summary section and names the tool that opens a block', async () => {
    const w = await aged(200, 0);
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    const noted = view.sections.filter((s) => s.note?.includes('AI-written summaries'));
    expect(noted.map((s) => s.title)).toEqual(['## Earlier History (compressed)']);
    expect(noted[0].note).toContain('not primary records');
    expect(noted[0].note).toContain('read_history(item: <handle>)');
    expect(noted[0].note).toContain('open it down to the raw entries and confirm it there');
    expect(view.text.split('AI-written summaries').length).toBe(2);
  });

  test('when only the older section exists the note leads that one; with no summaries there is no note', async () => {
    const w = await aged(200);
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { split: { raw: 50, recent: 0, older: 50 } } });
    // No tokens for the recent run of leaves: only the first block is left to place, and the note leads its section.
    expect(view.sections.map((s) => s.title)).toEqual(['## Older History (summary)']);
    expect(view.sections[0].note).toContain('AI-written summaries');
    const young = world(daily, 5);
    await young.seedDays(ada, 5);
    await young.compress();
    const recentOnly = await young.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    expect(recentOnly.text).not.toContain('AI-written');
    const opened = await w.history.open('b:5.0@person:ada', { viewer: viewerOf(ada) });
    expect(opened.sections[0].note).toContain('AI-written summaries');
    const custom = await aged(40, 20, { toolName: 'history' });
    expect((await custom.history.view({ select: { scope: ada }, viewer: viewerOf(ada) })).text).toContain('history(item: <handle>)');
  });
});

describe('zoom in: open', () => {
  test('a merged block opens into the two blocks it was written from', async () => {
    const w = await aged(200);
    const view = await w.history.open('b:5.1@person:ada', { viewer: viewerOf(ada) });
    expect(positions(view)).toEqual([{ level: 4, index: 2 }, { level: 4, index: 3 }]);
    expect(view.sections[0].title).toBe('## block b:5.1@person:ada opened: the blocks it was written from');
  });

  test('if a half was never built it opens further, and the span stays whole', async () => {
    const w = await aged(200);
    await dropMerges(w, (r) => r.level === 4 && r.index === 2);
    const view = await w.history.open('b:5.1@person:ada', { viewer: viewerOf(ada) });
    expect(positions(view)).toEqual([{ level: 3, index: 4 }, { level: 3, index: 5 }, { level: 4, index: 3 }]);
    expect(tiled(positions(view))).toEqual(blockSpan({ level: 5, index: 1 }));
  });

  test('a leaf opens into exactly its raw entries, each with a handle that opens in full', async () => {
    const w = await aged(200);
    const view = await w.history.open('b:0.7@person:ada', { viewer: viewerOf(ada) });
    expect(rawLines(view).map((l) => l.text)).toEqual(['[2026-01-08 09:00] note: ada day 7 #0', '[2026-01-08 10:00] note: ada day 7 #1', '[2026-01-08 11:00] note: ada day 7 #2']);
    expect(view.sections[0].title).toContain('its 3 raw entries');
    const entry = await w.history.open(view.handles[1].handle, { viewer: viewerOf(ada) });
    expect(entry.text).toContain('ada day 7 #1');
  });

  test('opening all the way down from the oldest block reaches the first raw entry', async () => {
    const w = await aged(200);
    const cover = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    let handle = blockLines(cover).sort((a, b) => a.range![0] - b.range![0])[0].handle!;
    let view = await w.history.open(handle, { viewer: viewerOf(ada) });
    let steps = 1;
    while (blockLines(view).length > 0) {
      handle = blockLines(view)[0].handle!;
      view = await w.history.open(handle, { viewer: viewerOf(ada) });
      steps++;
    }
    expect(steps).toBeGreaterThan(3);
    expect(rawLines(view)[0].text).toBe('[2026-01-01 09:00] note: ada day 0 #0');
  });

  test('a story opens into its events; an entry opens in full', async () => {
    const w = world({ collapse: { aggregateKey: bucketKinds(['ping']) } }, 1);
    for (let i = 0; i < 5; i++) await w.store.append({ scope: ada, partition: P, kind: 'ping', summary: `ping ${i}`, at: w.store.cursorAt(T0 + 9 * HOUR + i * 60_000), data: { n: i }, actor: { name: 'Ada' } });
    await w.store.append({ scope: ada, partition: P, kind: 'ping', summary: 'ping later', at: w.store.cursorAt(T0 + 11 * HOUR) });
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    expect(rawLines(view).map((l) => l.text)).toEqual([
      `[2026-01-01 09:00-09:04] ping (x5): ping 0 | ping 1 | ping 2 [story: s@person%3Aada:ping|${T0 + 9 * HOUR}|${T0 + 9 * HOUR + 4 * 60_000}]`,
      '[2026-01-01 11:00] ping: ping later',
    ]);
    expect(view.sections[0].note).toContain('aggregate routine events');
    const story = await w.history.open(view.handles[0].handle, { viewer: viewerOf(ada) });
    expect(rawLines(story).map((l) => l.text)).toEqual([0, 1, 2, 3, 4].map((i) => `[2026-01-01 09:0${i}] ping: ping ${i}`));
    const entry = await w.history.open(story.handles[2].handle, { viewer: viewerOf(ada) });
    expect(entry.text).toBe(`## Entry ${story.handles[2].handle}\n[2026-01-01 09:02] ping by Ada: ping 2\n{"n":2}`);
  });
});

describe('zoom out', () => {
  test('a block zooms out to its parent when the parent is built', async () => {
    const w = await aged(200);
    const view = await w.history.zoomOut('b:4.2@person:ada', { viewer: viewerOf(ada) });
    expect(positions(view)).toEqual([{ level: 5, index: 1 }]);
    expect(view.sections[0].title).toBe('## block b:4.2@person:ada zoomed out');
  });

  test('an unbuilt parent renders as the halves side by side, with a note; nothing is written', async () => {
    const w = await aged(200);
    await dropMerges(w, (r) => r.level === 5 && r.index === 1);
    const calls = w.summarizer.mergeCalls;
    const view = await w.history.zoomOut('b:4.3@person:ada', { viewer: viewerOf(ada) });
    expect(positions(view)).toEqual([{ level: 4, index: 2 }, { level: 4, index: 3 }]);
    expect(view.sections[0].title).toContain('not yet merged');
    expect(view.sections[0].note).toContain('has not been written yet');
    expect(w.summarizer.mergeCalls).toBe(calls);
    expect(await w.store.blockAt(ada, P, { level: 5, index: 1 })).toBeNull();
  });

  test('with build, the missing parent is written on demand with one merge call, then reused', async () => {
    const w = await aged(200);
    await dropMerges(w, (r) => r.level === 5 && r.index === 1);
    const calls = w.summarizer.mergeCalls;
    const view = await w.history.zoomOut('b:4.3@person:ada', { viewer: viewerOf(ada), build: true });
    expect(positions(view)).toEqual([{ level: 5, index: 1 }]);
    expect(w.summarizer.mergeCalls).toBe(calls + 1);
    const built = (await w.store.blockAt(ada, P, { level: 5, index: 1 }))!;
    expect(built.count).toBe(32 * 3);
    await w.history.zoomOut('b:4.2@person:ada', { viewer: viewerOf(ada), build: true });
    expect(w.summarizer.mergeCalls).toBe(calls + 1);
  });

  test('build never invents a half: a parent whose child is missing stays unbuilt', async () => {
    const w = await aged(200);
    await dropMerges(w, (r) => (r.level === 5 && r.index === 1) || (r.level === 4 && r.index === 2));
    const calls = w.summarizer.mergeCalls;
    const view = await w.history.zoomOut('b:4.3@person:ada', { viewer: viewerOf(ada), build: true });
    expect(tiled(positions(view))).toEqual(blockSpan({ level: 5, index: 1 }));
    expect(w.summarizer.mergeCalls).toBe(calls);
  });

  test('many zoom outs at once build the parent once', async () => {
    const w = await aged(200);
    await dropMerges(w, (r) => r.level === 5 && r.index === 1);
    const calls = w.summarizer.mergeCalls;
    const views = await Promise.all(Array.from({ length: 6 }, () => w.history.zoomOut('b:4.3@person:ada', { viewer: viewerOf(ada), build: true })));
    for (const v of views) expect(tiled(positions(v))).toEqual(blockSpan({ level: 5, index: 1 }));
    expect((await w.store.treeIndex(ada, P, {})).filter((r) => r.level === 5 && r.index === 1).length).toBe(1);
    expect(w.summarizer.mergeCalls).toBe(calls + 1);
  });

  test('at the newest edge, where the parent would reach past the last leaf, it shows what exists', async () => {
    const w = await aged(200); // leaves 0..199; the parent of leaf 199's level-3 block would need leaves up to 207
    const view = await w.history.zoomOut('b:3.24@person:ada', { viewer: viewerOf(ada), build: true });
    expect(tiled(positions(view))).toEqual([192, 200]);
    expect(view.sections[0].note).toContain('nothing coarser exists yet');
    const leaf = await w.history.zoomOut('b:0.199@person:ada', { viewer: viewerOf(ada) });
    expect(positions(leaf)).toEqual([{ level: 1, index: 99 }]);
    const lone = await aged(1);
    const only = await lone.history.zoomOut('b:0.0@person:ada', { viewer: viewerOf(ada), build: true });
    expect(positions(only)).toEqual([{ level: 0, index: 0 }]);
    expect(only.sections[0].note).toContain('nothing coarser exists yet');
  });

  test('zooming out to the top reaches one block over everything, then stops', async () => {
    const w = await aged(64);
    let handle = 'b:0.63@person:ada';
    for (let level = 1; level <= 6; level++) {
      const view = await w.history.zoomOut(handle, { viewer: viewerOf(ada), build: true });
      expect(positions(view)).toEqual([{ level, index: Math.floor(63 / 2 ** level) }]);
      handle = view.handles[0].handle;
    }
    expect(handle).toBe('b:6.0@person:ada');
    const top = await w.history.zoomOut(handle, { viewer: viewerOf(ada), build: true });
    expect(positions(top)).toEqual([{ level: 6, index: 0 }]);
  });

  test('an entry zooms out to the summary that covers it; a recent one says none does yet', async () => {
    const w = await aged(30, 0);
    const old = await w.history.open('b:0.3@person:ada', { viewer: viewerOf(ada) });
    const up = await w.history.zoomOut(old.handles[0].handle, { viewer: viewerOf(ada) });
    expect(positions(up)).toEqual([{ level: 0, index: 3 }]);
    const fresh = await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'just now' });
    expect(await steer(w.history.zoomOut(`a:${fresh.id}`, { viewer: viewerOf(ada) }))).toContain('no summary covers it yet');
    expect(await steer(w.history.zoomOut('s:note|1|2', { viewer: viewerOf(ada) }))).toContain('works on a block or an entry');
  });
});

describe('focus: any stretch at any resolution', () => {
  test('one month at eight lines tiles exactly the leaves of that month, finest at its end', async () => {
    const w = await aged(200);
    const from = Date.UTC(2026, 2, 1);
    const to = Date.UTC(2026, 3, 1);
    const view = await w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), from, to, budget: { coverLines: 8 } });
    const at = positions(view);
    expect(tiled(at)).toEqual([59, 90]); // March 1 is day 59 of 2026; 31 days
    expect(at.length).toBeLessThanOrEqual(8);
    expect(view.stats.overLines).toBeUndefined();
    for (const l of blockLines(view)) {
      expect(l.range![0]).toBeGreaterThanOrEqual(from);
      expect(l.range![1]).toBeLessThan(to);
    }
    const sizes = at.map(blockSpan).map(([a, b]) => b - a);
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(Math.max(...sizes));
    expect(view.sections[0].title).toBe('## Focus 2026-03-01 to 2026-03-31: summaries');
    expect(rawLines(view)).toEqual([]);
  });

  test('the same stretch at more lines is finer; at one line it is the fewest blocks that can hold it', async () => {
    const w = await aged(200);
    const read = (coverLines: number) => w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 3, 1), budget: { coverLines } });
    expect(positions(await read(31)).every((b) => b.level === 0)).toBe(true);
    expect(positions(await read(31)).length).toBe(31);
    const coarse = await read(1);
    expect(tiled(positions(coarse))).toEqual([59, 90]);
    // [59, 90) cannot be one aligned block; the fewest that tile it render, and the view says how many over.
    expect(coarse.stats.overLines).toBe(positions(coarse).length - 1);
    expect(positions(coarse).length).toBeLessThan(positions(await read(8)).length + 1);
  });

  test('the whole scope at four lines', async () => {
    const w = await aged(256);
    const view = await w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), from: 0, to: w.clock.now(), budget: { coverLines: 4 } });
    expect(tiled(positions(view))).toEqual([0, 256]);
    expect(positions(view).length).toBe(4);
  });

  test('a stretch that runs past the last summary continues as raw entries, each activity shown once', async () => {
    const w = world(daily, 100);
    await w.seedDays(ada, 100, 3);
    await w.compress();
    // Three fresh entries no leaf covers yet.
    for (let i = 0; i < 3; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `fresh ${i}`, at: w.store.cursorAt(w.clock.now() - (3 - i) * 60_000) });
    const view = await w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), from: T0 + 90 * DAY, to: w.clock.now() + DAY, budget: { coverLines: 32 } });
    expect(tiled(positions(view))).toEqual([90, 100]);
    expect(rawLines(view).map((l) => l.text.slice(19))).toEqual(['note: fresh 0', 'note: fresh 1', 'note: fresh 2']);
    expect(view.sections.map((s) => s.title)).toEqual(['## Focus 2026-04-01 to 2026-04-11: summaries', '## Focus 2026-04-01 to 2026-04-11: raw entries']);
  });

  test('a stretch with nothing in it says so; a stretch that needs one scope refuses a feed', async () => {
    const w = await aged(10);
    const empty = await w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), from: T0 - 30 * DAY, to: T0 - 20 * DAY });
    expect(empty.text).toContain('Nothing was logged in this stretch');
    expect(await steer(w.history.focus({ select: { all: true }, viewer: feedViewer(), from: 0, to: 1 }))).toContain('one scope at a time');
    expect(await steer(w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), from: 5, to: 5 }))).toContain('`from` before `to`');
    expect(await steer(w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), from: NaN, to: 5 }))).toContain('`from` before `to`');
    expect(await steer(w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), from: -500, to: -5 }))).toContain('between 1970 and 9999');
    expect(tiled(positions(await w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), from: -1e18, to: 1e18 })))).toEqual([0, 10]);
  });
});

describe('budgets: per read, then the agent profile, then the runtime default', () => {
  test('each layer overrides the one under it, field by field', async () => {
    const w = await aged(200, 20, { profiles: [{ id: 'helper', history: { coverLines: 8 } }], budget: { coverLines: 16 } });
    const lines = async (agent: string, budget?: object) => positions(await w.history.view({ select: { scope: ada }, viewer: { agentId: agent, partition: P, canRead: () => true }, budget })).length;
    expect(await lines('helper')).toBe(8);
    expect(await lines('helper', { coverLines: 12 })).toBe(12);
    expect(await lines('someone-else')).toBe(16);
    expect(await lines('helper', { tokens: 100_000 })).toBe(8);
    const plain = await aged(200);
    expect(positions(await plain.history.view({ select: { scope: ada }, viewer: viewerOf(ada) })).length).toBe(32);
  });

  test('a different budget changes the cover, not the history: both reach the first leaf', async () => {
    const w = await aged(200);
    const wide = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { coverLines: 32 } });
    const narrow = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), budget: { coverLines: 6 } });
    expect(tiled(positions(wide))).toEqual([0, 200]);
    expect(tiled(positions(narrow))).toEqual([0, 200]);
    expect(positions(narrow).length).toBeLessThan(positions(wide).length);
    expect(narrow.stats.tokens).toBeLessThan(wide.stats.tokens);
  });
});

describe('viewer: every read and every open is checked', () => {
  test('a scope the viewer cannot read is refused, and a handle into it reads as missing', async () => {
    const w = await aged(64);
    await w.seedDays(bram, 3);
    expect(await steer(w.history.view({ select: { scope: ada }, viewer: viewerOf(bram) }))).toBe('The scope person:ada is not readable from this run.');
    expect(await steer(w.history.search({ select: { scope: ada }, viewer: viewerOf(bram), query: 'ada' }))).toContain('not readable');
    expect(await steer(w.history.focus({ select: { scope: ada }, viewer: viewerOf(bram), from: 0, to: w.clock.now() }))).toContain('not readable');
    const real = (await w.store.blockAt(ada, P, { level: 0, index: 3 }))!;
    const act = (await w.store.activitiesIn(real))[0];
    const missing = await steer(w.history.open('b:0.9999@person:ada', { viewer: viewerOf(ada) }));
    for (const forged of ['b:0.3@person:ada', 'b:5.0@person:ada', `b:#${real.id}`, `a:${act.id}`]) {
      // Readable by its owner...
      expect((await w.history.open(forged, { viewer: viewerOf(ada) })).text.length).toBeGreaterThan(0);
      // ...and indistinguishable from a handle that does not exist for anyone else.
      const walled = await steer(w.history.open(forged, { viewer: viewerOf(bram) }));
      expect(walled).toBe(missing.replace('b:0.9999@person:ada', forged));
      expect(await steer(w.history.zoomOut(forged, { viewer: viewerOf(bram), build: true }))).toBe(walled);
    }
  });

  test('a forged zoom out cannot make another scope spend a summary call', async () => {
    const w = await aged(64);
    await dropMerges(w, (r) => r.level === 1 && r.index === 0);
    const calls = w.summarizer.mergeCalls;
    await steer(w.history.zoomOut('b:0.0@person:ada', { viewer: viewerOf(bram), build: true }));
    expect(w.summarizer.mergeCalls).toBe(calls);
    expect(await w.store.blockAt(ada, P, { level: 1, index: 0 })).toBeNull();
  });

  test('another partition is another world, even for a viewer that may read every scope', async () => {
    const w = await aged(64);
    const south = feedViewer('south');
    expect((await w.history.view({ select: { scope: ada }, viewer: south })).text).toBe('');
    expect((await w.history.view({ select: { all: true }, viewer: south })).text).toBe('');
    const real = (await w.store.blockAt(ada, P, { level: 0, index: 3 }))!;
    for (const handle of ['b:0.3@person:ada', `b:#${real.id}`, `a:${(await w.store.activitiesIn(real))[0].id}`, `s:note|0|${w.clock.now()}`]) {
      expect(await steer(w.history.open(handle, { viewer: south }))).toContain('No history item');
    }
    expect((await w.history.search({ select: { all: true }, viewer: south, query: 'ada' })).stats.raw).toBe(0);
  });

  test('a story and a feed show only the scopes the viewer may read', async () => {
    const w = world({ collapse: { aggregateKey: bucketKinds(['ping']) } }, 1);
    for (const s of [ada, bram, club]) for (let i = 0; i < 3; i++) await w.store.append({ scope: s, partition: P, kind: 'ping', summary: `${s.id} ping ${i}`, at: w.store.cursorAt(T0 + 9 * HOUR + i * 1000) });
    const handle = `s:ping|${T0}|${T0 + DAY}`;
    const all = await w.history.open(handle, { viewer: feedViewer() });
    expect(all.stats.raw).toBe(9);
    const mine = await w.history.open(handle, { viewer: viewerOf([bram, club]) });
    expect(rawLines(mine).every((l) => !l.text.includes('ada'))).toBe(true);
    expect(mine.stats.raw).toBe(6);
    const feed = await w.history.view({ select: { all: true }, viewer: viewerOf(bram) });
    expect(feed.text).toContain('bram ping');
    expect(feed.text).not.toContain('ada ping');
    expect(feed.text).not.toContain('club ping');
  });

  test('a viewer check that throws is a wall', async () => {
    const w = await aged(8);
    const broken = { agentId: 'x', partition: P, canRead: () => { throw new Error('lookup failed'); } };
    expect(await steer(w.history.view({ select: { scope: ada }, viewer: broken }))).toContain('not readable');
    expect((await w.history.view({ select: { all: true }, viewer: broken })).text).toBe('');
    expect(await steer(w.history.open('b:0.0@person:ada', { viewer: broken }))).toContain('No history item');
    const truthy = { agentId: 'x', partition: P, canRead: () => 'yes' as unknown as boolean };
    expect(await steer(w.history.open('b:0.0@person:ada', { viewer: truthy }))).toContain('No history item');
  });

  test('malformed and hostile handles steer; none throws anything else', async () => {
    const w = await aged(8);
    const bad = ['', '   ', 'b:', 'b:#', 'b:x.y@person:ada', 'b:-1.0@person:ada', 'b:0.-1@person:ada', 'b:0.0', 'b:0.0@', 'b:0.0@person', 'b:0.0@person:', 'b:60.0@person:ada', 'b:0.99999999999999999999@person:ada', 'b:1e3.0@person:ada', 'b:0.5.5@person:ada', 's:', 's:note', 's:note|5|1', 's:note|a|b', 's:|1|2', 'a:', 'a:nope', 'nonsense', '../../etc/passwd', "'; DROP TABLE x; --", 'b:0.0@person:ada\nb:0.1@person:ada'];
    for (const handle of bad) {
      expect(await steer(w.history.open(handle, { viewer: viewerOf(ada) }))).toContain('No history item');
      expect(typeof (await steer(w.history.zoomOut(handle, { viewer: viewerOf(ada), build: true })))).toBe('string');
    }
    for (const notAString of [null, undefined, 42, {}, []]) {
      expect(await steer(w.history.open(notAString as unknown as string, { viewer: viewerOf(ada) }))).toContain('No history item');
    }
  });
});

describe('as-of: a read at a past instant sees nothing written after it', () => {
  /**
   * Summaries are written as time passes: one pass an hour before the
   * instant, another on day 200. By default each pass builds every merge its
   * leaves allow, so the tree before the instant is complete up to leaf 99.
   */
  async function replay(passes: 'both' | 'before' = 'both', compress: object = { maxActivities: 3, rawWindowMs: 0 }) {
    const cutoff = T0 + 100 * DAY;
    const w = world({ compress }, 0);
    await w.seedDays(ada, 200, 3);
    w.clock.set(cutoff - HOUR);
    await w.compress();
    if (passes === 'both') {
      w.clock.set(T0 + 200 * DAY);
      await w.compress();
    }
    return { w, cutoff, asOf: asOfAt(w.store, cutoff) };
  }

  test('a summary written after the instant is not read, even over a stretch that had ended', async () => {
    // With the default merge boundary the first pass merges only leaves that
    // ended 14 days before it (0..85); merges over 86..99 come on day 200.
    const { w, cutoff, asOf } = await replay('both', daily.compress);
    const then = await replay('before', daily.compress);
    expect((await w.store.blockAt(ada, P, { level: 0, index: 99 }, asOf))!.createdAtMs).toBeLessThan(cutoff);
    for (const late of [{ level: 1, index: 43 }, { level: 2, index: 22 }, { level: 3, index: 11 }, { level: 2, index: 24 }]) {
      const b = (await w.store.blockAt(ada, P, late))!;
      expect(b.endMs).toBeLessThan(cutoff);
      expect(b.createdAtMs).toBe(T0 + 200 * DAY);
      expect(await w.store.blockAt(ada, P, late, asOf)).toBeNull();
      expect(await steer(w.history.open(`b:${late.level}.${late.index}@person:ada`, { viewer: viewerOf(ada), asOf }))).toContain('No history item');
    }
    for (const budget of [{ coverLines: 1 }, { coverLines: 4 }, {}, { rawWindow: { kind: 'age' as const, ms: DAY } }]) {
      const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), asOf, budget });
      expect(view.text).toBe((await then.w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), asOf: then.asOf, budget })).text);
    }
    const focus = (x: World) => x.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), asOf, from: T0 + 80 * DAY, to: cutoff, budget: { coverLines: 2 } });
    expect((await focus(w)).text).toBe((await focus(then.w)).text);
  });

  test('opening a block whose halves were rebuilt after the instant falls back to the finer blocks that existed', async () => {
    const { w, asOf } = await replay();
    w.store.dropBlock((await w.store.blockAt(ada, P, { level: 5, index: 0 }))!.id);
    await w.compress();
    expect((await w.store.blockAt(ada, P, { level: 5, index: 0 }))!.createdAtMs).toBe(T0 + 200 * DAY);
    expect(positions(await w.history.open('b:6.0@person:ada', { viewer: viewerOf(ada) }))).toEqual([{ level: 5, index: 0 }, { level: 5, index: 1 }]);
    expect(positions(await w.history.open('b:6.0@person:ada', { viewer: viewerOf(ada), asOf }))).toEqual([{ level: 4, index: 0 }, { level: 4, index: 1 }, { level: 5, index: 1 }]);
  });

  test('the cover as of day 100 is the cover a read on day 100 would have rendered', async () => {
    const { w, cutoff, asOf } = await replay();
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), asOf });
    for (const l of view.sections.flatMap((s) => s.lines)) expect(l.range![1]).toBeLessThan(cutoff);
    expect(rawLines(view).length).toBe(14 * 3);
    expect(Math.min(...rawLines(view).map((l) => l.range![0]))).toBeGreaterThanOrEqual(cutoff - 14 * DAY);
    expect(tiled(positions(view))).toEqual([0, 86]);
    expect(view.text).not.toContain('day 100 ');
    expect(view.text).not.toContain('day 150');
    const feed = await w.history.view({ select: { all: true }, viewer: feedViewer(), asOf });
    for (const l of feed.sections.flatMap((s) => s.lines)) expect(l.range![1]).toBeLessThan(cutoff);
  });

  test('a handle to something later does not exist yet, whatever kind it is', async () => {
    const { w, asOf } = await replay();
    const later = (await w.store.blockAt(ada, P, { level: 0, index: 150 }))!;
    const laterAct = (await w.store.activitiesIn(later))[0];
    for (const handle of ['b:0.150@person:ada', 'b:0.100@person:ada', `b:#${later.id}`, `a:${laterAct.id}`, 'b:7.0@person:ada', 'b:6.1@person:ada']) {
      expect((await w.history.open(handle, { viewer: viewerOf(ada) })).text.length).toBeGreaterThan(0);
      expect(await steer(w.history.open(handle, { viewer: viewerOf(ada), asOf }))).toContain('No history item');
      expect(await steer(w.history.zoomOut(handle, { viewer: viewerOf(ada), asOf, build: true }))).toContain('No history item');
    }
    expect((await w.history.open('b:0.99@person:ada', { viewer: viewerOf(ada), asOf })).stats.raw).toBe(3);
    expect(positions(await w.history.open('b:6.0@person:ada', { viewer: viewerOf(ada), asOf }))).toEqual([{ level: 5, index: 0 }, { level: 5, index: 1 }]);
  });

  test('zooming out near the instant never reaches past it, and never writes', async () => {
    const { w, cutoff, asOf } = await replay();
    const calls = w.summarizer.mergeCalls;
    // (3, 12) covers leaves 96..103; only 96..99 had ended.
    const view = await w.history.zoomOut('b:2.24@person:ada', { viewer: viewerOf(ada), asOf, build: true });
    expect(tiled(positions(view))).toEqual([96, 100]);
    for (const l of blockLines(view)) expect(l.range![1]).toBeLessThan(cutoff);
    await dropMerges(w, (r) => r.level === 3 && r.index === 2);
    const unbuilt = await w.history.zoomOut('b:2.4@person:ada', { viewer: viewerOf(ada), asOf, build: true });
    expect(positions(unbuilt)).toEqual([{ level: 2, index: 4 }, { level: 2, index: 5 }]);
    expect(w.summarizer.mergeCalls).toBe(calls);
    expect(await w.store.blockAt(ada, P, { level: 3, index: 2 })).toBeNull();
  });

  test('focus, search and stories are bounded the same way', async () => {
    const { w, cutoff, asOf } = await replay();
    const focus = await w.history.focus({ select: { scope: ada }, viewer: viewerOf(ada), asOf, from: T0 + 90 * DAY, to: T0 + 120 * DAY });
    expect(tiled(positions(focus))).toEqual([90, 100]);
    for (const l of focus.sections.flatMap((s) => s.lines)) expect(l.range![1]).toBeLessThan(cutoff);
    const found = await w.history.search({ select: { scope: ada }, viewer: viewerOf(ada), asOf, query: 'day 1', limit: 200 });
    expect(found.stats.raw).toBeGreaterThan(0);
    for (const l of rawLines(found)) expect(l.range![1]).toBeLessThan(cutoff);
    const story = await w.history.open(`s:note|${cutoff - DAY}|${cutoff + 10 * DAY}`, { viewer: viewerOf(ada), asOf });
    expect(story.stats.raw).toBe(3);
    for (const l of rawLines(story)) expect(l.range![1]).toBeLessThan(cutoff);
    // An activity logged exactly at the instant is not older than it.
    const edge = await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'at the instant', at: w.store.cursorAt(cutoff) });
    expect(await steer(w.history.open(`a:${edge.id}`, { viewer: viewerOf(ada), asOf }))).toContain('No history item');
    expect((await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), asOf })).text).not.toContain('at the instant');
  });
});

describe('ownership: an inbound belongs to the run it woke', () => {
  const ownership = { ownedKinds: new Set(['message_in']), withholds: (run: { reason: string }) => run.reason !== 'message_in' };
  const run = (reason: string) => ({ runId: 'r1', agentId: 'operator', scope: { type: 'global', id: 'global' }, partition: P, reason });

  async function chat() {
    const w = world({ ownership }, 1);
    const at = (m: number) => w.store.cursorAt(T0 + 9 * HOUR + m * 60_000);
    await w.store.append({ scope: club, partition: P, kind: 'message_in', summary: 'Ada: can someone water the beds?', at: at(0) });
    await w.store.append({ scope: club, partition: P, kind: 'message_out', summary: 'agent: I will ask Bram', at: at(1) });
    await w.store.append({ scope: ada, partition: P, kind: 'message_in', summary: 'Ada: thanks', at: at(2) });
    await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'watering agreed', at: at(3) });
    return w;
  }

  test('a run woken by something else gets a count line with no handle, and keeps our own outbound', async () => {
    const w = await chat();
    const view = await w.history.view({ select: { all: true }, viewer: feedViewer(), run: run('schedule') });
    expect(view.stats.withheld).toBe(2);
    const line = view.sections[0].lines[0];
    expect(line.kind).toBe('withheld');
    expect(line.handle).toBeUndefined();
    expect(line.text).toBe('[2026-01-01 09:00-09:02] 2 inbound messages withheld from this run (message_in x2): each one woke its own run, and that run answers it. This run was not woken by any of them, so none of them is yours to answer or act on, and none is unanswered because you cannot see it. Your own posts stay listed.');
    expect(view.text).not.toContain('water the beds');
    expect(view.text).toContain('I will ask Bram');
    expect(view.text).toContain('watering agreed');
    expect(view.handles.length).toBe(2);
  });

  test('the run the message woke, and a read with no run, see everything', async () => {
    const w = await chat();
    for (const req of [{ run: run('message_in') }, {}]) {
      const view = await w.history.view({ select: { all: true }, viewer: feedViewer(), ...req });
      expect(view.stats.withheld).toBeUndefined();
      expect(view.text).toContain('water the beds');
    }
  });

  test('search still finds a withheld message, deliberately; a story handle for the owned kind does not open', async () => {
    const w = await chat();
    const found = await w.history.search({ select: { all: true }, viewer: feedViewer(), run: run('schedule'), query: 'water' });
    expect(found.text).toContain('can someone water the beds?');
    const forged = `s:message_in|${T0}|${T0 + DAY}`;
    expect(await steer(w.history.open(forged, { viewer: feedViewer(), run: run('schedule') }))).toContain('belong to the runs they woke');
    expect((await w.history.open(forged, { viewer: feedViewer(), run: run('message_in') })).stats.raw).toBe(2);
  });
});

describe('collapse: stories and the census', () => {
  const collapse = {
    aggregateKey: bucketKinds(['ping'], ['report']),
    routine: (a: { kind: string }) => a.kind === 'tick',
    routineBlock: (kinds: readonly string[]) => kinds.every((k) => k === 'tick'),
  };

  test('routine work folds into one census line in a feed, each kind with a story handle that reopens it', async () => {
    const w = world({ collapse }, 1);
    for (let i = 0; i < 40; i++) await w.store.append({ scope: { type: 'person', id: `p${i % 4}` }, partition: P, kind: 'tick', summary: `tick ${i}`, at: w.store.cursorAt(T0 + i * 60_000) });
    await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'a person decided something', at: w.store.cursorAt(T0 + 20 * 60_000) });
    const view = await w.history.view({ select: { all: true }, viewer: feedViewer() });
    expect(view.stats.folded).toBe(40);
    expect(view.sections[0].lines.map((l) => l.kind)).toEqual(['census', 'activity']);
    expect(view.sections[0].lines[0].text).toBe(`[2026-01-01 00:00-00:39] routine activity (x40), collapsed: high-volume machine work with no decision by a person in any of it. tick x40 [story: s:tick|${T0}|${T0 + 39 * 60_000}]`);
    const story = await w.history.open(`s:tick|${T0}|${T0 + 39 * 60_000}`, { viewer: feedViewer() });
    expect(story.stats.raw).toBe(40);
    // A scoped read is not flooded by other scopes, so nothing folds there.
    const scoped = await w.history.view({ select: { scope: { type: 'person', id: 'p1' } }, viewer: feedViewer() });
    expect(scoped.stats.folded).toBeUndefined();
    expect(scoped.stats.raw).toBe(10);
  });

  test('a leaf whose every kind is routine folds into the block census; a mixed leaf stays', async () => {
    const w = world({ collapse, compress: { maxActivities: 3 } }, 60);
    for (let d = 0; d < 10; d++) for (let i = 0; i < 3; i++) await w.store.append({ scope: bram, partition: P, kind: 'tick', summary: `tick ${d}.${i}`, at: w.store.cursorAt(T0 + d * DAY + i * HOUR) });
    await w.seedDays(ada, 4, 3);
    await w.compress();
    const view = await w.history.view({ select: { all: true }, viewer: feedViewer(), budget: { rawWindow: { kind: 'age', ms: 14 * DAY } } });
    expect(view.stats.folded).toBe(10);
    const section = view.sections.find((s) => s.title.startsWith('## Earlier'))!;
    expect(section.lines[0].kind).toBe('census');
    expect(section.lines[0].text).toContain('10 routine summary blocks, collapsed');
    expect(section.lines[0].text).toContain('tick (in 10) [story: s:tick|');
    expect(blockLines(view).length).toBe(4);
    expect(blockLines(view).every((l) => l.handle!.endsWith('@person:ada'))).toBe(true);
  });

  test('day buckets and hour buckets', async () => {
    const w = world({ collapse }, 3);
    for (const h of [1, 5, 9]) await w.store.append({ scope: ada, partition: P, kind: 'report', summary: `report at ${h}`, at: w.store.cursorAt(T0 + h * HOUR) });
    for (const m of [0, 10, 70]) await w.store.append({ scope: ada, partition: P, kind: 'ping', summary: 'same words', at: w.store.cursorAt(T0 + DAY + m * 60_000) });
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    expect(rawLines(view).map((l) => l.text)).toEqual([
      `[2026-01-01 01:00-09:00] report (x3): report at 1 | report at 5 | report at 9 [story: s@person%3Aada:report|${T0 + HOUR}|${T0 + 9 * HOUR}]`,
      `[2026-01-02 00:00-00:10] ping (x2): same words [story: s@person%3Aada:ping|${T0 + DAY}|${T0 + DAY + 600_000}]`,
      '[2026-01-02 01:10] ping: same words',
    ]);
  });
});

describe('search', () => {
  test('finds raw entries by words, newest first, limited, inside the selection', async () => {
    const w = await aged(50);
    await w.seedDays(bram, 5);
    const found = await w.history.search({ select: { scope: ada }, viewer: viewerOf(ada), query: 'DAY 4 #', limit: 100 });
    expect(rawLines(found).map((l) => l.text.slice(25))).toEqual(['ada day 4 #2', 'ada day 4 #1', 'ada day 4 #0']);
    expect((await w.history.search({ select: { all: true }, viewer: feedViewer(), query: 'day 4 #', limit: 2 })).stats.raw).toBe(2);
    expect(found.sections[0].title).toBe('## Search "DAY 4 #": 3 entries, newest first');
    expect(await steer(w.history.search({ select: { scope: ada }, viewer: viewerOf(ada), query: '   ' }))).toContain('needs words');
    expect((await w.history.search({ select: { scope: ada }, viewer: viewerOf(ada), query: 'no such words' })).stats.raw).toBe(0);
    for (const limit of [NaN, -5, 0, Infinity, 1e9]) expect((await w.history.search({ select: { scope: ada }, viewer: viewerOf(ada), query: 'ada', limit })).stats.raw).toBeLessThanOrEqual(200);
  });
});

describe('legacy scopes and renderers', () => {
  test('a scope with an unnumbered leaf reads its newest leaves, deduplicated, until it is numbered', async () => {
    const w = world(daily, 100);
    const rows = await w.seedDays(ada, 6, 3);
    const c = (i: number) => rows[i].at;
    w.store.addLegacyLeaf(ada, P, { start: c(0), end: c(8), content: 'short', count: 9 });
    w.store.addLegacyLeaf(ada, P, { start: c(0), end: c(8), content: 'the longer copy of the same days', count: 9 });
    w.store.addLegacyLeaf(ada, P, { start: c(9), end: c(17), content: 'the next days', count: 9 });
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    expect(blockLines(view).map((l) => l.text.split('\n')[1])).toEqual(['the longer copy of the same days', 'the next days']);
    expect(blockLines(view).every((l) => l.handle!.startsWith('b:#'))).toBe(true);
    const opened = await w.history.open(blockLines(view)[1].handle!, { viewer: viewerOf(ada) });
    expect(opened.stats.raw).toBe(9);
    expect(await steer(w.history.zoomOut(blockLines(view)[1].handle!, { viewer: viewerOf(ada) }))).toContain('no place in its scope');
    // Compression numbers them and the scope reads as a tree from then on.
    for (let i = 0; i < 3; i++) await w.store.append({ scope: ada, partition: P, kind: 'note', summary: `more ${i}`, at: w.store.cursorAt(T0 + 20 * DAY + i) });
    await w.compress();
    const after = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    expect(positions(after)).toEqual([{ level: 0, index: 0 }, { level: 0, index: 1 }, { level: 0, index: 2 }]);
  });

  test('a host renderer shapes lines, hides what it returns null for, marks foreign text and opens its own refs', async () => {
    const w = world(
      {
        renderer: {
          hydrate: async (acts) => new Map(acts.map((a) => [a.id, `doc for ${a.summary}`])),
          line: (a, h: Map<string, string>) => (a.kind === 'hidden' ? null : { text: `${a.kind.toUpperCase()} ${a.summary} <${h.get(a.id)}>`, tokens: 1 }),
          full: (a, h: Map<string, string>) => `FULL ${a.summary} <${h.get(a.id)}>`,
          foreign: (a) => a.kind === 'message_in',
          openRef: async (ref) => (ref === 'email:7' ? 'the whole email' : null),
        },
      },
      1,
    );
    for (const [kind, summary] of [['note', 'one'], ['hidden', 'two'], ['message_in', 'three']]) await w.store.append({ scope: ada, partition: P, kind, summary, at: w.store.cursorAt(T0 + 1000) });
    const view = await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    expect(view.sections[0].lines.map((l) => [l.text, l.foreign])).toEqual([['NOTE one <doc for one>', undefined], ['MESSAGE_IN three <doc for three>', true]]);
    expect((await w.history.open(view.handles[0].handle, { viewer: viewerOf(ada) })).text).toContain('FULL one <doc for one>');
    expect((await w.history.open('email:7', { viewer: viewerOf(ada) })).text).toBe('## email:7\nthe whole email');
    expect(await steer(w.history.open('email:8', { viewer: viewerOf(ada) }))).toContain('No history item');
  });

  test('stamps render in the zone asked for', async () => {
    const w = world({}, 1);
    await w.store.append({ scope: ada, partition: P, kind: 'note', summary: 'noon utc', at: w.store.cursorAt(T0 + 12 * HOUR) });
    expect((await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada) })).text).toContain('[2026-01-01 12:00] note: noon utc');
    expect((await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), zone: 'America/New_York' })).text).toContain('[2026-01-01 07:00] note: noon utc');
    expect((await w.history.view({ select: { scope: ada }, viewer: viewerOf(ada), zone: 'Asia/Tokyo' })).text).toContain('[2026-01-01 21:00] note: noon utc');
  });

  test('compressOnce without a summarizer says what is missing', async () => {
    const w = world({ summarizer: undefined });
    expect(() => w.history.compressOnce({ deadlineAt: Date.now() + 1000 })).toThrow('needs a summarizer');
  });
});
