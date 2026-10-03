import type { CheckResult, ConvoMessage, Freeze, GateResult, ProductionReply, Score } from '@platform/evals';

import type { SurfaceRequest } from '../../convex/convex/lib/anthropic';
import { DRY_RUN_SCRIPT_REL } from './paths';

export type { SurfaceRequest };

// A surface is one production prompt with one call site. Its meta is light
// (registry.ts imports every one statically, and `stale` reads them in well
// under a second); its implementation is loaded only when a command needs it.

export interface SurfaceMeta {
  id: string;
  title: string;
  route: 'call' | 'agent';
  /** The pinned model id (models.ts). */
  model: string;
  /** Repo paths `stale` hashes at HEAD. surfaceSources() adds the surface's own dir and the harness. */
  sources: string[];
  reps: { check: number; smoke?: number };
  /** The cost estimate per rep before any real run has recorded one. */
  maxUsdPerRep: number;
  /** The criteria a new freeze is judged by when neither the fixture nor --judge sets one. */
  criteria?: string | null;
  /** Agent route: argv templates `snapshot` captures, e.g. [['brief'], ['org','inputs','--team','{team}','--json']]. */
  frozenReads?: string[][];
  /** Agent route: first words (or "w1 w2") that must be served, never live. */
  frozenVerbs?: string[];
  /**
   * Agent route: an argv the agent types, answered with what `snapshot` captured
   * for another of frozenReads. A role's own `cast brief` is read as
   * `brief @{role}` from the capturing shell, because a bare read from the
   * role's own session would move the role's brief clock in prod.
   */
  servedAliases?: Array<{ serve: string[]; from: string[] }>;
  /** Agent route: REFUSED lines matching one of these are allowed by the surface's harness note. */
  allowedRefusals?: string[];
}

/**
 * A REFUSED pattern for an agent writing its own brief (`cast brief edit -`):
 * a role's turn ends by saving what it learned, and the harness note sends
 * that save to `brief.md`, so a turn that also types the command did what its
 * frame asked. Only its own: `--for` names another role's brief, and
 * `brief @x edit` is not this command, so both stay refused.
 */
export const OWN_BRIEF_EDIT = '^(?!.*(?:^| )--for(?:[ =]|$))brief(?: --team[ =]\\S+)? edit(?: |$)';

/** The directory a surface's code lives in: its id in camelCase. */
export const surfaceDir = (id: string): string => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** A surface's declared sources: the prod files that shape its prompt, plus its own dir and the harness. */
export function surfaceSources(id: string, ...prod: string[]): string[] {
  return [...prod, `packages/evals/src/surfaces/${surfaceDir(id)}`, DRY_RUN_SCRIPT_REL];
}

/** What `capture` hands back for a real moment; the resolver redacts, hashes and stores the snapshot. */
export interface Captured {
  /** The snapshot content, written content-addressed under EVALS_HOME/snapshots/<surface>/. */
  snapshot?: unknown;
  /** Or an existing snapshot (an agent surface's served dir), relative to EVALS_HOME/snapshots. */
  snapshotRef?: string;
  subject: { id: string; kind: string; title: string };
  asOf: string;
  anchor: { kind: 'message' | 'run'; id: string };
  name?: string;
  trigger?: { type: string; data?: Record<string, unknown> };
  /** Extra private meta: conversation_id, call_id, trigger_id, workspace, model. */
  meta?: Record<string, unknown>;
}

export interface CaptureCtx {
  /** Pages /cli/read and the other access-checked reads (adapters/convo.ts). */
  readConversation(ref: string, opts?: { from?: number; to?: number }): Promise<unknown>;
}

export interface CallResult {
  request: SurfaceRequest;
  text: string;
  outputTokens: number;
  stopReason: string | null;
  modelUsage: Record<string, { outputTokens?: number; inputTokens?: number; costUSD?: number }>;
  costUsd: number;
  isError: boolean;
  /** Why the model never answered, when the prompt did not cause it (dryRun.ts harnessFailure). */
  harnessFailure?: string;
  exitCode: number;
  /** The harness run dir for this call. */
  dir: string;
  realMs: number;
  /** A call that grades the reply rather than one under test: its prompt stays out of promptSha. */
  grader?: boolean;
}

export interface AgentOptions {
  prompt: string;
  serveDir?: string;
  model: string;
  tools?: string[];
  maxTurns?: number;
  /** Later turns, in order: each is sent into the same session once the previous one ends. */
  then?: string[];
  /**
   * run.json.promptSha when the briefing wraps the prompt under test in text
   * of the run's own (org-review: the analyzer prompt without the harness
   * note and the run's paths). Named before the run starts, so a rep that
   * dies mid-run still records the prompt it ran.
   */
  promptSha?: string;
}

export interface AgentResult {
  runSubdir: string;
  /** Every assistant message of the run, every turn, in order. */
  said: string[];
  /** The same messages per turn: turns[0] answers the prompt, turns[n] the nth `then`. */
  turns: string[][];
  /** The files each turn wrote (dryRun.ts filesWrittenOf), per turn as `turns`. */
  wrote?: string[][];
  calls: string[];
  costUsd: number;
  /** Every model the run spent on, its `Agent` subagents included. */
  modelUsage: CallResult['modelUsage'];
  /** The agent's own loop: top-level assistant messages per model, read from the stream (dryRun.ts loopTurnsOf). Empty for a dry run. */
  loopTurns?: Record<string, number>;
  isError: boolean;
  /** Why the run says nothing about the prompt: the model never answered, or the agent's cast reached the real CLI outside its world (dryRun.ts readAgentRun). */
  harnessFailure?: string;
  exitCode: number;
  model: string;
  realMs: number;
}

export interface ReplayCtx {
  /** One single-call run through prompt-dry-run.ts --call. `label` names it for the reader; `grader` marks a call that grades the reply. */
  call(req: SurfaceRequest, opts?: { label?: string; grader?: boolean }): Promise<CallResult>;
  /** One agent run through prompt-dry-run.ts with a served world. */
  agent(opts: AgentOptions): Promise<AgentResult>;
  /** Canned output, no spawn: proves the wiring, spends nothing. */
  dry: boolean;
  /** The model under test: the surface's pin, or the --model override. */
  model: string;
  runDir: string;
  /** Absolute path of the freeze's served dir, for agent surfaces. */
  snapshotDir?: string;
  freeze: Freeze;
}

/** What a surface's replay returns: the reply a reader sees, and whatever it parsed. */
export interface ReplayOutput {
  reply: string;
  parsed?: unknown;
  extra?: Record<string, unknown>;
}

/** The output plus every harness run it made, which the route gates read. */
export interface ReplayResult extends ReplayOutput {
  calls: CallResult[];
  agents: AgentResult[];
}

export interface SurfaceImpl {
  /** One line for the UsageError: `title@ needs a session and line, like title@jx7c6zk:142`. */
  refForms: string;
  capture(ref: string, ctx: CaptureCtx): Promise<Captured>;
  replay(snap: any, ctx: ReplayCtx): Promise<ReplayOutput>;
  gates(snap: any, out: ReplayResult, label?: any): GateResult[];
  checks?(snap: any, out: ReplayResult, label?: any): CheckResult[];
  /** What the convo views show, and the judge unless judgeMoment says otherwise. */
  describe(snap: any): ConvoMessage[];
  /**
   * The moment the judge reads, when describe would show it text the prompt
   * under test renders: that text is left out, so both arms of an ablation
   * are graded against one moment and a prompt never becomes its own ruler.
   */
  judgeMoment?(snap: any): ConvoMessage[];
  /** Agent route: REFUSED patterns this snapshot's own turns ask for, on top of meta.allowedRefusals (a wake's `cast chat reply <its placeholder>`). */
  allowedRefusals?(snap: any): string[];
  productionReply?(snap: any): ProductionReply | null;
  /** Org only in Phase 1. `freeze` is the one `grade --freeze` names, or the one the dir's run.json records. */
  grade?(dir: string, label: any, freeze?: Freeze): Score;
  capturePresentation?(runDir: string): Promise<void>;
  /** Extra lines `check` prints under the surface's verdict, from every scored rep. */
  summarize?(scores: Score[]): string[];
}

/** A gate decided by code: what every surface's gates and the route gates are built from. */
export const gate = (id: string, pass: boolean, summary: string): GateResult => ({ id, pass, decidedBy: 'mechanical', evidence: { summary } });

/** The stub every Phase 1 surface starts as, until its wave 3 unit lands. */
export function notImplemented(id: string, refForms: string): SurfaceImpl {
  const fail = (): never => {
    throw new Error(`${id} is not implemented yet`);
  };
  return { refForms, capture: async () => fail(), replay: async () => fail(), gates: fail, describe: fail };
}
