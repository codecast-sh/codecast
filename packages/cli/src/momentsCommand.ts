// `cast line moments` and `cast line budget` (docs/architecture/
// learning-loop.md LL7, LL8, LL10): a repo's extractors and judges published
// from the machine that runs them, the moments they made, and the team's
// monthly model budget that judging and grouping draw from.
//
//   cast line moments publish --source <name> [--dry-run] [--json]
//   cast line moments ls [--source <name>] [--json]
//   cast line moments show <mo-N> [--body] [--json]
//   cast line moments extract        (one pass of what the daemon does)
//   cast line budget [--set <usd>] [--json]
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { JUDGES_DIR, MOMENTS_DIR, fileVersion, noteHostRoot, shadowDir, tickMoments } from "./momentsHost.js";
import { MOMENT_KIND, durationWords, parseExtractorHeader } from "@codecast/shared/contracts/moments";
import { parseJudgeSpec } from "@codecast/shared/contracts/judges";
import { budgetWords, type BudgetSummary } from "@codecast/shared/contracts/modelCall";
import { execFileAsync } from "./proc.js";

function fail(message: string, code = 2): never {
  console.error(fmt.error(message));
  process.exit(code);
}

async function repoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" } as any);
    return String(stdout).trim();
  } catch {
    fail("Run from inside the product's repository: its extractors and judges live in .codecast/");
  }
}

export type PublishSet = {
  extractors: Array<{ kind: string; path: string; version: string; quiet_ms: number; timeout_ms: number }>;
  judges: Array<{ name: string; path: string; version: string; moment: string; model: string; max_tokens: number; projects: string[]; mode: "shadow" | "live"; prompt: string }>;
  problems: string[];
};

/** What a checkout holds: every extractor with its header, every judge parsed, each at its file's version. */
export async function readPublishSet(root: string): Promise<PublishSet> {
  const set: PublishSet = { extractors: [], judges: [], problems: [] };
  const list = (dir: string, ext: string) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(ext)).sort() : []);
  for (const file of list(MOMENTS_DIR, ".ts")) {
    const kind = file.slice(0, -3);
    if (file.endsWith(".test.ts")) continue;
    if (!MOMENT_KIND.test(kind)) { set.problems.push(`${MOMENTS_DIR}/${file}: the file name is the moment kind (lowercase letters, digits, - and _)`); continue; }
    const rel = `${MOMENTS_DIR}/${file}`;
    const header = parseExtractorHeader(fs.readFileSync(path.join(root, rel), "utf8"));
    set.problems.push(...header.problems.map((p) => `${rel}: ${p}`));
    set.extractors.push({ kind, path: rel, version: await fileVersion(path.join(root, rel)), quiet_ms: header.quiet_ms, timeout_ms: header.timeout_ms });
  }
  for (const file of list(JUDGES_DIR, ".md")) {
    const rel = `${JUDGES_DIR}/${file}`;
    const spec = parseJudgeSpec(file.slice(0, -3), fs.readFileSync(path.join(root, rel), "utf8"));
    if ("error" in spec) { set.problems.push(`${rel}: ${spec.error}`); continue; }
    set.judges.push({ name: spec.name, path: rel, version: await fileVersion(path.join(root, rel)), moment: spec.moment, model: spec.model, max_tokens: spec.max_tokens, projects: spec.projects, mode: spec.mode, prompt: spec.prompt });
  }
  return set;
}

const age = (ms: number) => `${durationWords(Math.max(0, Date.now() - ms))} ago`;

export function registerMomentsCommands(line: Command, deps: PublishDeps): void {
  const scope = async () => {
    const { scopeFor } = await import("./signalCommand.js");
    const s: Record<string, unknown> = { ...(await scopeFor(deps, undefined, true)) };
    delete s.project;
    return s;
  };
  const moments = line.command("moments").description("Moments a product brings for codecast to judge: its extractors and judges, and what they found (learning-loop.md LL7)");

  moments
    .command("publish")
    .description("Publish this repo's .codecast/moments extractors and .codecast/judges judges for a source; this machine runs the extractors")
    .requiredOption("--source <name>", "The ingest source the product posts its moment events to")
    .option("--dry-run", "Read and check the files, publish nothing")
    .option("--json", "Machine-readable output")
    .action(async (options: { source: string; dryRun?: boolean; json?: boolean }) => {
      const root = await repoRoot(process.env.CODECAST_CWD || process.cwd());
      const set = await readPublishSet(root);
      if (options.dryRun) {
        if (options.json) console.log(JSON.stringify({ root, ...set }, null, 2));
        else {
          for (const e of set.extractors) console.log(`extractor ${e.kind}  ${e.version.slice(0, 10)}  quiet ${durationWords(e.quiet_ms)}`);
          for (const j of set.judges) console.log(`judge ${j.name}  ${j.version.slice(0, 10)}  reads ${j.moment}, ${j.mode}, ${j.model}, against ${j.projects.join(", ")}`);
          for (const p of set.problems) console.log(fmt.warning(p));
        }
        return;
      }
      if (set.problems.length) fail(`Fix these first:\n${set.problems.map((p) => `  ${p}`).join("\n")}`);
      const { deviceId } = await import("./remote/device.js");
      const result = await apiPost(deps, "/cli/moments/publish", { ...(await scope()), source: options.source, device_id: deviceId(), root, extractors: set.extractors, judges: set.judges.map(({ moment, ...j }) => ({ ...j, moment })) });
      noteHostRoot(root, set.extractors.length > 0);
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Published ${result.extractors} extractor${result.extractors === 1 ? "" : "s"} and ${result.judges} judge${result.judges === 1 ? "" : "s"} for ${result.source}. This machine runs the extractors.`);
      console.log(result.storage === "codecast" ? "Moment bodies are kept in codecast for 30 days." : `Moment bodies stay on this machine (${shadowDir()}), 30 days.`);
      for (const p of result.problems ?? []) console.log(`  ${p}`);
    });

  moments
    .command("ls")
    .description("The newest moments, and the extractors and judges each source has")
    .option("--source <name>", "One source")
    .option("--limit <n>", "How many moments", "30")
    .option("--json", "Machine-readable output")
    .action(async (options: { source?: string; limit: string; json?: boolean }) => {
      const result = await apiPost(deps, "/cli/moments/ls", { ...(await scope()), ...(options.source ? { source: options.source } : {}), limit: Number(options.limit) || 30 }, { read: true });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      for (const e of result.extractors) console.log(`${fmt.muted("extractor")} ${e.source}/${e.kind} ${e.version.slice(0, 10)}, quiet ${durationWords(e.quiet_ms)}`);
      for (const j of result.judges) console.log(`${fmt.muted("judge")} ${j.name} reads ${j.source}/${j.moment}, ${j.mode}, ${j.model}`);
      if (!result.moments.length) return console.log("No moments yet.");
      for (const m of result.moments) {
        const facts = [m.status, `${m.events} event${m.events === 1 ? "" : "s"}`, m.gap_ms !== undefined ? `read ${durationWords(m.gap_ms)} after` : null, m.judged_at ? "judged" : null, m.error].filter(Boolean).join(", ");
        console.log(`${m.short_id}  ${m.kind}/${m.subject}  ${facts}  (${age(m.event_at)})`);
      }
    });

  moments
    .command("show <moment>")
    .description("One moment and what each judge found in it")
    .option("--body", "Print the moment itself: from codecast when it keeps it, else from this machine")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, options: { body?: boolean; json?: boolean }) => {
      const result = await apiPost(deps, "/cli/moments/show", { ...(await scope()), moment: ref }, { read: true });
      let body: unknown = null;
      if (options.body) {
        body = result.moment.kept ? await apiPost(deps, "/cli/moments/body", { ...(await scope()), moment: ref }, { read: true }) : null;
        const local = path.join(shadowDir(), String(result.moment.source ?? "").replace(/[^A-Za-z0-9_-]/g, "_"), `${result.moment.short_id}.json`);
        if (!body && fs.existsSync(local)) body = JSON.parse(fs.readFileSync(local, "utf8"));
      }
      if (options.json) return console.log(JSON.stringify({ ...result, ...(options.body ? { body } : {}) }, null, 2));
      const m = result.moment;
      console.log(`${m.short_id}  ${m.kind}/${m.subject}  ${m.status}, ${m.events} event${m.events === 1 ? "" : "s"}, last ${age(m.event_at)}`);
      if (m.extractor_version) console.log(`  extracted by ${m.extractor_version.slice(0, 10)}, ${durationWords(m.gap_ms ?? 0)} after its last event; kept ${m.storage === "codecast" ? (m.kept ? "in codecast" : "in codecast, now expired") : "on the host"}`);
      if (m.error) console.log(`  ${m.error}`);
      for (const r of result.runs) {
        console.log(`\n${r.judge} ${r.judge_version.slice(0, 10)} (${r.mode}): ${r.status}${r.reason ? `, ${r.reason}` : ""}, ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}${r.filed ? `, ${r.filed} filed` : ""}, $${r.cost_usd.toFixed(4)}`);
        for (const f of r.findings) console.log(`  ${f.expectation} severity ${f.severity}: ${f.what_happened}${f.quote ? `\n    "${f.quote}"` : ""}`);
      }
      if (options.body) console.log(body ? `\n${JSON.stringify(body, null, 2)}` : "\nThe body is not kept anywhere this machine can read.");
    });

  moments
    .command("extract")
    .description("Claim and extract what is due on this machine now, the pass the daemon runs every minute")
    .option("--json", "Machine-readable output")
    .action(async (options: { json?: boolean }) => {
      const { deviceId } = await import("./remote/device.js");
      const results = await tickMoments({ post: (route, body) => apiPost(deps, route, body, { exitOnError: false }), deviceId: deviceId(), log: options.json ? undefined : console.log });
      if (options.json) console.log(JSON.stringify(results, null, 2));
      else if (!results.length) console.log("Nothing is due on this machine.");
    });

  line
    .command("budget")
    .description("The team's monthly model budget that judging, grouping and graph calls draw from; a team admin sets it (0 is off)")
    .option("--set <usd>", "The monthly cap in dollars")
    .option("--json", "Machine-readable output")
    .action(async (options: { set?: string; json?: boolean }) => {
      const set = options.set === undefined ? undefined : Number(options.set.replace(/^\$/, ""));
      if (set !== undefined && !(Number.isFinite(set) && set >= 0)) fail(`--set takes dollars, not "${options.set}"`);
      const result: BudgetSummary = await apiPost(deps, "/cli/model/budget", { ...(await scope()), ...(set !== undefined ? { set_usd: set } : {}) });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      console.log(budgetWords(result));
    });
}
