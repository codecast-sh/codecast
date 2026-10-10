import { fixedClock, type FixedClock } from '../src/clock';
import { positionalCodec } from '../src/codec';
import { createHistory, type HistoryDeps, type HistoryView } from '../src/history';
import type { Activity } from '../src/log';
import { partitionViewer, scopedViewer, type Partition, type Scope, type ScopeTypeDef } from '../src/scope';
import { memoryStore, type InMemoryStore } from '../src/stores/memory';
import type { Summarizer } from '../src/summarize';
import { blockSpan, type TreeBlock } from '../src/tree';

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const T0 = Date.UTC(2026, 0, 1);
export const P: Partition = 'default';
export const ada: Scope = { type: 'person', id: 'ada' };
export const bram: Scope = { type: 'person', id: 'bram' };
export const club: Scope = { type: 'group', id: 'club' };
export const SCOPES: ScopeTypeDef[] = [{ type: 'person' }, { type: 'group' }, { type: 'global', writesGlobalMemory: true }, { type: 'ticket', compress: false, inGlobalFeed: false }];

/** A summarizer that records its calls and writes content a test can read back. */
export function countingSummarizer(): Summarizer & { leafCalls: number; mergeCalls: number; failOn?: (scope: Scope) => boolean; delayMs?: number; contexts: Array<{ what: 'leaf' | 'merge'; firstDay: string; context: string[] }> } {
  const self = {
    leafCalls: 0,
    mergeCalls: 0,
    contexts: [] as Array<{ what: 'leaf' | 'merge'; firstDay: string; context: string[] }>,
    failOn: undefined as ((scope: Scope) => boolean) | undefined,
    delayMs: undefined as number | undefined,
    async leaf({ scope, lines, context }: { scope: Scope; lines: string[]; context: string[] }) {
      self.leafCalls++;
      self.contexts.push({ what: 'leaf', firstDay: lines[0].slice(1, 11), context });
      if (self.delayMs) await new Promise((r) => setTimeout(r, self.delayMs));
      if (self.failOn?.(scope)) throw new Error('model unavailable');
      return `${lines.length} entries from "${lines[0].slice(19)}" to "${lines[lines.length - 1].slice(19)}"`;
    },
    async merge({ earlier, later, context }: { earlier: { range: string }; later: { range: string }; context: string[] }) {
      self.mergeCalls++;
      self.contexts.push({ what: 'merge', firstDay: earlier.range.slice(0, 10), context });
      if (self.delayMs) await new Promise((r) => setTimeout(r, self.delayMs));
      return `merged [${earlier.range}] + [${later.range}]`;
    },
  };
  return self;
}

export interface World {
  store: InMemoryStore;
  clock: FixedClock;
  summarizer: ReturnType<typeof countingSummarizer>;
  history: ReturnType<typeof createHistory>;
  /** Append `perDay` activities a day for `days` days from T0 in a scope. */
  seedDays(scope: Scope, days: number, perDay?: number, kind?: string, partition?: Partition): Promise<Activity[]>;
  compress(): ReturnType<ReturnType<typeof createHistory>['compressOnce']>;
}

export function world(deps: Partial<HistoryDeps> = {}, startDay = 0): World {
  const clock = fixedClock(T0 + startDay * DAY);
  const store = memoryStore({ clock });
  const summarizer = countingSummarizer();
  const history = createHistory({ store, scopes: SCOPES, summarizer, clock, ...deps });
  return {
    store,
    clock,
    summarizer,
    history,
    async seedDays(scope, days, perDay = 3, kind = 'note', partition = P) {
      const out: Activity[] = [];
      for (let d = 0; d < days; d++) {
        for (let i = 0; i < perDay; i++) {
          out.push(await store.append({ scope, partition, kind, summary: `${scope.id} day ${d} #${i}`, at: store.cursorAt(T0 + d * DAY + (9 + i) * HOUR) }));
        }
      }
      return out;
    },
    compress: () => history.compressOnce({ deadlineAt: Date.now() + 60_000 }),
  };
}

export const viewerOf = (scope: Scope | Scope[], partition: Partition = P) => scopedViewer('helper', scope, partition);
export const feedViewer = (partition: Partition = P) => partitionViewer('operator', partition);

/** The tree positions of a view's block lines, in render order. */
export function positions(view: HistoryView): TreeBlock[] {
  return view.handles
    .filter((h) => h.kind === 'block')
    .map((h) => {
      const parsed = positionalCodec.parse(h.handle);
      if (!parsed || parsed.kind !== 'block' || !('at' in parsed)) throw new Error(`not a positional block handle: ${h.handle}`);
      return parsed.at;
    });
}

/** Sort positions by the leaves they cover and return [first leaf, last leaf + 1], failing on a gap or overlap. */
export function tiled(blocks: TreeBlock[]): [number, number] {
  const spans = blocks.map(blockSpan).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] !== spans[i - 1][1]) throw new Error(`gap or overlap between leaves ${spans[i - 1][1]} and ${spans[i][0]}`);
  }
  return [spans[0][0], spans[spans.length - 1][1]];
}

export const blockLines = (view: HistoryView) => view.sections.flatMap((s) => s.lines).filter((l) => l.kind === 'block');
export const rawLines = (view: HistoryView) => view.sections.flatMap((s) => s.lines).filter((l) => l.kind === 'activity' || l.kind === 'story');
