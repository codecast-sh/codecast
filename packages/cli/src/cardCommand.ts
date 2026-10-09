// `cast card build`: the change card (docs/architecture/the-line-end-to-end.md
// LE10) for one task. It reads what the line's nodes recorded (the task's cause
// and ground fields, its evidence, its runs, the eval station's
// eval-result.json, a recorded proof, the branch's diff), takes the three
// fields a model writes (wrong, change, recommend), validates, writes
// card.json beside card.html, and with --publish publishes the page through
// the same path as `cast publish --task`, so it lands on the task as evidence.
//
// The assembly, validation and rendering live in @codecast/shared so a
// workflow node and the web build the same card.
import * as fs from "fs";
import * as path from "path";
import type { Command } from "commander";
import {
  assembleChangeCard,
  CHANGE_VERDICTS,
  proofSummary,
  checksLabel,
  cardChecks,
  validateChangeCard,
  type CardEvidenceInput,
  type ChangeCard,
  type ChangeVerdict,
} from "@codecast/shared/contracts/changeCard";
import { goalRefLabel, type GoalsBrief } from "@codecast/shared/contracts/goalsBrief";
import { renderChangeCardHtml } from "@codecast/shared/render/changeCardHtml";
import type { EvalResult } from "@platform/evals/contract";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { printPublishResult, publishOnce } from "./publish.js";
import { parseWorkspaceKey, workspaceScope } from "./resolveWorkspace.js";
import { runGit } from "./repoMirror.js";
import { stdinText } from "./sendBody.js";

interface BuildOptions {
  task: string;
  evalResult?: string;
  proof?: string;
  headline?: string;
  context?: string;
  wrong?: string;
  change?: string;
  recommend?: string;
  why?: string;
  base?: string;
  dir?: string;
  out?: string;
  publish?: boolean;
  json?: boolean;
}

function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

function readJson<T>(file: string, what: string): T {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf-8")) as T;
  } catch (err) {
    return fail(`Could not read ${what} ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

/** "2 files changed, 18 insertions(+), 7 deletions(-)" into counts; null when git has nothing to say. */
export function parseShortstat(line: string): { files: number; added: number; removed: number } | null {
  const files = /(\d+) files? changed/.exec(line);
  if (!files) return null;
  return {
    files: Number(files[1]),
    added: Number(/(\d+) insertions?\(\+\)/.exec(line)?.[1] ?? 0),
    removed: Number(/(\d+) deletions?\(-\)/.exec(line)?.[1] ?? 0),
  };
}

/**
 * The change's own size: its line branch (codecast/line-<task>) against the
 * base, so a card built from any checkout measures the change and never the
 * checkout's unrelated work. HEAD is the fallback for a change built by hand.
 */
async function branchDiff(base: string, task: string): Promise<{ files: number; added: number; removed: number } | null> {
  const cwd = process.cwd();
  const lineBranch = `codecast/line-${task}`;
  const head = await runGit(cwd, ["rev-parse", "--verify", "--quiet", lineBranch]).then(() => lineBranch, () => "HEAD");
  // A branch name is measured as the remote has it: a checkout's local copy
  // can lag by days, and against it the card counted every commit the
  // branch was rebased over (918 files for a two-line prompt change).
  const remote = /^[\w./-]+$/.test(base) && !base.startsWith("origin/") && !/^[0-9a-f]{7,40}$/.test(base) ? `origin/${base}` : null;
  const from = remote ? await runGit(cwd, ["rev-parse", "--verify", "--quiet", remote]).then(() => remote, () => base) : base;
  try {
    return parseShortstat(await runGit(cwd, ["diff", "--shortstat", `${from}...${head}`]));
  } catch {
    return null;
  }
}

/** Agent minutes and tokens summed over the task's workflow runs. */
export function runCost(runs: Array<{ created_at?: number; updated_at: number; tokens?: number }>): { tokens: number; minutes: number } {
  let tokens = 0;
  let ms = 0;
  for (const r of runs) {
    tokens += r.tokens ?? 0;
    if (r.created_at !== undefined) ms += Math.max(0, r.updated_at - r.created_at);
  }
  return { tokens, minutes: ms / 60_000 };
}

// A card names the goal from the task's own workspace, never the shell's
// active one: a codecast cause built from a shell pointed at Union still
// finds its codecast project.
export function taskWorkspaceScope(task: { workspace?: string; project_id?: string }) {
  const project = task.project_id ? { project: String(task.project_id) } : {};
  const ws = parseWorkspaceKey(task.workspace);
  // A row from an older server carries no key: the directory decides, as it
  // does for any read that names no workspace.
  return ws ? { ...workspaceScope(ws), ...project } : { project_path: process.cwd(), ...project };
}

async function buildCard(deps: PublishDeps, options: BuildOptions): Promise<void> {
  const task = await apiPost(deps, "/cli/work/get", { short_id: options.task }, { read: true });
  if (!task?.short_id) fail(`Task not found: ${options.task}`);
  const optional = (p: Promise<any>) => p.catch(() => null);
  const goalRef: string | undefined = task.goal_ref && task.goal_ref !== "none" ? task.goal_ref : undefined;
  const [evidence, runs, signals, brief] = await Promise.all([
    optional(apiPost(deps, "/cli/work/evidence", { task_id: task.short_id }, { read: true, exitOnError: false })),
    optional(apiPost(deps, "/cli/workflow-runs/list", { task_id: task.short_id }, { read: true, exitOnError: false })),
    // The finders behind the cause, and the goal its ref names: the task
    // carries the ref and the signal count, the card says them in words.
    optional(apiPost(deps, "/cli/signal/ls", { task: task.short_id, limit: 200 }, { read: true, exitOnError: false })),
    goalRef ? optional(apiPost(deps, "/cli/goals/brief", taskWorkspaceScope(task), { read: true, exitOnError: false })) : null,
  ]);
  const goal = goalRef && brief?.projects ? goalRefLabel(brief as GoalsBrief, goalRef) : null;
  const sources = [...new Set<string>((signals?.signals ?? []).map((sg: { source: string }) => sg.source))];
  const named = {
    ...task,
    goal_name: task.goal_name || goal?.name,
    goal_why: task.goal_why || goal?.why,
    cause: task.cause ? { ...task.cause, sources: task.cause.sources?.length ? task.cause.sources : sources } : task.cause,
  };

  // A run's directory (the line's run files) supplies whichever inputs it holds.
  const inDir = (name: string) => (options.dir && fs.existsSync(path.join(options.dir, name)) ? path.join(options.dir, name) : undefined);
  const evalFile = options.evalResult ?? inDir("eval-result.json");
  const proofFile = options.proof ?? inDir("proof.json");
  const evalResult = evalFile ? readJson<EvalResult>(evalFile, "eval result") : null;
  const proof = proofFile ? readJson<ChangeCard["proof"]>(proofFile, "proof") : null;
  if (options.recommend && !CHANGE_VERDICTS.includes(options.recommend as ChangeVerdict)) {
    fail(`--recommend takes ${CHANGE_VERDICTS.join(" | ")}, got "${options.recommend}"`);
  }
  const base = options.base ?? evalResult?.base.sha ?? "origin/main";

  const card = assembleChangeCard({
    task: named,
    evidence: evidence && Array.isArray(evidence.files_changed) ? (evidence as CardEvidenceInput) : null,
    evalResult,
    proof,
    diff: await branchDiff(base, task.short_id),
    cost: runCost(Array.isArray(runs?.runs) ? runs.runs : []),
    headline: options.headline,
    context: options.context,
    wrong: options.wrong,
    change: options.change,
    recommend: options.recommend ? { verdict: options.recommend as ChangeVerdict, why: options.why?.trim() ?? "" } : null,
  });

  const validation = validateChangeCard(card);
  const errors = validation.ok ? [] : validation.errors;
  const outJson = path.resolve(options.out ?? (options.dir ? path.join(options.dir, "card.json") : "card.json"));
  const outHtml = outJson.replace(/\.json$/i, "") + ".html";
  fs.writeFileSync(outJson, JSON.stringify(card, null, 2) + "\n");
  fs.writeFileSync(outHtml, renderChangeCardHtml(card));

  let published: any = null;
  if (options.publish && !errors.length) {
    try {
      const { result, title } = await publishOnce(
        deps,
        outHtml,
        { task: task.short_id },
        { sessionRef: deps.detectCurrentSessionId() ?? undefined, withThumb: true, forceNew: false, exitOnError: false },
      );
      published = result;
      if (!options.json) printPublishResult(result, title);
    } catch (err) {
      fail(`Card publish failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ card, errors, card_json: outJson, card_html: outHtml, ...(published ? { published } : {}) }, null, 2));
  } else {
    console.log(`${fmt.label("card:")} ${outJson}`);
    console.log(`${fmt.label("page:")} ${outHtml}`);
    console.log(fmt.muted(`  ${proofSummary(card.proof).evidence} · ${checksLabel(cardChecks(card))} · ${card.examples.length} examples`));
    if (errors.length) {
      console.error(fmt.error(`\nThe card is not ready (${errors.length}):`));
      for (const e of errors) console.error(`  ${e}`);
      if (options.publish) console.error(fmt.muted("\nNot published. Fix the fields above and build again."));
    }
  }
  if (errors.length) process.exit(1);
}

export function registerCardCommand(program: Command, deps: PublishDeps): void {
  const card = program.command("card").description(commandGroup("card").description);

  card
    .command("build")
    .description("Assemble, validate and render the change card for a task (LE10)")
    .requiredOption("--task <ct-N>", "The cause the card is for")
    .option("--eval-result <file>", "The eval station's eval-result.json: verdicts, proven freezes, flipped examples")
    .option("--proof <file>", "A proof recorded outside evals: { before: Check[], after: Check[] }, red then green")
    .option("--headline <text>", stdinText("The card's title in plain words, under 80 characters"))
    .option("--context <text>", stdinText("One sentence: what the affected part of the product is and who sees it"))
    .option("--wrong <text>", stdinText("What is wrong, in the user's terms, one or two sentences"))
    .option("--change <text>", stdinText("What behaves differently after this change, one or two sentences"))
    .option("--recommend <verdict>", `${CHANGE_VERDICTS.join(" | ")}`)
    .option("--why <text>", stdinText("One sentence on why that recommendation"))
    .option("--base <ref>", "Base for the diff stats (default: the eval result's base, else origin/main)")
    .option("--dir <dir>", "A run's directory: reads eval-result.json and proof.json from it when present, and writes card.json there")
    .option("--out <file>", "Where card.json goes (default: card.json, in --dir when given); the page goes beside it as .html")
    .option("--publish", "Publish the page and attach it to the task as evidence (only when the card is valid)")
    .option("--json", "Print { card, errors, card_json, card_html, published }")
    .action((options: BuildOptions) => buildCard(deps, options));
}
