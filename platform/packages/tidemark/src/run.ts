import type { AsOf } from './asof';
import type { ReadBudget } from './budget';
import type { Partition, Scope } from './scope';

/** A conversation on some channel (v0.3 fills in the channel side). */
export interface ConversationRef {
  channel: string;
  id: string;
  thread?: string;
}

/** One run of one agent at one scope: what every read and guard is handed. */
export interface RunEnvelope {
  runId: string;
  agentId: string;
  scope: Scope;
  partition: Partition;
  /** Why it woke. */
  reason: string;
  trigger?: { activityId?: string; ref?: string; conversation?: ConversationRef };
  focusedTaskId?: string;
  asOf?: AsOf;
}

/** Decides which scopes' memories a run reads. Default: the run's own scope and the global scope. */
export type MemoryScopeResolver = (run: RunEnvelope) => Scope[] | Promise<Scope[]>;

export interface AgentProfile {
  id: string;
  /** The agent's default read budget; a per-read budget overrides it field by field. */
  history?: ReadBudget;
  memory?: { resolver: MemoryScopeResolver };
}

/** Where the runtime reports what it would otherwise swallow; `context.error` is the value as caught. Never throws. */
export interface RuntimeLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export const silentLogger: RuntimeLogger = { warn: () => {} };

/** A run as its store first sees it. */
export interface NewRun {
  runId: string;
  agentId: string;
  scope: Scope;
  partition: Partition;
  reason: string;
  startedAtMs: number;
}

/** One persisted row of a run's transcript (an assistant message, a tool result) and what it cost. */
export interface RunStep {
  row: unknown;
  costUsd: number;
}

export interface RunEnd {
  /** Why it stopped: done, approval, budget, time, error, cancelled. */
  reason: string;
  error?: string;
  costUsd: number;
  endedAtMs: number;
}

/** Where runs are recorded. v0.2 adds superseding and recent-run dedup. */
export interface RunStore {
  begin(r: NewRun): Promise<void>;
  step(runId: string, s: RunStep): Promise<void>;
  finish(runId: string, end: RunEnd): Promise<void>;
  isCancelled(runId: string): Promise<boolean>;
}
