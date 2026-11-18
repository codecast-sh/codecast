// Env case sets (pl-1049 ct-96179; design "Goals that agents can climb" §4
// Split, §6): an env's dev and held cases kept by codecast, versioned, so a
// run or a climb works on any machine, not only the one that built them.
//
// Both splits come in through `cast env cases put <env> --split dev|held
// --file <json>` and reach a run the same way: `cast env run <env> --split
// <split>` fetches the live set into a private file, names it to the runner
// in CODECAST_ENV_CASES, and deletes it after the run. Every fetch is an
// access-log row (who, session, task, when).
//
// Dev is readable by design: anyone in the workspace may fetch it
// (`cast env cases get`) and a dev run has no rules beyond that. Held is
// sealed: no CLI command or web view prints a held case, a held run needs a
// committed tree whose runner is the base's, its attempt is filed against its
// own fetch with hashed ids and scores only (contracts/envs.ts), and the
// fetches no attempt answered show on the env's standing.

import { ENV_LIMITS } from "./envs";

export const CASE_SET_LIMITS = {
  cases_max: ENV_LIMITS.cases_max,
  case_id_chars: ENV_LIMITS.case_id_chars,
  /** One case's payload as JSON text; a Convex document holds 1 MB. */
  payload_chars: 400_000,
  label_chars: 120,
  /** Opaque runner state that travels with the set (a seed, a calibration). */
  meta_chars: 200_000,
  /** How much one upload or fetch call carries, in payload characters. */
  chunk_chars: 2_000_000,
} as const;

/** How long a fetch stays open for its pages: the run's own limit, capped. */
export const CASES_READ_TTL_MAX_S = 6 * 3600;

/** The splits a case set is kept for. */
export const CASE_SET_SPLITS = ["dev", "held"] as const;
export type CaseSetSplit = (typeof CASE_SET_SPLITS)[number];
export const isCaseSetSplit = (x: unknown): x is CaseSetSplit => x === "dev" || x === "held";

/** The environment variable that names the case-set file a runner reads, on either split. */
export const CASES_FILE_ENV = "CODECAST_ENV_CASES";

/** A case as stored and as the runner reads it: its id and the opaque payload the runner needs. */
export type SetCase = { id: string; payload: unknown };
/** What `cast env cases put` reads: the cases, an optional label, and opaque meta the runner needs (a split seed, a calibration). */
export type CaseSetInput = { label?: string; meta?: unknown; cases: SetCase[] };
/** What the runner reads from CODECAST_ENV_CASES. */
export type CaseSetFile = { env: string; split: CaseSetSplit; version: string; label?: string; meta?: unknown; cases: SetCase[] };

/** A case set's standing, as the env's page and `cast env show` print it: never a case. */
export type EnvCaseSetStanding = {
  version: string;
  size: number;
  label?: string;
  uploaded_at: number;
  /** Fetches of the live set's content, the upload not counted. */
  reads: number;
  /** Held only: fetches that ended with no attempt filed against them, a read that was not a run. */
  unfiled: number;
  last_read_at?: number;
  /** The latest attempt on this split. */
  last_attempt?: { short_id: string; candidate: string; n: number; mean: number; finished_at: number };
};

/** One access-log row as shown: who fetched which version, from which session and task, when, and the attempt it filed. */
export type CaseSetRead = { kind: "put" | "run"; split: CaseSetSplit; version: string; by: string; session_id?: string; task_id?: string; at: number; attempt?: string };

/** Read and check a case-set file. Payloads stay opaque; only their size is checked. */
export function parseCaseSet(raw: unknown): { ok: true; set: { label?: string; meta?: string; cases: { id: string; payload: string }[] } } | { ok: false; error: string } {
  let x: any = raw;
  if (typeof raw === "string") {
    try { x = JSON.parse(raw); } catch { return { ok: false, error: "the case set is not JSON" }; }
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, error: "the case set must be { label?, meta?, cases: [{ id, payload }] }" };
  const extra = Object.keys(x).filter((k) => !["label", "meta", "cases"].includes(k));
  if (extra.length) return { ok: false, error: `the case set has unknown field${extra.length > 1 ? "s" : ""} ${extra.map((k) => `"${k}"`).join(", ")}` };
  if (!Array.isArray(x.cases) || !x.cases.length) return { ok: false, error: "cases must be a non-empty list" };
  if (x.cases.length > CASE_SET_LIMITS.cases_max) return { ok: false, error: `at most ${CASE_SET_LIMITS.cases_max} cases` };
  const seen = new Set<string>();
  const cases: { id: string; payload: string }[] = [];
  for (const [i, c] of x.cases.entries()) {
    if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id.trim()) return { ok: false, error: `cases[${i}] needs a string id` };
    if (c.id.length > CASE_SET_LIMITS.case_id_chars) return { ok: false, error: `cases[${i}].id is over ${CASE_SET_LIMITS.case_id_chars} characters` };
    if (seen.has(c.id)) return { ok: false, error: `cases[${i}] repeats an id` };
    seen.add(c.id);
    if (c.payload === undefined) return { ok: false, error: `cases[${i}] has no payload` };
    const payload = JSON.stringify(c.payload);
    if (payload.length > CASE_SET_LIMITS.payload_chars) return { ok: false, error: `cases[${i}]'s payload is over ${CASE_SET_LIMITS.payload_chars} characters` };
    cases.push({ id: c.id, payload });
  }
  const label = x.label === undefined ? undefined : typeof x.label === "string" && x.label.trim().length <= CASE_SET_LIMITS.label_chars ? x.label.trim() || undefined : null;
  if (label === null) return { ok: false, error: `label must be a string of at most ${CASE_SET_LIMITS.label_chars} characters` };
  const meta = x.meta === undefined ? undefined : JSON.stringify(x.meta);
  if (meta && meta.length > CASE_SET_LIMITS.meta_chars) return { ok: false, error: `meta is over ${CASE_SET_LIMITS.meta_chars} characters` };
  return { ok: true, set: { ...(label ? { label } : {}), ...(meta ? { meta } : {}), cases } };
}

/** A case set's version: a hash of its ids, payloads and meta, so the same set uploaded twice is one version. */
export async function caseSetVersion(set: { meta?: string; cases: { id: string; payload: string }[] }): Promise<string> {
  const text = [set.meta ?? "", ...[...set.cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((c) => `${c.id}\u0000${c.payload}`)].join("\u0001");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Split cases into calls of at most `chunk_chars` payload characters each. */
export function caseChunks<T extends { payload: string }>(cases: readonly T[], max: number = CASE_SET_LIMITS.chunk_chars): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], size = 0;
  for (const c of cases) {
    if (cur.length && size + c.payload.length > max) { out.push(cur); cur = []; size = 0; }
    cur.push(c);
    size += c.payload.length;
  }
  if (cur.length) out.push(cur);
  return out;
}
