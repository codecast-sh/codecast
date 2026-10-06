// Part of the fixture world (../world.ts), which every caller imports. The
// world's model: its deterministic helpers, the cast of surfaces and batches,
// and the state the sources (./sources.ts) read. What the pages show of it
// (stats, flips, verdicts, epochs, the ledger, attribution) is computed by
// @platform/evals/query, as it is over real records. Nothing here is real data.

import type { BisectState, BisectStep, CommitRef, EvalRoute, RunRow, SimCatalogResponse, SimRunResponse, SimSessionSummary, StalenessWord } from "@codecast/shared/contracts/evalsApi";
import { makeVerdict, statusPassRule } from "@platform/evals/analysis";
import { NotFound, type HandlerPolicy } from "@platform/evals/query";

export const DAY = 86_400_000;
export const PASS_MARK = 0.7;
const CALL_MODEL = "claude-haiku-4-5-20251001";
const STRONG_MODEL = "claude-sonnet-5-5";
const OPUS_MODEL = "claude-opus-5-5";
export const JUDGE_MODEL = "claude-sonnet-5-5";

/** The world's verdict policy, which is codecast's: a rep passes by its status at the pass mark, and is judged on the ruler its row names. */
export const fixturePolicy: HandlerPolicy = { passed: statusPassRule(PASS_MARK), ruler: (r) => r.ruler ?? null };
/** The engine's verdict bound to that policy, for what the world works out while it is built (which batches a bisect starts on). */
export const fixtureVerdict = makeVerdict(fixturePolicy);

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

// ── The cast ────────────────────────────────────────────────────────────────

type Story = "regression" | "model-change" | "judge-change" | "live-reads" | "freeze-recapture" | "improving" | "steady";

export interface SurfaceDef {
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
  "call summary: quote the owner in each item",
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
}

export interface FixtureState {
  now: number;
  defs: SurfaceDef[];
  freezes: Map<string, { id: string; name: string; surface: string; visibility: "public" | "private"; base: number; index: number }>;
  batches: Map<string, Batch[]>;
  /** Every rep, newest first, as the run index hands them. The same array for the world's whole life: the handler keeps its answers per array. */
  rows: RunRow[];
  byId: Map<string, RunRow>;
  /** Which of its surface's prompt epochs each rep rendered: what its promptSha hashes and its prompt files say. */
  promptEpochs: Map<string, number>;
  /** Oldest first, one line of history: the off-main commit sits where its main-line twin does. */
  commits: CommitRef[];
  bisects: BisectState[];
  /** The bisects playing a run in progress: they read as writing now, whatever the world's clock (see liveBisect). */
  running: Set<string>;
  stepsByBisect: Map<string, BisectStep[]>;
  tailByBisect: Map<string, string[]>;
  sim: { catalog: SimCatalogResponse; sessions: SimSessionSummary[]; runs: Map<string, SimRunResponse> };
}

export const rowsIn = (st: FixtureState, batch: Batch) => st.rows.filter((r) => r.surface === batch.surface && r.batch === batch.name);
export const sameFooting = (a: Batch, b: Batch) => a.model === b.model && a.ruler === b.ruler;

export function surfaceDef(st: FixtureState, id: string): SurfaceDef {
  const def = st.defs.find((d) => d.id === id);
  if (!def) throw new NotFound(`no surface ${id}`);
  return def;
}

/** The live batches a bisect is started on: dry renders graded nothing. */
export const gradedBatches = (st: FixtureState, surface: string) => (st.batches.get(surface) ?? []).filter((b) => !b.dry);
