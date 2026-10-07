import { formatStamp } from './render';
import type { MemoryScopeResolver, RunEnvelope } from './run';
import { GLOBAL, sameScope, scopeKey, type Partition, type Scope, type ScopeRegistry } from './scope';

/**
 * A memory is a durable note an agent keeps at a scope: a fact about a person
 * attaches to that person and loads only when a run works with them; a
 * procedure that applies everywhere lives at the global scope. Memories are
 * rows, numbered per agent and scope, and can expire or be archived.
 */
export interface Memory {
  id: string;
  agentId: string;
  scope: Scope;
  partition: Partition;
  /** Position among this agent's memories at this scope; how the agent refers to one. */
  seq: number;
  /** One line: what it is about. */
  header: string;
  content: string;
  createdAtMs: number;
  /** After this instant the memory no longer loads. */
  expiresAtMs?: number;
  archived: boolean;
}

export type NewMemory = Pick<Memory, 'agentId' | 'scope' | 'partition' | 'header' | 'content'> & { expiresAtMs?: number; createdAtMs?: number };

export interface MemoryStore {
  /** Memories as of an instant: not archived, created strictly before `at`, not yet expired at `at`. Ordered by scope, then seq. */
  list(q: { agentId: string; scopes: Scope[]; partition: Partition; at: number }): Promise<Memory[]>;
  write(m: NewMemory): Promise<Memory>;
  /** `expiresAtMs: null` clears an expiry. */
  edit(id: string, patch: { header?: string; content?: string; expiresAtMs?: number | null; archived?: boolean }): Promise<void>;
}

/** The default read fan-out: the run's own scope, then the global scope. */
export const defaultMemoryScopes: MemoryScopeResolver = (run) => (sameScope(run.scope, GLOBAL) ? [GLOBAL] : [run.scope, GLOBAL]);

/**
 * The scope a new memory is written at: the run's own scope by default, the
 * global scope on request. A run at a scope whose type may not write global
 * memory is refused rather than silently narrowed, so a fact about one person
 * never becomes something every run reads.
 */
export function memoryWriteScope(run: Pick<RunEnvelope, 'scope'>, registry: ScopeRegistry, opts: { global?: boolean } = {}): Scope {
  if (sameScope(run.scope, GLOBAL)) return GLOBAL;
  if (!opts.global) return run.scope;
  if (!registry.def(run.scope.type).writesGlobalMemory) {
    throw new Error(`A run at a ${run.scope.type} scope cannot write global memories. Write it at ${scopeKey(run.scope)} instead.`);
  }
  return GLOBAL;
}

/**
 * The memories a run reads: as of its replay instant when it has one (only
 * what was written strictly before it), else everything written up to now.
 */
export async function loadMemories(store: MemoryStore, run: RunEnvelope, now: number, resolver: MemoryScopeResolver = defaultMemoryScopes): Promise<Memory[]> {
  return store.list({ agentId: run.agentId, scopes: await resolver(run), partition: run.partition, at: run.asOf?.at ?? now + 1 });
}

/** Memories as a context section body, grouped by scope, or null when there are none. */
export function renderMemories(memories: readonly Memory[]): string | null {
  if (memories.length === 0) return null;
  const byScope = new Map<string, Memory[]>();
  for (const m of memories) byScope.set(scopeKey(m.scope), [...(byScope.get(scopeKey(m.scope)) ?? []), m]);
  return [...byScope.entries()]
    .map(([key, list]) => `### ${key}\n` + list.map((m) => `[${m.seq}] ${m.header}${m.expiresAtMs ? ` (until ${formatStamp(m.expiresAtMs)})` : ''}\n${m.content}`).join('\n\n'))
    .join('\n\n');
}
