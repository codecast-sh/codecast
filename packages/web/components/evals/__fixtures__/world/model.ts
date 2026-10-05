// Part of the fixture world (../world.ts), which every caller imports. The
// world's model: its deterministic helpers, the cast of surfaces and batches,
// and the views derived from the rows (stats, flips, verdicts, epochs, the
// ledger). Nothing here is real data.

import type { BatchStats, BatchVerdict, BisectState, BisectStep, CommitRef, Epoch, EvalRoute, FlipsResult, Footing, FootingMarker, LedgerRow, RunRow, SeparationResult, SimCatalogResponse, SimRunResponse, SimSessionSummary, StalenessWord, VerdictFlip } from "@codecast/shared/contracts/evalsApi";
// The engine's own night-by-night test, so a pooled verdict's p here is the one verdict.ts would print.
import { separateNights } from "../../../../../evals/src/stats";

/** A route the world has no answer for (an unknown id): the transport turns it into a 404. */
export class EvalsFixtureMiss extends Error {}

export const DAY = 86_400_000;
export const PASS_MARK = 0.7;
const CALL_MODEL = "claude-haiku-4-5-20251001";
const STRONG_MODEL = "claude-sonnet-5-5";
const OPUS_MODEL = "claude-opus-5-5";
export const JUDGE_MODEL = "claude-sonnet-5-5";

// ── Deterministic helpers ───────────────────────────────────────────────────

/** A stable hex string of `len` characters from any text. */
export function fixtureHex(text: string, len = 40): string {
  let out = "";
  let h = 0x811c9dc5;
  for (let round = 0; out.length < len; round++) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ round, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}

export const uuid = (text: string) => {
  const h = fixtureHex(text, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const iso = (ms: number) => new Date(ms).toISOString();
export const stampOf = (ms: number) => iso(ms).replace(/[:.]/g, "-");
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
export const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

/** One-sided Mann-Whitney on b against a, normal approximation; too few under 5 a side. */
export function fixtureSeparate(a: number[], b: number[]): SeparationResult {
  if (a.length < 5 || b.length < 5) return { kind: "too-few" };
  let u = 0;
  for (const x of b) for (const y of a) u += x > y ? 1 : x === y ? 0.5 : 0;
  const mu = (a.length * b.length) / 2;
  const sigma = Math.sqrt((a.length * b.length * (a.length + b.length + 1)) / 12);
  const z = (u - mu) / sigma;
  const tail = (x: number) => 0.5 * erfc(x / Math.SQRT2);
  const pWorse = tail(-z);
  const pBetter = tail(z);
  if (pWorse <= 0.05) return { kind: "worse", p: round(pWorse, 4) };
  if (pBetter <= 0.05) return { kind: "better", p: round(pBetter, 4) };
  return { kind: "not-separated", p: round(Math.min(pWorse, pBetter), 4) };
}
function erfc(x: number): number {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

// ── The cast ────────────────────────────────────────────────────────────────

type Story = "regression" | "model-change" | "judge-change" | "live-reads" | "freeze-recapture" | "improving" | "steady";

interface SurfaceDef {
  id: string;
  title: string;
  route: EvalRoute;
  model: string;
  every: number;
  seeds: number;
  freezeNames: string[];
  privateFrom: number;
  /** Batch indexes (oldest first) where a prompt epoch begins, after e1 at 0; negative counts from the newest. */
  epochsAt: number[];
  story: Story;
  staleness: StalenessWord;
  criteria: string;
  sources: string[];
}

export const SURFACE_DEFS: SurfaceDef[] = [
  { id: "title", title: "Session title and short title", route: "call", model: CALL_MODEL, every: 1, seeds: 2, freezeNames: ["long-debug-thread", "one-line-fix", "spec-review", "multi-repo-sweep", "silent-agent"], privateFrom: 3, epochsAt: [9], story: "judge-change", staleness: "fresh", criteria: "A title names the work, not the tool. Under 60 characters, no trailing punctuation, no quotes.", sources: ["packages/convex/convex/titles.ts", "packages/convex/convex/lib/titlePrompt.ts"] },
  { id: "settle", title: "Settle: is the session done, waiting or working", route: "call", model: CALL_MODEL, every: 1, seeds: 2, freezeNames: ["unresolvable-error", "waiting-on-review", "mid-refactor", "asked-a-question", "handed-off", "deploy-blocked"], privateFrom: 2, epochsAt: [7, -1], story: "regression", staleness: "fresh", criteria: "Done means the asked work is finished and verified. A session that asked the human anything is waiting, never done.", sources: ["packages/convex/convex/settle.ts", "packages/convex/convex/lib/settlePrompt.ts"] },
  { id: "insight", title: "Session insight: goal, blockers, next action", route: "call", model: CALL_MODEL, every: 1, seeds: 2, freezeNames: ["flaky-ci", "auth-migration", "perf-hunt", "docs-pass"], privateFrom: 2, epochsAt: [11], story: "model-change", staleness: "fresh", criteria: "The next action is something a person can do in the next ten minutes.", sources: ["packages/convex/convex/insights.ts"] },
  { id: "ask", title: "Ask a question about a session (terms, then answer)", route: "call", model: CALL_MODEL, every: 2, seeds: 2, freezeNames: ["what-changed", "why-reverted", "who-decided", "where-is-it"], privateFrom: 2, epochsAt: [6], story: "freeze-recapture", staleness: "due", criteria: "Answers cite the line they come from and flag anything later reversed.", sources: ["packages/convex/convex/ask.ts"] },
  { id: "call-summary", title: "Call summary and action items", route: "call", model: CALL_MODEL, every: 2, seeds: 2, freezeNames: ["standup-short", "design-review", "incident-call"], privateFrom: 1, epochsAt: [5], story: "steady", staleness: "fresh", criteria: "Every action item has an owner who said it.", sources: ["packages/convex/convex/callSummary.ts"] },
  { id: "handoff", title: "Handoff brief", route: "call", model: CALL_MODEL, every: 2, seeds: 2, freezeNames: ["half-done-feature", "blocked-on-review", "research-dump"], privateFrom: 2, epochsAt: [8], story: "improving", staleness: "fresh", criteria: "The next session can continue without reading the thread.", sources: ["packages/convex/convex/handoff.ts"] },
  { id: "suggest", title: "Composer suggestions (anthropic branch)", route: "call", model: CALL_MODEL, every: 3, seeds: 2, freezeNames: ["after-error", "after-pr", "idle-session"], privateFrom: 3, epochsAt: [], story: "steady", staleness: "due", criteria: "Suggestions are the human's likely next message, in their voice.", sources: ["packages/convex/convex/suggest.ts"] },
  { id: "route", title: "The semantic router: which role an unplaced request belongs to", route: "call", model: CALL_MODEL, every: 2, seeds: 2, freezeNames: ["billing-question", "infra-alert", "design-ask", "unclear"], privateFrom: 2, epochsAt: [4], story: "steady", staleness: "fresh", criteria: "Unclear requests go to the anchor, never a guessed role.", sources: ["packages/convex/convex/router.ts"] },
  { id: "changes-story", title: "Changes page: one story from its commits and gated sessions", route: "call", model: STRONG_MODEL, every: 2, seeds: 1, freezeNames: ["auth-rewrite-day", "tiny-fixes"], privateFrom: 2, epochsAt: [3], story: "steady", staleness: "fresh", criteria: "The story says what changed for a user, not which files moved.", sources: ["packages/convex/convex/changesProse.ts"] },
  { id: "changes-edition", title: "Changes page: a team day's edition from its stories", route: "call", model: STRONG_MODEL, every: 3, seeds: 1, freezeNames: ["busy-tuesday", "quiet-friday"], privateFrom: 2, epochsAt: [], story: "steady", staleness: "waiting", criteria: "The lead is the change that matters most to the team.", sources: ["packages/convex/convex/changesProse.ts"] },
  { id: "org-review", title: "Org analyzer review", route: "agent", model: OPUS_MODEL, every: 5, seeds: 1, freezeNames: ["union-base8", "codecast-base3"], privateFrom: 0, epochsAt: [3], story: "steady", staleness: "stale", criteria: "Each proposal names sessions that exist and a role that can own them.", sources: ["packages/cli/src/orgInitRun.ts"] },
  { id: "role-wake", title: "Role wake frame", route: "agent", model: STRONG_MODEL, every: 3, seeds: 1, freezeNames: ["infra-lead-morning", "chief-of-staff-noon", "growth-weekly"], privateFrom: 1, epochsAt: [4], story: "live-reads", staleness: "fresh", criteria: "The role acts on what changed since it last checked, and nothing else.", sources: ["packages/cli/src/orgRoutine.ts"] },
  { id: "anchor-brief", title: "Anchor and role opening briefing", route: "agent", model: STRONG_MODEL, every: 4, seeds: 1, freezeNames: ["new-team", "busy-team"], privateFrom: 1, epochsAt: [], story: "steady", staleness: "blocked", criteria: "The briefing names who to talk to first and why.", sources: ["packages/cli/src/anchorBrief.ts"] },
];

export const SUBJECTS = [
  "settle: treat a pending question as waiting",
  "insight: shorter next action",
  "title: drop the tool name from titles",
  "evals: pin heads under refs/evals",
  "settle: weigh the last assistant turn first",
  "web: inbox row density",
  "settle: one prompt for done and waiting",
  "router: route unclear asks to the anchor",
  "handoff: lead with what is verified",
  "convex: index pending sends by client id",
  "ask: cite the line, flag reversals",
  "call summary: owners from the speaker",
  "org: hide killed rows in the scan",
  "settle: fold error states into working",
  "cli: cast check watcher QoS",
  "role wake: read since checked_at",
  "changes: story lede rules",
  "anchor brief: who to talk to first",
  "web: palette search ranking",
  "suggest: voice from recent sends",
];
/** The last six days, denser, as a real tree is: a range between two recent batches holds several commits, some touching each surface. */
export const RECENT_SUBJECTS = [
  "evals: judge prompt cites the label",
  "settle: read the asked question verbatim",
  "web: sidebar wake signature",
  "evals: models table pins sonnet 4.6",
  "settle: done needs verified tests",
  "anchor brief: lead with the blocker",
  "call summary: merge duplicate owners",
  "cli: daemon restamp build id",
  "settle: drop the error-state rule",
  "evals: fixture for unresolvable errors",
  "handoff: name the open question",
  "anchor brief: shorter who-to-ask list",
];
export const SESSIONS = ["jx70x2y", "jx7c6zk", "jx7dhfh", "jx76e8h", "jx7appr", "jx768ah", "jx7k3m2", "jx7p9q1"];

export interface Batch {
  surface: string;
  index: number;
  name: string;
  at: number;
  cadence: string | null;
  epoch: number;
  model: string;
  ruler: string;
  gitHead: string;
  dry: boolean;
  landing: boolean;
}

export interface FixtureState {
  now: number;
  defs: SurfaceDef[];
  freezes: Map<string, { id: string; name: string; surface: string; visibility: "public" | "private"; base: number; index: number }>;
  batches: Map<string, Batch[]>;
  /** Each surface's epoch starts as batch indexes, resolved against its batch list. */
  epochStarts: Map<string, number[]>;
  rows: RunRow[];
  byId: Map<string, RunRow>;
  commits: CommitRef[];
  bisects: BisectState[];
  /** The bisects playing a run in progress: they read as writing now, whatever the world's clock (see liveBisect). */
  running: Set<string>;
  stepsByBisect: Map<string, BisectStep[]>;
  tailByBisect: Map<string, string[]>;
  sim: { catalog: SimCatalogResponse; sessions: SimSessionSummary[]; runs: Map<string, SimRunResponse> };
}

// ── Derived views ───────────────────────────────────────────────────────────

export const rowsOf = (st: FixtureState, surface: string) => st.rows.filter((r) => r.surface === surface);
export const rowsIn = (st: FixtureState, batch: Batch) => st.rows.filter((r) => r.surface === batch.surface && r.batch === batch.name);
export const scoredOf = (rows: RunRow[]) => rows.filter((r) => r.score !== null && (r.status === "pass" || r.status === "fail"));
export const footingOf = (b: Batch): Footing => ({ model: b.model, ruler: b.ruler });
export const sameFooting = (a: Batch, b: Batch) => a.model === b.model && a.ruler === b.ruler;

export function surfaceDef(st: FixtureState, id: string): SurfaceDef {
  const def = st.defs.find((d) => d.id === id);
  if (!def) throw new EvalsFixtureMiss(`no surface ${id}`);
  return def;
}
export function batchOf(st: FixtureState, surface: string, name: string): Batch {
  const b = st.batches.get(surface)?.find((x) => x.name === name);
  if (!b) throw new EvalsFixtureMiss(`no batch ${name} on ${surface}`);
  return b;
}

export function batchStats(st: FixtureState, b: Batch): BatchStats {
  const rows = rowsIn(st, b);
  const scored = scoredOf(rows);
  const scores = scored.map((r) => r.score as number);
  const passed = scored.filter((r) => r.status === "pass").length;
  const live = rows.filter((r) => r.liveReads > 0);
  return {
    batch: b.name,
    reps: scored.length,
    passed,
    median: median(scores),
    mean: mean(scores),
    costUsd: round(sum(rows.map((r) => r.costUsd)), 4),
    batchAt: iso(b.at),
    cadence: b.cadence,
    passRate: scored.length ? round(passed / scored.length) : null,
    min: scores.length ? Math.min(...scores) : null,
    max: scores.length ? Math.max(...scores) : null,
    crashes: rows.filter((r) => r.status === "crash").length,
    judgeCostUsd: round(sum(rows.map((r) => r.judgeCostUsd)), 4),
    liveReads: { reps: live.length, reads: sum(live.map((r) => r.liveReads)) },
    dry: rows.every((r) => r.status === "dry"),
    dirtyReps: rows.filter((r) => r.dirty).length,
    freezes: new Set(rows.map((r) => r.freezeId)).size,
    footing: footingOf(b),
    gitHeads: [...new Set(rows.map((r) => r.gitHead).filter((x): x is string => !!x))],
  };
}

function majorityOf(rows: RunRow[]): boolean | null {
  const scored = scoredOf(rows);
  if (!scored.length) return null;
  return scored.filter((r) => r.status === "pass").length * 2 > scored.length;
}

export function flipsOf(st: FixtureState, a: Batch, b: Batch): VerdictFlip[] {
  const out: VerdictFlip[] = [];
  const ra = rowsIn(st, a);
  const rb = rowsIn(st, b);
  for (const f of st.freezes.values()) {
    if (f.surface !== a.surface) continue;
    const fa = ra.filter((r) => r.freezeId === f.id);
    const fb = rb.filter((r) => r.freezeId === f.id);
    const ma = majorityOf(fa);
    const mb = majorityOf(fb);
    if (ma === null || mb === null || ma === mb) continue;
    // Each side's reps that agree with its verdict come first, as verdict.ts verdictFlips lists them.
    const lead = (rows: RunRow[], passes: boolean) => [...rows.filter((r) => (r.status === "pass") === passes), ...rows.filter((r) => (r.status === "pass") !== passes)].map((r) => r.id);
    out.push({ freezeId: f.id, name: f.name, visibility: f.visibility, direction: mb ? "fixed" : "broke", before: lead(fa, ma), after: lead(fb, mb) });
  }
  return out;
}

export function flipsBetween(st: FixtureState, a: Batch, b: Batch): FlipsResult {
  if (!sameFooting(a, b)) {
    const why = a.model !== b.model ? `the model moved from ${a.model} to ${b.model}` : `the judge ruler moved from ${a.ruler} to ${b.ruler}`;
    return { ok: false, reason: `Not on the same footing: ${why}.`, a: footingOf(a), b: footingOf(b) };
  }
  return { ok: true, flips: flipsOf(st, a, b) };
}

/** The live batches a strip, verdict and ledger read: dry renders graded nothing. */
export const gradedBatches = (st: FixtureState, surface: string) => (st.batches.get(surface) ?? []).filter((b) => !b.dry);

/** b weighed against `against`, or (nightly) a pool of up to three earlier nightly batches on its footing, or the previous one. */
export function verdict(st: FixtureState, b: Batch, against?: Batch): BatchVerdict {
  const list = gradedBatches(st, b.surface);
  const skipped: { batch: string; freezeId: string; why: "model" | "judge" }[] = [];
  const base: Batch[] = against ? [against] : [];
  const pooled = !against && b.cadence === "nightly";
  if (!against) {
    for (let i = list.indexOf(b) - 1; i >= 0 && base.length < (pooled ? 3 : 1); i--) {
      if (pooled && list[i].cadence !== "nightly") continue;
      if (sameFooting(list[i], b)) {
        base.push(list[i]);
        continue;
      }
      const first = rowsIn(st, list[i])[0];
      skipped.push({ batch: list[i].name, freezeId: first?.freezeId ?? "", why: list[i].model !== b.model ? "model" : "judge" });
    }
  }
  const set = batchStats(st, b);
  const cur = scoredOf(rowsIn(st, b)).map((r) => r.score as number);
  const prev = base.flatMap((x) => scoredOf(rowsIn(st, x)).map((r) => r.score as number));
  // A cadence baseline is weighed night by night per freeze (verdict.ts pooledRuns, nightStrata), however
  // many nights it holds; the others by the per-rep Mann-Whitney.
  const separation = !base.length ? ({ kind: "too-few" } as SeparationResult) : pooled ? separateNights(nightStrataOf(st, b, base)) : fixtureSeparate(prev, cur);
  const nearest = base[0];
  const flips = nearest && sameFooting(nearest, b) ? flipsOf(st, nearest, b) : [];
  return {
    surface: b.surface,
    batch: b.name,
    footing: footingOf(b),
    models: [b.model],
    dry: b.dry,
    set,
    baseline: base.length ? { kind: against ? "against" : pooled ? "pooled" : "previous", batches: base.map((x) => x.name), reps: prev.length, cadence: pooled ? b.cadence : null, skipped } : null,
    compared: { current: cur, previous: prev, previousFreezes: new Set(base.flatMap((x) => rowsIn(st, x).map((r) => r.freezeId))).size },
    separation,
    footingNotes: against && !sameFooting(against, b) ? [{ freezeId: rowsIn(st, b)[0]?.freezeId ?? "", model: against.model !== b.model ? { then: against.model, now: b.model } : null, judge: against.ruler !== b.ruler }] : [],
    flips,
    gatesFailed: [...new Set(rowsIn(st, b).flatMap((r) => r.gatesFailed))],
    regression: separation.kind === "worse",
  };
}

/** Each freeze both sides graded, as verdict.ts nightStrata shapes it: tonight's mean on it and each earlier night's mean. */
function nightStrataOf(st: FixtureState, b: Batch, nights: Batch[]): Array<{ current: number; previous: number[] }> {
  const meanOn = (x: Batch, f: string) => mean(scoredOf(rowsIn(st, x)).filter((r) => r.freezeId === f).map((r) => r.score as number));
  const freezes = [...new Set(scoredOf(rowsIn(st, b)).map((r) => r.freezeId))];
  return freezes.flatMap((f) => {
    const previous = nights.map((n) => meanOn(n, f)).filter((v): v is number => v !== null);
    const current = meanOn(b, f);
    return current !== null && previous.length ? [{ current, previous }] : [];
  });
}

export function epochsOf(st: FixtureState, surface: string): Epoch[] {
  surfaceDef(st, surface);
  const list = st.batches.get(surface) ?? [];
  const starts = [0, ...(st.epochStarts.get(surface) ?? [])];
  const fz = [...st.freezes.values()].filter((f) => f.surface === surface);
  return starts.map((start, i) => {
    const end = (starts[i + 1] ?? list.length) - 1;
    const first = list[start];
    return {
      n: i + 1,
      surface,
      firstBatch: first.name,
      firstBatchAt: iso(first.at),
      lastBatch: list[end].name,
      gitHead: first.gitHead,
      changedFreezes: i === 0 ? fz.map((f) => f.id) : fz.filter((f) => f.index % 2 === 0 || i === 1).map((f) => f.id),
      scope: surface === "org-review" ? "analyzer-only" : "rendered",
    };
  });
}

export function footingMarkers(st: FixtureState, surface: string): FootingMarker[] {
  const list = gradedBatches(st, surface);
  const out: FootingMarker[] = [];
  for (let i = 1; i < list.length; i++) {
    const [a, b] = [list[i - 1], list[i]];
    if (a.model !== b.model) out.push({ batch: b.name, batchAt: iso(b.at), kind: "model", from: a.model, to: b.model });
    if (a.ruler !== b.ruler) out.push({ batch: b.name, batchAt: iso(b.at), kind: "judge", from: a.ruler, to: b.ruler });
  }
  return out;
}

/** The freeze ledger; a well's flip is the flip its batch's verdict reports, as views.ts ledgerOf reads batchFlips. */
export function ledger(st: FixtureState, surface: string, list: Batch[]): LedgerRow[] {
  const out: LedgerRow[] = [];
  const flipsAt = new Map(list.map((b) => [b.name, new Map(verdict(st, b).flips.map((f) => [f.freezeId, f.direction]))]));
  for (const f of st.freezes.values()) {
    if (f.surface !== surface) continue;
    const cells: LedgerRow["cells"] = {};
    let flips = 0;
    for (const b of list) {
      const rows = rowsIn(st, b).filter((r) => r.freezeId === f.id);
      if (!rows.length) continue;
      const scored = scoredOf(rows);
      const flip = flipsAt.get(b.name)?.get(f.id) ?? null;
      if (flip) flips++;
      cells[b.name] = { reps: rows.length, passed: scored.filter((r) => r.status === "pass").length, mean: mean(scored.map((r) => r.score as number)), majority: majorityOf(rows), flip };
    }
    out.push({ freezeId: f.id, name: f.name, visibility: f.visibility, flips, cells });
  }
  return out.sort((a, b) => b.flips - a.flips || a.name.localeCompare(b.name));
}
