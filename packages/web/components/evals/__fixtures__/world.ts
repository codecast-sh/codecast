// A whole fake EVALS_HOME for the Evals pages in dev (lib/evals/fixtureTransport.ts)
// and their tests. Deterministic from a seed and a clock, and it answers every
// route in the contract with values of the contract's own types, so a page
// built against it works unchanged against the api child.
//
// It carries the stories the views exist for: settle regressing at a prompt
// epoch with freezes breaking (its records pin the commit for free),
// insight moving model, title's judge ruler moving, role-wake reading live
// workspace state, ask's freeze being re-captured, handoff improving, a
// bisect running and one finished, and a Multiplayer sim failure that shrank.
//
// Nothing here is real data: names, shas, sessions and replies are invented.
//
// The world holds records, not answers. Its rows, freezes, prompt files, git,
// bisects and sim are handed to the shared handler (@platform/evals/query) as
// codecast's api child hands over its real homes (world/sources.ts), so every
// verdict, flip, epoch, ledger and attribution a page shows is computed by the
// code that computes it in production. A story holds because the records tell
// it, never because an answer was written by hand.
//
// The world is split by what it holds: world/model.ts (the cast and the
// state), world/sources.ts (the state as the handler's sources),
// world/runText.ts, world/git.ts, world/bisects.ts and world/multiplayer.ts;
// this file builds the state and answers codecast's own routes.

import { matchEvalsRoute, searchRows, type BisectPlanRequest, type CommitRef, type EvalsRouteKey, type EvalsRoutes, type PatchResponse, type RunFileResponse, type RunRow, type RunRowStatus } from "@codecast/shared/contracts/evalsApi";
import { makeRng } from "@platform/evals/analysis";
import { evalsCalls, localTransport, type EvalsResponseOf } from "@platform/evals/client";
import type { EvalsBridgeRequest, EvalsBridgeResponse, EvalsViewRouteKey } from "@platform/evals/contract";
import { answer, createEvalsHandler, isViewRoute, need, NotFound, rowById, type AnyRouteHandler, type RouteHandler } from "@platform/evals/query";
import { sessionTrailerValue } from "@codecast/shared/blame";
import { type Batch, DAY, type FixtureState, JUDGE_MODEL, PASS_MARK, RECENT_SUBJECTS, SESSIONS, SUBJECTS, SURFACE_DEFS, clamp01, fixtureHex, fixturePolicy, iso, round, stampOf, uuid } from "./world/model";
import { bisectPlan, buildBisects } from "./world/bisects";
import { buildSim } from "./world/multiplayer";
import { byteLength, runDetail, runFileTexts } from "./world/runText";
import { fixtureSources, type FixtureSources } from "./world/sources";

/** How often, in percent, a batch from before tree patches were kept ran on uncommitted edits. */
const DIRTY_BEFORE_PATCHES = 25;

function build(now: number, seed: number): { st: FixtureState; sources: FixtureSources } {
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
  const promptEpochs = new Map<string, number>();
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
      list.push({ surface: def.id, index: list.length, name: iso(at), at, cadence: def.route === "agent" || day % 3 !== 0 ? null : "nightly", epoch: 1, model: def.model, ruler: `${JUDGE_MODEL}#r2`, gitHead: headAt(at).sha, dry: false });
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
    list.forEach((b, i) => {
      b.index = i;
      b.epoch = 1 + starts.filter((x) => x <= i).length;
      if (def.story === "model-change" && i < 11) b.model = "claude-sonnet-4-5-20250929";
      if (def.story === "judge-change" && i >= 14) b.ruler = `${JUDGE_MODEL}#r3`;
    });
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
          // The newest batch is the one checked against edits in progress. About half the last week ran on edits, each
          // with its patch kept; before patches were kept (older than a week) edits were rarer, and nothing can replay
          // them. Keyed by where the batch sits in its surface's history, never by its name, so the same batches are
          // dirty whatever the day and every story the records tell holds on every clock.
          const recent = now - b.at < 8 * DAY;
          const dirty = b.index === list.length - 1 || parseInt(fixtureHex(`dirty:${def.id}:${b.index}`, 4), 16) % 100 < (recent ? 50 : DIRTY_BEFORE_PATCHES);
          const live = def.story === "live-reads" && rand() < 0.4 ? 1 + Math.floor(rand() * 3) : 0;
          const agent = def.route === "agent";
          const stamp = b.at + s * 41_000 + f.index * 7_000;
          const gitHead = b.gitHead;
          const commit = commits.find((c) => c.sha === gitHead);
          // Every freeze renders anew at the surface's second epoch, and every other one at each epoch after it.
          const promptEpoch = starts.length && f.index % 2 === 0 ? b.epoch : Math.min(b.epoch, 2);
          const promptSha = fixtureHex(`${def.id}:${f.id}:e${promptEpoch}`, 64);
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
          promptEpochs.set(row.id, promptEpoch);
        }
      }
    }
  });

  // title's newest batch is still landing: one more rep has started and is not scored yet. Its stamp is on the real
  // clock, as the wall weighs a landing rep's age against Date.now (and as the bisects below run on it).
  const landing = rows.filter((r) => r.surface === "title" && r.batch === batches.get("title")?.at(-1)?.name).at(-1);
  if (landing) {
    const stamp = Math.max(now, Date.now()) - 5 * 60_000;
    const row: RunRow = { ...landing, id: `title-${landing.freezeId.slice(0, 8)}-seed${landing.seed + 1}-${stampOf(stamp)}`, seed: landing.seed + 1, stamp: iso(stamp), status: "unscored", score: null, passMark: null, gatesFailed: [], checks: {}, missedFloors: [], judgeModel: null, ruler: null, judgeCostUsd: 0, scoreVersions: 0 };
    rows.push(row);
    promptEpochs.set(row.id, promptEpochs.get(landing.id) ?? 1);
  }
  // Newest first, as the run index hands them.
  rows.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : a.id < b.id ? -1 : 1));

  const st: FixtureState = {
    now,
    defs: SURFACE_DEFS,
    freezes,
    batches,
    rows,
    byId: new Map(rows.map((r) => [r.id, r])),
    promptEpochs,
    commits,
    bisects: [],
    running: new Set(),
    stepsByBisect: new Map(),
    tailByBisect: new Map(),
    sim: buildSim(now),
  };
  const sources = fixtureSources(st);
  buildBisects(st, sources);
  return { st, sources };
}

// ── Codecast's own routes ───────────────────────────────────────────────────
// The routes only codecast has, answered from the world as packages/evals/src/api/handlers.ts answers them from the real homes.

/** A kept tree patch: the edits a dirty rep ran on top of its head (any treePatch a row names). */
function patch(st: FixtureState, sha: string): PatchResponse {
  // A Multiplayer sim session's kept edits: the store code its runs read.
  if (st.sim.sessions.some((x) => x.treePatch === sha)) {
    const file = "packages/web/store/inboxStore.ts";
    const diff = `diff --git a/${file} b/${file}\nindex 51a0c3e..e77d902 100644\n--- a/${file}\n+++ b/${file}\n@@ -812,6 +812,7 @@ export const hideConversation = action((draft, id: string) => {\n   const row = draft.sessions[id];\n   if (!row) return;\n+  if (row.team_id && !draft.teamMembers[row.team_id]) return;\n   draft.inboxHides[id] = { at: Date.now() };\n });\n`;
    return { sha, files: [{ path: file, additions: 1, deletions: 0 }], diff, truncated: false };
  }
  const row = st.rows.find((r) => r.treePatch === sha);
  if (!row) throw new NotFound(`no patch ${sha.slice(0, 12)}`);
  const file = `packages/convex/convex/lib/${row.surface.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Prompt.ts`;
  const diff = `diff --git a/${file} b/${file}\nindex 3f1c2aa..9be04d1 100644\n--- a/${file}\n+++ b/${file}\n@@ -20,7 +20,8 @@ export const RULES = [\n   "Read the last assistant turn first.",\n-  "Answer in JSON only.",\n+  "Answer in JSON only, with no prose around it.",\n+  "When unsure between two states, pick the one the human must act on.",\n   "Never guess a state the transcript does not show.",\n ];\n`;
  return { sha, files: [{ path: file, additions: 2, deletions: 1 }], diff, truncated: false };
}

function runFile(st: FixtureState, row: RunRow, path: string): RunFileResponse {
  const text = runFileTexts(runDetail(st, row)).get(path);
  if (text === undefined) throw new NotFound(`no file ${path} in ${row.id}`);
  return { path, size: byteLength(text), text, truncated: false };
}

type OwnRouteKey = Exclude<EvalsRouteKey, EvalsViewRouteKey>;

const ownRoutes = (st: FixtureState, sources: FixtureSources): { [K in OwnRouteKey]: RouteHandler<EvalsRoutes, K> } => ({
  "GET /run/:id/file": ({ params, query }) => runFile(st, rowById(st.rows, params.id), need(query, "path")),
  "GET /patch/:sha": ({ params }) => patch(st, params.sha),
  "GET /search": ({ query }) => searchRows(st.rows, query.q ?? ""),
  "POST /bisect/plan": ({ body }) => bisectPlan(st, sources, body as BisectPlanRequest),
  "POST /bisect": () => ({ id: st.bisects[0].id, tmux: st.bisects[0].tmux }),
  "POST /bisect/:id/stop": ({ params }) => ({ id: params.id, stopping: true }),
  "GET /sim/catalog": () => st.sim.catalog,
  "GET /sim/sessions": () => ({ sessions: st.sim.sessions }),
  "GET /sim/run/:session/:run": ({ params }) => {
    const r = st.sim.runs.get(`${params.session}/${params.run}`);
    if (!r) throw new NotFound(`no sim run ${params.session}/${params.run}`);
    return r;
  },
  "POST /sim/shrink": () => ({ job: "job-shrink-1" }),
  "POST /sim/sweep": () => ({ job: "job-sweep-1" }),
});

const calls = evalsCalls<EvalsRoutes>();

export interface EvalsFixtureWorld {
  readonly now: number;
  /** Every run in the world, newest first. */
  readonly rows: readonly RunRow[];
  /** One bridge request answered as the api child answers it: the shared routes by @platform/evals/query over the world's records, codecast's own from the world. Never throws. */
  handle(req: EvalsBridgeRequest): Promise<EvalsBridgeResponse>;
  /** The answer to one route, as a page's client gets it; a status other than 200 throws the client's EvalsRequestError. */
  answer<K extends EvalsRouteKey>(key: K, params?: Record<string, string>, query?: Record<string, string>, body?: unknown): Promise<EvalsResponseOf<EvalsRoutes, K>>;
}

/** The default world clock: the start of this UTC day. A test that rebuilds the transport's world uses it to name the same runs. */
export const fixtureWorldNow = (at = Date.now()) => Math.floor(at / DAY) * DAY;

/**
 * A world with its clock at `now`. The default is the start of this UTC day:
 * recent enough that the 30-day windows stay current, and still for a whole
 * day, so batch names, run ids and sim session ids (all built from the clock)
 * keep naming the same things while a page or a pinned link is open.
 *
 * The handler weighs the wall on the real clock (its 30-day window, a batch
 * still landing), as it does over real records, so a world held at another
 * instant needs the clock held there too (a test's setSystemTime).
 */
export function evalsFixtureWorld(opts: { now?: number; seed?: number } = {}): EvalsFixtureWorld {
  const now = opts.now ?? fixtureWorldNow();
  const { st, sources } = build(now, opts.seed ?? 42);
  const shared = createEvalsHandler(sources, fixturePolicy);
  const own = ownRoutes(st, sources);
  const handle = async (req: EvalsBridgeRequest): Promise<EvalsBridgeResponse> => {
    const route = matchEvalsRoute(req.method, req.path);
    if (!route || isViewRoute(route.key)) return shared(req);
    return answer(req, route, own[route.key] as AnyRouteHandler);
  };
  const transport = localTransport(handle, "fixture");
  return { now, rows: st.rows, handle, answer: (key, params, query, body) => calls.call(transport, key, { params, query, body } as never) };
}
