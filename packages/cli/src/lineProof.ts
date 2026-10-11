// The proof a line cause leaves (line-map.md LX6, the-line-end-to-end.md LE8).
// A cause in category `line` asks for a change to the line itself, and its miss
// is the line's own behavior on runs it already recorded. The prove station
// names those runs in `$run_dir/line-proof.json`; the red station checks every
// claim against the run records before the line spends a build on it, so a
// line cause never passes on a comment.
//
//   { "runs": [ { "task": "ct-57458", "run": "<run id>", "station": "prove",
//                 "status": "failed", "outcome": "success",
//                 "fail_reason": "no outgoing edge from prove",
//                 "shows": "what this run shows, one line" } ] }
//
// A claim names the station and at least one of the station's recorded
// status, its outcome, or words from the run's fail reason; each one it names
// must match the record.

export type LineProofClaim = {
  task: string;
  run: string;
  station: string;
  status?: string;
  outcome?: string;
  fail_reason?: string;
  shows?: string;
};

/** A run row as /cli/workflow-runs/list returns it, the fields a claim is checked against. */
export type RecordedRun = {
  _id: string;
  status?: string;
  fail_reason?: string;
  node_statuses?: ReadonlyArray<{ node_id: string; status?: string; outcome?: string }>;
};

export type ClaimCheck = { claim: LineProofClaim; ok: boolean; why: string };
export type LineProofCheck = { ok: boolean; checks: ClaimCheck[]; why: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The claims in a line-proof.json, or the one line saying why it cannot be read. */
export function parseLineProof(raw: unknown): { claims: LineProofClaim[] } | { error: string } {
  const runs = raw && typeof raw === "object" ? (raw as { runs?: unknown }).runs : undefined;
  if (!Array.isArray(runs) || runs.length === 0) return { error: "line-proof.json names no runs: it needs a \"runs\" list with at least one recorded run" };
  const claims: LineProofClaim[] = [];
  for (const [i, r] of runs.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    const claim: LineProofClaim = { task: str(o.task), run: str(o.run), station: str(o.station) };
    for (const k of ["status", "outcome", "fail_reason", "shows"] as const) if (str(o[k])) claim[k] = str(o[k]);
    const missing = (["task", "run", "station"] as const).filter((k) => !claim[k]);
    if (missing.length) return { error: `runs[${i}] has no ${missing.join(", ")}` };
    if (!claim.status && !claim.outcome && !claim.fail_reason) return { error: `runs[${i}] (${claim.run}) says nothing the record can confirm: name the station's status, its outcome, or the run's fail_reason` };
    claims.push(claim);
  }
  return { claims };
}

/** One claim against the runs its task recorded. */
export function checkClaim(claim: LineProofClaim, runs: ReadonlyArray<RecordedRun>): ClaimCheck {
  const no = (why: string): ClaimCheck => ({ claim, ok: false, why: `${claim.task} run ${claim.run}: ${why}` });
  const run = runs.find((r) => r._id === claim.run || r._id.startsWith(claim.run));
  if (!run) return no(`no such run recorded for ${claim.task}`);
  const node = run.node_statuses?.find((n) => n.node_id === claim.station);
  if (!node) return no(`the run never reached ${claim.station}`);
  if (claim.status && node.status !== claim.status) return no(`${claim.station} is recorded ${node.status ?? "with no status"}, not ${claim.status}`);
  if (claim.outcome && node.outcome !== claim.outcome) return no(`${claim.station}'s outcome is recorded ${node.outcome ?? "as none"}, not ${claim.outcome}`);
  if (claim.fail_reason && !(run.fail_reason ?? "").toLowerCase().includes(claim.fail_reason.toLowerCase())) {
    return no(`the run's fail reason is ${run.fail_reason ? `"${run.fail_reason}"` : "empty"}, which does not say "${claim.fail_reason}"`);
  }
  const said = [claim.status ?? node.status, claim.fail_reason ? `"${run.fail_reason}"` : null].filter(Boolean).join(", ");
  return { claim, ok: true, why: `${claim.task} run ${run._id.slice(0, 7)}: ${claim.station} ${said}` };
}

/** Every claim, each against its own task's runs (`runsOf` reads them once per task). */
export async function checkLineProof(raw: unknown, runsOf: (task: string) => Promise<ReadonlyArray<RecordedRun>>): Promise<LineProofCheck> {
  const parsed = parseLineProof(raw);
  if ("error" in parsed) return { ok: false, checks: [], why: parsed.error };
  const cache = new Map<string, Promise<ReadonlyArray<RecordedRun>>>();
  const checks: ClaimCheck[] = [];
  for (const claim of parsed.claims) {
    if (!cache.has(claim.task)) cache.set(claim.task, runsOf(claim.task));
    checks.push(checkClaim(claim, await cache.get(claim.task)!));
  }
  const bad = checks.filter((c) => !c.ok);
  const why = bad.length
    ? `${bad.length} of ${checks.length} claims do not match the records: ${bad.map((c) => c.why).join("; ")}`
    : `${checks.length} recorded ${checks.length === 1 ? "run shows" : "runs show"} it: ${checks.map((c) => c.why).join("; ")}`;
  return { ok: bad.length === 0, checks, why };
}
