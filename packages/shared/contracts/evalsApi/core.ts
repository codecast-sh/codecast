// Part of the Evals UI's wire contract (docs/architecture/evals-ui.md). Every
// party imports it through ../evalsApi.ts. The primitives, the analysis shapes,
// the neutral part of the index row and the helpers over them live in
// @platform/evals/contract and are re-exported here; codecast adds its own row
// fields (CodecastRunFields), the guard's marks and the staleness words. PURE
// isomorphic data: no Node or DOM APIs.

import { RUN_ROW_CORE_FIELDS, rowProblems, type FieldSpec, type RunRowCore } from "@platform/evals/contract";

export type {
  BatchStats,
  BatchVerdict,
  CommitRef,
  Epoch,
  EvalRoute,
  EvalVisibility,
  FlipsResult,
  Footing,
  FootingMarker,
  PromptFilePair,
  RunDiffEntry,
  RunRowStatus,
  SeparationResult,
  SkippedBatch,
  SpendDay,
  VerdictFlip,
} from "@platform/evals/contract";

export {
  EVALS_BATCH_TOKEN_RE,
  EVALS_PATCH_SHA_RE,
  EVALS_SHA_RE,
  EVALS_STAMP_BATCH_RE,
  evalsBatchRef,
  FLAPPING_MIN_FLIPS,
  FLAPPING_MIN_SHARE,
  flipCounts,
  isFlapping,
  isNoiseFlip,
  resolveEvalsBatchRef,
  spendByDayOf,
  unaskedSet,
} from "@platform/evals/contract";

// ── Primitives ──────────────────────────────────────────────────────────────

/** The marks the dry-run guard writes to calls.log, one per outcome. */
export const GUARD_STATUSES = ["SERVED", "UNSERVED", "LIVE", "REFUSED", "UNKNOWN", "HELP"] as const;
export type GuardStatus = (typeof GUARD_STATUSES)[number];

/** calls.log marks counted per rep. */
export interface GuardCounts {
  served: number;
  unserved: number;
  live: number;
  refused: number;
  unknown: number;
  help: number;
}

/**
 * Where a surface stands against its sources (commands/stale.ts staleness):
 * `fresh` ran on them, `stale` its sources changed at HEAD since, `waiting`
 * stale but the sources are dirty in the checkout, `due` a call surface
 * `check --stale` would run now, `blocked` crashed twice on these sources.
 */
export type StalenessWord = "fresh" | "stale" | "waiting" | "due" | "blocked";

// ── The index (section 3.2) ─────────────────────────────────────────────────

/** What codecast's index adds to the shared row. */
export interface CodecastRunFields {
  /** Declared sources hashed at HEAD (git ls-tree): what staleness reads. */
  sourceHash: string | null;
  guard: GuardCounts;
  /** How many score versions the folder holds (score.json plus every kept rescore and rejudge). */
  scoreVersions: number;
}

/** One run folder under EVALS_HOME/runs, as EVALS_HOME/index/runs.jsonl holds it. A cache: always rebuildable from the folder. Its id is the folder name, `<surface>-<freeze8>-seed<rep>-<stamp>`. */
export type RunRow = RunRowCore & CodecastRunFields;

const GUARD_KEYS: readonly (keyof GuardCounts)[] = ["served", "unserved", "live", "refused", "unknown", "help"];
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Every RunRow field in the order a problem list names them: the shared fields, with codecast's in the places they always stood. */
const RUN_ROW_FIELDS: Record<keyof CodecastRunFields | keyof typeof RUN_ROW_CORE_FIELDS, FieldSpec> = (() => {
  const fields: Record<string, FieldSpec> = {};
  for (const [field, kind] of Object.entries(RUN_ROW_CORE_FIELDS)) {
    fields[field] = kind;
    if (field === "treePatch") fields.sourceHash = "string?";
  }
  fields.guard = { name: "guard", ok: (v) => !!v && typeof v === "object" && GUARD_KEYS.every((k) => isNum((v as Record<string, unknown>)[k])) };
  fields.scoreVersions = "number";
  return fields as Record<keyof CodecastRunFields | keyof typeof RUN_ROW_CORE_FIELDS, FieldSpec>;
})();

/** Why a value is not a RunRow, one line per field; empty when it is one. The index writer and its tests hold every row to this. */
export const runRowProblems = (value: unknown): string[] => rowProblems(value, RUN_ROW_FIELDS);
