// What the run and compare pages decide (evals-ui.md 4.4): the run page's own
// tabs and the fragment that opens one, gate and check order, and the
// neighbours a rep steps to. Pure, beside the views that draw it. The tabs a
// host adds under a run (codecast's calls, agent, guard and files) are the
// host's to decide (host.tsx useRunPanels).

import type { RunDiffEntry, RunRow, GateResultJson, CheckResultJson, Epoch, FreezeResponse, RunResponse, ScoreJson } from "@codecast/shared/contracts/evalsApi";
import { score2, batchLabel } from "./format";
import { PASS_MARK } from "./charts/scale";

/** In words, what moved from a to b on one entry, and which way. */
export function diffWords(e: RunDiffEntry): { tone: "broke" | "fixed"; before: string; after: string } {
  if (e.kind === "gate") return { tone: e.after ? "fixed" : "broke", before: e.before ? "held" : "failed", after: e.after ? "held" : "failed" };
  return { tone: e.after >= e.before ? "fixed" : "broke", before: score2(e.before), after: score2(e.after) };
}

/** What differs about how the two reps were made, so a reader knows what the comparison holds still. */
export function compareFooting(a: RunRow, b: RunRow): string[] {
  const out: string[] = [];
  if (a.freezeId !== b.freezeId) out.push("different freezes: the replies answer different moments");
  if (a.model !== b.model) out.push(`model ${a.model ?? "none"} against ${b.model ?? "none"}`);
  if (a.ruler !== b.ruler) out.push("judged on different rulers");
  if (a.promptSha !== b.promptSha) out.push("the rendered prompt differs");
  if (a.gitHead !== b.gitHead) out.push("ran on different commits");
  return out;
}

export const gateAnchor = (id: string) => `gate-${id}`;

/** Failing gates first, each group in the order the score lists them. */
export function orderGates(gates: readonly GateResultJson[]): GateResultJson[] {
  return [...gates.filter((g) => !g.pass), ...gates.filter((g) => g.pass)];
}

/**
 * What a gate's evidence says, in words: a vacuous hold says it had nothing to
 * check. A summary states its own count ("4 calls caught at the boundary"), so
 * `scanned` is shown only beside the excerpts, as the platform's run page does.
 */
export function gateEvidenceWords(g: GateResultJson): string {
  if (g.pass && g.evidence.vacuous) return "held, nothing to check";
  return g.evidence.summary;
}

export const checkAnchor = (id: string) => `check-${id}`;

/** A check's own state, read the way ScoreBar draws it: at the pass mark and over its `must` floor. */
export const checkPasses = (c: Pick<CheckResultJson, "score" | "must">, passMark = PASS_MARK) => c.score >= passMark && (c.must === null || c.must === undefined || c.score >= c.must);

// ── What the page decides ───────────────────────────────────────────────────

/** The tabs every run has. A host's panels follow them, each tab named by its panel's id. */
export const RUN_TABS = ["verdict", "moment"] as const;
export type RunTab = (typeof RUN_TABS)[number];

export const RUN_TAB_WORDS: Record<RunTab, string> = { verdict: "Verdict", moment: "Moment and reply" };

/**
 * The tab a fragment names. A gate or check address (`#gate-no-leak`,
 * `#check-criteria`) lives on the Verdict tab; any other name is a tab's, and
 * the view opens Verdict when the run has no tab by that name.
 */
export function tabOfHash(hash: string): { tab: string; target: string | null } {
  const h = decodeURIComponent(hash.replace(/^#/, ""));
  if (h.startsWith("gate-") || h.startsWith("check-")) return { tab: "verdict", target: h };
  return { tab: h || "verdict", target: null };
}

/** The prompt epoch a batch ran in: the last one that began at or before it. */
export function epochOfBatch(batchAt: string | null, epochs: readonly Epoch[]): Epoch | null {
  if (!batchAt) return null;
  let found: Epoch | null = null;
  for (const e of [...epochs].sort((a, b) => a.n - b.n)) if (e.firstBatchAt <= batchAt) found = e;
  return found;
}

/**
 * The run to diff this rep's prompts against: the same freeze in the previous
 * prompt epoch, newest first and the same seed when there is one. Crashes and
 * bisect probes are passed over (a probe renders an old commit on purpose).
 */
export function previousEpochRun(row: RunRow, runs: readonly RunRow[], epochs: readonly Epoch[]): { id: string | null; why: string } {
  const e = epochOfBatch(row.batchAt, epochs);
  if (!e) return { id: null, why: epochs.length ? "This rep's batch is older than every epoch on record" : "The freeze's epochs are still loading" };
  if (e.n === 1) return { id: null, why: "This rep ran in the first prompt epoch: there is nothing earlier to diff against" };
  const prev = epochs.find((x) => x.n === e.n - 1);
  if (!prev) return { id: null, why: `Epoch e${e.n - 1} is not on record` };
  const inPrev = runs.filter((r) => r.freezeId === row.freezeId && r.batchAt !== null && r.batchAt >= prev.firstBatchAt && r.batchAt < e.firstBatchAt && r.status !== "crash" && r.cadence !== "bisect");
  if (!inPrev.length) return { id: null, why: `Epoch e${prev.n} never ran this freeze` };
  const best = [...inPrev].sort((a, b) => (b.batchAt ?? "").localeCompare(a.batchAt ?? "") || Number(b.seed === row.seed) - Number(a.seed === row.seed))[0];
  const sameSeed = inPrev.filter((r) => r.batch === best.batch).find((r) => r.seed === row.seed);
  return { id: (sameSeed ?? best).id, why: `e${prev.n} against e${e.n}` };
}

/** The previous and next seed of this freeze in this batch, by seed. */
export function seedNeighbours(row: RunRow, siblings: readonly RunRow[]): { prev: string | null; next: string | null; all: RunRow[] } {
  const all = [row, ...siblings.filter((s) => s.id !== row.id)].sort((a, b) => a.seed - b.seed || a.stamp.localeCompare(b.stamp));
  const i = all.findIndex((r) => r.id === row.id);
  return { prev: all[i - 1]?.id ?? null, next: all[i + 1]?.id ?? null, all };
}

/**
 * This freeze's graded reps that rendered the same prompt as this one, across
 * its batches (bisect probes left out): the spread a reader weighs one rep
 * against before calling it a regression. Null when the rep's prompt is
 * unknown or that prompt ran in this batch alone.
 */
export function samePromptSpread(row: Pick<RunRow, "id" | "freezeId" | "promptSha">, freezeRuns: readonly RunRow[]): { batches: number; reps: number; passed: number; min: number; max: number } | null {
  if (!row.promptSha) return null;
  const same = freezeRuns.filter((r) => r.freezeId === row.freezeId && r.promptSha === row.promptSha && r.cadence !== "bisect" && r.score !== null && (r.status === "pass" || r.status === "fail"));
  const batches = new Set(same.map((r) => r.batch));
  if (batches.size < 2) return null;
  const scores = same.map((r) => r.score as number);
  return { batches: batches.size, reps: same.length, passed: same.filter((r) => r.status === "pass").length, min: Math.min(...scores), max: Math.max(...scores) };
}

/** The three things worth copying: where the folder is, how to replay its freeze, how to grade it again. */
export function runCommands(row: Pick<RunRow, "id" | "freezeId" | "model">, evalsHome: string | null) {
  return {
    path: `${evalsHome ?? "$EVALS_HOME"}/runs/${row.id}`,
    replay: `./evals freeze replay ${row.freezeId.slice(0, 8)} --reps 3${row.model ? ` --model ${row.model}` : ""}`,
    rescore: `./evals rescore ${row.id}`,
  };
}

/** Reps worth comparing this one with, grouped: the batch's other seeds, the same freeze one batch either side, and the freeze's other recent reps. A dry render replied nothing, so it is never offered. */
export function compareCandidates(run: Pick<RunResponse, "row" | "siblings" | "adjacent">, freezeRuns: readonly RunRow[]): Array<{ group: string; rows: Array<{ id: string; label: string; row: RunRow | null }> }> {
  const seen = new Set<string>([run.row.id]);
  const take = (id: string | null, label: string, row: RunRow | null) => {
    if (!id || seen.has(id) || row?.status === "dry") return null;
    seen.add(id);
    return { id, label, row };
  };
  const byId = new Map(freezeRuns.map((r) => [r.id, r]));
  const groups = [
    { group: "This batch, other seeds", rows: run.siblings.map((s) => take(s.id, `seed ${s.seed}`, s)) },
    {
      group: "The same freeze, one batch either side",
      // Offered once the freeze's runs name them, so a dry neighbour is known for what it is before it can be picked.
      rows: (["previous", "next"] as const).map((side) => {
        const row = byId.get(run.adjacent[side] ?? "") ?? null;
        return row ? take(row.id, `${side} batch`, row) : null;
      }),
    },
    {
      group: "Other reps of this freeze",
      rows: [...freezeRuns]
        .sort((a, b) => b.stamp.localeCompare(a.stamp))
        .slice(0, 12)
        .map((r) => take(r.id, `${batchLabel(r.batch ?? r.stamp, r.batchAt)}, seed ${r.seed}`, r)),
    },
  ];
  return groups.map((g) => ({ group: g.group, rows: g.rows.filter((x): x is NonNullable<typeof x> => !!x) })).filter((g) => g.rows.length);
}

/** Who read the reply: the judge only when a score says it did. */
export function replyReading(run: Pick<RunResponse, "sends" | "score">): string {
  if (!run.score) return "not judged yet";
  return run.sends.length > 1 ? `${run.sends.length} sends, as the judge read them` : "as the judge read it";
}

/**
 * What a rep is held to when it has no grade that counts: the child's rubric
 * (sent only when the folder has no score), else the freeze's own criteria. A
 * dry rep often carries a score.json, because the tool grades the rendered
 * prompt as if it were the reply, so its rubric comes from the freeze.
 */
export function rubricOfRun(run: Pick<RunResponse, "rubric">, freeze: FreezeResponse | null, passMark: number): NonNullable<RunResponse["rubric"]> | null {
  if (run.rubric) return run.rubric;
  return freeze ? { criteria: freeze.freeze.judge ?? null, passMark } : null;
}

/** A dry rep's grade in one line: what the tool scored the echoed prompt, and that it counts nowhere. */
export function dryGradeWords(score: ScoreJson): string {
  const failed = score.gates.filter((g) => !g.pass).map((g) => g.id);
  return `scored ${score2(score.score)}${failed.length ? `, failed ${failed.join(", ")}` : ""}; counts toward nothing`;
}

/**
 * Vertical offsets that keep dots apart on a one-line strip: only reps whose
 * x falls within `near` px of a neighbour are dodged, symmetric about the
 * track (two at plus and minus 4, three at -5, 0 and 5, more spread within
 * `room`); a rep alone stays on the track.
 */
export function dodgeOffsets(xs: readonly number[], near = 9, room = 8): number[] {
  const order = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const out = xs.map(() => 0);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.x - order[end]!.x < near) end++;
    const k = end - start + 1;
    const step = k === 2 ? 8 : Math.min(5, (2 * room) / Math.max(1, k - 1));
    for (let j = 0; j < k; j++) out[order[start + j]!.i] = k === 1 ? 0 : (j - (k - 1) / 2) * step;
    start = end + 1;
  }
  return out;
}
