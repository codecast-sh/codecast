import type { ReadBudget } from './budget';
import type { Clock } from './clock';
import type { History, ViewRequest } from './history';
import { loadMemories, renderMemories, type MemoryStore } from './memory';
import { estimateTokens } from './render';
import type { MemoryScopeResolver, RunEnvelope } from './run';
import type { Viewer } from './scope';

/** One part of a run's system prompt. */
export interface ContextSection {
  key: string;
  title?: string;
  /**
   * Cache tier. 'stable' sections change rarely (identity, rules, memory) and
   * go first, in a block a provider may cache for long; 'volatile' sections
   * change every run (history) and go last.
   */
  tier: 'stable' | 'volatile';
  /** Null leaves the section out. */
  render(run: RunEnvelope, budget: ReadBudget): Promise<string | null> | string | null;
}

export interface AssembledContext {
  system: string;
  /** The same text as cache blocks: stable first (long TTL), then volatile. */
  systemBlocks: Array<{ text: string; ttl?: '1h' }>;
  /** Estimated tokens per section key. */
  sizes: Record<string, number>;
}

/** Render a run's sections into its system prompt, stable sections ahead of volatile ones. */
export async function assembleContext(run: RunEnvelope, sections: readonly ContextSection[], budget: ReadBudget = {}): Promise<AssembledContext> {
  const rendered = await Promise.all(
    sections.map(async (s) => {
      const body = await s.render(run, budget);
      return { section: s, text: body == null || body === '' ? null : s.title ? `## ${s.title}\n${body}` : body };
    }),
  );
  const sizes: Record<string, number> = {};
  const tier = (t: ContextSection['tier']) =>
    rendered
      .filter((r) => r.section.tier === t && r.text !== null)
      .map((r) => {
        sizes[r.section.key] = estimateTokens(r.text!);
        return r.text!;
      })
      .join('\n\n');
  const stable = tier('stable');
  const volatile = tier('volatile');
  const systemBlocks: AssembledContext['systemBlocks'] = [];
  if (stable) systemBlocks.push({ text: stable, ttl: '1h' });
  if (volatile) systemBlocks.push({ text: volatile });
  return { system: systemBlocks.map((b) => b.text).join('\n\n'), systemBlocks, sizes };
}

/** The run's scope history as a volatile section: the cover, as of the run's replay instant when it has one. */
export function historySection(history: History, opts: { viewer: Viewer; select?: ViewRequest['select']; zone?: string; key?: string }): ContextSection {
  return {
    key: opts.key ?? 'history',
    tier: 'volatile',
    render: async (run, budget) => (await history.view({ select: opts.select ?? { scope: run.scope }, viewer: opts.viewer, budget, asOf: run.asOf, run, zone: opts.zone })).text || null,
  };
}

/** The run's memories as a stable section. */
export function memorySection(store: MemoryStore, opts: { clock: Clock; resolver?: MemoryScopeResolver; key?: string; title?: string }): ContextSection {
  return {
    key: opts.key ?? 'memory',
    title: opts.title ?? 'Memory',
    tier: 'stable',
    render: async (run) => renderMemories(await loadMemories(store, run, opts.clock.now(), opts.resolver)),
  };
}
