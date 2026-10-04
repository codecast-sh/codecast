// A whole fake EVALS_HOME for the Evals pages in dev (lib/evals/fixtureTransport.ts)
// and their tests. Deterministic from a seed and a clock, and it answers every
// route in the contract with values of the contract's own types, so a page
// built against it works unchanged against the api child.
//
// It carries the stories the views exist for: settle regressing at a prompt
// epoch with two freezes flipping (attribution narrows it to three commits),
// insight moving model, title's judge ruler moving, role-wake reading live
// workspace state, ask's freeze being re-captured, handoff improving, a
// bisect running and one finished, and a Multiplayer sim failure that shrank.
//
// Nothing here is real data: names, shas, sessions and replies are invented.

import type {
  Attribution,
  AttributionAnswer,
  BatchStats,
  BatchVerdict,
  BatchesResponse,
  BisectPlan,
  BisectPlanRequest,
  BisectProbe,
  BisectResponse,
  BisectState,
  BisectStep,
  BisectSummary,
  CallDetail,
  Candidate,
  CommitRef,
  CommitResponse,
  CompareResponse,
  CostBound,
  Endpoint,
  Epoch,
  EpochResponse,
  EvalFlip,
  EvalRoute,
  EvalsRouteKey,
  FlipsResult,
  Footing,
  FootingMarker,
  FreezeResponse,
  GuardEntry,
  GuardStatus,
  LedgerRow,
  MomentMessage,
  MovedEvent,
  OverviewResponse,
  PatchResponse,
  PromptFilePair,
  RecordedProbe,
  RunDiffEntry,
  RunFileEntry,
  RunFileResponse,
  RunResponse,
  RunRow,
  RunRowStatus,
  SeparationResult,
  SimCatalogResponse,
  SimInvariant,
  SimRunResponse,
  SimRunRow,
  SimScenario,
  SimSessionSummary,
  StalenessWord,
  SurfaceOverview,
  SurfaceResponse,
  VerdictFlip,
} from "@codecast/shared/contracts/evalsApi";
import { largestDrops, narrowByRecords, sourceConfidence } from "@codecast/shared/contracts/evalsApi";
import { makeRng } from "@codecast/shared/random";
import { sessionTrailerValue } from "@codecast/shared/blame";
import { simGridOf } from "../../../store/__tests__/sim/grid";
import { simFixtureRun } from "./sim";
import { fixtureBisect, type FixtureBisectKind } from "./bisect";

/** A route the world has no answer for (an unknown id): the transport turns it into a 404. */
export class EvalsFixtureMiss extends Error {}

const DAY = 86_400_000;
const PASS_MARK = 0.7;
const CALL_MODEL = "claude-haiku-4-5-20251001";
const STRONG_MODEL = "claude-sonnet-5-5";
const OPUS_MODEL = "claude-opus-5-5";
const JUDGE_MODEL = "claude-sonnet-5-5";

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

const uuid = (text: string) => {
  const h = fixtureHex(text, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const iso = (ms: number) => new Date(ms).toISOString();
const stampOf = (ms: number) => iso(ms).replace(/[:.]/g, "-");
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
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

const SURFACE_DEFS: SurfaceDef[] = [
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

const SUBJECTS = [
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
const RECENT_SUBJECTS = [
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
const SESSIONS = ["jx70x2y", "jx7c6zk", "jx7dhfh", "jx76e8h", "jx7appr", "jx768ah", "jx7k3m2", "jx7p9q1"];

interface Batch {
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

interface FixtureState {
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

function build(now: number, seed: number): FixtureState {
  const rand = makeRng(seed);
  const placed = [
    ...SUBJECTS.map((subject, i) => ({ subject, i, at: now - (29 - i * 1.5) * DAY - 3 * 3_600_000, key: `commit:${i}:${subject}` })),
    ...RECENT_SUBJECTS.map((subject, j) => ({ subject, i: SUBJECTS.length + j, at: now - (6 - j * 0.5) * DAY - 5 * 3_600_000, key: `commit:r${j}:${subject}` })),
  ].sort((a, b) => a.at - b.at);
  const commits: CommitRef[] = placed.map(({ subject, i, at, key }) => {
    const sha = fixtureHex(key);
    const offMain = i === 13;
    return {
      sha,
      subject,
      author: i % 4 === 3 ? "Samvit Rao" : "Ashot Petrosian",
      at: iso(at),
      // A real trailer: the session link with its full id (blame refuses short ids).
      session: sessionTrailerValue(`jx7${fixtureHex(`session:${SESSIONS[i % SESSIONS.length]}`, 29)}`),
      mainSha: offMain ? fixtureHex(`commit:${i}:main-twin`) : sha,
      onMain: !offMain,
    };
  });
  const headAt = (ms: number) => [...commits].reverse().find((c) => Date.parse(c.at) <= ms) ?? commits[0];

  const freezes: FixtureState["freezes"] = new Map();
  const batches = new Map<string, Batch[]>();
  const epochStarts = new Map<string, number[]>();
  const rows: RunRow[] = [];

  SURFACE_DEFS.forEach((def, si) => {
    const fz = def.freezeNames.map((name, i) => {
      const f = { id: uuid(`${def.id}:${name}`), name, surface: def.id, visibility: (i >= def.privateFrom ? "private" : "public") as "public" | "private", base: 0.6 + rand() * 0.3, index: i };
      freezes.set(f.id, f);
      return f;
    });
    const list: Batch[] = [];
    for (let day = 29; day >= 0; day--) {
      if ((day + si) % def.every !== 0) continue;
      const at = now - day * DAY - (2 + (si % 5)) * 3_600_000 - Math.floor(rand() * 40) * 60_000;
      if (at > now) continue;
      // The real mix: agent surfaces carry no cadence, and most call batches are run by hand; a call surface's nightly lands every third day.
      list.push({ surface: def.id, index: list.length, name: iso(at), at, cadence: def.route === "agent" || day % 3 !== 0 ? null : "nightly", epoch: 1, model: def.model, ruler: `${JUDGE_MODEL}#r2`, gitHead: headAt(at).sha, dry: false, landing: false });
    }
    // A named batch by hand mid-window, and a dry render on the busy surfaces.
    const mid = list[Math.floor(list.length / 2)];
    if (mid) list.push({ ...mid, name: iso(mid.at + 5_400_000), at: mid.at + 5_400_000, cadence: null });
    if (def.every === 1) {
      const late = list[list.length - 4];
      if (late) list.push({ ...late, name: iso(late.at + 3_600_000), at: late.at + 3_600_000, cadence: null, dry: true });
    }
    list.sort((a, b) => a.at - b.at);
    const starts = def.epochsAt.map((x) => (x < 0 ? list.length + x : x)).filter((x) => x > 0 && x < list.length);
    epochStarts.set(def.id, starts);
    list.forEach((b, i) => {
      b.index = i;
      b.epoch = 1 + starts.filter((x) => x <= i).length;
      if (def.story === "model-change" && i < 11) b.model = "claude-sonnet-4-5-20250929";
      if (def.story === "judge-change" && i >= 14) b.ruler = `${JUDGE_MODEL}#r3`;
    });
    if (def.id === "title") {
      const last = list[list.length - 1];
      last.landing = true;
    }
    batches.set(def.id, list);

    const lastEpoch = 1 + starts.length;
    for (const b of list) {
      for (const f of fz) {
        for (let s = 1; s <= def.seeds; s++) {
          let score = f.base + (rand() - 0.5) * 0.24;
          if (def.story === "regression" && b.epoch === lastEpoch && (f.index === 0 || f.index === 2)) score -= 0.38;
          if (def.story === "improving" && b.epoch === lastEpoch && f.index === 1) score += 0.2;
          if (def.story === "model-change" && b.model !== def.model) score -= 0.08;
          score = clamp01(score);
          const gateFail = rand() < 0.035;
          const crash = !b.dry && rand() < 0.012;
          const status: RunRowStatus = b.dry ? "dry" : crash ? "crash" : gateFail ? "fail" : score >= PASS_MARK ? "pass" : "fail";
          const scored = status === "pass" || status === "fail";
          const finalScore = scored ? (gateFail ? 0 : round(score)) : null;
          // A batch runs on one tree, so its reps share the disk: dirty is the batch's (about half of them). The draw is
          // still taken, so every later number in the world stays where it was.
          rand();
          // The newest batch is the one checked against edits in progress.
          const dirty = b.index === list.length - 1 || parseInt(fixtureHex(`dirty:${def.id}:${b.name}`, 4), 16) % 100 < 50;
          const recent = now - b.at < 8 * DAY;
          const live = def.story === "live-reads" && rand() < 0.4 ? 1 + Math.floor(rand() * 3) : 0;
          const agent = def.route === "agent";
          const stamp = b.at + s * 41_000 + f.index * 7_000;
          const gitHead = b.gitHead;
          const commit = commits.find((c) => c.sha === gitHead);
          const promptSha = fixtureHex(`${def.id}:${f.id}:e${starts.length && f.index % 2 === 0 ? b.epoch : Math.min(b.epoch, 2)}`, 64);
          const row: RunRow = {
            id: `${def.id}-${f.id.slice(0, 8)}-seed${s}-${stampOf(stamp)}`,
            surface: def.id,
            freezeId: f.id,
            freezeName: f.name,
            visibility: f.visibility,
            seed: s,
            stamp: iso(stamp),
            batch: b.name,
            batchAt: iso(b.at),
            cadence: b.cadence,
            status,
            score: finalScore,
            passMark: scored ? PASS_MARK : null,
            gatesFailed: gateFail ? ["no-leak"] : [],
            checks: scored ? { criteria: round(clamp01(score + (rand() - 0.5) * 0.1)), voice: round(clamp01(score + 0.05 + (rand() - 0.5) * 0.15)) } : {},
            missedFloors: scored && score < 0.4 ? ["criteria"] : [],
            model: b.model,
            judgeModel: scored ? JUDGE_MODEL : null,
            ruler: scored ? b.ruler : null,
            gitHead,
            mainSha: commit?.mainSha ?? gitHead,
            dirty,
            offBranch: commit ? !commit.onMain : false,
            treePatch: dirty && recent ? fixtureHex(`patch:${b.name}`, 64) : null,
            sourceHash: fixtureHex(`src:${def.id}:${b.epoch}`, 64),
            sourceHashDisk: recent ? fixtureHex(`disk:${def.id}:${b.epoch}:${dirty}`, 64) : null,
            promptSha,
            freezeSha: def.story === "freeze-recapture" && f.index === 1 && b.index >= list.length - 3 ? fixtureHex(`freeze:${f.id}:v2`, 64) : fixtureHex(`freeze:${f.id}`, 64),
            liveReads: live,
            costUsd: b.dry ? 0 : round(agent ? 0.15 + rand() * 0.45 : 0.002 + rand() * 0.004, 4),
            judgeCostUsd: scored ? round(agent ? 0.02 + rand() * 0.02 : 0.003 + rand() * 0.002, 4) : 0,
            realMs: Math.round(agent ? 60_000 + rand() * 120_000 : 1_500 + rand() * 2_500),
            guard: agent ? { served: 8 + Math.floor(rand() * 12), unserved: 1 + Math.floor(rand() * 2), live, refused: rand() < 0.2 ? 1 : 0, unknown: rand() < 0.15 ? 1 : 0, help: rand() < 0.3 ? 1 : 0 } : { served: 0, unserved: 0, live: 0, refused: 0, unknown: 0, help: 0 },
            scoreVersions: scored && rand() < 0.15 ? 2 : scored ? 1 : 0,
          };
          rows.push(row);
        }
      }
    }
  });

  const state: FixtureState = {
    now,
    defs: SURFACE_DEFS,
    freezes,
    batches,
    epochStarts,
    rows,
    byId: new Map(rows.map((r) => [r.id, r])),
    commits,
    bisects: [],
    running: new Set(),
    stepsByBisect: new Map(),
    tailByBisect: new Map(),
    sim: buildSim(now),
  };
  buildBisects(state);
  return state;
}

// ── Derived views ───────────────────────────────────────────────────────────

const rowsOf = (st: FixtureState, surface: string) => st.rows.filter((r) => r.surface === surface);
const rowsIn = (st: FixtureState, batch: Batch) => st.rows.filter((r) => r.surface === batch.surface && r.batch === batch.name);
const scoredOf = (rows: RunRow[]) => rows.filter((r) => r.score !== null && (r.status === "pass" || r.status === "fail"));
const footingOf = (b: Batch): Footing => ({ model: b.model, ruler: b.ruler });
const sameFooting = (a: Batch, b: Batch) => a.model === b.model && a.ruler === b.ruler;

function surfaceDef(st: FixtureState, id: string): SurfaceDef {
  const def = st.defs.find((d) => d.id === id);
  if (!def) throw new EvalsFixtureMiss(`no surface ${id}`);
  return def;
}
function batchOf(st: FixtureState, surface: string, name: string): Batch {
  const b = st.batches.get(surface)?.find((x) => x.name === name);
  if (!b) throw new EvalsFixtureMiss(`no batch ${name} on ${surface}`);
  return b;
}

function batchStats(st: FixtureState, b: Batch): BatchStats {
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

function flipsOf(st: FixtureState, a: Batch, b: Batch): VerdictFlip[] {
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
    out.push({ freezeId: f.id, name: f.name, visibility: f.visibility, direction: mb ? "fixed" : "broke", before: fa.map((r) => r.id), after: fb.map((r) => r.id) });
  }
  return out;
}

function flipsBetween(st: FixtureState, a: Batch, b: Batch): FlipsResult {
  if (!sameFooting(a, b)) {
    const why = a.model !== b.model ? `the model moved from ${a.model} to ${b.model}` : `the judge ruler moved from ${a.ruler} to ${b.ruler}`;
    return { ok: false, reason: `Not on the same footing: ${why}.`, a: footingOf(a), b: footingOf(b) };
  }
  return { ok: true, flips: flipsOf(st, a, b) };
}

/** The live batches a strip, verdict and ledger read: dry renders graded nothing. */
const gradedBatches = (st: FixtureState, surface: string) => (st.batches.get(surface) ?? []).filter((b) => !b.dry);

/** b weighed against `against`, or (nightly) a pool of up to three earlier nightly batches on its footing, or the previous one. */
function verdict(st: FixtureState, b: Batch, against?: Batch): BatchVerdict {
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
  const separation = base.length ? fixtureSeparate(prev, cur) : ({ kind: "too-few" } as SeparationResult);
  const nearest = base[0];
  const flips = nearest && sameFooting(nearest, b) ? flipsOf(st, nearest, b) : [];
  return {
    surface: b.surface,
    batch: b.name,
    footing: footingOf(b),
    models: [b.model],
    dry: b.dry,
    set,
    baseline: base.length ? { kind: against ? "against" : base.length > 1 ? "pooled" : "previous", batches: base.map((x) => x.name), reps: prev.length, cadence: nearest.cadence, skipped } : null,
    compared: { current: cur, previous: prev, previousFreezes: new Set(base.flatMap((x) => rowsIn(st, x).map((r) => r.freezeId))).size },
    separation,
    footingNotes: against && !sameFooting(against, b) ? [{ freezeId: rowsIn(st, b)[0]?.freezeId ?? "", model: against.model !== b.model ? { then: against.model, now: b.model } : null, judge: against.ruler !== b.ruler }] : [],
    flips,
    gatesFailed: [...new Set(rowsIn(st, b).flatMap((r) => r.gatesFailed))],
    regression: separation.kind === "worse",
  };
}

function epochsOf(st: FixtureState, surface: string): Epoch[] {
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

function footingMarkers(st: FixtureState, surface: string): FootingMarker[] {
  const list = gradedBatches(st, surface);
  const out: FootingMarker[] = [];
  for (let i = 1; i < list.length; i++) {
    const [a, b] = [list[i - 1], list[i]];
    if (a.model !== b.model) out.push({ batch: b.name, batchAt: iso(b.at), kind: "model", from: a.model, to: b.model });
    if (a.ruler !== b.ruler) out.push({ batch: b.name, batchAt: iso(b.at), kind: "judge", from: a.ruler, to: b.ruler });
  }
  return out;
}

function ledger(st: FixtureState, surface: string, list: Batch[]): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const f of st.freezes.values()) {
    if (f.surface !== surface) continue;
    const cells: LedgerRow["cells"] = {};
    let prev: { b: Batch; maj: boolean | null } | null = null;
    let flips = 0;
    for (const b of list) {
      const rows = rowsIn(st, b).filter((r) => r.freezeId === f.id);
      if (!rows.length) continue;
      const scored = scoredOf(rows);
      const maj = majorityOf(rows);
      const flip = prev && prev.maj !== null && maj !== null && prev.maj !== maj && sameFooting(prev.b, b) ? (maj ? "fixed" : "broke") : null;
      if (flip) flips++;
      cells[b.name] = { reps: rows.length, passed: scored.filter((r) => r.status === "pass").length, mean: mean(scored.map((r) => r.score as number)), majority: maj, flip };
      if (maj !== null) prev = { b, maj };
    }
    out.push({ freezeId: f.id, name: f.name, visibility: f.visibility, flips, cells });
  }
  return out.sort((a, b) => b.flips - a.flips || a.name.localeCompare(b.name));
}

// ── Text the run pages read ─────────────────────────────────────────────────

/** How each freeze's moment ends: the human's question, the agent's answer ending on a question back, and what a "done" reading would claim. */
const CLOSERS: Array<{ ask: string; answer: string; done: string }> = [
  { ask: "Does this need a deploy, or is it client only?", answer: "Client only. Want me to open the PR or leave it in the tree?", done: "The fix is in the tree and tests pass." },
  { ask: "Did the migration run on staging too?", answer: "It ran on staging. Should I run it on prod now, or wait for the window?", done: "The migration ran on staging." },
  { ask: "Can you check the flaky test while you're there?", answer: "The flake is a timer race; I pinned the clock. Same fix in the other two suites?", done: "The flaky test is fixed and the clock is pinned." },
  { ask: "What's left on the export bug?", answer: "The CSV path is fixed. The PDF path still drops its header; should I take that next?", done: "The CSV export is fixed." },
  { ask: "Is the webhook retry safe to ship?", answer: "It is idempotent now. Behind the flag, or straight to everyone?", done: "The retry is idempotent and ready." },
];

/** One closer per freeze, seeded by its id, so two flips never show the same moment. */
const closerOf = (freezeId: string) => {
  let h = 0;
  for (let i = 0; i < freezeId.length; i++) h = (h * 31 + freezeId.charCodeAt(i)) >>> 0;
  return CLOSERS[h % CLOSERS.length];
};

function momentOf(st: FixtureState, freezeId: string): MomentMessage[] {
  const f = st.freezes.get(freezeId);
  if (!f) return [];
  const t0 = st.now - 31 * DAY;
  const c = closerOf(freezeId);
  const lines: Array<[MomentMessage["direction"], string, string]> = [
    ["in", "Ashot", `Can you look at ${f.name.replace(/-/g, " ")}? It came up again this morning.`],
    ["out", "agent", "Reading the logs first. The failure starts after the cache warms, not at boot."],
    ["out", "agent", "Found it: the retry wraps the wrong call. Patch is in the tree, tests pass locally."],
    ["in", "Ashot", c.ask],
    ["out", "agent", c.answer],
  ];
  return lines.map(([direction, from, text], n) => ({ n: n + 1, id: `m${n + 1}`, at: iso(t0 + n * 240_000), channel: "session", isGroup: false, direction, from, text }));
}

function replyOf(row: RunRow): string {
  const pass = row.status === "pass";
  switch (row.surface) {
    case "settle": {
      const c = closerOf(row.freezeId);
      return JSON.stringify(pass ? { state: "waiting", why: `The agent asked "${c.answer.slice(c.answer.lastIndexOf(". ") + 2)}" and has no answer.` } : { state: "done", why: c.done });
    }
    case "title":
      return pass ? `Fix ${row.freezeName.replace(/-/g, " ")} retry` : `Claude Code: ${row.freezeName}`;
    default:
      return pass
        ? `${row.freezeName.replace(/-/g, " ")}: the work is clear, the next step is named, and nothing is invented.`
        : `${row.freezeName.replace(/-/g, " ")}: a confident summary that misses the open question at the end.`;
  }
}

function promptOf(st: FixtureState, row: RunRow, file: string): string {
  const def = surfaceDef(st, row.surface);
  const b = batchOf(st, row.surface, row.batch ?? "");
  const extra = b.epoch >= 2 ? "\n- If the human was asked anything, the session is waiting, whatever else is true." : "";
  const extra3 = b.epoch >= 3 ? "\n- A finished fix with tests passing is done. Prefer done when work is verified." : "";
  if (file.endsWith("system.md")) return `You read one coding session and answer for the ${def.id} surface.\n\nRules:\n- Read the last assistant turn first.${extra}${extra3}\n- Answer in JSON only.`;
  if (file.endsWith("then2.md")) return "Anything else you would do before ending the turn?";
  return momentOf(st, row.freezeId).map((m) => `${m.from}: ${m.text}`).join("\n");
}

/** What an agent typed, per mark: real-shaped commands, cycled when a count outruns the list. */
const GUARD_ARGV: Record<GuardStatus, string[]> = {
  SERVED: ["cast feed --since 1d", "cast task ls -q sync", "cast plan show pl-810", "cast read jx7c6zk 40:60", "cast sessions --label growth", "cast task show ct-4102", "cast search \"weekly digest\" -s 7d", "cast decisions list", "cast pr ls --mine", "cast calls -n 3", "cast doc search \"growth plan\"", "cast trigger ls", "cast task ready -q growth", "cast chat read --channel growth --since 1d", "cast summary jx7dhfh", "cast plan ls -q growth", "cast diff jx7c6zk", "cast feed --label growth", "cast task ls --assignee me", "cast usage"],
  UNSERVED: ["cast plan context pl-810", "cast call cl-212 --transcript"],
  LIVE: ["cast sessions --state needs-input", "cast feed --since 2h", "cast task ls -s in_progress"],
  REFUSED: ['cast task comment ct-4102 "done"'],
  UNKNOWN: ["cast roster"],
  HELP: ["cast trigger --help"],
};

function guardOf(row: RunRow): GuardEntry[] {
  const out: GuardEntry[] = [];
  const push = (status: GuardStatus, n: number, turn: number, from = 0) => {
    const list = GUARD_ARGV[status];
    for (let i = 0; i < n; i++) out.push({ seq: out.length + 1, turn, argv: list[(from + i) % list.length], status });
  };
  push("SERVED", Math.min(row.guard.served, 4), 1);
  push("HELP", row.guard.help, 1);
  push("SERVED", Math.max(0, row.guard.served - 4), 2, 4);
  push("UNSERVED", row.guard.unserved, 2);
  push("LIVE", row.guard.live, 2);
  push("UNKNOWN", row.guard.unknown, 2);
  push("REFUSED", row.guard.refused, 2);
  return out;
}

function runResponse(st: FixtureState, row: RunRow): RunResponse {
  const def = surfaceDef(st, row.surface);
  const scored = row.status === "pass" || row.status === "fail";
  // A dry rep calls no model: a call's reply is its prompt echoed back (adapters/dryRun.ts), an agent's a fixed line.
  const dry = row.status === "dry";
  const reply = dry ? (def.route === "call" ? promptOf(st, row, "call1/prompt.md") : "(dry run: no agent ran)") : replyOf(row);
  const calls: CallDetail[] =
    def.route === "call" && row.status !== "crash"
      ? [{ n: 1, dir: "call1", request: { model: row.model ?? def.model, max_tokens: 1024, temperature: 0 }, system: promptOf(st, row, "call1/system.md"), prompt: promptOf(st, row, "call1/prompt.md"), reply, stopReason: "end_turn", tokens: dry ? { input: null, output: Math.ceil(reply.length / 4), cacheRead: null, cacheWrite: null } : { input: 2140, output: 96, cacheRead: 1800, cacheWrite: 0 }, costUsd: row.costUsd, realMs: row.realMs, isError: false, harnessFailure: null }]
      : [];
  const agents =
    def.route === "agent" && row.status !== "crash"
      ? [{
          n: 1,
          dir: "agent1",
          model: row.model ?? def.model,
          prompt: promptOf(st, row, "agent1/prompt.md"),
          then: [promptOf(st, row, "agent1/then2.md")],
          turns: dry ? [[{ kind: "text" as const, text: reply }]] : [
            [{ kind: "thinking" as const, text: "Start from what changed since the last check." }, { kind: "tool" as const, name: "Bash", input: { command: "cast feed --since 1d" }, output: "12 events since yesterday", isError: false }, { kind: "text" as const, text: reply }],
            [{ kind: "text" as const, text: "Nothing else: the open items belong to other roles." }],
          ],
          said: [reply],
          brief: "You are the infra lead. Check what changed since you last looked.",
          args: { model: row.model ?? def.model, call: false, maxOutputTokens: null, tools: ["Bash", "Read"], maxTurns: 12, serve: "served/", guard: "guard/" },
          tokens: { input: 48_000, output: 2_100, cacheRead: 40_000, cacheWrite: 6_000 },
          costUsd: row.costUsd,
        }]
      : [];
  const gates = [
    { id: "no-leak", title: "No private text leaks into the reply", pass: !row.gatesFailed.includes("no-leak"), decidedBy: "mechanical" as const, evidence: row.gatesFailed.includes("no-leak") ? { summary: "The reply quotes a private channel name.", scanned: 1, excerpts: [{ where: "reply", text: "#founders-only" }] } : { summary: "Scanned 1 reply, nothing private.", scanned: 1 } },
    { id: "shape", title: "The reply parses", pass: true, decidedBy: "mechanical" as const, evidence: { summary: "Held, nothing to check.", vacuous: true } },
  ];
  // The tool grades a dry rep too, scoring the echoed prompt as if it were a reply: real dry folders mostly fail `parse` at 0.
  const dryScore = dry
    ? { pass: false, score: 0, passMark: PASS_MARK, gates: [{ id: "shape", title: "The reply parses", pass: false, decidedBy: "mechanical" as const, evidence: { summary: `not JSON: the reply starts "${reply.slice(0, 32)}"` } }], checks: [], missedFloors: [], judgeCostUsd: 0, judgeModel: null, scoredAt: iso(Date.parse(row.stamp) + 2_000) }
    : null;
  const score = scored
    ? {
        pass: row.status === "pass",
        score: row.score as number,
        passMark: PASS_MARK,
        gates,
        checks: Object.entries(row.checks).map(([id, s]) => ({ id, ask: id === "criteria" ? def.criteria : "Does it sound like the person, not like a model?", weight: id === "criteria" ? 0.7 : 0.3, score: s, must: id === "criteria" ? 0.4 : null, reasoning: s >= PASS_MARK ? "It answers the question the moment asks and invents nothing." : "It reads as finished, but the session ended on an unanswered question.", evidence: null })),
        missedFloors: row.missedFloors.map((id) => ({ id, score: row.checks[id] ?? 0, must: 0.4 })),
        judgeCostUsd: row.judgeCostUsd,
        judgeModel: row.judgeModel,
        scoredAt: iso(Date.parse(row.stamp) + 90_000),
      }
    : dryScore;
  // Sizes come from the texts the file route serves (runFileTexts), so the tree and the open file agree.
  const files: RunFileEntry[] = [
    { path: "run.json", kind: "file", size: 0 },
    { path: "result.json", kind: "file", size: 0 },
    ...(score ? [{ path: "score.json", kind: "file" as const, size: 0 }] : []),
    { path: "sends.json", kind: "file", size: 0 },
    ...(calls.length ? [{ path: "call1", kind: "dir" as const, size: 0 }, { path: "call1/system.md", kind: "file" as const, size: 0 }, { path: "call1/prompt.md", kind: "file" as const, size: 0 }, { path: "call1/reply.md", kind: "file" as const, size: 0 }] : []),
    ...(agents.length ? [{ path: "agent1", kind: "dir" as const, size: 0 }, { path: "agent1/prompt.md", kind: "file" as const, size: 0 }, { path: "agent1/then2.md", kind: "file" as const, size: 0 }, { path: "agent1/stream.jsonl", kind: "file" as const, size: 0 }, { path: "calls.log", kind: "file" as const, size: 0 }] : []),
    ...(row.status === "crash" ? [{ path: "run.log", kind: "file" as const, size: 0 }] : []),
  ];
  const b = batchOf(st, row.surface, row.batch ?? "");
  const list = st.batches.get(row.surface) ?? [];
  const sameFreeze = (x: Batch | undefined) => (x ? rowsIn(st, x).find((r) => r.freezeId === row.freezeId && r.seed === row.seed)?.id ?? null : null);
  const res: RunResponse = {
    row,
    run: { freezeId: row.freezeId, notes: null, model: row.model ?? def.model, route: def.route, sourceHash: row.sourceHash ?? "", sourceHashDisk: row.sourceHashDisk, treePatch: row.treePatch, freezeSha: row.freezeSha, promptSha: row.promptSha, judgeModel: row.judgeModel, budgetUsd: 8, gitHead: row.gitHead ?? "", dirty: row.dirty, dry: row.status === "dry", temperatureProd: [0], temperatureReplay: "cli-default", liveReads: row.liveReads, batch: row.batch ?? "", cadence: row.cadence, title: `${row.surface} ${row.freezeName}` },
    result: { scenario: row.freezeName, seed: row.seed, title: `${row.surface} ${row.freezeName}`, startedAt: row.stamp, endedBecause: row.status === "crash" ? "failed" : "done", stopReason: row.status === "crash" ? "the replay exited 1 before replying" : null, steps: calls.length + agents.length, virtualElapsedMs: 0, realElapsedMs: row.realMs, costUsd: row.costUsd, captures: 1 },
    score,
    scoreVersions: score
      ? [
          ...(row.scoreVersions > 1 ? [{ file: "score.before-rejudge.json", scoredAt: null, judgeModel: JUDGE_MODEL, score: round(clamp01((row.score as number) + 0.06)), pass: true, legacy: true }] : []),
          { file: "score.json", scoredAt: score.scoredAt ?? null, judgeModel: score.judgeModel, score: score.score, pass: score.pass, legacy: false },
        ]
      : [],
    rubric: score ? null : { criteria: def.criteria, passMark: PASS_MARK },
    sends: row.status === "crash" ? [] : [{ seq: 1, at: row.stamp, label: def.id, rail: def.route === "agent" ? "chat" : "result", to: null, audience: "founder", text: reply, chars: reply.length }],
    calls,
    agents,
    judge: scored ? { model: row.judgeModel, prompt: `Grade the reply against: ${def.criteria}`, reply: JSON.stringify({ score: row.score }), costUsd: row.judgeCostUsd } : null,
    guard: def.route === "agent" ? guardOf(row) : [],
    files,
    logTail: row.status === "crash" ? "replay: spawning claude -p\nerror: the model returned an empty stream\n    at readStream (adapters/replay.ts:211)\nexit 1" : null,
    siblings: rowsIn(st, b).filter((r) => r.freezeId === row.freezeId && r.id !== row.id),
    adjacent: { previous: sameFreeze(list[b.index - 1]), next: sameFreeze(list[b.index + 1]) },
    extra: row.surface === "org-review" ? { gradeAuto: { named: 7, exist: 7, owners: 6 }, hashes: { analyzer: row.promptSha } } : null,
  };
  const texts = runFileTexts(res);
  return { ...res, files: files.map((f) => (f.kind === "dir" ? f : { ...f, size: byteLength(texts.get(f.path) ?? "") })) };
}

function promptPair(st: FixtureState, a: RunRow, b: RunRow): PromptFilePair[] {
  const files = surfaceDef(st, a.surface).route === "agent" ? ["agent1/prompt.md", "agent1/then2.md"] : ["call1/system.md", "call1/prompt.md"];
  return files.map((file) => ({ freezeId: a.freezeId, file, a: { runId: a.id, text: promptOf(st, a, file) }, b: { runId: b.id, text: promptOf(st, b, file) } }));
}

function examplesOf(st: FixtureState, flips: VerdictFlip[]): EvalFlip[] {
  return flips.map((f) => {
    // The reps that show the flip: one on each side with the side's majority outcome, as flipOf picks them.
    const pick = (ids: string[], pass: boolean) => ids.map((id) => st.byId.get(id)).find((r) => r && (r.status === "pass") === pass) ?? st.byId.get(ids[0]);
    const before = pick(f.before, f.direction === "broke");
    const after = pick(f.after, f.direction !== "broke");
    return {
      freeze: f.freezeId,
      name: f.name,
      direction: f.direction,
      input: momentOf(st, f.freezeId).slice(-2).map((m) => `${m.from}: ${m.text}`).join(" "),
      before: before ? replyOf(before) : "",
      after: after ? replyOf(after) : "",
      note: f.direction === "broke" ? "It calls the session done although the agent's last line asks the human a question." : "It now names the open question and calls the session waiting.",
    };
  });
}

// ── Attribution and bisect ──────────────────────────────────────────────────

function endpointOf(st: FixtureState, surface: string, ref: string): { endpoint: Endpoint; batch: Batch | null } {
  const b = st.batches.get(surface)?.find((x) => x.name === ref) ?? null;
  if (b) {
    const rows = rowsIn(st, b);
    const dirty = rows.some((r) => r.dirty);
    return { batch: b, endpoint: { batch: b.name, sha: b.gitHead, mainSha: st.commits.find((c) => c.sha === b.gitHead)?.mainSha ?? b.gitHead, dirty, treePatch: rows.find((r) => r.treePatch)?.treePatch ?? null, footing: footingOf(b), at: iso(b.at) } };
  }
  const c = st.commits.find((x) => x.sha.startsWith(ref));
  if (!c) throw new EvalsFixtureMiss(`no batch or commit ${ref}`);
  return { batch: null, endpoint: { batch: null, sha: c.sha, mainSha: c.mainSha, dirty: false, treePatch: null, footing: { model: surfaceDef(st, surface).model, ruler: `${JUDGE_MODEL}#r2` }, at: c.at } };
}

function attribution(st: FixtureState, surface: string, goodRef: string, badRef: string, allCommits = false): Attribution {
  const good = endpointOf(st, surface, goodRef);
  const bad = endpointOf(st, surface, badRef);
  const gb = good.batch;
  const bb = bad.batch;
  const flipped = gb && bb && sameFooting(gb, bb) ? flipsOf(st, gb, bb).filter((f) => f.direction === "broke") : [];
  const footingDiffers = good.endpoint.footing.model !== bad.endpoint.footing.model || good.endpoint.footing.ruler !== bad.endpoint.footing.ruler;
  const freezeShas = (b: Batch | null) => new Set(b ? rowsIn(st, b).map((r) => `${r.freezeId}:${r.freezeSha}`) : []);
  const fa = freezeShas(gb);
  const changedFreezes = bb ? [...new Set(rowsIn(st, bb).filter((r) => !fa.has(`${r.freezeId}:${r.freezeSha}`) && gb && rowsIn(st, gb).some((g) => g.freezeId === r.freezeId)).map((r) => r.freezeId))] : [];
  const badRows = bb ? rowsIn(st, bb) : [];
  const live = badRows.filter((r) => r.liveReads > 0);
  const sourceDiffers = good.endpoint.sha !== bad.endpoint.sha || (gb && bb ? gb.epoch !== bb.epoch : false);
  const checklist: Attribution["checklist"] = [
    { class: "footing", differs: footingDiffers, detail: footingDiffers ? `Model ${good.endpoint.footing.model} then ${bad.endpoint.footing.model}; ruler ${good.endpoint.footing.ruler} then ${bad.endpoint.footing.ruler}.` : "Same model and judge ruler on both ends." },
    { class: "freeze", differs: changedFreezes.length > 0, detail: changedFreezes.length ? `${changedFreezes.length} freeze was captured again between the two batches.` : "Every freeze is byte-identical on both ends." },
    { class: "live-reads", differs: live.length > 0, detail: live.length ? `${live.length} reps on the bad end read live workspace state.` : "No rep read the live workspace." },
    { class: "source", differs: sourceDiffers, detail: sourceDiffers ? "The rendered prompt and the declared sources differ." : "Same sources and the same rendered prompt." },
    { class: "noise", differs: false, detail: "Reached only when nothing above differs." },
  ];
  const lo = Date.parse(good.endpoint.at ?? "");
  const hi = Date.parse(bad.endpoint.at ?? "");
  const inRange = st.commits.filter((c) => Date.parse(c.at) > lo && Date.parse(c.at) <= hi);
  const surfaceWord = surface.split("-")[0];
  const touching = inRange.filter((c) => c.subject.startsWith(surfaceWord) || c.subject.startsWith("evals"));
  let answer: AttributionAnswer;
  let candidates: Candidate[] = [];
  if (footingDiffers) answer = { kind: "footing", change: good.endpoint.footing.model !== bad.endpoint.footing.model ? "model" : "judge", from: good.endpoint.footing.model !== bad.endpoint.footing.model ? good.endpoint.footing.model : good.endpoint.footing.ruler, to: good.endpoint.footing.model !== bad.endpoint.footing.model ? bad.endpoint.footing.model : bad.endpoint.footing.ruler };
  else if (changedFreezes.length) answer = { kind: "freeze", freezeIds: changedFreezes };
  else if (live.length) answer = { kind: "live-reads", reps: live.length, reads: sum(live.map((r) => r.liveReads)) };
  else if (sourceDiffers) {
    // The search set, as attribution.ts walks it: the commits touching declared sources, or every commit with --all-commits.
    const searched = allCommits ? inRange : touching;
    const patch: Candidate | null = bad.endpoint.dirty && bad.endpoint.treePatch ? { kind: "patch", base: bad.endpoint.sha, treePatch: bad.endpoint.treePatch, renderClass: null } : null;
    // Either end on edits nothing kept cannot stand for one commit (attribution.ts unreplayable).
    const unkept = (["good", "bad"] as const).filter((k) => { const e = (k === "good" ? good : bad).endpoint; return e.dirty && !e.treePatch; });
    const unattributable = unkept.length > 0;
    // Every recorded batch inside the range, on the same footing, that ran a flipped freeze and can be replayed (clean, or
    // carrying a patch), placed at its commit's index and read by the probe rule: majority per flipped freeze.
    const focus = new Set(flipped.map((f) => f.freezeId));
    const probeVerdict = (rows: RunRow[]): RecordedProbe["verdict"] => {
      const byFreeze = new Map<string, boolean[]>();
      for (const r of rows) byFreeze.set(r.freezeId, [...(byFreeze.get(r.freezeId) ?? []), r.status === "pass"]);
      const failing = [...byFreeze.values()].filter((v) => v.filter(Boolean).length * 2 <= v.length).length;
      return failing * 2 > byFreeze.size ? "bad" : (byFreeze.size - failing) * 2 > byFreeze.size ? "good" : "unsure";
    };
    const recorded = gb && bb && !unattributable
      ? gradedBatches(st, surface)
          .filter((b) => b.at > gb.at && b.at < bb.at && sameFooting(b, gb))
          .flatMap((b) => {
            const all = rowsIn(st, b);
            const ran = all.filter((r) => focus.has(r.freezeId) && (r.status === "pass" || r.status === "fail"));
            const dirty = all.some((r) => r.dirty);
            const at = inRange.findIndex((c) => c.sha === b.gitHead);
            if (!ran.length || at < 0 || (dirty && !all.some((r) => r.treePatch))) return [];
            return [{ batch: b.name, sha: b.gitHead, verdict: probeVerdict(ran), reps: ran.length, at, clean: !dirty }];
          })
      : [];
    const { goodAt, badAt, keepPatch } = narrowByRecords(inRange.length, recorded);
    candidates = [
      ...searched.filter((c) => { const i = inRange.indexOf(c); return unattributable || (i > goodAt && i <= badAt); }).map((commit) => ({ kind: "commit" as const, commit, renderClass: null })),
      ...(patch && (unattributable || keepPatch) ? [patch] : []),
    ];
    answer = {
      kind: "source",
      confidence: unattributable ? "unattributable" : sourceConfidence(candidates.length),
      candidates,
      narrowedBy: recorded.map(({ at: _, clean: __, ...r }) => r),
      epochs: epochsOf(st, surface).filter((e) => Date.parse(e.firstBatchAt) > lo && Date.parse(e.firstBatchAt) <= hi),
      noDeclaredSourceMoved: !allCommits && !touching.length && !patch,
      rangeCommits: inRange.length,
      reason: unattributable ? unkept.map((k) => `the ${k} batch ran uncommitted edits and kept no patch; nothing recorded can replay them`).join("; ") : null,
    };
  } else answer = { kind: "noise", separation: gb && bb ? fixtureSeparate(scoredOf(rowsIn(st, gb)).map((r) => r.score as number), scoredOf(badRows).map((r) => r.score as number)) : { kind: "too-few" } };
  const firstFlip = flipped[0];
  const ra = firstFlip ? st.byId.get(firstFlip.before[0]) : undefined;
  const rb = firstFlip ? st.byId.get(firstFlip.after[0]) : undefined;
  return {
    surface,
    good: good.endpoint,
    bad: bad.endpoint,
    mode: flipped.length ? "flip" : "score",
    flipped,
    checklist,
    answer,
    promptDiffs: ra && rb ? promptPair(st, ra, rb) : [],
    examples: examplesOf(st, flipped),
  };
}

function bisectPlan(st: FixtureState, req: BisectPlanRequest): BisectPlan {
  const def = surfaceDef(st, req.surface);
  const attr = attribution(st, req.surface, req.good, req.bad, req.allCommits);
  const candidates = attr.answer.kind === "source" ? attr.answer.candidates : [];
  // The focus freezes, as the engine's planFrom picks them: the flips, or in score mode the largest median drops (contract's largestDrops).
  const batchOf = (batch: string | null) => (batch ? (st.batches.get(req.surface)?.find((b) => b.name === batch) ?? null) : null);
  const gradedRows = (batch: string | null) => { const b = batchOf(batch); return b ? rowsIn(st, b).filter((r) => r.status !== "crash" && r.status !== "dry") : []; };
  const focusIds = attr.flipped.length ? attr.flipped.map((f) => f.freezeId) : largestDrops(gradedRows(attr.good.batch), gradedRows(attr.bad.batch));
  const flipped = focusIds.map((id) => ({ id, name: attr.flipped.find((f) => f.freezeId === id)?.name ?? st.freezes.get(id)?.name ?? id.slice(0, 8), role: "flipped" as const }));
  const controls = [...st.freezes.values()].filter((f) => f.surface === req.surface && !flipped.some((x) => x.id === f.id)).slice(0, 2).map((f) => ({ id: f.id, name: f.name, role: "control" as const }));
  const freezes = req.freezes?.length ? [...flipped, ...controls].filter((f) => req.freezes!.includes(f.id)) : [...flipped, ...controls];
  const reps = req.reps ?? 3;
  // The api child plans with --no-render, so every candidate (the patch included) counts as its own class until start renders them.
  const classes = candidates.length;
  const probes = Math.ceil(Math.log2(classes + 1));
  const F = freezes.length;
  const maxReps = (2 + probes) * F * (reps + 2) + 2 * (F + 2) * 5;
  const perRepUsd = def.route === "agent" ? 0.42 : 0.006;
  const judgePerRepUsd = def.route === "agent" ? 0.03 : 0.004;
  const maxUsd = round(maxReps * (perRepUsd + judgePerRepUsd), 2);
  const bound: CostBound = { classes, probes, freezes: F, reps, maxReps, perRepUsd, judgePerRepUsd, maxUsd };
  const budgetUsd = req.budgetUsd ?? round(maxUsd * 1.2, 2);
  return {
    surface: req.surface,
    good: attr.good,
    bad: attr.bad,
    attribution: attr,
    freezes,
    reps,
    candidates,
    classes: null,
    bound,
    budgetUsd,
    maxMinutes: req.maxMinutes ?? 45,
    allCommits: req.allCommits ?? false,
    needsConfirm: def.route === "agent",
    // plan.ts costLine, word for word.
    summary: `2 controls + up to ${probes} probe${probes === 1 ? "" : "s"} + confirmation, ${F} freeze${F === 1 ? "" : "s"}, ${reps} to ${reps + 2} reps: at most ${maxReps} reps, about $${maxUsd.toFixed(2)}, budget $${budgetUsd.toFixed(2)}`,
  };
}

/** The newest pair of batches on one surface whose attribution narrows to `minCommits` or more candidates, the patch included (flipped freezes preferred). */
function narrowedPair(st: FixtureState, surface: string, minCommits: number): { good: Batch; bad: Batch } | null {
  const graded = gradedBatches(st, surface);
  let fallback: { good: Batch; bad: Batch } | null = null;
  for (let bi = graded.length - 1; bi >= Math.max(1, graded.length - 3); bi--) {
    for (let gap = 2; gap <= 6 && bi - gap >= 0; gap++) {
      const good = graded[bi - gap];
      const bad = graded[bi];
      if (!sameFooting(good, bad)) continue;
      const a = attribution(st, surface, good.name, bad.name);
      if (a.answer.kind !== "source" || a.answer.confidence !== "narrowed" || a.answer.candidates.length < minCommits) continue;
      if (a.flipped.length) return { good, bad };
      fallback ??= { good, bad };
    }
  }
  return fallback;
}

/**
 * The bisects the pages show: settle running and finished, a stalled agent
 * run, an unsure range, drift and a control that crashed (__fixtures__/bisect.ts
 * plays each out).
 * Their clock is the real one, not the world's start of day: a page weighs a
 * bisect's elapsed time and its last write against Date.now, so a run that
 * began at the world's clock would read as hours old and never stalled. Their
 * ids are fixed, so nothing that names one moves.
 */
function buildBisects(st: FixtureState, clock = Math.max(st.now, Date.now())) {
  // A landed rep links to one of the world's own runs on its freeze with the same outcome; a crash (null) to a crashed run, on its freeze when one crashed there.
  const runIdOf = (freezeId: string, passed: boolean | null, n: number) => {
    const surface = st.rows.find((r) => r.freezeId === freezeId)?.surface;
    const crashes = st.rows.filter((r) => r.status === "crash" && r.freezeId === freezeId);
    const runs =
      passed === null
        ? crashes.length ? crashes : st.rows.filter((r) => r.status === "crash" && r.surface === surface)
        : st.rows.filter((r) => r.freezeId === freezeId && (r.status === "pass") === passed && (r.status === "pass" || r.status === "fail"));
    return runs.length ? runs[runs.length - 1 - (n % runs.length)].id : null;
  };
  const cases: Array<{ id: string; surface: string; kind: FixtureBisectKind; ageMin: number }> = [
    { id: "b-settle-1003", surface: "settle", kind: "running", ageMin: 18 },
    { id: "b-anchor-brief-1003", surface: "anchor-brief", kind: "stalled", ageMin: 50 },
    { id: "b-settle-0927", surface: "settle", kind: "culprit", ageMin: 60 * 26 },
    { id: "b-call-summary-0929", surface: "call-summary", kind: "range", ageMin: 60 * 24 * 4 },
    { id: "b-handoff-0930", surface: "handoff", kind: "drift", ageMin: 60 * 24 * 3 },
    { id: "b-title-1002", surface: "title", kind: "crashed", ageMin: 60 * 30 },
  ];
  for (const c of cases) {
    // An unsure range needs two commits that render alike, which the fixture's Tier 1 folds only among four or more.
    const pair = narrowedPair(st, c.surface, c.kind === "range" ? 5 : 3);
    if (!pair) continue;
    const plan = bisectPlan(st, { surface: c.surface, good: pair.good.name, bad: pair.bad.name });
    const b = fixtureBisect(c.kind, plan, { id: c.id, now: clock, ageMin: c.ageMin, runIdOf });
    st.bisects.push(b.state);
    if (c.kind === "running") st.running.add(c.id);
    st.stepsByBisect.set(c.id, b.steps);
    st.tailByBisect.set(c.id, b.logTail);
  }
}

/**
 * A bisect as a page sees it. The world's clock is the start of the day, but
 * a page weighs a bisect's last write against the real clock, so the running
 * one is shown as having written within the last half minute: otherwise every
 * page would flag it "stalled?" a few minutes into the day.
 */
const liveBisect = (st: FixtureState, b: BisectState): BisectState => (st.running.has(b.id) ? { ...b, updatedAt: iso(Math.max(Date.parse(b.updatedAt), Date.now() - 30_000)) } : b);

const bisectSummary = (b: BisectState): BisectSummary => ({
  id: b.id,
  surface: b.surface,
  good: b.range.good,
  bad: b.range.bad,
  status: b.status,
  outcome: b.answer?.kind ?? null,
  culprit: b.answer?.kind === "culprit" ? b.answer.commit.sha : null,
  spentUsd: b.spentUsd,
  budgetUsd: b.budgetUsd,
  startedAt: b.startedAt,
  updatedAt: b.updatedAt,
  finishedAt: b.finishedAt,
});

// ── Multiplayer sim ─────────────────────────────────────────────────────────

const SIM_SCENARIOS = ["agentPingPong", "daemonRestartParked", "memberRemovedMidTurn", "personalAnchorOwnedByTeammate", "queuedSendVsLaggingTail", "reapVsFollowerLock", "resumeVsSend", "roleTriggerScope", "twoHumansOneRole", "viewerHideVsOwner", "visibilityFlip"];
const SIM_SELFTESTS = ["dsl", "invariants", "realm", "window", "world"];
const SIM_INVARIANTS: Array<[string, string]> = [
  ["INV-sessions-mine", "the window's mine digest, tally and placements equal the principal's canonical projection"],
  ["INV-followers", "every follower holds the host's replicated slice byte for byte"],
  ["INV-team-inbox", "the team slot holds exactly the server's team list for the viewer, minus the viewer's own hides"],
  ["INV-workspace-rows", "the window holds no task, doc, plan or project its principal cannot read, and each one it feeds matches the server in its workspace"],
  ["INV-sweep", "the team scope sweep finds no work item whose stored workspace key disagrees with its computed one"],
  ["INV-cursors", "each held sync-log scope's cursor stands at its head, and no unheld scope has a cursor"],
  ["INV-pending-locks", "no acknowledged lock survives its cursor, and no field lock outlives the settle window"],
  ["INV-outbox", "every window's engine outbox is empty once the world settles"],
  ["INV-triggers", "the trigger replica equals agentTasks:webList, and each conversation's armed kind matches its live triggers"],
  ["INV-pending-sends", "every send bubble is echoed, settled or failed, and each client_id is on at most one pending_messages row"],
  ["INV-chat", "the chat replica equals chat:listMessages, each mention wakes its target once, and the hourly wake caps hold"],
  ["INV-roles", "each role's mention wake counter equals the wakes enqueued for it, and listAnchors equals visibleAnchorsForUser"],
  ["INV-ping-pong", "agent to agent wakes per virtual hour stay under the mention caps, per sender, per person and per target"],
  ["INV-row-shape", "every sessions row holds only the inbox row's fields (INBOX_ROW_FIELDS plus the facts), or a field a pending local write holds"],
  ["INV-fixpoint", "re-running every mounted feeder, one catch-up and a byIds pass over every held id changes nothing"],
];

const failureInvariant = (r: SimRunResponse) => (r.result.passed === true ? "" : r.result.invariant.id);

function buildSim(now: number): FixtureState["sim"] {
  const rand = makeRng(7);
  const invariants: SimInvariant[] = SIM_INVARIANTS.map(([id, meaning]) => ({ id, meaning, keys: [] }));
  const head = fixtureHex("commit:19:suggest: voice from recent sends");
  const sessions: SimSessionSummary[] = [];
  const runs = new Map<string, SimRunResponse>();
  const allRows: Array<{ session: string; at: number; row: SimRunRow }> = [];
  for (let i = 0; i < 9; i++) {
    const at = now - (8 - i) * DAY * 0.9 - 3_600_000;
    const id = stampOf(at);
    const rows: SimRunRow[] = [];
    for (const scenario of SIM_SCENARIOS) {
      for (const mode of ["scripted", "interleave"] as const) {
        const seeds = mode === "interleave" ? 4 : 1;
        for (let seed = 1; seed <= seeds; seed++) {
          const fails = scenario === "memberRemovedMidTurn" && mode === "interleave" && seed === 3 && i >= 6;
          const row: SimRunRow = { scenario, mode, seed, passed: !fails, deliveries: 20 + Math.floor(rand() * 40), ms: 300 + Math.floor(rand() * 900), ...(fails ? { dir: `${scenario}-${mode}-${seed}` } : {}) };
          rows.push(row);
          allRows.push({ session: id, at, row });
        }
      }
    }
    const failed = rows.filter((r) => !r.passed).length;
    const failing = rows.filter((r) => !r.passed).map(({ scenario, mode, seed, dir }) => ({ scenario, mode, seed, ...(dir ? { dir } : {}) }));
    sessions.push({ id, argv: i === 8 ? ["memberRemovedMidTurn", "--sweep", "4"] : [], gitHead: head, dirty: i >= 7, treePatch: i >= 7 ? fixtureHex(`simpatch:${id}`, 64) : null, startedAt: iso(at), finishedAt: iso(at + 95_000), exit: failed ? 1 : 0, runs: rows.length, failed, scenarios: SIM_SCENARIOS.length, failing });
  }
  sessions.push({ id: "codecast-sim-legacy-1", argv: [], gitHead: null, dirty: false, treePatch: null, startedAt: iso(now - 12 * DAY), finishedAt: null, exit: null, unsessioned: true, runs: 1, failed: 1, scenarios: 1, failing: [{ scenario: "memberRemovedMidTurn", mode: "interleave", seed: 1 }] });

  // Every failing run is the same story (__fixtures__/sim.ts); the newest one has been shrunk.
  const failing = allRows.filter((r) => !r.row.passed);
  failing.forEach(({ session, row }, k) => {
    const run = simFixtureRun({ session: sessions.find((s) => s.id === session)!, run: row, gitHead: head, shrunk: k === failing.length - 1 });
    row.deliveries = run.run.deliveries;
    runs.set(`${session}/${row.dir}`, run);
  });

  const scenarios: SimScenario[] = [
    ...SIM_SCENARIOS.map((name) => ({ name, file: `scenarios/${name}.scenario.ts`, selftest: false, modes: ["scripted", "interleave"], red: name === "roleTriggerScope" ? [{ task: "ct-55120", invariant: "INV-triggers", modes: ["interleave"], seeds: null }] : [], known: name === "visibilityFlip" ? [{ invariant: "INV-sweep", tasks: ["ct-54902"] }] : [] })),
    ...SIM_SELFTESTS.map((name) => ({ name, file: `selftests/${name}.selftest.ts`, selftest: true, modes: ["scripted"], red: [], known: [] })),
  ];
  const catalog: SimCatalogResponse = {
    gitHead: head,
    scenarios,
    invariants,
    notCompared: [
      { key: "conversations", reason: "the message page's meta twin, fed only by a conversation page the sim does not open" },
      { key: "capabilityBindings", reason: "fed by useSyncCapabilityState, a bespoke hook the sim does not mount" },
      { key: "buckets", reason: "fed by useSyncBuckets, a bespoke hook the sim does not mount" },
      { key: "chatReads", reason: "per-viewer read marks fed by useChatSync, which the sim does not mount" },
      { key: "chatRail", reason: "a client fold over chat rows, derived at read time" },
    ],
    // The child's own fold over the same history (store/__tests__/sim/grid.ts).
    ...simGridOf(
      scenarios,
      [...sessions].reverse().filter((s) => !s.unsessioned).map((session) => ({ session, runs: allRows.filter((r) => r.session === session.id).map((r) => r.row) })),
      (session, dir) => {
        const run = runs.get(`${session}/${dir}`);
        return run ? failureInvariant(run) || null : null;
      },
    ),
  };
  return { catalog, sessions: sessions.reverse(), runs };
}

// ── The routes ──────────────────────────────────────────────────────────────

function overview(st: FixtureState, cadence: string): OverviewResponse {
  const from = st.now - 30 * DAY;
  const keep = (b: Batch) => b.at >= from && !b.dry && (cadence === "all" || (cadence === "named" ? b.cadence === null : b.cadence === cadence));
  const surfaces: SurfaceOverview[] = st.defs.map((def) => {
    const list = (st.batches.get(def.id) ?? []).filter(keep);
    const last = list[list.length - 1];
    const rows = rowsOf(st, def.id);
    const fz = [...st.freezes.values()].filter((f) => f.surface === def.id);
    return {
      id: def.id,
      title: def.title,
      route: def.route,
      model: def.model,
      freezes: { public: fz.filter((f) => f.visibility === "public").length, private: fz.filter((f) => f.visibility === "private").length },
      strip: list.map((b) => batchStats(st, b)),
      dots: list.flatMap((b) => rowsIn(st, b).map((r) => ({ batch: b.name, at: r.stamp, score: r.score, status: r.status }))),
      latest: last ? verdict(st, last) : null,
      staleness: def.staleness,
      spend7dUsd: round(sum(rows.filter((r) => Date.parse(r.stamp) >= st.now - 7 * DAY).map((r) => r.costUsd + r.judgeCostUsd)), 2),
      epochs: epochsOf(st, def.id),
      footing: footingMarkers(st, def.id),
      landing: !!last?.landing,
    };
  });
  const moved: MovedEvent[] = [];
  for (const def of st.defs) {
    for (const e of epochsOf(st, def.id).slice(1)) moved.push({ at: e.firstBatchAt, surface: def.id, kind: "epoch", epoch: e.n, batch: e.firstBatch, changedFreezes: e.changedFreezes.length });
    for (const m of footingMarkers(st, def.id)) moved.push({ at: m.batchAt, surface: def.id, kind: "footing", batch: m.batch, change: m.kind, from: m.from, to: m.to });
    const list = gradedBatches(st, def.id);
    for (let i = Math.max(1, list.length - 4); i < list.length; i++) {
      const v = verdict(st, list[i]);
      const broke = v.flips.filter((f) => f.direction === "broke").length;
      const fixed = v.flips.length - broke;
      if (v.flips.length) moved.push({ at: iso(list[i].at), surface: def.id, kind: "flips", batch: list[i].name, broke, fixed });
    }
  }
  for (const b of st.bisects) if (b.finishedAt) moved.push({ at: b.finishedAt, surface: b.surface, kind: "bisect", id: b.id, outcome: b.answer?.kind ?? null });
  const lastFail = [...st.sim.runs.values()].pop();
  if (lastFail) moved.push({ at: lastFail.session.startedAt, surface: null, kind: "sim-failure", session: lastFail.session.id, run: lastFail.run.dir ?? "", scenario: lastFail.run.scenario, invariant: lastFail.invariant?.id ?? "" });
  const spend = new Map<string, { usd: number; judgeUsd: number }>();
  for (const r of st.rows) {
    if (Date.parse(r.stamp) < from) continue;
    const day = r.stamp.slice(0, 10);
    const s = spend.get(day) ?? { usd: 0, judgeUsd: 0 };
    s.usd += r.costUsd;
    s.judgeUsd += r.judgeCostUsd;
    spend.set(day, s);
  }
  return {
    cadence,
    surfaces,
    moved: moved.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12),
    spendByDay: [...spend].sort(([a], [b]) => a.localeCompare(b)).map(([day, s]) => ({ day, usd: round(s.usd, 2), judgeUsd: round(s.judgeUsd, 2) })),
    bisects: st.bisects.map((b) => bisectSummary(liveBisect(st, b))),
    // The newest session by when it began: the list puts the read-only legacy folder first.
    sim: [...st.sim.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null,
  };
}

function surfaceResponse(st: FixtureState, id: string, q: Record<string, string>): SurfaceResponse {
  const def = surfaceDef(st, id);
  const from = q.from ? Date.parse(q.from) : -Infinity;
  const to = q.to ? Date.parse(q.to) : Infinity;
  const list = (st.batches.get(id) ?? []).filter(
    (b) => b.at >= from && b.at <= to && (q.dry === "1" || !b.dry) && (!q.model || b.model === q.model) && (!q.cadence || q.cadence === "all" || (q.cadence === "named" ? b.cadence === null : b.cadence === q.cadence)),
  );
  const names = new Set(list.map((b) => b.name));
  const fz = [...st.freezes.values()].filter((f) => f.surface === id);
  const lo = list[0]?.at ?? st.now;
  const hi = list[list.length - 1]?.at ?? st.now;
  const word = id.split("-")[0];
  return {
    surface: { id, title: def.title, route: def.route, model: def.model, criteria: def.criteria, freezes: { public: fz.filter((f) => f.visibility === "public").length, private: fz.filter((f) => f.visibility === "private").length }, sources: def.sources, reps: { check: def.seeds, smoke: 1 }, maxUsdPerRep: def.route === "agent" ? 0.8 : 0.02 },
    runs: rowsOf(st, id).filter((r) => r.batch && names.has(r.batch)),
    batches: list.map((b) => batchStats(st, b)),
    epochs: epochsOf(st, id),
    footing: footingMarkers(st, id),
    ledger: ledger(st, id, list.filter((b) => !b.dry)),
    commits: st.commits.filter((c) => Date.parse(c.at) >= lo - DAY && Date.parse(c.at) <= hi && (c.subject.startsWith(word) || c.subject.startsWith("evals"))),
    latest: (() => {
      const last = list.filter((b) => !b.dry).at(-1);
      return last ? verdict(st, last) : null;
    })(),
  };
}

function freezeResponse(st: FixtureState, id: string): FreezeResponse {
  const f = st.freezes.get(id);
  if (!f) throw new EvalsFixtureMiss(`no freeze ${id}`);
  const def = surfaceDef(st, f.surface);
  const moment = momentOf(st, id);
  return {
    freeze: { id, name: f.name, surface: f.surface, visibility: f.visibility, createdAt: iso(st.now - 30 * DAY), asOf: moment[moment.length - 2]?.at ?? iso(st.now), anchor: { kind: "message", id: moment[moment.length - 2]?.id ?? "m1" }, subject: { kind: "session", id: SESSIONS[f.index % SESSIONS.length], title: f.name.replace(/-/g, " ") }, trigger: null, notes: null, judge: def.criteria, tags: [f.visibility], freezeSha: fixtureHex(`freeze:${id}`, 64) },
    label: { verdict: f.index % 3 === 0 ? "waiting" : "done", why: "The last assistant line asks the human to choose." },
    labelSource: f.visibility === "public" ? "inline" : "labels",
    moment,
    cutAt: moment.length - 1,
    production: { messages: [{ n: 99, id: "prod", at: iso(st.now - 30 * DAY), channel: "session", isGroup: false, direction: "system", from: def.id, text: '{"state":"waiting"}' }], verdict: { score: 0.9, pass: true, reasoning: "Production called it waiting, which matches the label." } },
    runs: rowsOf(st, f.surface).filter((r) => r.freezeId === id),
    epochs: epochsOf(st, f.surface),
  };
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Each file of a run folder as the file route serves it. */
function runFileTexts(r: RunResponse): Map<string, string> {
  const map: Record<string, unknown> = {
    "run.json": r.run,
    "result.json": r.result,
    "score.json": r.score,
    "sends.json": r.sends,
    "call1/system.md": r.calls[0]?.system,
    "call1/prompt.md": r.calls[0]?.prompt,
    "call1/reply.md": r.calls[0]?.reply,
    "agent1/prompt.md": r.agents[0]?.prompt,
    "agent1/then2.md": r.agents[0]?.then[0],
    "agent1/stream.jsonl": r.agents[0]?.turns.flat().map((t) => JSON.stringify(t)).join("\n"),
    "calls.log": r.guard.map((g) => `${g.argv}\n# ${g.status}`).join("\n"),
    "run.log": r.logTail,
  };
  const out = new Map<string, string>();
  for (const [path, v] of Object.entries(map)) if (v !== undefined && v !== null) out.set(path, typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return out;
}

function runFile(st: FixtureState, row: RunRow, path: string): RunFileResponse {
  const text = runFileTexts(runResponse(st, row)).get(path);
  if (text === undefined) throw new EvalsFixtureMiss(`no file ${path} in ${row.id}`);
  return { path, size: byteLength(text), text, truncated: false };
}

function compare(st: FixtureState, a: RunRow, b: RunRow): CompareResponse {
  const diff: RunDiffEntry[] = [];
  for (const g of new Set([...a.gatesFailed, ...b.gatesFailed])) diff.push({ kind: "gate", id: g, before: !a.gatesFailed.includes(g), after: !b.gatesFailed.includes(g) });
  for (const id of Object.keys({ ...a.checks, ...b.checks })) {
    const x = a.checks[id] ?? 0;
    const y = b.checks[id] ?? 0;
    if (Math.abs(x - y) >= 0.2) diff.push({ kind: "check", id, before: x, after: y });
  }
  return { a, b, diff, replies: { a: replyOf(a), b: replyOf(b) }, prompts: a.freezeId === b.freezeId ? promptPair(st, a, b) : [] };
}

function batches(st: FixtureState, surface: string, an: string, bn: string): BatchesResponse {
  const a = batchOf(st, surface, an);
  const b = batchOf(st, surface, bn);
  const flips = flipsBetween(st, a, b);
  const gates = new Set([...rowsIn(st, a), ...rowsIn(st, b)].flatMap((r) => r.gatesFailed));
  const first = flips.ok ? flips.flips[0] : undefined;
  const ra = first ? st.byId.get(first.before[0]) : undefined;
  const rb = first ? st.byId.get(first.after[0]) : undefined;
  return {
    verdict: verdict(st, b, a),
    flips,
    gateDeltas: [...gates].map((id) => ({ id, a: rowsIn(st, a).filter((r) => r.gatesFailed.includes(id)).length, b: rowsIn(st, b).filter((r) => r.gatesFailed.includes(id)).length })),
    examples: flips.ok ? examplesOf(st, flips.flips) : [],
    promptDiffs: ra && rb ? promptPair(st, ra, rb) : [],
  };
}

function epoch(st: FixtureState, surface: string, n: number): EpochResponse {
  const all = epochsOf(st, surface);
  const e = all.find((x) => x.n === n);
  if (!e) throw new EvalsFixtureMiss(`no epoch ${n} on ${surface}`);
  const prev = all.find((x) => x.n === n - 1) ?? null;
  const diffs: PromptFilePair[] = [];
  if (prev) {
    const lastBefore = batchOf(st, surface, prev.lastBatch);
    const firstAfter = batchOf(st, surface, e.firstBatch);
    for (const fid of e.changedFreezes) {
      const a = rowsIn(st, lastBefore).find((r) => r.freezeId === fid);
      const b = rowsIn(st, firstAfter).find((r) => r.freezeId === fid);
      if (a && b) diffs.push(...promptPair(st, a, b));
    }
  }
  const lo = prev ? Date.parse(prev.firstBatchAt) : 0;
  const hi = Date.parse(e.firstBatchAt);
  return { epoch: e, previous: prev, diffs, commits: st.commits.filter((c) => Date.parse(c.at) > lo && Date.parse(c.at) <= hi) };
}

function commit(st: FixtureState, sha: string, whole: boolean): CommitResponse {
  const c = st.commits.find((x) => x.sha.startsWith(sha));
  if (!c) throw new EvalsFixtureMiss(`no commit ${sha}`);
  const i = st.commits.indexOf(c);
  const file = c.subject.startsWith("settle") ? "packages/convex/convex/lib/settlePrompt.ts" : "packages/web/components/Inbox.tsx";
  const diff = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -12,6 +12,7 @@ export const RULES = [\n   "Read the last assistant turn first.",\n-  "If the human was asked anything, the session is waiting.",\n+  "If the human was asked anything, the session is waiting, whatever else is true.",\n+  "A finished fix with tests passing is done. Prefer done when work is verified.",\n   "Answer in JSON only.",\n ];\n`;
  return {
    commit: c,
    parents: i > 0 ? [st.commits[i - 1].sha] : [],
    body: `${c.subject}\n\nCodecast-Session: ${c.session}`,
    whole,
    files: whole ? [{ path: file, status: "M", additions: 2, deletions: 1 }, { path: "packages/web/components/InboxRow.tsx", status: "M", additions: 14, deletions: 9 }] : [{ path: file, status: "M", additions: 2, deletions: 1 }],
    diff,
  };
}

/** A kept tree patch: the edits a dirty rep ran on top of its head (any treePatch a row names). */
function patch(st: FixtureState, sha: string): PatchResponse {
  // A Multiplayer sim session's kept edits: the store code its runs read.
  if (st.sim.sessions.some((x) => x.treePatch === sha)) {
    const file = "packages/web/store/inboxStore.ts";
    const diff = `diff --git a/${file} b/${file}\nindex 51a0c3e..e77d902 100644\n--- a/${file}\n+++ b/${file}\n@@ -812,6 +812,7 @@ export const hideConversation = action((draft, id: string) => {\n   const row = draft.sessions[id];\n   if (!row) return;\n+  if (row.team_id && !draft.teamMembers[row.team_id]) return;\n   draft.inboxHides[id] = { at: Date.now() };\n });\n`;
    return { sha, files: [{ path: file, additions: 1, deletions: 0 }], diff, truncated: false };
  }
  const row = st.rows.find((r) => r.treePatch === sha);
  if (!row) throw new EvalsFixtureMiss(`no patch ${sha.slice(0, 12)}`);
  const file = `packages/convex/convex/lib/${row.surface.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Prompt.ts`;
  const diff = `diff --git a/${file} b/${file}\nindex 3f1c2aa..9be04d1 100644\n--- a/${file}\n+++ b/${file}\n@@ -20,7 +20,8 @@ export const RULES = [\n   "Read the last assistant turn first.",\n-  "Answer in JSON only.",\n+  "Answer in JSON only, with no prose around it.",\n+  "When unsure between two states, pick the one the human must act on.",\n   "Never guess a state the transcript does not show.",\n ];\n`;
  return { sha, files: [{ path: file, additions: 2, deletions: 1 }], diff, truncated: false };
}

function runRowOf(st: FixtureState, id: string): RunRow {
  const row = st.byId.get(id);
  if (!row) throw new EvalsFixtureMiss(`no run ${id}`);
  return row;
}

export interface EvalsFixtureWorld {
  readonly now: number;
  /** Every run in the world, oldest batch first. */
  readonly rows: readonly RunRow[];
  /** The answer to one route, as the api child would give it; throws EvalsFixtureMiss for an unknown id. */
  answer(key: EvalsRouteKey, params: Record<string, string>, query: Record<string, string>, body?: unknown): unknown;
}

/** The default world clock: the start of this UTC day. A test that rebuilds the transport's world uses it to name the same runs. */
export const fixtureWorldNow = (at = Date.now()) => Math.floor(at / DAY) * DAY;

/**
 * A world with its clock at `now`. The default is the start of this UTC day:
 * recent enough that the 30-day windows stay current, and still for a whole
 * day, so batch names, run ids and sim session ids (all built from the clock)
 * keep naming the same things while a page or a pinned link is open.
 */
export function evalsFixtureWorld(opts: { now?: number; seed?: number } = {}): EvalsFixtureWorld {
  const now = opts.now ?? fixtureWorldNow();
  const st = build(now, opts.seed ?? 42);
  let cursor = 100;
  const answer = (key: EvalsRouteKey, p: Record<string, string>, q: Record<string, string>, body?: unknown): unknown => {
    switch (key) {
      case "GET /health":
        return { root: "/Users/you/src/codecast", evalsHome: "~/.local/share/codecast/evals", gitHead: st.commits[st.commits.length - 1].sha, runsIndexed: st.rows.length, index: { state: "warm", done: st.rows.length, total: st.rows.length }, pid: 48213, startedAt: iso(now - 600_000) };
      case "GET /overview":
        return overview(st, q.cadence || "all");
      case "GET /surface/:id":
        return surfaceResponse(st, p.id, q);
      case "GET /freeze/:id":
        return freezeResponse(st, p.id);
      case "GET /run/:id":
        return runResponse(st, runRowOf(st, p.id));
      case "GET /run/:id/file":
        return runFile(st, runRowOf(st, p.id), q.path ?? "");
      case "GET /compare":
        return compare(st, runRowOf(st, q.a), runRowOf(st, q.b));
      case "GET /batches":
        return batches(st, q.surface, q.a, q.b);
      case "GET /epoch":
        return epoch(st, q.surface, Number(q.n));
      case "GET /attribution":
        return attribution(st, q.surface, q.good, q.bad, q.allCommits === "1");
      case "GET /commit/:sha":
        return commit(st, p.sha, q.whole === "1");
      case "GET /patch/:sha":
        return patch(st, p.sha);
      case "GET /changes":
        cursor = Math.max(cursor, Number(q.since) || 0) + 1;
        return { cursor, runs: [], bisects: st.bisects.filter((b) => !b.finishedAt).map((b) => bisectSummary(liveBisect(st, b))), jobs: [] };
      case "POST /bisect/plan":
        return bisectPlan(st, body as BisectPlanRequest);
      case "POST /bisect":
        return { id: st.bisects[0].id, tmux: st.bisects[0].tmux };
      case "GET /bisects":
        return { bisects: st.bisects.map((b) => bisectSummary(liveBisect(st, b))), running: [...st.running][0] ?? null };
      case "GET /bisect/:id": {
        const found = st.bisects.find((b) => b.id === p.id);
        if (!found) throw new EvalsFixtureMiss(`no bisect ${p.id}`);
        const state = liveBisect(st, found);
        const since = Number(q.since) || 0;
        const steps = (st.stepsByBisect.get(p.id) ?? []).filter((s) => s.seq > since);
        const stalled = !state.finishedAt && Math.max(now, Date.now()) - Date.parse(state.updatedAt) > 5 * 60_000;
        const resp: BisectResponse = { state, steps, cursor: Math.max(since, ...steps.map((s) => s.seq)), logTail: st.tailByBisect.get(p.id) ?? [], stalled };
        return resp;
      }
      case "POST /bisect/:id/stop":
        return { id: p.id, stopping: true };
      case "GET /sim/catalog":
        return st.sim.catalog;
      case "GET /sim/sessions":
        return { sessions: st.sim.sessions };
      case "GET /sim/run/:session/:run": {
        const r = st.sim.runs.get(`${p.session}/${p.run}`);
        if (!r) throw new EvalsFixtureMiss(`no sim run ${p.session}/${p.run}`);
        return r;
      }
      case "POST /sim/shrink":
      case "POST /sim/sweep":
        return { job: `job-${key.endsWith("shrink") ? "shrink" : "sweep"}-1` };
    }
  };
  return { now, rows: st.rows, answer };
}
