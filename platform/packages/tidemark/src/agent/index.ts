/**
 * The bridge to @platform/agent: the history tool a model calls, and a
 * minimal scoped run over `runAssistant`. This is the only place tidemark
 * touches the agent loop; the core imports none of it.
 */
import { defineTool, runAssistant, Type, type Gate, type MessageRow, type RunAssistantOptions, type RunResult, type Tool } from '@platform/agent';

import { resolveBudget, type ReadBudget } from '../budget';
import { systemClock, type Clock } from '../clock';
import { assembleContext, type ContextSection } from '../context';
import { HistoryError, type History, type HistoryView } from '../history';
import type { AgentProfile, RunEnvelope, RunStore } from '../run';
import { parseScopeKey, type ScopeSelector, type Viewer } from '../scope';

export { assembleContext, historySection, memorySection } from '../context';
export type { AssembledContext, ContextSection } from '../context';

/** Extra verbs a host adds to the history tool (its own documents: messages, calls, threads). */
export interface HistoryToolExtension {
  /** Added to the tool description. */
  describe: string;
  /** Extra parameters, as typebox schemas by name. */
  parameters?: Record<string, ReturnType<typeof Type.String>>;
  /** Answers the call, or returns null when the arguments are not for it. */
  run(args: Record<string, unknown>, ctx: { run: RunEnvelope; viewer: Viewer }): Promise<string | null>;
}

export interface HistoryToolOptions {
  run: RunEnvelope;
  viewer: Viewer;
  /** Its `history` budget is the default for every call and the ceiling for `lines`. */
  profile?: AgentProfile;
  zone?: string;
  clock?: Clock;
  /** Let a zoom out write a missing coarser block on demand (one summary call). Default true. */
  build?: boolean;
  extensions?: HistoryToolExtension[];
  name?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** An instant from what a model writes: an ISO date or datetime, or epoch milliseconds. A bare date as `to` means through the end of that day. */
function instant(value: unknown, end: boolean): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d{11,}$/.test(text)) return Number(text);
  const ms = Date.parse(DAY.test(text) ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(ms)) return null;
  return end && DAY.test(text) ? ms + 24 * 60 * 60 * 1000 : ms;
}

/**
 * `read_history`: the one tool through which a model reads and zooms.
 * - no arguments: the scope's cover (raw lines near now, summaries behind)
 * - `item`: open a handle one level finer; with `zoom: "out"`, one level coarser
 * - `from` / `to`: any stretch, at `lines` resolution
 * - `query`: keyword search over the raw log
 * `lines` is the per-read budget the model may ask for, clamped by the profile.
 * A read that cannot be served returns its steering message as the result, so
 * the model learns what to do instead of seeing an error.
 */
export function historyTools(history: History, opts: HistoryToolOptions): Tool[] {
  const clock = opts.clock ?? systemClock;
  const base: ReadBudget = opts.profile?.history ?? {};
  const ceiling = resolveBudget(base).maxCoverLines;
  const extensions = opts.extensions ?? [];
  const extra = Object.assign({}, ...extensions.map((e) => e.parameters ?? {}));

  const read = async (args: Record<string, unknown>): Promise<HistoryView> => {
    const common = { viewer: opts.viewer, asOf: opts.run.asOf, run: opts.run, zone: opts.zone };
    // resolveBudget cuts it to the profile's ceiling and to at least one.
    const lines = typeof args.lines === 'number' && Number.isFinite(args.lines) ? args.lines : undefined;
    const budget: ReadBudget = lines === undefined ? base : { ...base, coverLines: lines };
    if (typeof args.item === 'string' && args.item.trim()) {
      return args.zoom === 'out' ? history.zoomOut(args.item, { ...common, budget, build: opts.build ?? true }) : history.open(args.item, { ...common, budget });
    }
    let select: ScopeSelector = { scope: opts.run.scope };
    if (typeof args.scope === 'string' && args.scope.trim()) {
      const scope = parseScopeKey(args.scope.trim());
      if (!scope) throw new HistoryError(`"${args.scope}" is not a scope. A scope is written type:id.`);
      select = { scope };
    }
    if (typeof args.query === 'string' && args.query.trim()) return history.search({ ...common, select, budget, query: args.query, limit: lines });
    if (args.from !== undefined || args.to !== undefined) {
      const now = opts.run.asOf?.at ?? clock.now();
      const from = args.from === undefined ? 0 : instant(args.from, false);
      const to = args.to === undefined ? now : instant(args.to, true);
      if (from === null || to === null) throw new HistoryError('`from` and `to` are dates like 2026-03-01 or full ISO timestamps.');
      return history.focus({ ...common, select, budget, from, to: Math.min(to, now) });
    }
    return history.view({ ...common, select, budget });
  };

  return [
    defineTool({
      name: opts.name ?? 'read_history',
      description: [
        'Read the logged history of the scope you are working in, at any zoom.',
        'With no arguments: recent raw entries, then AI-written summaries reaching back to the beginning.',
        'item: a handle exactly as a read printed it. Opens it one level finer (a summary into the two it was written from, or into its raw entries; a story into its events). With zoom "out", shows the coarser summary that holds it.',
        'from / to: read one stretch (dates like 2026-03-01), summarized into at most `lines` blocks, finest at its end.',
        'query: keyword search over raw entries, newest first.',
        `lines: how many summary blocks to spend (1 to ${ceiling}). Fewer is coarser.`,
        'Summaries are secondhand. Before relying on a name, number, commitment or outcome found only in one, open it down to raw entries.',
        ...extensions.map((e) => e.describe),
      ].join('\n'),
      parameters: Type.Object({
        scope: Type.Optional(Type.String({ description: 'Another scope to read, as type:id. Defaults to the scope of this run.' })),
        item: Type.Optional(Type.String({ description: 'A handle from an earlier read.' })),
        zoom: Type.Optional(Type.String({ description: 'With item: "in" (default) opens it finer, "out" shows the coarser block.' })),
        from: Type.Optional(Type.String({ description: 'Start of a stretch, e.g. 2026-03-01.' })),
        to: Type.Optional(Type.String({ description: 'End of a stretch (a bare date includes that day).' })),
        lines: Type.Optional(Type.Number({ description: `Summary blocks to spend, 1 to ${ceiling}.` })),
        query: Type.Optional(Type.String({ description: 'Words to search the raw log for.' })),
        ...extra,
      }),
      risk: 'read',
      run: async (args) => {
        const given = args as Record<string, unknown>;
        try {
          for (const e of extensions) {
            const answer = await e.run(given, { run: opts.run, viewer: opts.viewer });
            if (answer !== null) return answer;
          }
          const view = await read(given);
          return { content: view.text || '(Nothing is logged here yet.)', details: { stats: view.stats, truncated: view.truncated, handles: view.handles.length } };
        } catch (error) {
          if (error instanceof HistoryError) return error.message;
          throw error;
        }
      },
    }),
  ];
}

/**
 * Shapes a run's toolset before it starts. A tool whose every call would be
 * refused is withheld here, and its absence is stated as a fact with the
 * alternative, so the model never learns a standing fact by being refused.
 */
export type ToolScoper = (run: RunEnvelope, tools: Tool[]) => { tools: Tool[]; facts?: string[] } | Promise<{ tools: Tool[]; facts?: string[] }>;

export interface ScopedRunOptions {
  run: RunEnvelope;
  profile: AgentProfile;
  sections: ContextSection[];
  tools: Tool[];
  model: RunAssistantOptions['model'];
  ceilingUsd: number;
  deadlineMs: number;
  runs: RunStore;
  /** What the run answers: the person's turn, or the reason it woke. Rows must end on a user turn. */
  input: string | MessageRow[];
  gate?: Gate;
  scopers?: ToolScoper[];
  clock?: Clock;
  apiKeys?: RunAssistantOptions['apiKeys'];
  signal?: AbortSignal;
  /** How often the run store is asked whether the run was cancelled. Default 5 seconds. */
  cancelPollMs?: number;
}

export type ScopedRunResult = RunResult & { context: { sizes: Record<string, number>; facts: string[] } };

/**
 * One run of one agent at one scope: record it, assemble its context, shape
 * its toolset, loop with `runAssistant`, record every row and the end. The
 * run's own transcript is @platform/agent's rows; the scope's long history
 * arrives through the sections (see `historySection`). Never throws for a
 * model or tool failure: `runAssistant` reports those in the result.
 */
export async function runScopedAgent(opts: ScopedRunOptions): Promise<ScopedRunResult> {
  const { run, runs } = opts;
  const clock = opts.clock ?? systemClock;
  await runs.begin({ runId: run.runId, agentId: run.agentId, scope: run.scope, partition: run.partition, reason: run.reason, startedAtMs: clock.now() });

  const cancel = new AbortController();
  const abort = () => cancel.abort();
  opts.signal?.addEventListener('abort', abort);
  if (opts.signal?.aborted) abort();
  const poll = setInterval(() => {
    runs.isCancelled(run.runId).then((yes) => yes && abort(), () => {});
  }, opts.cancelPollMs ?? 5000);

  let costUsd = 0;
  try {
    let tools = opts.tools;
    const facts: string[] = [];
    for (const scoper of opts.scopers ?? []) {
      const shaped = await scoper(run, tools);
      tools = shaped.tools;
      facts.push(...(shaped.facts ?? []));
    }
    const sections: ContextSection[] = facts.length > 0 ? [...opts.sections, { key: 'run-facts', title: 'This run', tier: 'volatile', render: () => facts.join('\n') }] : opts.sections;
    const context = await assembleContext(run, sections, opts.profile.history ?? {});
    if (await runs.isCancelled(run.runId)) abort();

    const result = await runAssistant({
      model: opts.model,
      system: context.system,
      history: typeof opts.input === 'string' ? [{ role: 'user', content: opts.input, timestamp: clock.now() }] : opts.input,
      tools,
      gate: opts.gate,
      ceilingUsd: opts.ceilingUsd,
      deadlineMs: opts.deadlineMs,
      apiKeys: opts.apiKeys,
      signal: cancel.signal,
      sessionId: run.runId,
      onMessage: async (row, info) => {
        costUsd += info.costUsd;
        await runs.step(run.runId, { row, costUsd: info.costUsd });
      },
    });
    const cancelled = cancel.signal.aborted && result.reason === 'error';
    await runs.finish(run.runId, { reason: cancelled ? 'cancelled' : result.reason, error: result.error, costUsd: result.costUsd, endedAtMs: clock.now() });
    return { ...result, context: { sizes: context.sizes, facts } };
  } catch (error) {
    await runs.finish(run.runId, { reason: 'error', error: String(error), costUsd, endedAtMs: clock.now() }).catch(() => {});
    throw error;
  } finally {
    clearInterval(poll);
    opts.signal?.removeEventListener('abort', abort);
  }
}
