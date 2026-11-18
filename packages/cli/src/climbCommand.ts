// `cast climb`: the climb flow's deterministic stations (flows.md FL10,
// templates/climb.cast). Each subcommand reads and writes the climb's state
// in one directory (the run's `$run_dir/climb`), so a resumed run repeats
// nothing it paid for. Exit 0 goes on; 3 stops the climb with nothing to
// promote; 4 stops it because the budget is spent. The last line of every
// station's output is one JSON {"why"} the run report reads.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { CLIMB_EXPERIMENT_MAX_WEEKS, experimentWeeks } from "@codecast/shared/contracts/climb";
import { formatSeriesValue, metricReadings } from "@codecast/shared/contracts/initiative";
import { MDE_WEEKS, mdeWords } from "@codecast/shared/contracts/metricStanding";
import { liveSeries } from "./initiativeCommand.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";
import { baseSha, recordRun, runEnv, runWithCases, withTreeAt } from "./envCommand.js";
import { repoRoot } from "./envDeclaration.js";
import { ClimbStop, admit, bindPromoted, confirm, gauge, guard, readState, refuse, screen, setOutcome, type ClimbIo, type RunOut } from "./climb/engine.js";
import { LINE_COMMAND_VARS } from "./lineProfile.js";
import { statusText, summaryText } from "./climb/report.js";

const cwd = () => process.env.CODECAST_CWD || process.cwd();

/**
 * The run's values a station script hands down ($run_dir, $task_id, ...), taken
 * out of this process's environment before any runner starts: candidate code
 * runs inside the env runner, and must not be told where the climb's run lives.
 * The product's eval command gets them back, since it is the line's own.
 */
let runValues: Record<string, string> | null = null;
function scrubRunValues(): Record<string, string> {
  if (runValues) return runValues;
  runValues = {};
  for (const k of [...LINE_COMMAND_VARS, "CODECAST_RUN_DIR"]) if (process.env[k] !== undefined) { runValues[k] = process.env[k]!; delete process.env[k]; }
  return runValues;
}

/** A held run goes through `cast env run --split held`, the one path that may hand a runner sealed cases. */
function heldRun(dir: string, key: string, label: string, goal: string, task?: string): RunOut {
  // CODECAST_CWD names the candidate's tree: a parent's value would score the main checkout instead.
  const r = spawnSync("cast", ["env", "run", key, "--split", "held", "--candidate", label, "--goal", goal, ...(task ? ["--task", task] : []), "--json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CODECAST_CWD: dir } });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n").pop()! };
  try {
    const out = JSON.parse(r.stdout);
    return { ok: true, result: out.result, short_id: out.short_id };
  } catch {
    return { ok: false, error: "cast env run printed no JSON result" };
  }
}

export function defaultIo(deps: PublishDeps): ClimbIo {
  scrubRunValues();
  const root = repoRoot(cwd());
  if (!root) throw new ClimbStop("not inside a git repository", 3);
  const post = (urlPath: string, body: Record<string, unknown>, read?: boolean) => apiPost(deps, urlPath, body, { read });
  return {
    root,
    post,
    run: async (decl, o) => {
      if (o.split === "held") return heldRun(o.dir, decl.key, o.label, o.goal, o.task);
      // The env's dev set travels through codecast (envCases.ts): runWithCases hands it to the runner and names the version read, which the attempt records.
      const fetch = { goal: o.goal, task_id: o.task, session_id: deps.detectCurrentSessionId() };
      let r: Awaited<ReturnType<typeof runEnv>>, read: string | undefined;
      try { ({ run: r, read } = await runWithCases(post, decl, { dir: o.dir, candidate: o.label, split: o.split, sha: o.sha, quiet: false }, fetch)); } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
      if (!r.ok) return r;
      const filed = await recordRun(post, decl, root, r.result, { ...fetch, ...(read ? { cases_read: read } : {}) }).catch(() => null);
      return { ok: true, result: r.result, short_id: filed?.short_id };
    },
    tree: (sha, fn) => withTreeAt(root, sha, fn),
    evalResult: (reps, out) => spawnSync("cast", ["line", "eval-result", "--reps", reps, "--out", out], { stdio: "inherit" }).status ?? 2,
    log: (line) => console.log(line),
  };
}

const readJson = (file: string, what: string, code = 3): unknown => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { throw new ClimbStop(`${what} ${file} is not readable JSON: ${err instanceof Error ? err.message : err}`, code); }
};

/** Run one station: its words on stdout, a {"why"} line last, its exit code. */
async function station(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const why = await fn();
    console.log(JSON.stringify({ why }));
  } catch (err) {
    const code = err instanceof ClimbStop ? err.code : 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${name}: ${msg}`);
    console.log(JSON.stringify({ why: msg }));
    process.exit(code);
  }
}

/**
 * How long a production test needs to read a lift on a goal metric, in words,
 * from the same reading `cast goal show` prints (metricReadings over the
 * goal's live series): its window's level and its 4-week MDE, which carry the
 * pooling, the cohort periods and the observed spread. Promote sizes the
 * experiment with this.
 */
export async function experimentLine(post: ClimbIo["post"], goalRef: string, key: string, lift: number): Promise<string> {
  const goal = await post("/cli/initiatives/get", { id: goalRef }, true);
  if (!goal) throw new ClimbStop(`goal ${goalRef} not found or not visible`, 3);
  const r = metricReadings(goal, liveSeries(goal)).find((x) => x.key === key || x.name === key);
  if (!r) throw new ClimbStop(`${goalRef} has no metric ${key} (${(goal.metrics ?? []).map((x: any) => x.key).join(", ") || "none"})`, 3);
  const b = r.band;
  if (!b) throw new ClimbStop(`${key} is read without a window and a noise model, so no test can be sized from it (cast goal set --metric "... window 4w noise poisson")`, 3);
  if (b.mde === null) throw new ClimbStop(`${key}'s reading has no detectable change to size a test from${b.note ? `: ${b.note}` : ""}`, 3);
  const level = r.unit ? formatSeriesValue(b.mean, r.unit) : String(Math.round(b.mean * 100) / 100);
  const how = `${b.pooling === "pooled" ? "pooled" : "mean"} over ${b.periods} ${b.cohort ? "cohort " : ""}${b.period}s, ${b.spread ?? "model"} spread`;
  const pct = `${(lift * 100).toFixed(0)}%`;
  const weeks = experimentWeeks(b.mde, r.noise, lift);
  const four = `${MDE_WEEKS} weeks detect ${mdeWords(b.mde)}`;
  return weeks === null
    ? `${key} at ${level} (${how}): a 50/50 test cannot detect ${pct} within ${CLIMB_EXPERIMENT_MAX_WEEKS} weeks (${four})`
    : `${key} at ${level} (${how}): a 50/50 test detects ${pct} in ${weeks} week${weeks === 1 ? "" : "s"} (${four})`;
}

export function registerClimbCommand(program: Command, deps: PublishDeps): void {
  const climb = program.command("climb").description(commandGroup("climb").description);
  const dirOpt = (cmd: Command) => cmd.requiredOption("--dir <dir>", "The climb's directory (the run's $run_dir/climb)");

  dirOpt(climb.command("gauge").description("Read Frame's card under the caps, run the base on each level to measure its noise, and refuse levels that cannot see one change"))
    .requiredOption("--card <file>", "The climb card Frame wrote")
    .option("--base <ref>", "The base every candidate starts from (default: the merge base with origin's default branch)")
    .option("--task <ct-N>", "The climb's task")
    .option("--goal <ref>", "The climb's task's goal_ref (in-N or in-N:metric): the card must climb that goal")
    .action((o) => station("gauge", async () => {
      const io = defaultIo(deps);
      const base = baseSha(io.root, o.base);
      if (!base) throw new ClimbStop("no base to climb from (no merge base with origin)", 3);
      const s = await gauge(io, o.dir, { card: readJson(o.card, "the card", 5), base, task: o.task, goal: o.goal ?? undefined });
      console.log(statusText(s));
      return `levels kept: ${s.levels.filter((l) => l.kept).map((l) => `${l.level} ${l.env}`).join(", ")}`;
    }));

  dirOpt(climb.command("admit").description("Check Propose's candidates against the diff rules: one branch each, from the base, touching nothing that grades it"))
    .requiredOption("--candidates <file>", "The candidate list Propose wrote")
    .action((o) => station("admit", async () => {
      const s = await admit(defaultIo(deps), o.dir, readJson(o.candidates, "the candidate list"));
      return `${s.candidates.filter((c) => c.status === "admitted").length} of ${s.candidates.length} candidates admitted`;
    }));

  dirOpt(climb.command("refuse").description("Refuse an admitted candidate (the review station), with why"))
    .argument("<id>", "The candidate (cand-N)")
    .requiredOption("-m, --message <why>", "Why it is refused")
    .action((id: string, o) => station("refuse", async () => { await refuse(defaultIo(deps), o.dir, id, o.message); return `${id} refused`; }));

  dirOpt(climb.command("screen").description("Run the candidates on the dev split, cheapest level first, keeping the better half that separates from base"))
    .action((o) => station("screen", async () => {
      const s = await screen(defaultIo(deps), o.dir);
      return `${s.candidates.filter((c) => c.status === "survivor").length} survived dev`;
    }));

  dirOpt(climb.command("confirm").description("Run the survivors on the held split; a dev gain that vanishes there is logged as overfit"))
    .action((o) => station("confirm", async () => {
      const s = await confirm(defaultIo(deps), o.dir);
      return `${s.candidates.filter((c) => c.status === "survivor").length} confirmed on held; overfit: ${s.candidates.filter((c) => c.status === "overfit").map((c) => c.id).join(", ") || "none"}`;
    }));

  dirOpt(climb.command("guard").description("The goal's L0 checks and the product's eval gate (the line profile's commands.eval, as committed at the base) on each survivor, best first; the first to pass is promoted"))
    .action((o) => station("guard", async () => {
      const io = defaultIo(deps);
      const s = await guard(io, o.dir, { env: scrubRunValues() });
      const top = s.candidates.find((c) => c.status === "promoted")!;
      return `${top.id} promoted; guard refused: ${s.candidates.filter((c) => c.status === "guard_failed").map((c) => c.id).join(", ") || "none"}`;
    }));

  dirOpt(climb.command("promote").description("Record the task Promote filed for the promoted change: the only task Approve and Drop act on"))
    .requiredOption("--task <ct-N>", "The promoted change's task: a subtask of the climb's task, under the climb's goal")
    .action((o) => station("promote", async () => {
      const io = defaultIo(deps);
      const s = await bindPromoted(io, o.dir, o.task, { env: scrubRunValues() });
      console.log(summaryText(s));
      return `${o.task} carries the promoted change`;
    }));

  dirOpt(climb.command("status").description("The climb as it stands: levels, candidates, cost, how it ended"))
    .option("--summary", "The short record the climb leaves on its goal")
    .option("--field <name>", "One value: goal, metric, promoted, branch, task, stopped")
    .option("--json", "The whole state as JSON")
    .action((o) => {
      const s = readState(o.dir);
      if (!s) { if (!o.field) console.log("No climb here yet."); return; }
      if (o.json) { console.log(JSON.stringify(s, null, 2)); return; }
      if (o.field) {
        const top = s.candidates.find((c) => c.status === "promoted");
        const v: Record<string, string | undefined> = { goal: s.card.goal, promoted: top?.id, branch: top?.branch, task: s.promoted_task, stopped: s.stopped, metric: s.card.metric };
        console.log(v[o.field] ?? "");
        return;
      }
      console.log(o.summary ? summaryText(s) : statusText(s));
    });

  dirOpt(climb.command("outcome").description("Record how the climb's decision went"))
    .argument("<text>", "What happened")
    .action((text: string, o) => { setOutcome(o.dir, text); });

  climb.command("experiment").description("How many weeks a 50/50 production test needs to detect a lift on a goal metric")
    .requiredOption("--goal <in-N>", "The goal")
    .requiredOption("--metric <key>", "The goal metric")
    .requiredOption("--lift <fraction>", "The relative lift to detect (0.08 is 8%)")
    .action((o) => station("experiment", async () => {
      const lift = Number(o.lift);
      if (!(lift > 0)) throw new ClimbStop(`--lift ${o.lift} is not a positive fraction`, 3);
      return experimentLine((p, b, r) => apiPost(deps, p, b, { read: r }), o.goal, o.metric, lift);
    }));
}
