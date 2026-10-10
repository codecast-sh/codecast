import type { AsOf } from './asof';
import { dedupeOverlappingLeaves, fillBudgetNewestFirst, fitCover, resolveBudget, SCOPED_RAW_WINDOW_MS, splitRecentOlder, type ReadBudget, type ResolvedBudget } from './budget';
import { systemClock, type Clock } from './clock';
import { positionalCodec, type HandleCodec, type ParsedHandle } from './codec';
import { aggregate, censusApplies, formatActivityCensus, formatBlockCensus, formatStoryLine, partitionRoutine, partitionRoutineBlocks, type CollapsePolicy, type KindTally } from './collapse';
import { buildBlock, compressOnce, DEFAULT_COMPRESS, type CompressConfig, type CompressOptions, type CompressReport } from './compress';
import type { Cursor } from './cursor';
import type { Activity, Block } from './log';
import { formatWithheldLine, partitionOwned, withholdsFrom, type OwnershipPolicy } from './ownership';
import { dayRange, estimateTokens, formatBlock, formatClippedBlock, plainRenderer, type EventRenderer, type RenderCtx } from './render';
import { silentLogger, type AgentProfile, type RunEnvelope, type RuntimeLogger } from './run';
import { scopeKey, scopeRegistry, singleScope, storeSelector, type Partition, type Scope, type ScopeSelector, type ScopeTypeDef, type Viewer } from './scope';
import type { HistoryStore, TreeIndexRow } from './store';
import type { Summarizer } from './summarize';
import { blockKey, blockParent, blockSpan, coverSpan, isNumberedScope, planCover, resolveBlocks, type TreeBlock } from './tree';

export interface ViewRequest {
  select: ScopeSelector;
  viewer: Viewer;
  /** Per read; falls back to the agent's profile, then the runtime default. */
  budget?: ReadBudget;
  /** A lens. When set, no blocks are read: summaries were written over every kind and cannot be re-filtered. */
  kinds?: ReadonlySet<string>;
  asOf?: AsOf;
  /** The run reading, for ownership. */
  run?: RunEnvelope;
  /** IANA zone for stamps. */
  zone?: string;
}

export type HandleRequest = Omit<ViewRequest, 'select'>;

export interface ViewLine {
  text: string;
  kind: 'activity' | 'story' | 'block' | 'census' | 'withheld';
  handle?: string;
  level?: number;
  range?: [number, number];
  /** The line carries text from outside (a person's words); a host fences it before it reaches a model. */
  foreign?: boolean;
}

export interface HistoryView {
  text: string;
  sections: Array<{ title: string; note?: string; lines: ViewLine[] }>;
  handles: Array<{ handle: string; kind: 'block' | 'story' | 'activity'; level?: number; range: [number, number] }>;
  stats: {
    raw: number;
    recentBlocks: number;
    olderBlocks: number;
    folded?: number;
    withheld?: number;
    tokens: number;
    /** Blocks rendered beyond the line budget, when the stretch cannot be tiled that coarsely. */
    overLines?: number;
    /** The line budget the summaries were rendered at, when the token budget made them coarser than asked. */
    coarsenedTo?: number;
    /** Summary blocks cut after the first one, when even the coarsest cover did not fit the token budget. */
    droppedBlocks?: number;
  };
  /**
   * Present when the budget cut something. `raw`: the oldest raw lines were
   * dropped. `older`: summary blocks were dropped; in a cover these come from
   * the middle, right after the first block, which is never dropped.
   * `firstClipped`: the first block alone was larger than the budget and is
   * shown clipped.
   */
  truncated?: { raw?: boolean; older?: boolean; firstClipped?: boolean };
}

/** A read that cannot be served. The message is written for the model: what failed and what to do instead. */
export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryError';
  }
}

export interface History {
  /** The cover: raw lines near now, then the tree's cover, back to the first leaf. */
  view(req: ViewRequest): Promise<HistoryView>;
  /** One level finer: a merged block opens into its two halves, a leaf into its raw activities, a story into its events. */
  open(handle: string, req: HandleRequest): Promise<HistoryView>;
  /** One level coarser: the parent block, or its halves side by side if the parent is not built. */
  zoomOut(handle: string, req: HandleRequest & { build?: boolean }): Promise<HistoryView>;
  /** Any stretch at any resolution: the leaves in [from, to) tiled in at most budget.coverLines blocks. */
  focus(req: ViewRequest & { from: number; to: number }): Promise<HistoryView>;
  /** Keyword search over the log, newest first. Finds what a read folded or withheld. */
  search(req: ViewRequest & { query: string; limit?: number }): Promise<HistoryView>;
}

export interface HistoryDeps {
  store: HistoryStore;
  scopes: readonly ScopeTypeDef[];
  renderer?: EventRenderer<any>;
  summarizer?: Summarizer;
  clock?: Clock;
  codec?: HandleCodec;
  collapse?: CollapsePolicy;
  ownership?: OwnershipPolicy;
  logger?: RuntimeLogger;
  /** Per-agent default budgets, by `viewer.agentId`. */
  profiles?: readonly AgentProfile[];
  /** The runtime default under every profile. */
  budget?: ReadBudget;
  compress?: Partial<CompressConfig>;
  /** The tool name the notes tell the model to call. Default `read_history`. */
  toolName?: string;
}

/** Most raw rows one read loads. */
export const RAW_ROW_LIMIT = 2000;
/** Most leaves a cross-scope feed loads. */
export const FEED_LEAF_LIMIT = 1000;
/** Most leaves a scope without numbered leaves renders. */
export const LEGACY_LEAF_LIMIT = 50;
/** Most events one story opens. */
export const STORY_LIMIT = 500;
/** The last instant of year 9999, the latest any store stamps. */
export const MAX_INSTANT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
/** Most pages one read turns while skipping rows its viewer may not read. */
export const MAX_PAGES = 20;

const hasNul = (s: string): boolean => s.includes('\u0000');

const NOT_FOUND = (handle: string) => `No history item "${handle}" is readable from this run. Use a handle exactly as a read printed it.`;

export function createHistory(deps: HistoryDeps): History & { compressOnce(opts: CompressOptions): Promise<CompressReport> } {
  const { store } = deps;
  const renderer: EventRenderer<any> = deps.renderer ?? plainRenderer;
  const clock = deps.clock ?? systemClock;
  const codec = deps.codec ?? positionalCodec;
  const registry = scopeRegistry(deps.scopes);
  const logger = deps.logger ?? silentLogger;
  const tool = deps.toolName ?? 'read_history';
  const profiles = new Map((deps.profiles ?? []).map((p) => [p.id, p]));
  const tag = codec.blockTag;
  /** Parents being written on demand, by scope and slot, so concurrent zoom outs spend one merge call. */
  const building = new Map<string, Promise<unknown>>();

  const blockNote =
    `(These blocks are AI-written summaries of older raw entries, not primary records. ` +
    `Any [${tag}:<handle>] can be opened with ${tool}(item: <handle>): a block summarizing a long stretch opens into the two blocks it was written from, a block of raw entries opens into those entries. ` +
    `Before repeating a load-bearing specific (a name, number, commitment, or claimed outcome) found only in a summary, open it down to the raw entries and confirm it there.)`;
  const storyNote = `(Lines tagged "(xN) … [story: <handle>]" aggregate routine events; call ${tool}(item: <that handle>) to see the underlying events.)`;

  const budgetOf = (req: { budget?: ReadBudget; viewer: Viewer }): ResolvedBudget => resolveBudget(req.budget, profiles.get(req.viewer.agentId)?.history, deps.budget);
  const ctxOf = (req: HandleRequest): RenderCtx => ({ now: req.asOf?.at ?? clock.now(), zone: req.zone, viewer: req.viewer, asOf: req.asOf });

  /** canRead, asked once per scope per read. */
  function reader(viewer: Viewer): (scope: Scope) => Promise<boolean> {
    const seen = new Map<string, Promise<boolean>>();
    return (scope) => {
      const key = scopeKey(scope);
      // No store can hold a NUL byte, so a scope naming one names nothing.
      if (hasNul(key)) return Promise.resolve(false);
      let answer = seen.get(key);
      if (!answer) {
        answer = Promise.resolve()
          .then(() => viewer.canRead(scope))
          .then((ok) => ok === true)
          // A viewer check that fails is a wall, not an open door.
          .catch(() => false);
        seen.set(key, answer);
      }
      return answer;
    };
  }

  async function readable<T extends { scope: Scope; partition: Partition }>(rows: readonly T[], viewer: Viewer, can: (s: Scope) => Promise<boolean>): Promise<T[]> {
    const out: T[] = [];
    for (const r of rows) if (r.partition === viewer.partition && (await can(r.scope))) out.push(r);
    return out;
  }

  /**
   * Up to `want` rows the viewer may read, newest first, paging past rows it
   * may not read so a read is never starved by other scopes. `fetch` returns
   * one page at or before `until`, newest first; rows already seen at a tied
   * stamp are skipped. `more` says rows may remain beyond what was returned.
   */
  async function collect(fetch: (until: Cursor | undefined, size: number) => Promise<Activity[]>, want: number, keep: (a: Activity) => Promise<boolean>): Promise<{ rows: Activity[]; more: boolean }> {
    const rows: Activity[] = [];
    const seen = new Set<string>();
    let until: Cursor | undefined;
    let size = Math.max(want + 1, 100);
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await fetch(until, size);
      const fresh = batch.filter((a) => !seen.has(a.id));
      for (const a of fresh) {
        seen.add(a.id);
        if (await keep(a)) {
          rows.push(a);
          if (rows.length > want) return { rows: rows.slice(0, want), more: true };
        }
      }
      if (batch.length < size) return { rows, more: false };
      // A page that is one tied stamp already seen: widen it to get past the tie.
      if (fresh.length === 0) size *= 2;
      until = batch[batch.length - 1].at;
    }
    return { rows, more: true };
  }

  async function requireScope(select: ScopeSelector, viewer: Viewer, verb: string): Promise<Scope> {
    const scope = singleScope(select);
    if (!scope) throw new HistoryError(`${verb} reads one scope at a time. Name a single scope.`);
    if (!(await reader(viewer)(scope))) throw new HistoryError(`The scope ${scopeKey(scope)} is not readable from this run.`);
    return scope;
  }

  const blockText = (b: Block, handle: string) => formatBlock(tag, handle, b);
  const blockLine = (b: Block): ViewLine => {
    const handle = codec.block(b);
    return { text: blockText(b, handle), kind: 'block', handle, level: b.level, range: [b.startMs, b.endMs] };
  };
  const clippedBlockLine = (b: Block, tokens: number): ViewLine => ({ ...blockLine(b), text: formatClippedBlock(tag, codec.block(b), b, tokens) });
  const storyHandleOf = (k: KindTally) => codec.story(k.kind, k.firstMs, k.lastMs);
  const nulError = () => new HistoryError('A scope, kind, handle or search cannot contain a NUL character.');
  const selectorHasNul = (select: ScopeSelector, kinds?: ReadonlySet<string>): boolean =>
    ('scope' in select && hasNul(scopeKey(select.scope))) ||
    ('anyOf' in select && select.anyOf.some((s) => hasNul(scopeKey(s)))) ||
    ('types' in select && select.types.some(hasNul)) ||
    ('all' in select && (select.except ?? []).some(hasNul)) ||
    [...(kinds ?? [])].some(hasNul);

  /** One line per activity, each with its handle; `full` renders the opened form. */
  async function activityLines(acts: Activity[], ctx: RenderCtx, full: boolean): Promise<ViewLine[]> {
    const hydrated = renderer.hydrate ? await renderer.hydrate(acts, ctx) : undefined;
    const out: ViewLine[] = [];
    for (const a of acts) {
      const text = full && renderer.full ? renderer.full(a, hydrated, ctx) : renderer.line(a, hydrated, ctx)?.text;
      if (text == null) continue;
      out.push({ text, kind: 'activity', handle: codec.activity(a), range: [a.atMs, a.atMs], foreign: renderer.foreign?.(a) || undefined });
    }
    return out;
  }

  /**
   * The raw part of a read: withhold what the run does not own, fold routine
   * work into the census, collapse stories, then keep what fits the token
   * budget from the newest end.
   */
  async function rawPart(ascending: Activity[], req: ViewRequest, ctx: RenderCtx, tokenBudget: number) {
    const storyScope = singleScope(req.select) ?? undefined;
    const owned = partitionOwned(ascending, deps.ownership, req.run);
    const routine = partitionRoutine(owned.visible, deps.collapse, censusApplies(deps.collapse, req.select));
    const groups = aggregate(routine.signal, deps.collapse);
    const singles = groups.filter((g) => g.count === 1).map((g) => g.first);
    const hydrated = renderer.hydrate ? await renderer.hydrate(singles, ctx) : undefined;
    const rendered: Array<{ line: ViewLine; tokens: number; first: Activity; lastMs: number }> = [];
    for (const g of groups) {
      if (g.count > 1) {
        const handle = codec.story(g.kind, g.first.atMs, g.last.atMs, storyScope);
        const text = formatStoryLine(g, handle);
        rendered.push({ line: { text, kind: 'story', handle, range: [g.first.atMs, g.last.atMs] }, tokens: estimateTokens(text), first: g.first, lastMs: g.last.atMs });
        continue;
      }
      const made = renderer.line(g.first, hydrated, ctx);
      if (!made) continue;
      rendered.push({
        line: { text: made.text, kind: 'activity', handle: codec.activity(g.first), range: [g.first.atMs, g.first.atMs], foreign: renderer.foreign?.(g.first) || undefined },
        tokens: made.tokens ?? estimateTokens(made.text),
        first: g.first,
        lastMs: g.first.atMs,
      });
    }
    // A story line sits at its first event but holds events up to its last;
    // the budget fills by each line's newest event, so the newest event is
    // never the one dropped.
    const byNewest = rendered.map((r, i) => ({ r, i })).sort((a, b) => a.r.lastMs - b.r.lastMs || a.i - b.i);
    const fill = fillBudgetNewestFirst(
      byNewest.map((x) => x.r.tokens),
      tokenBudget,
    );
    const keptAt = new Set(byNewest.filter((_, k) => fill.kept[k]).map((x) => x.i));
    const keptCount = fill.keptCount;
    const shown = rendered.filter((_, i) => keptAt.has(i));
    const head: ViewLine[] = [];
    if (owned.census) head.push({ text: formatWithheldLine(owned.census), kind: 'withheld', range: [owned.census.firstMs, owned.census.lastMs] });
    if (routine.census) head.push({ text: formatActivityCensus(routine.census, storyHandleOf), kind: 'census', range: [routine.census.firstMs, routine.census.lastMs] });
    return {
      lines: [...head, ...shown.map((r) => r.line)],
      shown: shown.length,
      /** The oldest activity a kept line shows: where the compressed part must end. */
      oldestKept: shown.length > 0 ? shown[0].first : null,
      dropped: keptCount < rendered.length,
      hasStory: shown.some((r) => r.line.kind === 'story'),
      folded: routine.census?.total,
      withheld: owned.census?.total,
    };
  }

  function finish(sections: HistoryView['sections'], stats: Omit<HistoryView['stats'], 'tokens'>, truncated?: HistoryView['truncated']): HistoryView {
    const text = sections
      .map((s) => {
        const body = s.lines.map((l) => l.text).join(s.lines.some((l) => l.kind === 'block') ? '\n\n' : '\n');
        return [s.title, s.note, body].filter((part) => part != null && part !== '').join('\n');
      })
      .join('\n\n');
    const handles: HistoryView['handles'] = [];
    for (const s of sections) {
      for (const l of s.lines) {
        if (l.handle && (l.kind === 'block' || l.kind === 'story' || l.kind === 'activity')) handles.push({ handle: l.handle, kind: l.kind, level: l.level, range: l.range ?? [0, 0] });
      }
    }
    const cut = truncated && (truncated.raw || truncated.older || truncated.firstClipped) ? truncated : undefined;
    return { text, sections, handles, stats: { ...stats, tokens: estimateTokens(text) }, ...(cut ? { truncated: cut } : {}) };
  }

  /** Blocks by id in the order asked; ids the store no longer has are skipped. */
  async function blocksInOrder(ids: readonly string[], asOf?: AsOf): Promise<Block[]> {
    if (ids.length === 0) return [];
    const byId = new Map((await store.blocks(ids, asOf)).map((b) => [b.id, b]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  interface Tree {
    rows: TreeIndexRow[];
    idByKey: Map<string, string>;
    /** Numbered leaves, 0..T-1. */
    T: number;
    numbered: boolean;
  }

  async function treeOf(scope: Scope, partition: Partition, q: { endedBefore?: Cursor; asOf?: AsOf } = {}): Promise<Tree> {
    const rows = await store.treeIndex(scope, partition, q);
    const idByKey = new Map<string, string>();
    let top = -1;
    for (const r of rows) {
      if (r.index === null) continue;
      idByKey.set(blockKey({ level: r.level, index: r.index }), r.id);
      if (r.level === 0) top = Math.max(top, r.index);
    }
    return { rows, idByKey, T: top + 1, numbered: isNumberedScope(rows.map((r) => ({ level: r.level, blockIndex: r.index, endMs: r.endMs }))) };
  }

  /**
   * The one zoom primitive: leaves [lo, hi) of a scope tiled in at most
   * `lines` blocks, finest near hi, every missing merge opened into its halves
   * so the span stays whole.
   */
  async function spanBlocks(tree: Tree, lo: number, hi: number, lines: number, asOf?: AsOf): Promise<{ blocks: Block[]; wanted: TreeBlock[] }> {
    const wanted = coverSpan(Math.max(0, lo), Math.min(hi, tree.T), lines);
    const resolved = resolveBlocks(wanted, (b) => tree.idByKey.has(blockKey(b)));
    return { blocks: await blocksInOrder(resolved.flatMap((b) => tree.idByKey.get(blockKey(b)) ?? []), asOf), wanted };
  }

  /** A handle's block, or a not-found that reads the same whether it is missing, walled off, or not yet written as of the read. */
  async function resolveBlock(parsed: Extract<ParsedHandle, { kind: 'block' }>, handle: string, req: HandleRequest): Promise<Block> {
    const can = reader(req.viewer);
    if ('scope' in parsed && !(await can(parsed.scope))) throw new HistoryError(NOT_FOUND(handle));
    const b = 'id' in parsed ? await store.block(parsed.id, req.asOf) : await store.blockAt(parsed.scope, req.viewer.partition, parsed.at, req.asOf);
    if (!b || b.partition !== req.viewer.partition || !(await can(b.scope))) throw new HistoryError(NOT_FOUND(handle));
    return b;
  }

  async function parseHandle(handle: string): Promise<ParsedHandle> {
    const direct = typeof handle === 'string' ? codec.parse(handle) : null;
    if (direct && direct.kind !== 'ref') return direct;
    if (codec.resolvePrefix && typeof handle === 'string' && handle.trim()) {
      const full = await codec.resolvePrefix(handle.trim());
      if (full.length === 1) {
        const parsed = codec.parse(full[0]);
        if (parsed) return parsed;
      }
      if (full.length > 1) throw new HistoryError(`"${handle}" is ambiguous: it starts ${full.length} handles (${full.slice(0, 5).join(', ')}). Pass one of them in full.`);
    }
    if (direct) return direct;
    throw new HistoryError(NOT_FOUND(String(handle)));
  }

  async function view(req: ViewRequest): Promise<HistoryView> {
    const budget = budgetOf(req);
    const ctx = ctxOf(req);
    const can = reader(req.viewer);
    if (selectorHasNul(req.select, req.kinds)) throw nulError();
    const scoped = singleScope(req.select);
    if (scoped && !(await can(scoped))) throw new HistoryError(`The scope ${scopeKey(scoped)} is not readable from this run.`);
    const select = storeSelector(req.select, registry);
    const partition = req.viewer.partition;
    const window = budget.rawWindow ?? (scoped ? { kind: 'age' as const, ms: SCOPED_RAW_WINDOW_MS } : { kind: 'tokens' as const });
    const ageBoundaryMs = window.kind === 'age' ? ctx.now - window.ms : null;
    const ageCursor = ageBoundaryMs === null ? null : store.cursorAt(ageBoundaryMs);

    // A scoped read's raw lines begin right after the newest summary that
    // ended before the window, not at the window's edge: an activity older
    // than the window that no summary holds yet (a leaf still straddling the
    // edge, a tail too short to summarize, a scope type that is never
    // summarized) is shown raw rather than lost. The token budget bounds it.
    let since: Cursor | undefined;
    let from: Cursor | undefined;
    if (ageCursor !== null && scoped) since = (await store.leaves({ select: { scope: scoped }, partition, endedBefore: ageCursor, limit: 1, asOf: req.asOf }))[0]?.end;
    else if (ageCursor !== null) from = ageCursor;

    const kinds = req.kinds ? [...req.kinds] : undefined;
    const fetched = await collect(
      (until, size) => store.activities({ select, partition, after: since, from, until, kinds, order: 'desc', limit: size, asOf: req.asOf }),
      RAW_ROW_LIMIT,
      async (a) => a.partition === partition && (await can(a.scope)),
    );
    const raw = await rawPart(fetched.rows.reverse(), req, ctx, budget.rawTokens);

    const sections: HistoryView['sections'] = [];
    if (raw.lines.length > 0) sections.push({ title: '## Recent Activity', note: raw.hasStory ? storyNote : undefined, lines: raw.lines });
    const stats: Omit<HistoryView['stats'], 'tokens'> = { raw: raw.shown, recentBlocks: 0, olderBlocks: 0 };
    if (raw.folded) stats.folded = raw.folded;
    if (raw.withheld) stats.withheld = raw.withheld;
    const truncated: NonNullable<HistoryView['truncated']> = { raw: raw.dropped || fetched.more || undefined };
    if (req.kinds) return finish(sections, stats, truncated);

    // Raw and compressed are one timeline: blocks cover what ended before the
    // raw part begins. That is the age boundary when every raw line in the
    // window was kept; otherwise the oldest kept line, or the read's own
    // instant when no raw line was kept at all.
    const rawCut = raw.dropped || fetched.more || ageCursor === null;
    const boundary: Cursor = !rawCut ? ageCursor! : raw.oldestKept ? raw.oldestKept.at : (req.asOf?.cursor ?? store.cursorAt(ctx.now));
    const tokensOf = (b: Block) => estimateTokens(blockText(b, codec.block(b)));

    let recent: Block[];
    let older: Block[];
    let censusLine: ViewLine | null = null;
    const tree = scoped ? await treeOf(scoped, partition, { endedBefore: boundary, asOf: req.asOf }) : null;
    let firstClipTo: number | undefined;
    let gapNote: string | undefined;
    if (tree && tree.numbered) {
      // The store already kept only what ended before the boundary, so every
      // numbered leaf it returned is inside the cover.
      const rows = tree.rows.map((r) => ({ id: r.id, level: r.level, blockIndex: r.index, endMs: r.endMs }));
      const fetchedById = new Map<string, Block>();
      const coverAt = async (lines: number) => {
        const planned = planCover(rows, Infinity, lines);
        for (const b of await blocksInOrder(planned.map((r) => r.id).filter((id) => !fetchedById.has(id)), req.asOf)) fetchedById.set(b.id, b);
        return planned.flatMap((r) => fetchedById.get(r.id) ?? []);
      };
      const chosen = await fitCover(budget.coverLines, coverAt, tokensOf, budget.recentTokens, budget.olderTokens);
      if (chosen.lines < budget.coverLines) stats.coarsenedTo = chosen.lines;
      const { blocks, fit } = chosen;
      if (blocks.length > budget.coverLines) stats.overLines = blocks.length - budget.coverLines;
      ({ recent, older } = fit);
      firstClipTo = fit.clipFirstTo;
      if (firstClipTo !== undefined) truncated.firstClipped = true;
      if (fit.dropped > 0) {
        truncated.older = true;
        stats.droppedBlocks = fit.dropped;
        const cut = blocks.slice(1, 1 + fit.dropped);
        gapNote = `(The first summary reaches back to the beginning. The ${cut.length === 1 ? 'summary' : `${cut.length} summaries`} after it, ${dayRange(cut[0].startMs, cut[cut.length - 1].endMs)}, did not fit this read; ${tool} with from and to reads that stretch.)`;
      }
    } else {
      // A cross-scope read takes leaves only: a merged block is one scope's
      // compression of its own leaves and would repeat them.
      const leaves = await readable(await store.leaves({ select, partition, endedBefore: boundary, limit: scoped ? LEGACY_LEAF_LIMIT : FEED_LEAF_LIMIT, asOf: req.asOf }), req.viewer, can);
      const kept = dedupeOverlappingLeaves(leaves.map((b) => ({ ...b, scopeKey: scopeKey(b.scope) })));
      const parts = partitionRoutineBlocks(kept, deps.collapse, censusApplies(deps.collapse, req.select));
      if (parts.census) {
        stats.folded = (stats.folded ?? 0) + parts.routine.length;
        censusLine = { text: formatBlockCensus(parts.census, storyHandleOf), kind: 'census', range: [parts.census.firstMs, parts.census.lastMs] };
      }
      const split = splitRecentOlder(parts.signal, tokensOf, budget.recentTokens, budget.olderTokens);
      if (split.recent.length + split.older.length < parts.signal.length) truncated.older = true;
      // Newest first in, oldest first out.
      recent = split.recent.reverse();
      older = split.older.reverse();
    }
    stats.recentBlocks = recent.length;
    stats.olderBlocks = older.length;

    // The first block of a cover may be clipped; it is the oldest line shown.
    const first = older[0] ?? recent[0];
    const lineOf = (b: Block) => (b === first && firstClipTo !== undefined ? clippedBlockLine(b, firstClipTo) : blockLine(b));
    const noteOf = (lead: boolean, holdsFirst: boolean) => [lead ? blockNote : undefined, holdsFirst ? gapNote : undefined].filter(Boolean).join('\n') || undefined;
    // The census leads the first summary section that exists, so a reader
    // learns what was collapsed before reading what survived.
    if (recent.length > 0 || (censusLine && older.length === 0)) {
      sections.push({ title: '## Earlier History (compressed)', note: noteOf(true, older.length === 0), lines: [...(censusLine ? [censusLine] : []), ...recent.map(lineOf)] });
    }
    if (older.length > 0) {
      const leads = recent.length === 0;
      sections.push({ title: '## Older History (summary)', note: noteOf(leads, true), lines: [...(leads && censusLine ? [censusLine] : []), ...older.map(lineOf)] });
    }
    return finish(sections, stats, truncated);
  }

  async function openStory(parsed: Extract<ParsedHandle, { kind: 'story' }>, handle: string, req: HandleRequest): Promise<HistoryView> {
    if (withholdsFrom(deps.ownership, req.run) && deps.ownership.ownedKinds.has(parsed.key)) {
      throw new HistoryError(`"${handle}" holds inbound messages that belong to the runs they woke, not this one. Search for a specific message only if work you already own needs it.`);
    }
    // A story printed by a one-scope read names its scope and opens only
    // there; one printed by a cross-scope read opens across the scopes this
    // viewer may read, in the feed.
    const can = reader(req.viewer);
    if (parsed.scope && !(await can(parsed.scope))) throw new HistoryError(NOT_FOUND(handle));
    const select: ScopeSelector = parsed.scope ? { scope: parsed.scope } : storeSelector({ all: true }, registry);
    const partition = req.viewer.partition;
    const found = await collect(
      (until, size) => store.activities({ select, partition, kinds: [parsed.key], from: store.cursorAt(parsed.fromMs), before: store.cursorAt(parsed.toMs + 1), until, order: 'desc', limit: size, asOf: req.asOf }),
      STORY_LIMIT,
      async (a) => a.partition === partition && (await can(a.scope)),
    );
    if (found.rows.length === 0) throw new HistoryError(NOT_FOUND(handle));
    const lines = await activityLines(found.rows.reverse(), ctxOf(req), false);
    const more = found.more ? `, the newest ${STORY_LIMIT} shown` : '';
    return finish([{ title: `## Story ${handle}: ${parsed.key} events${more}`, lines }], { raw: lines.length, recentBlocks: 0, olderBlocks: 0 }, { raw: found.more });
  }

  async function open(handle: string, req: HandleRequest): Promise<HistoryView> {
    const parsed = await parseHandle(handle);
    const ctx = ctxOf(req);
    if (parsed.kind === 'story') return openStory(parsed, handle, req);
    if (parsed.kind === 'activity') {
      const a = await store.activity(parsed.id, req.asOf);
      if (!a || a.partition !== req.viewer.partition || !(await reader(req.viewer)(a.scope))) throw new HistoryError(NOT_FOUND(handle));
      const lines = await activityLines([a], ctx, true);
      return finish([{ title: `## Entry ${handle}`, lines }], { raw: lines.length, recentBlocks: 0, olderBlocks: 0 });
    }
    if (parsed.kind === 'ref') {
      const text = renderer.openRef ? await renderer.openRef(parsed.ref, {}, ctx) : null;
      if (text == null) throw new HistoryError(NOT_FOUND(handle));
      return finish([{ title: `## ${parsed.ref}`, lines: [{ text, kind: 'activity' }] }], { raw: 1, recentBlocks: 0, olderBlocks: 0 });
    }
    const b = await resolveBlock(parsed, handle, req);
    if (b.level === 0 || b.index === null) {
      const lines = await activityLines(await store.activitiesIn(b, req.asOf), ctx, true);
      return finish([{ title: `## ${tag} ${handle} opened: its ${lines.length} raw entries (${dayRange(b.startMs, b.endMs)})`, lines }], { raw: lines.length, recentBlocks: 0, olderBlocks: 0 });
    }
    const [lo, hi] = blockSpan({ level: b.level, index: b.index });
    const { blocks } = await spanBlocks(await treeOf(b.scope, b.partition, { asOf: req.asOf }), lo, hi, 2, req.asOf);
    return finish([{ title: `## ${tag} ${handle} opened: the blocks it was written from`, note: blockNote, lines: blocks.map(blockLine) }], { raw: 0, recentBlocks: 0, olderBlocks: blocks.length });
  }

  async function zoomOut(handle: string, req: HandleRequest & { build?: boolean }): Promise<HistoryView> {
    const parsed = await parseHandle(handle);
    if (parsed.kind === 'activity') {
      const a = await store.activity(parsed.id, req.asOf);
      if (!a || a.partition !== req.viewer.partition || !(await reader(req.viewer)(a.scope))) throw new HistoryError(NOT_FOUND(handle));
      const leaf = await store.leafHolding(a, req.asOf);
      if (!leaf) throw new HistoryError(`Entry "${handle}" is recent enough that no summary covers it yet. Read the scope's history to see it in place.`);
      return finish([{ title: `## Entry ${handle} zoomed out: the summary that covers it`, note: blockNote, lines: [blockLine(leaf)] }], { raw: 0, recentBlocks: 1, olderBlocks: 0 });
    }
    if (parsed.kind !== 'block') throw new HistoryError(`Zooming out works on a ${tag} or an entry. "${handle}" is neither; open it instead.`);
    const b = await resolveBlock(parsed, handle, req);
    if (b.index === null) throw new HistoryError(`"${handle}" has no place in its scope's tree yet, so there is nothing coarser to show. Open it instead.`);
    const at = { level: b.level, index: b.index };
    const parent = blockParent(at);
    const [lo, hi] = blockSpan(parent);
    let tree = await treeOf(b.scope, b.partition, { asOf: req.asOf });
    if (hi > tree.T) {
      // The parent would reach past the newest leaf: show what exists of it.
      const { blocks } = await spanBlocks(tree, lo, tree.T, 1, req.asOf);
      const whole = blocks.length === 1 && blocks[0].id === b.id;
      const note = whole ? `(This ${tag} already reaches the newest summary; nothing coarser exists yet.)` : `(The coarser ${tag} is not complete yet: its later half is still being written. What exists of it is shown.)`;
      return finish([{ title: `## ${tag} ${handle} zoomed out`, note: `${note}\n${blockNote}`, lines: blocks.map(blockLine) }], { raw: 0, recentBlocks: 0, olderBlocks: blocks.length });
    }
    if (!tree.idByKey.has(blockKey(parent)) && req.build && deps.summarizer && !req.asOf) {
      const [left, right] = [tree.idByKey.get(blockKey({ level: at.level, index: parent.index * 2 })), tree.idByKey.get(blockKey({ level: at.level, index: parent.index * 2 + 1 }))];
      if (left && right) {
        const key = `${b.partition}\u0000${scopeKey(b.scope)}\u0000${blockKey(parent)}`;
        let pending = building.get(key);
        if (!pending) {
          pending = buildBlock({ store, summarizer: deps.summarizer, logger, config: { ...DEFAULT_COMPRESS, ...deps.compress } }, b.scope, b.partition, parent, left, right).finally(() => building.delete(key));
          building.set(key, pending);
        }
        await pending;
        tree = await treeOf(b.scope, b.partition);
      }
    }
    const { blocks } = await spanBlocks(tree, lo, hi, 1, req.asOf);
    const merged = tree.idByKey.has(blockKey(parent));
    return finish(
      [{ title: `## ${tag} ${handle} zoomed out${merged ? '' : ': not yet merged'}`, note: merged ? blockNote : `(The coarser ${tag} has not been written yet; the stretch it would cover is shown as the blocks that exist.)\n${blockNote}`, lines: blocks.map(blockLine) }],
      { raw: 0, recentBlocks: 0, olderBlocks: blocks.length },
    );
  }

  async function focus(req: ViewRequest & { from: number; to: number }): Promise<HistoryView> {
    if (selectorHasNul(req.select, req.kinds)) throw nulError();
    const scope = await requireScope(req.select, req.viewer, 'A focused read');
    if (!Number.isFinite(req.from) || !Number.isFinite(req.to) || req.from >= req.to) throw new HistoryError('A focused read needs a stretch with `from` before `to`.');
    // Instants outside what a timestamp can hold are read as its ends.
    req = { ...req, from: Math.max(0, req.from), to: Math.min(MAX_INSTANT, req.to) };
    if (req.from >= req.to) throw new HistoryError('A focused read needs a stretch with `from` before `to`, between 1970 and 9999.');
    const budget = budgetOf(req);
    const ctx = ctxOf(req);
    const partition = req.viewer.partition;
    const title = `## Focus ${dayRange(req.from, req.to - 1)}`;
    const sections: HistoryView['sections'] = [];
    const stats: Omit<HistoryView['stats'], 'tokens'> = { raw: 0, recentBlocks: 0, olderBlocks: 0 };
    const truncated: NonNullable<HistoryView['truncated']> = {};
    const toCursor = store.cursorAt(req.to);

    /** Where the summaries of this stretch end; raw entries after it are shown as they are. */
    let coveredTo: Cursor | null = null;
    if (!req.kinds) {
      const tree = await treeOf(scope, partition, { asOf: req.asOf });
      let blocks: Block[];
      if (tree.numbered) {
        const leaves = tree.rows.filter((r) => r.level === 0 && r.index !== null).sort((a, b) => a.index! - b.index!);
        const inside = leaves.filter((r) => r.endMs >= req.from && r.startMs < req.to);
        const lo = inside.length > 0 ? inside[0].index! : 0;
        const hi = inside.length > 0 ? inside[inside.length - 1].index! + 1 : 0;
        const span = await spanBlocks(tree, lo, hi, budget.coverLines, req.asOf);
        blocks = span.blocks;
        if (span.wanted.length > budget.coverLines) stats.overLines = span.wanted.length - budget.coverLines;
        // A stretch that ends inside the summarized past needs no raw tail.
        if (hi === tree.T && blocks.length > 0) coveredTo = blocks[blocks.length - 1].end;
        else if (hi > 0) coveredTo = toCursor;
      } else {
        const found = await store.leaves({ select: { scope }, partition, endedBefore: req.asOf?.cursor ?? toCursor, limit: LEGACY_LEAF_LIMIT, asOf: req.asOf });
        blocks = dedupeOverlappingLeaves(found.map((b) => ({ ...b, scopeKey: scopeKey(b.scope) })))
          .filter((b) => b.endMs >= req.from && b.startMs < req.to);
        if (blocks.length > budget.coverLines) truncated.older = true;
        blocks = blocks.slice(0, budget.coverLines).reverse();
        if (blocks.length > 0) coveredTo = blocks[blocks.length - 1].end;
      }
      const texts = blocks.map((b) => estimateTokens(blockText(b, codec.block(b))));
      const { kept, keptCount } = fillBudgetNewestFirst(texts, budget.recentTokens + budget.olderTokens);
      if (keptCount < blocks.length) truncated.older = true;
      const shown = blocks.filter((_, i) => kept[i]);
      stats.olderBlocks = shown.length;
      if (shown.length > 0) sections.push({ title: `${title}: summaries`, note: blockNote, lines: shown.map(blockLine) });
    }

    if (coveredTo !== toCursor) {
      const newest = await store.activities({
        select: { scope },
        partition,
        after: coveredTo ?? undefined,
        from: store.cursorAt(req.from),
        before: toCursor,
        kinds: req.kinds ? [...req.kinds] : undefined,
        order: 'desc',
        limit: RAW_ROW_LIMIT + 1,
        asOf: req.asOf,
      });
      const overflow = newest.length > RAW_ROW_LIMIT;
      const raw = await rawPart(newest.slice(0, RAW_ROW_LIMIT).reverse(), req, ctx, budget.rawTokens);
      stats.raw = raw.shown;
      if (raw.folded) stats.folded = raw.folded;
      if (raw.withheld) stats.withheld = raw.withheld;
      if (raw.dropped || overflow) truncated.raw = true;
      if (raw.lines.length > 0) sections.push({ title: `${title}: raw entries`, note: raw.hasStory ? storyNote : undefined, lines: raw.lines });
    }
    if (sections.length === 0) sections.push({ title, note: '(Nothing was logged in this stretch.)', lines: [] });
    return finish(sections, stats, truncated);
  }

  async function search(req: ViewRequest & { query: string; limit?: number }): Promise<HistoryView> {
    const text = typeof req.query === 'string' ? req.query.trim() : '';
    if (!text) throw new HistoryError('A search needs words to look for.');
    if (hasNul(text) || selectorHasNul(req.select, req.kinds)) throw nulError();
    const limit = Math.min(200, Math.max(1, Math.floor(Number.isFinite(req.limit) ? req.limit! : 20)));
    const can = reader(req.viewer);
    const scoped = singleScope(req.select);
    if (scoped && !(await can(scoped))) throw new HistoryError(`The scope ${scopeKey(scoped)} is not readable from this run.`);
    const select = storeSelector(req.select, registry);
    const partition = req.viewer.partition;
    const kinds = req.kinds ? [...req.kinds] : undefined;
    const needle = text.toLowerCase();
    // Filters run in the store before its limit, and pages continue past rows
    // this viewer may not read, so neither a lens nor other scopes starve it.
    const found = await collect(
      store.search
        ? (until, size) => store.search!({ select, partition, text, kinds, until, limit: size, asOf: req.asOf })
        : (until, size) => store.activities({ select, partition, kinds, until, order: 'desc', limit: size, asOf: req.asOf }),
      limit,
      async (a) => a.partition === partition && a.summary.toLowerCase().includes(needle) && (await can(a.scope)),
    );
    const acts = found.rows;
    const lines = await activityLines(acts, ctxOf(req), false);
    return finish([{ title: `## Search "${text}": ${lines.length} ${lines.length === 1 ? 'entry' : 'entries'}, newest first`, lines }], { raw: lines.length, recentBlocks: 0, olderBlocks: 0 });
  }

  return {
    view,
    open,
    zoomOut,
    focus,
    search,
    compressOnce(opts) {
      if (!deps.summarizer) throw new Error('compressOnce needs a summarizer');
      return compressOnce({ store, summarizer: deps.summarizer, clock, registry, logger, config: { ...DEFAULT_COMPRESS, ...deps.compress } }, opts);
    },
  };
}
