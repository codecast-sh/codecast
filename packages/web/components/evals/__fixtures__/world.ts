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
//
// The world is split by what it answers: world/model.ts (the cast and the views
// derived from its rows), world/runText.ts, world/attribution.ts and
// world/multiplayer.ts; this file builds the state and answers the routes.

import { type BatchesResponse, type BisectPlanRequest, type BisectResponse, type CommitRef, type CommitResponse, type CompareResponse, type EpochResponse, type EvalsRouteKey, type FreezeResponse, type MovedEvent, type OverviewResponse, type PatchResponse, type PromptFilePair, type RunDiffEntry, type RunFileResponse, type RunRow, type RunRowStatus, type SurfaceOverview, type SurfaceResponse, searchRows } from "@codecast/shared/contracts/evalsApi";
import { makeRng } from "@codecast/shared/random";
import { sessionTrailerValue } from "@codecast/shared/blame";
import { type Batch, DAY, EvalsFixtureMiss, type FixtureState, JUDGE_MODEL, PASS_MARK, RECENT_SUBJECTS, SESSIONS, SUBJECTS, SURFACE_DEFS, batchOf, batchStats, clamp01, epochsOf, fixtureHex, flipsBetween, footingMarkers, gradedBatches, iso, ledger, round, rowsIn, rowsOf, stampOf, sum, surfaceDef, uuid, verdict } from "./world/model";
import { byteLength, examplesOf, momentOf, promptPair, replyOf, runFileTexts, runResponse } from "./world/runText";
import { attribution, bisectPlan, bisectSummary, buildBisects, liveBisect } from "./world/attribution";
import { buildSim } from "./world/multiplayer";

export { EvalsFixtureMiss, fixtureHex, fixtureSeparate } from "./world/model";

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
        return attribution(st, q.surface, q.good || undefined, q.bad || undefined, q.allCommits === "1", q.freeze || undefined);
      case "GET /commit/:sha":
        return commit(st, p.sha, q.whole === "1");
      case "GET /patch/:sha":
        return patch(st, p.sha);
      case "GET /changes":
        cursor = Math.max(cursor, Number(q.since) || 0) + 1;
        return { cursor, runs: [], bisects: st.bisects.filter((b) => !b.finishedAt).map((b) => bisectSummary(liveBisect(st, b))), jobs: [] };
      case "GET /search":
        return searchRows(st.rows, q.q ?? "");
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
