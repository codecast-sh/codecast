// `cast climb`: the climb flow's deterministic stations (flows.md FL10,
// templates/climb.cast). Each subcommand reads and writes the climb's state
// in one directory (the run's `$run_dir/climb`), so a resumed run repeats
// nothing it paid for. Exit 0 goes on; 3 stops the climb with nothing to
// promote; 4 stops it because the budget is spent. The last line of every
// station's output is one JSON {"why"} the run report reads.
import fs from "node:fs";
import { spawnSync } from "./proc.js";
import type { Command } from "commander";
import { MetricUnread, experimentWords } from "./climb/readability.js";
import { archiveSealed, climbHome } from "./climb/store.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";
import { recordRun, runEnv, runWithCases, withTreeAt } from "./envCommand.js";
import { climbBase, stackBase } from "./climb/base.js";
import { repoRoot } from "./envDeclaration.js";
import { parseDuration } from "@codecast/shared/time";
import { ClimbStop, STOP, admit, bindPromoted, promoteMode, confirm, gauge, guard, readState, refuse, screen, setOutcome, type ClimbIo, type RunOut } from "./climb/engine.js";
import { LINE_COMMAND_VARS } from "./lineProfile.js";
import { effectLine, filedLine, hypothesisLine, statusText, summaryText } from "./climb/report.js";

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
  // A refusal from the server is an error the station handles, never an exit: an exit mid-gauge loses what it ran,
  // and turns a refusal the caller reads (an env with no case set in codecast runs as before) into the climb's end.
  const post = (urlPath: string, body: Record<string, unknown>, read?: boolean) => apiPost(deps, urlPath, body, { read, exitOnError: false });
  // The flow run is the attempt: a failure is reused across its stations and run again by the next run of the flow.
  return climbIo(post, root, deps.detectCurrentSessionId(), scrubRunValues().run_id);
}

/** The climb's runs on this machine: dev through runWithCases (an env with no set in codecast runs as before), held through `cast env run`, each filed. */
export function climbIo(post: ClimbIo["post"], root: string, sessionId: string | null | undefined, attempt?: string): ClimbIo {
  return {
    root,
    ...(attempt ? { attempt } : {}),
    post,
    run: async (decl, o) => {
      if (o.split === "held") return heldRun(o.dir, decl.key, o.label, o.goal, o.task);
      // The env's dev set travels through codecast (envCases.ts): runWithCases hands it to the runner and names the version read, which the attempt records.
      const fetch = { goal: o.goal, task_id: o.task, session_id: sessionId };
      let r: Awaited<ReturnType<typeof runEnv>>, read: string | undefined;
      try { ({ run: r, read } = await runWithCases(post, decl, { dir: o.dir, candidate: o.label, split: o.split, sha: o.sha, quiet: false }, fetch)); } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
      if (!r.ok) return r;
      try {
        const filed = await recordRun(post, decl, root, r.result, { ...fetch, ...(read ? { cases_read: read } : {}) });
        return { ok: true, result: r.result, short_id: filed.short_id };
      } catch (err) {
        return { ok: true, result: r.result, unfiled: err instanceof Error ? err.message : String(err) };
      }
    },
    tree: (sha, fn) => withTreeAt(root, sha, fn),
    evalResult: (reps, out) => spawnSync("cast", ["line", "eval-result", "--reps", reps, "--out", out], { stdio: "inherit" }).status ?? 2,
    log: (line) => console.log(line),
  };
}

const readJson = (file: string, what: string, code = 3): unknown => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { throw new ClimbStop(`${what} ${file} is not readable JSON: ${err instanceof Error ? err.message : err}`, code); }
};

/** Run one station: its words on stdout, a {"why"} line last, its exit code. A station that fails says what the climb has filed so far, or that it filed nothing. */
async function station(name: string, fn: () => Promise<string>, dir?: string): Promise<void> {
  try {
    const why = await fn();
    console.log(JSON.stringify({ why }));
  } catch (err) {
    const code = err instanceof ClimbStop ? err.code : 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${name}: ${msg}`);
    let filed = "";
    try { filed = dir ? filedLine(readState(dir)) : ""; } catch {}
    if (filed) console.log(filed);
    console.log(JSON.stringify({ why: filed ? `${msg} (${filed})` : msg }));
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
  try { return experimentWords(goal, key, lift); } catch (err) { if (err instanceof MetricUnread) throw new ClimbStop(err.message, 3); throw err; }
}

export function registerClimbCommand(program: Command, deps: PublishDeps): void {
  const climb = program.command("climb").description(commandGroup("climb").description);
  const dirOpt = (cmd: Command) => cmd.requiredOption("--dir <dir>", "The climb's directory (the run's $run_dir/climb)");

  dirOpt(climb.command("gauge").description("Read Frame's card under the caps, run the base on each level to measure its noise, and refuse levels that cannot see one change"))
    .requiredOption("--card <file>", "The climb card Frame wrote")
    .option("--base <ref>", "The base every candidate starts from (default: the default branch's upstream tip, fetched now, whatever this checkout's HEAD is)")
    .option("--task <ct-N>", "The climb's task")
    .option("--goal <ref>", "The climb's task's goal_ref (in-N or in-N:metric): the card must climb that goal")
    .action((o) => station("gauge", async () => {
      const io = defaultIo(deps);
      // A shared checkout lags its default branch: base on the upstream tip, never on this checkout's own HEAD.
      let base = climbBase(io.root, o.base);
      if (!base) throw new ClimbStop(o.base ? `--base ${o.base} is not a commit here` : "no base to climb from: no upstream and no HEAD", 3);
      const card = readJson(o.card, "the card", 5) as any;
      // A climb that builds on a pending change measures against that change applied onto the tip, so no candidate is credited with it.
      if (card?.stack && (card.stack.ref || card.stack.patch)) {
        const stacked = stackBase(io.root, base.sha, card.stack);
        if ("error" in stacked) throw new ClimbStop(`the card's stack cannot be the base: ${stacked.error}`, 5);
        base = { ...base, sha: stacked.sha, stack: { ...card.stack, sha: stacked.sha, onto: base.sha } };
      }
      const s = await gauge(io, o.dir, { card, base: base.sha, base_info: base, task: o.task, goal: o.goal ?? undefined });
      console.log(statusText(s));
      return `levels kept: ${s.levels.filter((l) => l.kept).map((l) => `${l.level} ${l.env}`).join(", ")}`;
    }, o.dir));

  dirOpt(climb.command("admit").description("Check Propose's candidates against the diff rules: one branch each, from the base, touching nothing that grades it"))
    .requiredOption("--candidates <file>", "The candidate list Propose wrote")
    .action((o) => station("admit", async () => {
      const s = await admit(defaultIo(deps), o.dir, readJson(o.candidates, "the candidate list"));
      return `${s.candidates.filter((c) => c.status === "admitted").length} of ${s.candidates.length} candidates admitted`;
    }, o.dir));

  dirOpt(climb.command("refuse").description("Refuse an admitted candidate (the review station), with why"))
    .argument("<id>", "The candidate (cand-N)")
    .requiredOption("-m, --message <why>", "Why it is refused")
    .action((id: string, o) => station("refuse", async () => { await refuse(defaultIo(deps), o.dir, id, o.message); return `${id} refused`; }));

  dirOpt(climb.command("screen").description("Run the candidates on the dev split, cheapest level first, keeping the better half that separates from base"))
    .action((o) => station("screen", async () => {
      const s = await screen(defaultIo(deps), o.dir);
      for (const line of [effectLine(s), hypothesisLine(s)]) if (line) console.log(line);
      return `${s.candidates.filter((c) => c.status === "survivor").length} survived dev`;
    }, o.dir));

  dirOpt(climb.command("confirm").description("Run the survivors on the held split; a dev gain that vanishes there is logged as overfit"))
    .action((o) => station("confirm", async () => {
      const s = await confirm(defaultIo(deps), o.dir);
      return `${s.candidates.filter((c) => c.status === "survivor").length} confirmed on held; overfit: ${s.candidates.filter((c) => c.status === "overfit").map((c) => c.id).join(", ") || "none"}`;
    }, o.dir));

  dirOpt(climb.command("guard").description("The goal's L0 checks and the product's eval gate (the line profile's commands.eval, as committed at the base) on each survivor, best first; the first to pass is promoted. A void verdict (an outage, a capped pool, unscored cases) exits 6 and promotes nothing"))
    .option("--hold", "On a void verdict, re-run the void checks every --every until a real verdict lands or --for runs out (the Hold station)")
    .option("--every <duration>", "How long to wait between re-runs of a void check", "3h")
    .option("--for <duration>", "How long to hold for a real verdict before stopping the climb", "3d")
    .action((o) => station("guard", async () => {
      const io = defaultIo(deps);
      const every = parseDuration(o.every), until = Date.now() + parseDuration(o.for);
      let s;
      // The first pass reads the void verdict back at no cost; each pass after a wait re-runs the void checks.
      for (let rerun = false; ; rerun = true) {
        try { s = await guard(io, o.dir, { env: scrubRunValues(), rerunVoid: rerun }); break; } catch (err) {
          if (!(o.hold && err instanceof ClimbStop && err.code === STOP.pending)) throw err;
          if (Date.now() + every > until) throw new ClimbStop(`still void after holding for ${o.for}: ${err.message}`, STOP.pending);
          console.log(`${new Date().toISOString()} guard void, re-running in ${o.every}: ${err.message}`);
          await new Promise((r) => setTimeout(r, every));
        }
      }
      const top = s.candidates.find((c) => c.status === "promoted")!;
      return `${top.id} promoted; guard refused: ${s.candidates.filter((c) => c.status === "guard_failed").map((c) => c.id).join(", ") || "none"}`;
    }, o.dir));

  dirOpt(climb.command("promote-mode").description("How this repo ships a promoted change, from .codecast/climb.toml at the climb's base ([promote] mode = \"line\" | \"experiment\"), as one JSON line for the graph to route on"))
    .action((o) => {
      const s = readState(o.dir);
      if (!s) { console.log(JSON.stringify({ mode: "experiment" })); return; }
      const root = repoRoot(cwd());
      try { console.log(JSON.stringify({ mode: root ? promoteMode(root, s.base) : "experiment" })); } catch (err) { console.log(JSON.stringify({ mode: "experiment", why: err instanceof Error ? err.message : String(err) })); }
    });

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

  dirOpt(climb.command("where").description("Where this climb keeps its state on this machine (the run's $run_dir/climb is its handle)"))
    .action((o) => {
      const s = readState(o.dir);
      console.log(`${climbHome(o.dir)}${s ? ` (base ${s.base.slice(0, 10)}, ${s.stopped ? `stopped: ${s.stopped.slice(0, 120)}` : s.candidates.find((c) => c.status === "promoted") ? "promoted" : "under way"})` : " (no climb state yet)"}`);
    });

  dirOpt(climb.command("reset").description("Set this climb's state aside (kept beside it as state.<time>.json, never deleted) so its next run starts a fresh climb"))
    .action((o) => {
      const to = archiveSealed(o.dir);
      console.log(to ? `The climb's state is set aside at ${to}; the next Gauge starts a fresh climb. Its filed env attempts stay in the registry.` : `No climb state at ${climbHome(o.dir)}.`);
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
