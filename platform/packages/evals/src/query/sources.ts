// What a product hands the shared evals handler: its rows and surfaces, which
// every product has, and the reads only some products can answer (freezes,
// prompt files, git, bisects, a change feed). A read a product leaves out
// turns its capability off (capabilitiesOf), so its views hide rather than
// show empty, and its routes answer 404. Nothing here writes.

import type { AttributionGit, AttributionMeta, PromptReader, VerdictPolicy, VerdictRun } from '../analysis';
import type { BisectResponse, BisectSummary, CommitRef, CommitResponse, CompareResponse, EvalFlip, EvalsCapabilities, FreezeResponse, HealthResponse, RunResponse, RunRowCore, SurfaceInfo } from '../contract';

/** What the views read about a surface. A product's own registry entry may carry more; `info` picks what its header shows. */
export interface QuerySurface {
  id: string;
  title: string;
  route: string | null;
  model: string | null;
  /** The pass mark its reps are held to, when the surface names its own. */
  passMark?: number | null;
  /** A product's own gate, shown as data (union: the Jeffreys rule from its backend). */
  gate?: SurfaceInfo['gate'];
}

/** A rep's detail as the product reads it; the query adds the row, its siblings and its neighbours. A product adds its own anatomy by intersection. */
export type RunDetail<R extends RunRowCore = RunRowCore> = Omit<RunResponse<R>, 'row' | 'siblings' | 'adjacent'>;

/** Freeze counts by visibility, as the wall and the surface header show them. */
export type FreezeCounts = { public: number; private: number };

/**
 * Everything the views read. `R` is the product's row, `S` its surface entry
 * and `M` its own "What moved" kinds (each with the time it happened).
 */
export interface EvalsSources<R extends RunRowCore = RunRowCore, S extends QuerySurface = QuerySurface, M extends { at: string } = never> {
  /** Every rep, newest first. The same array until the rows change: answers are kept per array. */
  rows(): Promise<R[]>;
  /** Every surface, in the order the wall lists them before it sorts. */
  surfaces(): readonly S[] | Promise<readonly S[]>;
  /** The product's own facts about this process and its index. Left out, /health counts the rows. */
  health?(): Omit<HealthResponse, 'capabilities'>;
  /** What the surface page's header adds to a surface's id, title, route, model, pass mark and gate (codecast: criteria, sources, reps, spend cap). */
  info?(surface: S): object;
  /** The prompt files each rep wrote: epochs, footing diffs and prompt diffs read them. */
  prompts?: PromptReader;
  freezes?: {
    /** Each surface's freezes, counted by visibility. */
    counts(): Promise<(surface: string) => FreezeCounts>;
    /** One freeze's page without its epochs (the query adds them); null, or NotFound, when no home holds it. */
    get(id: string, rows: R[]): Promise<Omit<FreezeResponse<R>, 'epochs'> | null>;
  };
  /** Each surface's word for where it stands against its sources (codecast: fresh, stale, ...). Asked before the rows load, so it may run beside them. */
  staleness?(): Promise<(surface: string) => string | null>;
  /** One rep's detail. Left out, a run page holds the row, its siblings and its neighbours, and no result, score or sends. */
  run?(row: R): Promise<RunDetail<R>>;
  /** False for a product whose rows name no model and no judge: the chips for them are not drawn. Left out, they are, and a rep that named none reads "no model". */
  models?: boolean;
  /** False for a product that records no pass mark (union: each scenario sets its own, and no route returns it): no view draws one. Left out, a rep that names none is drawn against the default. */
  marks?: boolean;
  /** False for a product whose reader knows each rep's prompt by its hash (promptSha) and keeps no files (union: one stored system prompt per result, read nowhere else): its epochs still draw, and no view offers a prompt diff. Left out, the reader's files are diffed. */
  promptFiles?: boolean;
  /** Two reps' scores weighed and their replies, for the compare page. Left out, a run offers no comparison. */
  pair?(a: string, b: string): Pick<CompareResponse<R>, 'diff' | 'replies'>;
  /** The reply text behind flips, for the before and after cards. */
  flipExamples?(surface: string, freezeIds: string[], a: string, b: string): Promise<EvalFlip[]>;
  git?: {
    /** Throws BadRequest when `sha` names no commit here. */
    verify(sha: string): void;
    touching(surface: string, from: string | null, to: string | null): CommitRef[];
    between(surface: string, a: string, b: string): CommitRef[];
    commit(sha: string, surface: string | null, whole: boolean): CommitResponse;
    readonly attribution: AttributionGit;
    meta: AttributionMeta;
  };
  bisects?: {
    /** As they stand: the wall reads them without settling. */
    summaries(): BisectSummary[];
    /** Marks a bisect whose planner died as failed, before a list or a change feed reads them. */
    settle?(): void;
    running(): string | null;
    get(id: string, since: number): BisectResponse | null;
  };
  /**
   * The change feed (GET /changes), for a product whose rows() is cheap
   * enough to ask on every poll (a local index). The handler keeps the
   * cursor. `sig` adds what else marks a row as changed (codecast: its score
   * versions); `extra` adds the product's own changed things since the
   * cursor (codecast: jobs). Left out, the client polls each page it shows.
   */
  changes?: { sig?(row: R): string; extra?(since: number): object };
  /** The product's own lines on the wall's "What moved", and its own fields beside the wall's (codecast: the sim's newest failure, and `sim`). */
  overview?(): { moved?: M[]; fields?: object };
}

/** The product's verdict rule, and how long a running rep may go quiet before it reads stalled (liveness; left out, the product shows none). */
export interface HandlerPolicy<R extends VerdictRun = VerdictRun> extends VerdictPolicy<R> {
  stallAfterMs?: number;
}

/** Which panels a product's sources can fill, from which sources it handed over. */
export function capabilitiesOf(sources: EvalsSources<any, any, any>, policy?: Pick<HandlerPolicy, 'stallAfterMs'>): EvalsCapabilities {
  return {
    trends: true,
    freezes: !!sources.freezes,
    epochs: !!sources.prompts,
    attribution: !!(sources.git && sources.prompts),
    commits: !!sources.git,
    bisect: !!sources.bisects,
    changes: !!sources.changes,
    liveness: policy?.stallAfterMs !== undefined,
    models: sources.models !== false,
    compare: !!sources.pair,
    marks: sources.marks !== false,
    promptFiles: !!sources.prompts && sources.promptFiles !== false,
  };
}
