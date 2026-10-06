// Part of the fixture world (../world.ts), which every caller imports. The
// world as the shared handler reads a product (@platform/evals/query
// EvalsSources), field for field as packages/evals/src/api/sources.ts hands
// over codecast's real homes: the rows, the registry, the freezes, the run
// folders, git, the bisects and the sim. Every verdict, flip, epoch, ledger
// and attribution a page shows is then the engine's own. Nothing here is real data.

import type { BisectResponse, BisectState, BisectSummary, FreezeResponse, HealthResponse, RunDiffEntry, RunRow, SimFailureMoved } from "@codecast/shared/contracts/evalsApi";
import type { EvalsSources } from "@platform/evals/query";
import { fixtureGit } from "./git";
import { DAY, type FixtureState, SESSIONS, type SurfaceDef, fixtureHex, iso } from "./model";
import { flipExamples, momentOf, promptReader, replyOf, runDetail } from "./runText";

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

function bisectResponse(st: FixtureState, id: string, since: number): BisectResponse | null {
  const found = st.bisects.find((b) => b.id === id);
  if (!found) return null;
  const state = liveBisect(st, found);
  const steps = (st.stepsByBisect.get(id) ?? []).filter((s) => s.seq > since);
  const stalled = !state.finishedAt && Math.max(st.now, Date.now()) - Date.parse(state.updatedAt) > 5 * 60_000;
  return { state, steps, cursor: Math.max(since, ...steps.map((s) => s.seq)), logTail: st.tailByBisect.get(id) ?? [], stalled };
}

/** One freeze's page, by its id or the 8-character prefix an address carries. */
function freezePage(st: FixtureState, ref: string, rows: RunRow[]): Omit<FreezeResponse, "epochs"> | null {
  const f = st.freezes.get(ref) ?? [...st.freezes.values()].find((x) => x.id.startsWith(ref));
  if (!f) return null;
  const def = st.defs.find((d) => d.id === f.surface)!;
  const moment = momentOf(st, f.id);
  // One verdict, and every line about it says the same thing.
  const verdict = f.index % 3 === 0 ? "waiting" : "done";
  const why = verdict === "waiting" ? "The last assistant line asks the human to choose." : "The last assistant line reports the fix verified, with nothing left to ask.";
  return {
    freeze: { id: f.id, name: f.name, surface: f.surface, visibility: f.visibility, createdAt: iso(st.now - 30 * DAY), asOf: moment[moment.length - 2]?.at ?? iso(st.now), anchor: { kind: "message", id: moment[moment.length - 2]?.id ?? "m1" }, subject: { kind: "session", id: SESSIONS[f.index % SESSIONS.length], title: f.name.replace(/-/g, " ") }, trigger: null, notes: null, judge: def.criteria, tags: [f.visibility], freezeSha: fixtureHex(`freeze:${f.id}`, 64) },
    label: { verdict, why },
    labelSource: f.visibility === "public" ? "inline" : "labels",
    moment,
    cutAt: moment.length - 1,
    production: { messages: [{ n: 99, id: "prod", at: iso(st.now - 30 * DAY), channel: "session", isGroup: false, direction: "system", from: def.id, text: `{"state":"${verdict}"}` }], verdict: { score: 0.9, pass: true, reasoning: `Production called it ${verdict}, which matches the label.` } },
    runs: rows.filter((r) => r.freezeId === f.id),
  };
}

/** Two reps' scores weighed: each gate either failed, and each check whose score moved by a fifth or more. */
function runPair(a: RunRow, b: RunRow) {
  const diff: RunDiffEntry[] = [];
  for (const g of new Set([...a.gatesFailed, ...b.gatesFailed])) diff.push({ kind: "gate", id: g, before: !a.gatesFailed.includes(g), after: !b.gatesFailed.includes(g) });
  for (const id of Object.keys({ ...a.checks, ...b.checks })) {
    const x = a.checks[id] ?? 0;
    const y = b.checks[id] ?? 0;
    if (Math.abs(x - y) >= 0.2) diff.push({ kind: "check", id, before: x, after: y });
  }
  return { diff, replies: { a: replyOf(a), b: replyOf(b) } };
}

/** The sim's newest failure as a What moved line, and its newest session, as api/views.ts simOverview reads the sim home. */
function simOverview(st: FixtureState): { moved: SimFailureMoved[]; fields: { sim: FixtureState["sim"]["sessions"][number] | null } } {
  const lastFail = [...st.sim.runs.values()].pop();
  return {
    moved: lastFail ? [{ at: lastFail.session.startedAt, surface: null, kind: "sim-failure", session: lastFail.session.id, run: lastFail.run.dir ?? "", scenario: lastFail.run.scenario, invariant: lastFail.invariant?.id ?? "" }] : [],
    // The newest session by when it began: the list puts the read-only legacy folder first.
    fields: { sim: [...st.sim.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null },
  };
}

export function fixtureSources(st: FixtureState) {
  const prompts = promptReader(st);
  const freezesOf = (surface: string) => [...st.freezes.values()].filter((f) => f.surface === surface);
  return {
    health: (): HealthResponse => ({ root: "/Users/you/src/codecast", evalsHome: "~/.local/share/codecast/evals", gitHead: st.commits[st.commits.length - 1].sha, runsIndexed: st.rows.length, index: { state: "warm", done: st.rows.length, total: st.rows.length }, pid: 48213, startedAt: iso(st.now - 600_000) }),
    rows: async () => st.rows,
    surfaces: () => st.defs,
    info: (def) => ({ criteria: def.criteria, sources: def.sources, reps: { check: def.seeds, smoke: 1 }, maxUsdPerRep: def.route === "agent" ? 0.8 : 0.02 }),
    prompts,
    freezes: {
      counts: async () => (surface) => {
        const pub = freezesOf(surface).filter((f) => f.visibility === "public").length;
        return { public: pub, private: freezesOf(surface).length - pub };
      },
      get: async (id, rows) => freezePage(st, id, rows),
    },
    staleness: async () => (id) => st.defs.find((d) => d.id === id)?.staleness ?? "fresh",
    run: async (row) => runDetail(st, row),
    pair: (a, b) => runPair(st.byId.get(a)!, st.byId.get(b)!),
    flipExamples: async (surface, freezeIds, a, b) => flipExamples(st, surface, freezeIds, a, b),
    git: fixtureGit(st),
    bisects: {
      summaries: () => st.bisects.map((b) => bisectSummary(liveBisect(st, b))),
      running: () => [...st.running][0] ?? null,
      get: (id, since) => bisectResponse(st, id, since),
    },
    changes: { sig: (r) => String(r.scoreVersions), extra: () => ({ jobs: [] }) },
    overview: () => simOverview(st),
  } satisfies EvalsSources<RunRow, SurfaceDef, SimFailureMoved>;
}

export type FixtureSources = ReturnType<typeof fixtureSources>;
