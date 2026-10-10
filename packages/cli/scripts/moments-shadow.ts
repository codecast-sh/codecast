#!/usr/bin/env bun
// A judge's shadow run on this machine (docs/architecture/learning-loop.md
// LL4 "Set up judging", LL5 phase 2): run a product's extractor on a list of
// events and its judge on each moment, the way codecast would once they are
// published, and keep everything here. Nothing reaches codecast's server,
// nothing is filed, and moment bodies stay under the host's moments-shadow
// directory (LL7), so a product can prove a judge on real conversations
// before a person decides where those may be stored.
//
// Each step is codecast's own: runExtractor and keepOnHost (momentsHost.ts),
// parseExtractorOutput, judgeRequest and parseJudgeReply (shared/contracts),
// and the request body prod posts (convex lib/anthropic.ts, thinking off on
// the cheap model), billed to the evals' API key, never ANTHROPIC_API_KEY.
//
//   bun packages/cli/scripts/moments-shadow.ts --root <product checkout> --judge <name> \
//     --team <team> --source <name> --events <events.jsonl> --out <runs.jsonl> [--budget 8] [--concurrency 6]
//     [--model <id>] [--max-tokens <n>]
//
// An events line is { subject, at?, refs? }; a line already in --out is skipped,
// so a stopped run resumes where it was.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { keepOnHost, runExtractor, fileVersion, JUDGES_DIR, MOMENTS_DIR, type MomentClaim } from "../src/momentsHost";
import { parseExtractorHeader, parseExtractorOutput, type MomentRecord } from "@codecast/shared/contracts/moments";
import { judgeRequest, parseJudgeReply, parseJudgeSpec, type ExpectationsBrief } from "@codecast/shared/contracts/judges";
import { modelCost, postMessages, replyText } from "../../convex/convex/lib/anthropic";
import { evalsApiKey } from "../../evals/src/adapters/apiCall";

const { values: a } = parseArgs({
  options: {
    root: { type: "string" },
    judge: { type: "string" },
    team: { type: "string" },
    source: { type: "string" },
    events: { type: "string" },
    out: { type: "string" },
    budget: { type: "string", default: "8" },
    concurrency: { type: "string", default: "6" },
    model: { type: "string" },
    "max-tokens": { type: "string" },
  },
});
for (const k of ["root", "judge", "team", "source", "events", "out"] as const) if (!a[k]) throw new Error(`--${k} is required`);
const root = path.resolve(a.root!);
const budget = Number(a.budget);
const apiKey = evalsApiKey();
if (!apiKey) throw new Error("No evals API key (keychain codecast-evals-anthropic-key or CODECAST_EVALS_ANTHROPIC_KEY)");

const judgeFile = path.join(root, JUDGES_DIR, `${a.judge}.md`);
const parsedSpec = parseJudgeSpec(a.judge!, fs.readFileSync(judgeFile, "utf8"));
if ("error" in parsedSpec) throw new Error(parsedSpec.error);
// --model and --max-tokens try the same judge on another model without editing its file.
const spec = { ...parsedSpec, ...(a.model ? { model: a.model } : {}), ...(a["max-tokens"] ? { max_tokens: Number(a["max-tokens"]) } : {}) };
const extractorRel = `${MOMENTS_DIR}/${spec.moment}.ts`;
const header = parseExtractorHeader(fs.readFileSync(path.join(root, extractorRel), "utf8"));
const [judgeVersion, extractorVersion] = await Promise.all([fileVersion(judgeFile), fileVersion(path.join(root, extractorRel))]);

/** Each project's active expectations at their current version, read the way the judge reads them. */
function brief(project: string): ExpectationsBrief {
  const cast = (args: string[]) => {
    const r = spawnSync("cast", ["expectations", "show", ...args, "--project", project, "--team", a.team!, "--json"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`cast expectations show ${project}: ${r.stderr.trim()}`);
    return JSON.parse(r.stdout);
  };
  const full = cast([]);
  const short = cast(["--brief"]);
  const ids = (full.doc?.items ?? []).filter((i: any) => i.status === "active").map((i: any) => i.id as string);
  return { project, version: short.version, text: short.text, ids };
}
const briefs = spec.projects.map(brief);
const ids = briefs.flatMap((b) => b.ids);

const done = new Set(
  fs.existsSync(a.out!) ? fs.readFileSync(a.out!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).subject as string) : [],
);
const events = fs.readFileSync(a.events!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !done.has(e.subject));
let spent = fs.existsSync(a.out!) ? fs.readFileSync(a.out!, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (JSON.parse(l).cost_usd ?? 0), 0) : 0;
console.error(`${spec.name} ${judgeVersion.slice(0, 10)} (${spec.model}) on ${spec.moment} ${extractorVersion.slice(0, 10)}: ${events.length} to run, $${spent.toFixed(3)} spent of $${budget}`);

const RETRY = new Set([429, 500, 502, 503, 504, 529]);

async function one(e: { subject: string; at?: number; refs?: Record<string, string> }, n: number) {
  const eventAt = e.at ?? Date.now();
  const moment = `shadow-${spec.name}-${n}`;
  const claim: MomentClaim = {
    moment,
    source: a.source!,
    input: { kind: spec.moment, subject: e.subject, at: eventAt, refs: e.refs ?? {}, events: 1, moment },
    extractor: { path: extractorRel, root, version: extractorVersion, timeout_ms: header.timeout_ms },
    storage: "host",
  };
  const row: Record<string, unknown> = { subject: e.subject, refs: e.refs ?? {}, moment, judge: spec.name, model: spec.model, judge_version: judgeVersion, extractor_version: extractorVersion, expectations: Object.fromEntries(briefs.map((b) => [b.project, b.version])) };
  const t0 = Date.now();
  const extracted = await runExtractor(claim);
  row.extract_ms = Date.now() - t0;
  if (!extracted.output) return { ...row, status: "failed", reason: extracted.error };
  const parsed = parseExtractorOutput(extracted.output);
  if ("error" in parsed) return { ...row, status: "failed", reason: parsed.error };
  const extractedAt = Date.now();
  row.body_file = keepOnHost(claim, JSON.stringify(parsed), extracted.version, extractedAt);
  // The event is when the moment's facts were last true; in a replay that is
  // the past moment the extractor read (refs.as_of), so the judge's clock
  // stands there plus the time extraction took.
  const record: MomentRecord = { ...parsed, kind: spec.moment, subject: e.subject, event_at: eventAt, extracted_at: eventAt + (row.extract_ms as number), gap_ms: row.extract_ms as number, extractor: { path: extractorRel, version: extracted.version } };
  const req = judgeRequest(spec, briefs, record, record.extracted_at);
  const t1 = Date.now();
  let status = 0;
  let data: any = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    const res = await postMessages({ model: req.model, system: req.system, prompt: req.prompt, max_tokens: req.max_tokens }, { apiKey: apiKey! }).catch(() => null);
    status = res?.status ?? 0;
    data = res ? await res.json().catch(() => null) : null;
    if (status === 200 || !RETRY.has(status)) break;
  }
  row.judge_ms = Date.now() - t1;
  const usage = { input_tokens: data?.usage?.input_tokens ?? 0, output_tokens: data?.usage?.output_tokens ?? 0 };
  row.usage = usage;
  row.cost_usd = modelCost(req.model, usage);
  row.stop_reason = data?.stop_reason ?? null;
  if (status !== 200) return { ...row, status: "failed", reason: `API ${status}: ${String(data?.error?.message ?? "").slice(0, 200)}` };
  const text = replyText(data);
  row.reply = text;
  const verdict = parseJudgeReply(text, ids);
  if (!verdict) return { ...row, status: "failed", reason: "the reply held no deviations list" };
  return { ...row, status: "done", findings: verdict.findings, uncited: verdict.uncited };
}

const queue = events.map((e, i) => [e, done.size + i + 1] as const);
let stopped = false;
async function worker() {
  while (queue.length && !stopped) {
    if (spent >= budget) { stopped = true; console.error(`Budget reached: $${spent.toFixed(3)}`); break; }
    const [e, n] = queue.shift()!;
    const r = await one(e, n);
    spent += (r.cost_usd as number) ?? 0;
    fs.appendFileSync(a.out!, JSON.stringify(r) + "\n", { mode: 0o600 });
    console.error(`${n} ${r.status} ${(r as any).findings?.length ?? "-"} findings, ${r.extract_ms}ms extract, $${spent.toFixed(3)}${r.status === "failed" ? `: ${r.reason}` : ""}`);
  }
}
await Promise.all(Array.from({ length: Number(a.concurrency) }, worker));
console.error(`Done: $${spent.toFixed(3)} spent`);
