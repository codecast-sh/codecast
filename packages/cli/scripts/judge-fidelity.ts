#!/usr/bin/env bun
// Does a judge on a Claude Code subscription answer as it does on the API?
// (src/subscriptionCall.ts). Each moment's judge request is built once, the
// way a judge-fix A/B builds it (judgeRequest over the published judge, the
// expectations as they stood at the moment, the team's rulings it shows), then
// sent `--reps` times to each side: the API through /cli/model/call (on the
// team's model budget, as an A/B is) and the subscription through
// subscriptionModelCall. Run it from the product's checkout, so the judges and
// the line scope resolve there.
//
//   bun packages/cli/scripts/judge-fidelity.ts --out <dir> --reps 3 mo-1 mo-2 ...
//   bun packages/cli/scripts/judge-fidelity.ts --out <dir> --report
//   --side sub|api sends one side only (reuse the other side's runs.jsonl lines);
//   --effort <level> runs the subscription side at that Claude Code effort.
//
// Writes <out>/requests/<moment>.json and <out>/runs.jsonl (one line per call,
// resumable: a rerun sends only what runs.jsonl lacks), and --report prints
// agreement within each side (the noise floor) beside agreement across sides.
import fs from "node:fs";
import path from "node:path";
import { readAuthConfig, defaultConfigDir } from "../src/config/readAuthConfig.ts";
import { apiPost, type PublishDeps } from "../src/castApi.ts";
import { scopeFor } from "../src/lineScope.ts";
import { JUDGES_DIR } from "../src/momentsHost.ts";
import { callModel, repoRoot } from "../src/judgingCommand.ts";
import { momentOn, showMoment } from "../src/judgeFixCommand.ts";
import { subscriptionModelCall } from "../src/subscriptionCall.ts";
import { briefAt, evidenceScopes, judgeRequest, narrowBrief, parseJudgeReply, parseJudgeSpec, rulingsShown, type ExpectationsBrief, type JudgeSpec } from "@codecast/shared/contracts/judges";
import type { ModelCallSpec } from "@codecast/shared/contracts/modelCall";

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const out = path.resolve(opt("out") ?? "");
if (!opt("out")) { console.error("usage: judge-fidelity.ts --out <dir> [--reps N] [--concurrency N] mo-1 mo-2 ... | --report"); process.exit(2); }
const reps = Number(opt("reps") ?? 3);
const concurrency = Number(opt("concurrency") ?? 3);
// --effort runs the subscription side at that Claude Code effort; --side sub sends only that side.
const effort = opt("effort");
const sides = (opt("side") ? [opt("side")] : ["api", "sub"]) as Array<"api" | "sub">;
const moments = argv.filter((a, i) => /^mo-\d+$/.test(a) && !argv[i - 1]?.startsWith("--"));
fs.mkdirSync(path.join(out, "requests"), { recursive: true });
const runsFile = path.join(out, "runs.jsonl");

type Run = { moment: string; judge: string; side: "api" | "sub"; rep: number; ok: boolean; error?: string; findings?: Array<{ expectation: string; severity: number; quote: string }>; uncited?: number; usage?: unknown; cost_usd?: number; notional_usd?: number; thought?: boolean; ms: number };
const readRuns = (): Run[] => (fs.existsSync(runsFile) ? fs.readFileSync(runsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

if (argv.includes("--report")) {
  report(readRuns());
  process.exit(0);
}

const config = readAuthConfig(defaultConfigDir());
if (!config?.auth_token || !config.convex_url) { console.error("Not authenticated: cast auth"); process.exit(1); }
const deps: PublishDeps = { getCliEndpoint: () => ({ siteUrl: config.convex_url!.replace(".cloud", ".site"), apiToken: config.auth_token! }), detectCurrentSessionId: () => null } as PublishDeps;

const root = await repoRoot(process.cwd());
const specs = new Map<string, JudgeSpec>();
for (const f of fs.readdirSync(path.join(root, JUDGES_DIR)).filter((f) => f.endsWith(".md"))) {
  const s = parseJudgeSpec(path.basename(f, ".md"), fs.readFileSync(path.join(root, JUDGES_DIR, f), "utf8"));
  if (!("error" in s)) specs.set(s.name, s);
}
const briefsOf = new Map<string, Promise<ExpectationsBrief[]>>();
const briefsFor = (spec: JudgeSpec) => {
  if (!briefsOf.has(spec.name)) briefsOf.set(spec.name, (async () => {
    const briefs: ExpectationsBrief[] = [];
    for (const project of spec.projects) {
      const b = await apiPost(deps, "/cli/expectations/brief", await scopeFor(deps, undefined, false, project), { read: true });
      briefs.push(narrowBrief({ project: b.project.title, version: b.version, text: b.text, ids: b.ids ?? [], ...(b.since ? { since: b.since } : {}) }, spec.parts));
    }
    return briefs;
  })());
  return briefsOf.get(spec.name)!;
};

const scope = await scopeFor(deps, undefined, false);
const { project: _p, ...workspaceScope } = scope as Record<string, unknown>;
type Job = { moment: string; judge: string; side: "api" | "sub"; rep: number; request: ModelCallSpec; ids: string[] };
const jobs: Job[] = [];
const done = new Set(readRuns().filter((r) => r.ok).map((r) => `${r.moment}|${r.judge}|${r.side}|${r.rep}`));
for (const ref of moments) {
  const shown = await showMoment(deps, scope, ref);
  for (const spec of [...specs.values()].filter((s) => s.moment === shown.moment.kind)) {
    const record = await momentOn({ root, fresh: false }, shown, spec);
    if ("error" in record) { console.error(`${ref} ${spec.name}: ${record.error}`); continue; }
    const briefs = (await briefsFor(spec)).map((b) => briefAt(b, record.at ?? record.event_at));
    const all = await apiPost(deps, "/cli/moments/rulings", { ...workspaceScope, scopes: evidenceScopes(record) }, { read: true }).catch(() => []);
    // The clock is the moment's own time, so every rep of both sides reads the same request.
    const request = judgeRequest(spec, briefs, record, record.at ?? record.event_at, rulingsShown(record, all ?? []));
    fs.writeFileSync(path.join(out, "requests", `${ref}.${spec.name}.json`), JSON.stringify(request, null, 1));
    const ids = briefs.flatMap((b) => b.ids);
    for (let rep = 0; rep < reps; rep++) for (const side of sides) if (!done.has(`${ref}|${spec.name}|${side}|${rep}`)) jobs.push({ moment: ref, judge: spec.name, side, rep, request, ids });
  }
}
console.log(`${jobs.length} calls to send (${jobs.filter((j) => j.side === "sub").length} on the subscription)`);

async function send(j: Job): Promise<void> {
  const started = Date.now();
  const r = j.side === "api" ? await callModel(deps, scope, j.request, `Judge fidelity ${j.judge}`) : await subscriptionModelCall(j.request, effort ? { effort } : {});
  const parsed = r.ok ? parseJudgeReply(r.text, j.ids) : null;
  const run: Run = {
    moment: j.moment, judge: j.judge, side: j.side, rep: j.rep, ok: !!parsed, ms: Date.now() - started,
    ...(r.ok ? {} : { error: r.error }),
    ...(r.ok && !parsed ? { error: "the answer held no deviations list" } : {}),
    ...(parsed ? { findings: parsed.findings.map((f) => ({ expectation: f.expectation, severity: f.severity, quote: f.quote })), uncited: parsed.uncited } : {}),
    ...(r.ok ? { usage: r.usage } : {}),
    cost_usd: r.cost_usd,
    ...("notional_usd" in r ? { notional_usd: (r as any).notional_usd, thought: (r as any).thought } : {}),
  };
  fs.appendFileSync(runsFile, JSON.stringify(run) + "\n");
  console.log(`${j.moment} ${j.judge} ${j.side}#${j.rep}: ${run.ok ? `${run.findings!.length} findings` : `failed (${run.error})`} ${Math.round(run.ms / 1000)}s`);
}
// The two sides draw from separate pools, so a slow side never holds the other back.
const pool = async (queue: Job[], n: number) => Promise.all(Array.from({ length: n }, async () => { while (queue.length) await send(queue.shift()!); }));
await Promise.all([pool(jobs.filter((j) => j.side === "api"), concurrency + 1), pool(jobs.filter((j) => j.side === "sub"), concurrency)]);
report(readRuns());

function report(all: Run[]) {
  // The last ok run of each (moment, judge, side, rep).
  const byKey = new Map<string, Run>();
  for (const r of all) if (r.ok) byKey.set(`${r.moment}|${r.judge}|${r.side}|${r.rep}`, r);
  const runs = [...byKey.values()];
  const units = [...new Set(runs.map((r) => `${r.moment}|${r.judge}`))];
  const ids = (r: Run) => new Set(r.findings!.map((f) => f.expectation));
  const jaccard = (a: Set<string>, b: Set<string>) => { const u = new Set([...a, ...b]); if (!u.size) return 1; return [...a].filter((x) => b.has(x)).length / u.size; };
  const same = (a: Set<string>, b: Set<string>) => (a.size === b.size && [...a].every((x) => b.has(x)) ? 1 : 0);
  const sevOf = (r: Run) => { const m = new Map<string, number>(); for (const f of r.findings!) m.set(f.expectation, Math.max(m.get(f.expectation) ?? 0, f.severity)); return m; };
  type Acc = { pairs: number; jac: number; exact: number; anyAgree: number; sevPairs: number; sevDiff: number };
  const acc = (): Acc => ({ pairs: 0, jac: 0, exact: 0, anyAgree: 0, sevPairs: 0, sevDiff: 0 });
  const groups: Record<string, Record<string, Acc>> = {};
  const add = (judge: string, kind: string, a: Run, b: Run) => {
    for (const g of [judge, "all"]) {
      const x = ((groups[g] ??= {})[kind] ??= acc());
      const A = ids(a), B = ids(b);
      x.pairs++; x.jac += jaccard(A, B); x.exact += same(A, B); x.anyAgree += (A.size > 0) === (B.size > 0) ? 1 : 0;
      const sa = sevOf(a), sb = sevOf(b);
      for (const [k, v] of sa) if (sb.has(k)) { x.sevPairs++; x.sevDiff += Math.abs(v - sb.get(k)!); }
    }
  };
  const per: Record<string, { api: number[]; sub: number[] }> = {};
  for (const u of units) {
    const [moment, judge] = u.split("|");
    const api = runs.filter((r) => r.moment === moment && r.judge === judge && r.side === "api");
    const sub = runs.filter((r) => r.moment === moment && r.judge === judge && r.side === "sub");
    for (let i = 0; i < api.length; i++) for (let j = i + 1; j < api.length; j++) add(judge!, "api-api", api[i]!, api[j]!);
    for (let i = 0; i < sub.length; i++) for (let j = i + 1; j < sub.length; j++) add(judge!, "sub-sub", sub[i]!, sub[j]!);
    for (const a of api) for (const s of sub) add(judge!, "api-sub", a, s);
    for (const g of [judge!, "all"]) { (per[g] ??= { api: [], sub: [] }).api.push(...api.map((r) => r.findings!.length)); per[g]!.sub.push(...sub.map((r) => r.findings!.length)); }
  }
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
  const mean = (xs: number[]) => (xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2) : "-");
  const fails = all.filter((r) => !r.ok);
  console.log(`\n${units.length} moment-judge units, ${runs.filter((r) => r.side === "api").length} API runs, ${runs.filter((r) => r.side === "sub").length} subscription runs ok; ${fails.length} failed calls (${fails.filter((r) => r.side === "sub").length} subscription)`);
  console.log("judge   pair      pairs  mean-jaccard  same-set  any-vs-none  sev|diff| (n)");
  for (const [g, kinds] of Object.entries(groups)) for (const k of ["api-api", "sub-sub", "api-sub"]) {
    const x = kinds[k]; if (!x) continue;
    console.log(`${g.padEnd(7)} ${k.padEnd(9)} ${String(x.pairs).padStart(5)}  ${(x.jac / x.pairs).toFixed(3).padStart(12)}  ${pct(x.exact, x.pairs).padStart(8)}  ${pct(x.anyAgree, x.pairs).padStart(11)}  ${(x.sevPairs ? (x.sevDiff / x.sevPairs).toFixed(2) : "-").padStart(9)} (${x.sevPairs})`);
  }
  console.log("\nfindings per run (mean): " + Object.entries(per).map(([g, v]) => `${g} api ${mean(v.api)} / sub ${mean(v.sub)}`).join(", "));
  const sub = runs.filter((r) => r.side === "sub");
  console.log(`subscription runs that thought: ${sub.filter((r) => r.thought).length}/${sub.length}; API spend $${all.filter((r) => r.side === "api").reduce((s, r) => s + (r.cost_usd ?? 0), 0).toFixed(2)}; subscription notional $${sub.reduce((s, r) => s + (r.notional_usd ?? 0), 0).toFixed(2)}`);
}
