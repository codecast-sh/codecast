// The judge route's two tools (docs/architecture/learning-loop.md LL11): a
// problem that gathers cases against a judge is fixed in an edited copy of
// the product's .codecast (the judge's prompt or the extractor of its
// moment), measured against what is published now on the very moments the
// cases were ruled on, and brought to the project's reviewer as one card.
//
//   cast line judges arm --task <ct-N> --dir <dir>
//     The cases (each finding the judge got wrong, its moment, the expectation
//     it named and what a correct judgment does) into <dir>/cases.json, and an
//     edited copy at <dir>/arm: .codecast/judges and .codecast/moments copied,
//     every other top-level entry of the checkout linked, so an extractor's
//     relative reads resolve as they do in the checkout.
//   cast line judges ab --task <ct-N> --dir <dir> [--reps 5] [--controls 10] [--budget 8] --change "<sentence>"
//     Judges each ruled moment and each control (a live finding of the same
//     judge) on both sides, reps times, on the team's budget; a changed
//     extractor re-extracts both sides from the product's own data. Writes
//     the card (<dir>/judge-fix.json, shared/contracts/judgeFix.ts) and exits
//     0 only when the ruled cases separate and the controls do not get worse.
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { scopeFor } from "./signalCommand.js";
import { JUDGES_DIR, MOMENTS_DIR, fileVersion, runExtractor, shadowDir } from "./momentsHost.js";
import { callModel, momentForTry, repoRoot } from "./judgingCommand.js";
import { judgeRequest, narrowBrief, parseJudgeReply, parseJudgeSpec, type ExpectationsBrief, type JudgeSpec } from "@codecast/shared/contracts/judges";
import { parseExtractorHeader, type MomentRecord } from "@codecast/shared/contracts/moments";
import { isJudgeCaseKey, type CaseTarget } from "@codecast/shared/contracts/judgeReview";
import { judgeFixGroup, judgeFixVerdict, validateJudgeFixCard, type JudgeFixCard, type JudgeFixCase } from "@codecast/shared/contracts/judgeFix";

function fail(message: string, code = 2): never {
  console.error(fmt.error(message));
  process.exit(code);
}

/** One ruled case as the route reads it. */
export type RuledCase = {
  case: string;
  finding: string;
  judge: string;
  moment: string;
  expectation: string;
  against: CaseTarget;
  said: string;
  correct: string;
  fact?: string;
  why?: string;
};

export type CasesFile = {
  task: string;
  title: string;
  project_id: string;
  judges: string[];
  /** The parts the cases name, each with its file in the checkout. */
  parts: Array<{ against: CaseTarget; name: string; file: string }>;
  cases: RuledCase[];
  root: string;
  arm: string;
};

const against = (key: string, answer?: string): CaseTarget =>
  key.startsWith("extractor:") ? "extractor" : key.startsWith("judge-input:") ? "input" : key.startsWith("judge:") ? "judge" : answer === "missing" ? "extractor" : "judge";

/** The files a case's part lives in: the judge's prompt, or the extractor of the moment's kind. */
function partFile(c: { against: CaseTarget; judge: string }, kindOf: (judge: string) => string | null): { name: string; file: string } | null {
  if (c.against === "judge") return { name: `the ${c.judge} judge's prompt`, file: `${JUDGES_DIR}/${c.judge}.md` };
  const kind = kindOf(c.judge);
  return kind ? { name: `the ${kind} extractor`, file: `${MOMENTS_DIR}/${kind}.ts` } : null;
}

/** The lines removed from `a` and added in `b`, in order (a line diff good enough for a card). */
export function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const A = a.split("\n");
  const B = b.split("\n");
  const inB = new Map<string, number>();
  for (const l of B) inB.set(l, (inB.get(l) ?? 0) + 1);
  const inA = new Map<string, number>();
  for (const l of A) inA.set(l, (inA.get(l) ?? 0) + 1);
  const take = (lines: string[], other: Map<string, number>) => {
    const left = new Map(other);
    return lines.filter((l) => {
      const n = left.get(l) ?? 0;
      if (n > 0) { left.set(l, n - 1); return false; }
      return l.trim().length > 0;
    });
  };
  return { removed: take(A, inB), added: take(B, inA) };
}

/** Every file under `rel` in both roots that differs, as path relative to the root. */
function changedFiles(root: string, arm: string, rel: string): string[] {
  const out: string[] = [];
  const walk = (r: string) => {
    const dir = path.join(arm, r);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(r, name);
      if (fs.statSync(path.join(arm, p)).isDirectory()) { walk(p); continue; }
      const base = path.join(root, p);
      if (!fs.existsSync(base) || fs.readFileSync(base, "utf8") !== fs.readFileSync(path.join(arm, p), "utf8")) out.push(p);
    }
  };
  walk(rel);
  return out.sort();
}

/** The cases a judge-route problem holds, each with the finding it rules on. */
async function readCases(deps: PublishDeps, task: string): Promise<{ title: string; project_id: string; cases: RuledCase[] }> {
  const ls = await apiPost(deps, "/cli/signal/ls", { task, limit: 200 }, { read: true });
  const rows: any[] = (ls.signals ?? []).filter((s: any) => !s.retired);
  if (!rows.length) fail(`${task} holds no live findings`);
  if (!rows.every((s: any) => isJudgeCaseKey(s.fingerprint ?? ""))) fail(`${task} is not a judge-route problem: its findings are not cases against a judge`);
  const cases: RuledCase[] = [];
  // A split's own record names no ruled finding; the cases are the rest.
  for (const s of rows.filter((r: any) => r.case_of)) {
    const shown = await apiPost(deps, "/cli/signal/show", { signal: s.case_of }, { read: true });
    const f = shown.signal ?? shown;
    const review = f.judge_review ?? {};
    cases.push({
      case: s.short_id,
      finding: f.short_id,
      judge: f.judge ?? s.judge,
      moment: f.moment ?? s.moment,
      expectation: f.subject,
      against: review.against ?? against(s.fingerprint, review.answer),
      said: String(f.title ?? "").slice(0, 400),
      correct: String(review.sentence ?? review.note ?? "").slice(0, 600),
      ...(review.fact ? { fact: String(review.fact).slice(0, 600) } : {}),
      ...(review.why ? { why: String(review.why).slice(0, 800) } : {}),
    });
  }
  return { title: rows[0].task_title ?? task, project_id: rows[0].project_id, cases: cases.filter((c) => c.moment && c.expectation) };
}

/** The edited copy: .codecast's judges and moments copied, the rest of the checkout linked in place. */
export function layOutArm(root: string, arm: string): void {
  fs.mkdirSync(path.join(arm, ".codecast"), { recursive: true });
  for (const dir of [JUDGES_DIR, MOMENTS_DIR]) {
    const from = path.join(root, dir);
    if (fs.existsSync(from) && !fs.existsSync(path.join(arm, dir))) fs.cpSync(from, path.join(arm, dir), { recursive: true });
  }
  for (const name of fs.readdirSync(root)) {
    if (name === ".codecast" || name === ".git") continue;
    const link = path.join(arm, name);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(root, name), link);
  }
}

type MomentShown = { moment: any; body: any };

async function showMoment(deps: PublishDeps, scope: Record<string, unknown>, ref: string): Promise<MomentShown> {
  const shown = await apiPost(deps, "/cli/moments/show", { ...scope, moment: ref }, { read: true });
  let body: any = shown.moment.kept ? await apiPost(deps, "/cli/moments/body", { ...scope, moment: ref }, { read: true }) : null;
  const local = path.join(shadowDir(), String(shown.moment.source ?? "").replace(/[^A-Za-z0-9_-]/g, "_"), `${shown.moment.short_id}.json`);
  if (!body && fs.existsSync(local)) body = JSON.parse(fs.readFileSync(local, "utf8")).output;
  return { moment: shown.moment, body };
}

/** The moment as one side's extractor sees it now: the kept body, or a fresh extraction from that side's root. */
async function momentOn(side: { root: string; fresh: boolean }, m: MomentShown, spec: JudgeSpec): Promise<MomentRecord | { error: string }> {
  let raw: unknown = m.body;
  if (side.fresh) {
    const rel = `${MOMENTS_DIR}/${m.moment.kind}.ts`;
    const file = path.join(side.root, rel);
    const header = parseExtractorHeader(fs.readFileSync(file, "utf8"));
    const input = { kind: m.moment.kind, subject: m.moment.subject, at: m.moment.event_at, refs: m.moment.refs ?? {}, events: m.moment.events ?? 1, moment: m.moment.short_id, ...(m.body?.window ? { window: m.body.window } : {}) };
    const out = await runExtractor({ moment: m.moment.short_id, source: String(m.moment.source ?? ""), input, extractor: { path: rel, root: side.root, version: await fileVersion(file), timeout_ms: header.timeout_ms }, storage: "host" });
    if (out.error) return { error: out.error };
    raw = JSON.parse(out.output!);
  }
  if (!raw) return { error: "the moment's body is not kept anywhere this machine can read" };
  return momentForTry(raw, spec, m.moment.subject, Date.now());
}

export function registerJudgeFixCommands(judges: Command, deps: PublishDeps): void {
  judges
    .command("arm")
    .description("Lay out a judge-route problem's fix: its cases, and an edited copy of this checkout's .codecast to change")
    .requiredOption("--task <ct>", "The problem whose findings are cases against a judge")
    .option("--dir <dir>", "Where the cases and the edited copy go")
    .option("--under <dir>", "Or a new directory for this run under this one, named for the problem and the time")
    .action(async (options: { task: string; dir?: string; under?: string }) => {
      const root = await repoRoot(process.env.CODECAST_CWD || process.cwd());
      if (!options.dir && !options.under) fail("Give --dir, or --under for a new directory");
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const dir = path.resolve(options.dir ?? path.join(options.under!, `${options.task}-${stamp}`));
      fs.mkdirSync(dir, { recursive: true });
      const arm = path.join(dir, "arm");
      const { title, project_id, cases } = await readCases(deps, options.task);
      if (!cases.length) fail(`${options.task}'s cases name no moment and expectation to measure on`);
      layOutArm(root, arm);
      const kindOf = (judge: string) => {
        const f = path.join(root, JUDGES_DIR, `${judge}.md`);
        const spec = fs.existsSync(f) ? parseJudgeSpec(judge, fs.readFileSync(f, "utf8")) : null;
        return spec && !("error" in spec) ? spec.moment : null;
      };
      const parts = new Map<string, { against: CaseTarget; name: string; file: string }>();
      for (const c of cases) {
        const p = partFile(c, kindOf);
        if (p) parts.set(p.file, { against: c.against, ...p });
      }
      const out: CasesFile = { task: options.task, title, project_id, judges: [...new Set(cases.map((c) => c.judge))], parts: [...parts.values()], cases, root, arm };
      fs.writeFileSync(path.join(dir, "cases.json"), JSON.stringify(out, null, 2) + "\n");
      console.log(JSON.stringify({ dir, arm, cases: path.join(dir, "cases.json"), judges: out.judges, parts: out.parts, moments: [...new Set(cases.map((c) => c.moment))] }, null, 2));
    });

  judges
    .command("ab")
    .description("Measure a judge-route fix: the edited copy against what is published, on the ruled moments and on live findings it must keep; writes the reviewer's card")
    .requiredOption("--task <ct>", "The problem the fix is for")
    .requiredOption("--dir <dir>", "The directory `cast line judges arm` laid out")
    .requiredOption("--change <sentence>", "What the edit makes the judge do, one sentence (the card's words)")
    .option("--reps <n>", "Judge runs per moment on each side", (v: string) => parseInt(v, 10), 5)
    .option("--controls <n>", "Live findings of the same judges to keep (distinct moments)", (v: string) => parseInt(v, 10), 10)
    .option("--budget <usd>", "Stop spending past this", (v: string) => Number(v), 8)
    .option("--json", "Machine-readable output")
    .action(async (options: { task: string; dir: string; change: string; reps: number; controls: number; budget: number; json?: boolean }) => {
      const dir = path.resolve(options.dir);
      const file = path.join(dir, "cases.json");
      if (!fs.existsSync(file)) fail(`No ${file}: run cast line judges arm --task ${options.task} --dir ${options.dir} first`);
      const cf: CasesFile = JSON.parse(fs.readFileSync(file, "utf8"));
      // The checkout's line profile names the workspace, wherever in it the station runs.
      process.env.CODECAST_CWD = cf.root;
      const changed = [...changedFiles(cf.root, cf.arm, JUDGES_DIR), ...changedFiles(cf.root, cf.arm, MOMENTS_DIR)];
      if (!changed.length) fail(`Nothing in ${cf.arm}/.codecast differs from the checkout: edit the copy first`);
      const extractorChanged = changed.some((p) => p.startsWith(MOMENTS_DIR));
      const scope = await scopeFor(deps, undefined, false);

      // Each judge on each side, and the expectations it grades against.
      const specs = new Map<string, { base: JudgeSpec; arm: JudgeSpec; briefsBase: ExpectationsBrief[]; briefsArm: ExpectationsBrief[] }>();
      for (const name of cf.judges) {
        const read = (root: string) => {
          const s = parseJudgeSpec(name, fs.readFileSync(path.join(root, JUDGES_DIR, `${name}.md`), "utf8"));
          if ("error" in s) fail(`${root}/${JUDGES_DIR}/${name}.md: ${s.error}`);
          return s;
        };
        const base = read(cf.root);
        const arm = read(cf.arm);
        const briefs = async (spec: JudgeSpec) => {
          const out: ExpectationsBrief[] = [];
          for (const project of spec.projects) {
            const b = await apiPost(deps, "/cli/expectations/brief", await scopeFor(deps, undefined, false, project), { read: true });
            out.push(narrowBrief({ project: b.project.title, version: b.version, text: b.text, ids: b.ids ?? [] }, spec.parts));
          }
          return out;
        };
        specs.set(name, { base, arm, briefsBase: await briefs(base), briefsArm: await briefs(arm) });
      }

      // The ruled moments, and controls: live findings of the same judges, the ruled expectations first.
      const ruled = [...new Map(cf.cases.map((c) => [`${c.moment}|${c.expectation}|${c.judge}`, c])).values()];
      const ruledMoments = new Set(ruled.map((c) => c.moment));
      const ruledExp = new Set(ruled.map((c) => c.expectation));
      const live: any[] = [];
      for (const name of cf.judges) {
        const r = await apiPost(deps, "/cli/signal/ls", { ...scope, source: `judge:${name}`, limit: 400 }, { read: true });
        live.push(...(r.signals ?? []).filter((s: any) => s.project_id === cf.project_id && !s.retired && s.moment && !ruledMoments.has(s.moment)));
      }
      live.sort((a, b) => Number(ruledExp.has(b.subject)) - Number(ruledExp.has(a.subject)) || b.created_at - a.created_at);
      const controls: Array<{ moment: string; expectation: string; judge: string; finding: string }> = [];
      const seen = new Set<string>();
      for (const s of live) {
        if (controls.length >= options.controls || seen.has(s.moment)) continue;
        seen.add(s.moment);
        controls.push({ moment: s.moment, expectation: s.subject, judge: s.judge, finding: s.short_id });
      }

      // Both sides of every moment, reps times; the base side is cached by what it ran.
      const cachePath = path.join(dir, "ab-base.jsonl");
      const cache = new Map<string, string[]>();
      if (fs.existsSync(cachePath)) for (const l of fs.readFileSync(cachePath, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); cache.set(r.key, r.found); }
      const versions = Object.fromEntries(await Promise.all([...changed, ...cf.judges.map((j) => `${JUDGES_DIR}/${j}.md`)].map(async (p) => [p, fs.existsSync(path.join(cf.root, p)) ? (await fileVersion(path.join(cf.root, p))).slice(0, 10) : "none"])));
      const baseStamp = JSON.stringify(versions);
      let spent = 0;
      let model = "";
      const shown = new Map<string, MomentShown>();
      const records = new Map<string, MomentRecord | { error: string }>();
      const jobs: Array<{ side: "base" | "arm"; moment: string; judge: string; rep: number }> = [];
      const units = [...ruled.map((c) => ({ moment: c.moment, judge: c.judge })), ...controls.map((c) => ({ moment: c.moment, judge: c.judge }))];
      for (const u of new Map(units.map((u) => [`${u.moment}|${u.judge}`, u])).values()) {
        for (let rep = 0; rep < options.reps; rep++) for (const side of ["base", "arm"] as const) jobs.push({ side, moment: u.moment, judge: u.judge, rep });
      }
      const found = new Map<string, string[] | null>();
      const key = (j: { side: string; moment: string; judge: string; rep: number }) => `${j.side}|${j.moment}|${j.judge}|${j.rep}`;
      let stopped: string | null = null;
      const run = async (j: (typeof jobs)[number]) => {
        const baseKey = `${baseStamp}|${j.moment}|${j.judge}|${j.rep}`;
        if (j.side === "base" && cache.has(baseKey)) return found.set(key(j), cache.get(baseKey)!);
        if (spent >= options.budget) { stopped = `stopped at $${spent.toFixed(2)}, the --budget`; return found.set(key(j), null); }
        const s = specs.get(j.judge)!;
        const spec = j.side === "base" ? s.base : s.arm;
        const recKey = `${j.side}|${j.moment}|${j.judge}`;
        if (!records.has(recKey)) {
          if (!shown.has(j.moment)) shown.set(j.moment, await showMoment(deps, scope, j.moment));
          records.set(recKey, await momentOn({ root: j.side === "base" ? cf.root : cf.arm, fresh: extractorChanged }, shown.get(j.moment)!, spec));
        }
        const record = records.get(recKey)!;
        if ("error" in record) return found.set(key(j), null);
        const briefs = j.side === "base" ? s.briefsBase : s.briefsArm;
        const request = judgeRequest(spec, briefs, record, Math.min(Date.now(), record.at ?? Date.now()));
        model = request.model;
        const result = await callModel(deps, scope, request, `Judge A/B ${j.judge} ${options.task}`);
        spent += result.cost_usd;
        if (!result.ok) { if (result.reason === "budget") stopped = "the team's model budget is full"; return found.set(key(j), null); }
        const parsed = parseJudgeReply(result.text, briefs.flatMap((b) => b.ids));
        const exps = parsed ? parsed.findings.map((f) => f.expectation) : null;
        found.set(key(j), exps);
        if (exps && j.side === "base") fs.appendFileSync(cachePath, JSON.stringify({ key: baseKey, found: exps }) + "\n");
      };
      const queue = [...jobs];
      await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length && !stopped) await run(queue.shift()!); }));

      // Rates: a run of a ruled moment counts when it still names the ruled expectation; a control's, when it finds its own again.
      const count = (moment: string, judge: string, exp: string, side: "base" | "arm") => {
        let runs = 0, hits = 0;
        for (let rep = 0; rep < options.reps; rep++) {
          const f = found.get(key({ side, moment, judge, rep }));
          if (!f) continue;
          runs++;
          if (f.includes(exp)) hits++;
        }
        return { runs, hits };
      };
      const tally = (rows: Array<{ moment: string; judge: string; expectation: string }>) => {
        let runs = 0, base = 0, arm = 0;
        for (const r of rows) {
          const b = count(r.moment, r.judge, r.expectation, "base");
          const a = count(r.moment, r.judge, r.expectation, "arm");
          const n = Math.min(a.runs, b.runs);
          runs += n;
          base += Math.min(b.hits, n);
          arm += Math.min(a.hits, n);
        }
        return { runs, base, arm };
      };
      const r = tally(ruled);
      const k = tally(controls);
      const ruledG = judgeFixGroup(ruled.length, r.runs, r.base, r.arm, "fewer");
      const controlsG = judgeFixGroup(controls.length, k.runs, k.base, k.arm, "more");
      const verdict = judgeFixVerdict(ruledG, controlsG);
      const cases: JudgeFixCase[] = ruled.slice(0, 6).map((c) => {
        const b = count(c.moment, c.judge, c.expectation, "base");
        const a = count(c.moment, c.judge, c.expectation, "arm");
        return { finding: c.finding, moment: c.moment, expectation: c.expectation, said: c.said, correct: c.correct, base: b.hits, arm: a.hits, reps: Math.min(a.runs, b.runs) };
      });
      const diff = changed.map((p) => ({ file: p, ...lineDiff(fs.existsSync(path.join(cf.root, p)) ? fs.readFileSync(path.join(cf.root, p), "utf8") : "", fs.readFileSync(path.join(cf.arm, p), "utf8")) }));
      const editedPart = cf.parts.find((p) => changed.includes(p.file)) ?? { against: (extractorChanged ? "extractor" : "judge") as CaseTarget, name: changed[0], file: changed[0] };
      const card: JudgeFixCard = {
        kind: "judge_fix",
        problem: cf.task,
        question: `Publish this change to ${editedPart.name}?`,
        change: options.change.trim(),
        part: editedPart,
        diff,
        ab: { reps: options.reps, model, cost_usd: Math.round(spent * 100) / 100, ruled: ruledG, controls: controlsG, verdict },
        cases,
      };
      const checked = validateJudgeFixCard(card);
      if (!checked.ok) fail(`The card is not ready:\n  ${checked.errors.join("\n  ")}`);
      fs.writeFileSync(path.join(dir, "judge-fix.json"), JSON.stringify(card, null, 2) + "\n");
      const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
      if (options.json) console.log(JSON.stringify({ card: path.join(dir, "judge-fix.json"), question: card.question, verdict, ruled: ruledG, controls: controlsG, cost_usd: card.ab.cost_usd, ...(stopped ? { stopped } : {}) }, null, 2));
      else {
        console.log(`${cf.task}: ${verdict.replace("_", " ")}  ($${card.ab.cost_usd.toFixed(2)}, ${options.reps} reps, ${model})`);
        console.log(`  ruled     ${ruledG.moments} moments: still found ${ruledG.base}/${ruledG.runs} (${pct(ruledG.base, ruledG.runs)}) -> ${ruledG.arm}/${ruledG.runs} (${pct(ruledG.arm, ruledG.runs)})${ruledG.p !== null ? `  p=${ruledG.p.toFixed(4)}` : ""}`);
        console.log(`  controls  ${controlsG.moments} moments: found ${controlsG.base}/${controlsG.runs} (${pct(controlsG.base, controlsG.runs)}) -> ${controlsG.arm}/${controlsG.runs} (${pct(controlsG.arm, controlsG.runs)})`);
        for (const c of cases) console.log(`    ${c.moment} ${c.expectation}: ${c.base}/${c.reps} -> ${c.arm}/${c.reps}`);
        if (stopped) console.log(fmt.warning(`  ${stopped}`));
        console.log(`  card: ${path.join(dir, "judge-fix.json")}`);
      }
      process.exit(verdict === "better" ? 0 : 1);
    });
}
