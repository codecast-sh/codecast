import { describe, expect, test, setDefaultTimeout } from 'bun:test';

import { parseStory, positionalCodec, type HandleCodec } from '../src/codec';
import { bucketKinds } from '../src/collapse';
import type { Activity, Block } from '../src/log';
import { DAY, HOUR, P, T0, ada, viewerOf, world } from './helpers';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

const block = (over: Partial<Block> = {}): Block => ({ id: '17', scope: ada, partition: P, level: 3, index: 5, start: '' as Block['start'], end: '' as Block['end'], startMs: 0, endMs: 0, content: '', count: 0, createdAtMs: 0, ...over });
const activity = (id: string): Activity => ({ id, scope: ada, partition: P, kind: 'note', summary: '', at: '' as Activity['at'], atMs: 0 });

describe('positionalCodec', () => {
  test('every handle it mints parses back to what it names', () => {
    expect(positionalCodec.block(block())).toBe('b:3.5@person:ada');
    expect(positionalCodec.parse('b:3.5@person:ada')).toEqual({ kind: 'block', scope: ada, at: { level: 3, index: 5 } });
    expect(positionalCodec.block(block({ index: null, level: 0 }))).toBe('b:#17');
    expect(positionalCodec.parse('b:#17')).toEqual({ kind: 'block', id: '17' });
    expect(positionalCodec.story('ping', 100, 200)).toBe('s:ping|100|200');
    expect(positionalCodec.parse('s:ping|100|200')).toEqual({ kind: 'story', key: 'ping', fromMs: 100, toMs: 200 });
    expect(positionalCodec.story('ping', 100, 200, { type: 'channel', id: 'a:b|c@d' })).toBe('s@channel%3Aa%3Ab%7Cc%40d:ping|100|200');
    expect(positionalCodec.parse('s@channel%3Aa%3Ab%7Cc%40d:ping|100|200')).toEqual({ kind: 'story', key: 'ping', fromMs: 100, toMs: 200, scope: { type: 'channel', id: 'a:b|c@d' } });
    for (const bad of ['s@', 's@person%3Aada', 's@%E0%A4%A:ping|1|2', 's@nocolon:ping|1|2', 's@person%3Aada:ping|2|1', 'a:x\u0000', 'b:0.1@person:a\u0000']) expect(positionalCodec.parse(bad)).toBeNull();
    expect(positionalCodec.activity(activity('abc'))).toBe('a:abc');
    expect(positionalCodec.parse('a:abc')).toEqual({ kind: 'activity', id: 'abc' });
    expect(positionalCodec.parse('  a:abc\n')).toEqual({ kind: 'activity', id: 'abc' });
  });

  test('scope ids and story keys may hold the separators', () => {
    const odd = { type: 'channel', id: 'team:general@work' };
    const handle = positionalCodec.block(block({ scope: odd }));
    expect(positionalCodec.parse(handle)).toEqual({ kind: 'block', scope: odd, at: { level: 3, index: 5 } });
    expect(positionalCodec.parse(positionalCodec.story('a|b', 1, 2))).toEqual({ kind: 'story', key: 'a|b', fromMs: 1, toMs: 2 });
  });

  test('malformed handles are null; anything unrecognized is a host ref', () => {
    for (const bad of ['', ' ', 'b:', 'b:#', 'b:3@person:ada', 'b:3.5', 'b:3.5@', 'b:3.5@person', 'b:3.5@:ada', 'b:3.5@person:', 'b:-3.5@person:ada', 'b:3.-5@person:ada', 'b:3.5.1@person:ada', 'b:1e2.5@person:ada', 'b:0x3.5@person:ada', 'b:3 .5@person:ada', 'b:53.0@person:ada', 'b:52.9007199254740991@person:ada', 'b:0.99999999999999999@person:ada', 's:', 's:ping', 's:ping|1', 's:|1|2', 's:ping|2|1', 's:ping|1.5|2', 's:ping|a|2', 'a:']) {
      expect(positionalCodec.parse(bad)).toBeNull();
    }
    expect(positionalCodec.parse('email:42')).toEqual({ kind: 'ref', ref: 'email:42' });
    expect(parseStory('k|-5|5')).toEqual({ kind: 'story', key: 'k', fromMs: -5, toMs: 5 });
  });
});

/**
 * A host keeps its own handle formats by supplying a codec. This one expresses
 * the formats the first host already showed its agents, so its renders
 * can stay byte-identical when it adopts the runtime: a block is
 * `chunk_<12 hex>` inside a `[chunk:…]` frame, a story is the bare
 * `kind|startMs|endMs`, an activity is its bare uuid.
 */
const CHUNK = /^chunk_[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hostCodec: HandleCodec = {
  blockTag: 'chunk',
  block: (b) => b.id,
  story: (key, fromMs, toMs) => `${key}|${fromMs}|${toMs}`,
  activity: (a) => a.id,
  parse(handle) {
    const h = handle.trim();
    if (CHUNK.test(h)) return { kind: 'block', id: h };
    if (UUID.test(h)) return { kind: 'activity', id: h };
    return parseStory(h) ?? (h ? { kind: 'ref', ref: h } : null);
  },
  resolvePrefix: async (prefix) => KNOWN.filter((id) => id.startsWith(prefix)),
};
let KNOWN: string[] = [];

describe('a host codec with its own formats', () => {
  async function hosted() {
    let n = 0;
    const hex = (width: number) => (++n).toString(16).padStart(width, '0');
    const { memoryStore } = await import('../src/stores/memory');
    const { fixedClock } = await import('../src/clock');
    const { createHistory } = await import('../src/history');
    const { countingSummarizer, SCOPES } = await import('./helpers');
    const clock = fixedClock(T0 + 60 * DAY);
    // Scattered, the way random ids are, so short prefixes are mostly unique.
    const scatter = () => ((++n * 2654435761) % 2 ** 48).toString(16).padStart(12, '0');
    const store = memoryStore({ clock, ids: { block: () => `chunk_${scatter()}`, activity: () => `00000000-0000-4000-8000-${hex(12)}` } });
    const history = createHistory({ store, scopes: SCOPES, clock, codec: hostCodec, summarizer: countingSummarizer(), compress: { maxActivities: 3 }, collapse: { aggregateKey: bucketKinds(['ping']) } });
    for (let d = 0; d < 40; d++) for (let i = 0; i < 3; i++) await store.append({ scope: ada, partition: P, kind: 'note', summary: `day ${d} #${i}`, at: store.cursorAt(T0 + d * DAY + i * HOUR) });
    for (let i = 0; i < 4; i++) await store.append({ scope: ada, partition: P, kind: 'ping', summary: `ping ${i}`, at: store.cursorAt(T0 + 59 * DAY + i * 60_000) });
    await history.compressOnce({ deadlineAt: Date.now() + 60_000 });
    KNOWN = (await store.treeIndex(ada, P, {})).map((r) => r.id);
    return { store, history };
  }

  test('blocks render in the host frame and open by the host id', async () => {
    const { store, history } = await hosted();
    const view = await history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    const leaf = (await store.blockAt(ada, P, { level: 0, index: 39 }))!;
    expect(CHUNK.test(leaf.id)).toBe(true);
    expect(view.text).toContain(`[chunk:${leaf.id} | 2026-02-09]\n3 entries from "note: day 39 #0" to "note: day 39 #2"\n[/chunk:${leaf.id}]`);
    expect(view.text).toContain('Any [chunk:<handle>] can be opened with read_history(item: <handle>)');
    const opened = await history.open(leaf.id, { viewer: viewerOf(ada) });
    expect(opened.stats.raw).toBe(3);
    expect(opened.handles.every((h) => UUID.test(h.handle))).toBe(true);
    expect((await history.open(opened.handles[0].handle, { viewer: viewerOf(ada) })).text).toContain('day 39 #0');
    const up = await history.zoomOut(leaf.id, { viewer: viewerOf(ada) });
    expect(up.handles[0].handle).toBe((await store.blockAt(ada, P, { level: 1, index: 19 }))!.id);
  });

  test('stories keep the bare kind|start|end form', async () => {
    const { history } = await hosted();
    const view = await history.view({ select: { scope: ada }, viewer: viewerOf(ada) });
    const from = T0 + 59 * DAY;
    expect(view.text).toContain(`[2026-03-01 00:00-00:03] ping (x4): ping 0 | ping 1 | ping 2 [story: ping|${from}|${from + 180_000}]`);
    expect((await history.open(`ping|${from}|${from + 180_000}`, { viewer: viewerOf(ada) })).stats.raw).toBe(4);
  });

  test('a shortened id resolves when it names one item, and steers when it names several', async () => {
    const { store, history } = await hosted();
    const leaf = (await store.blockAt(ada, P, { level: 0, index: 39 }))!;
    // The shortest prefix of some id that no other id starts with.
    const prefixes = KNOWN.flatMap((id) => Array.from({ length: id.length - 7 }, (_, n) => id.slice(0, 7 + n)));
    const solo = prefixes.find((p) => KNOWN.filter((k) => k.startsWith(p)).length === 1 && !KNOWN.includes(p))!;
    expect(solo).toBeDefined();
    expect((await history.open(solo, { viewer: viewerOf(ada) })).text.length).toBeGreaterThan(0);
    const many = history.open('chunk_', { viewer: viewerOf(ada) });
    await expect(many).rejects.toThrow('is ambiguous');
    await expect(history.open('chunk_ffffffffffff', { viewer: viewerOf(ada) })).rejects.toThrow('No history item');
    // The viewer check applies to host ids exactly as to positional ones.
    await expect(history.open(leaf.id, { viewer: viewerOf({ type: 'person', id: 'bram' }) })).rejects.toThrow('No history item');
  });
});
