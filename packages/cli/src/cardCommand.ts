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
  runVerify,
  CHANGE_VERDICTS,
  proofSummary,
  checksLabel,
  cardChecks,
  validateChangeCard,
  type CardEvidenceInput,
  type BranchBase,
  type ChangeCard,
  type ChangeVerdict,
  type RiskClass,
} from "@codecast/shared/contracts/changeCard";
import { validateProposalCard } from "@codecast/shared/contracts/proposalCard";
import { goalRefLabel, type GoalsBrief } from "@codecast/shared/contracts/goalsBrief";
import { renderChangeCardHtml } from "@codecast/shared/render/changeCardHtml";
import type { EvalResult } from "@platform/evals/contract";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { printPublishResult, publishOnce } from "./publish.js";
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
  ask?: string;
  words?: string;
  base?: string;
  dir?: string;
  out?: string;
  publish?: boolean;
  json?: boolean;
}

/** --words: a JSON object, inline or a file path. */
function parseWords(raw: string): Record<string, any> {
  const text = fs.existsSync(raw) ? fs.readFileSync(raw, "utf-8") : raw;
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  fail("--words takes a JSON object (or a file holding one) with headline, context, wrong, change, recommend, why and examples");
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
 * The change and its base as refs: the change is its line branch
 * (codecast/line-<task>), so a card built from any checkout measures the
 * change and never the checkout's unrelated work, with HEAD the fallback for a
 * change built elsewhere. A branch name for the base is read as the remote has
 * it: a checkout's local copy can lag by days, and against it the card counted
 * every commit the branch was rebased over (918 files for a two-line prompt
 * change).
 */
async function changeRefs(base: string, task: string): Promise<{ cwd: string; head: string; from: string }> {
  const cwd = process.cwd();
  const lineBranch = `codecast/line-${task}`;
  const head = await runGit(cwd, ["rev-parse", "--verify", "--quiet", lineBranch]).then(() => lineBranch, () => "HEAD");
  const remote = /^[\w./-]+$/.test(base) && !base.startsWith("origin/") && !/^[0-9a-f]{7,40}$/.test(base) ? `origin/${base}` : null;
  const from = remote ? await runGit(cwd, ["rev-parse", "--verify", "--quiet", remote]).then(() => remote, () => base) : base;
  return { cwd, head, from };
}

async function branchDiff({ cwd, head, from }: { cwd: string; head: string; from: string }): Promise<{ files: number; added: number; removed: number } | null> {
  try {
    return parseShortstat(await runGit(cwd, ["diff", "--shortstat", `${from}...${head}`]));
  } catch {
    return null;
  }
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** `git merge-tree --name-only` output into the conflicted paths: the first line is the tree, then one path per line until the blank line before the messages. */
export function mergeTreeConflicts(stdout: string): string[] {
  const [, ...rest] = stdout.split("\n");
  const end = rest.indexOf("");
  return [...new Set((end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim()).filter(Boolean))];
}

/**
 * Where the branch stands against the moving main (origin/main, fetched first
 * when it can be): how far behind, which of its files main changed since the
 * branch was cut, and what conflicts merging today. A card proven on a base
 * hundreds of commits old said Ship over prompts main had since rewritten.
 * Null when git cannot say (no such ref, not a checkout).
 */
async function branchBase({ cwd, head }: { cwd: string; head: string }, main = "origin/main"): Promise<BranchBase | null> {
  const [remote, ...branch] = main.split("/");
  if (remote === "origin" && branch.length) await runGit(cwd, ["fetch", "--quiet", "origin", branch.join("/")]).catch(() => {});
  try {
    const mergeBase = (await runGit(cwd, ["merge-base", main, head])).trim();
    const behind = Number((await runGit(cwd, ["rev-list", "--count", `${head}..${main}`])).trim()) || 0;
    const touched = lines(await runGit(cwd, ["diff", "--name-only", `${mergeBase}..${head}`]));
    const changedOnMain = touched.length && behind ? lines(await runGit(cwd, ["diff", "--name-only", `${mergeBase}..${main}`, "--", ...touched])) : [];
    // merge-tree exits 1 when the merge conflicts and prints the paths either way.
    const merged = await runGit(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", main, head])
      .then(() => "", (err: { code?: number; stdout?: string }) => {
        if (err.code === 1 && typeof err.stdout === "string") return err.stdout;
        throw err;
      });
    return { behind, changedOnMain, conflicts: merged ? mergeTreeConflicts(merged) : [] };
  } catch {
    return null;
  }
}

/** Agent minutes summed over the task's workflow runs, with the tokens and dollars their sessions cost (lineTrial.problemCost's run part). */
export function runCost(runs: Array<{ created_at?: number; updated_at: number }>, priced?: { tokens?: number; run_usd?: number } | null): { tokens: number; minutes: number; usd: number } {
  let ms = 0;
  for (const r of runs) if (r.created_at !== undefined) ms += Math.max(0, r.updated_at - r.created_at);
  return { tokens: priced?.tokens ?? 0, minutes: ms / 60_000, usd: priced?.run_usd ?? 0 };
}

/** The run a card is built in: the task's live run, else its newest. */
export const currentRun = <R extends { status?: string; created_at?: number }>(runs: R[]): R | undefined =>
  runs.find((r) => r.status === "running" || r.status === "paused") ?? [...runs].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];

// A card names the goal from the task's own workspace, never the shell's
// active one: a codecast cause built from a shell pointed at Union still
// finds its codecast project.
export function taskWorkspaceScope(task: { workspace?: string; project_id?: string }) {
  const project = task.project_id ? { project: String(task.project_id) } : {};
  const key = task.workspace ?? "";
  if (key.startsWith("team:")) return { workspace: "team" as const, team_id: key.slice(5), ...project };
  if (key.startsWith("user:")) return { workspace: "personal" as const, ...project };
  return { project_path: process.cwd(), ...project };
}

async function buildCard(deps: PublishDeps, options: BuildOptions): Promise<void> {
  const task = await apiPost(deps, "/cli/work/get", { short_id: options.task }, { read: true });
  if (!task?.short_id) fail(`Task not found: ${options.task}`);
  const optional = (p: Promise<any>) => p.catch(() => null);
  const goalRef: string | undefined = task.goal_ref && task.goal_ref !== "none" ? task.goal_ref : undefined;
  const [evidence, runs, signals, brief, history] = await Promise.all([
    optional(apiPost(deps, "/cli/work/evidence", { task_id: task.short_id }, { read: true, exitOnError: false })),
    optional(apiPost(deps, "/cli/workflow-runs/list", { task_id: task.short_id }, { read: true, exitOnError: false })),
    // The finders behind the cause, and the goal its ref names: the task
    // carries the ref and the signal count, the card says them in words.
    optional(apiPost(deps, "/cli/signal/ls", { task: task.short_id, limit: 200 }, { read: true, exitOnError: false })),
    goalRef ? optional(apiPost(deps, "/cli/goals/brief", taskWorkspaceScope(task), { read: true, exitOnError: false })) : null,
    // The cause's earlier shipped fixes, shown beside this change (line-workspace.md LW5).
    optional(apiPost(deps, "/cli/work/history", { short_id: task.short_id }, { read: true, exitOnError: false })),
  ]);
  // The runs' sessions priced the way the trial's spend prices them, so a card says what reaching it cost.
  const priced = await optional(apiPost(deps, "/cli/line/problem-cost", { ...taskWorkspaceScope(task), task: task.short_id }, { read: true, exitOnError: false }));
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
  // The card's author's fields in one object (a card-words node's whole JSON); a flag of the same name wins.
  const words = options.words ? parseWords(options.words) : {};
  for (const k of ["headline", "context", "wrong", "change", "recommend", "why", "ask"] as const) {
    if (options[k] === undefined && typeof words[k] === "string") options[k] = words[k] as string;
  }
  const examples = Array.isArray(words.examples) ? words.examples.map((ex: any) => ({
    input: String(ex?.input ?? "").trim(),
    before: String(ex?.before ?? "").trim(),
    after: String(ex?.after ?? "").trim(),
    note: String(ex?.note ?? "").trim(),
  })) : null;
  const seen = Array.isArray(words.seen) ? words.seen.map((x: any) => ({
    signal: String(x?.signal ?? "").trim(),
    asked: String(x?.asked ?? "").trim(),
    quote: String(x?.quote ?? "").trim(),
    ...(typeof x?.missing === "string" && x.missing.trim() ? { missing: x.missing.trim() } : {}),
  })) : null;
  // Kept as written, so the validator names a malformed one rather than the card silently losing it.
  const reach = words.reach && typeof words.reach === "object" ? words.reach : null;
  const stops = words.stops && typeof words.stops === "object" ? words.stops : null;
  const risk = words.risk && typeof words.risk === "object" && typeof words.risk.reason === "string"
    ? { class: String(words.risk.class ?? "") as RiskClass, reason: words.risk.reason }
    : null;
  if (options.recommend && !CHANGE_VERDICTS.includes(options.recommend as ChangeVerdict)) {
    fail(`--recommend takes ${CHANGE_VERDICTS.join(" | ")}, got "${options.recommend}"`);
  }
  const base = options.base ?? evalResult?.base.sha ?? "origin/main";
  const refs = await changeRefs(base, task.short_id);

  const card = assembleChangeCard({
    task: named,
    evidence: evidence && Array.isArray(evidence.files_changed) ? (evidence as CardEvidenceInput) : null,
    // The run building this card is the task's live one; its own Verify step speaks for it.
    verify: runVerify(currentRun<{ status?: string; created_at?: number; node_statuses?: Parameters<typeof runVerify>[0] }>(Array.isArray(runs?.runs) ? runs.runs : [])?.node_statuses),
    evalResult,
    proof,
    diff: await branchDiff(refs),
    base: await branchBase(refs),
    cost: runCost(Array.isArray(runs?.runs) ? runs.runs : [], priced),
    headline: options.headline,
    context: options.context,
    wrong: options.wrong,
    change: options.change,
    recommend: options.recommend ? { verdict: options.recommend as ChangeVerdict, why: options.why?.trim() ?? "" } : null,
    ask: options.ask,
    earlier: Array.isArray(history?.earlier) ? history.earlier : null,
    examples,
    seen,
    reach,
    stops,
    risk,
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

/** `cast card proposal`: a proposal gate's card from its words node's fields, validated and written where the gate's card attribute reads it. */
function buildProposal(options: { words: string; out: string; json?: boolean }): void {
  const words = parseWords(options.words);
  const card = { kind: "proposal", ...words };
  const checked = validateProposalCard(card);
  const errors = checked.ok ? [] : checked.errors;
  const out = path.resolve(options.out);
  if (!errors.length) fs.writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
  if (options.json) console.log(JSON.stringify({ card, errors, card_json: errors.length ? null : out }, null, 2));
  else if (errors.length) {
    console.error(fmt.error(`The proposal card is not ready (${errors.length}):`));
    for (const e of errors) console.error(`  ${e}`);
  } else console.log(`${fmt.label("proposal:")} ${out}`);
  if (errors.length) process.exit(1);
}

export function registerCardCommand(program: Command, deps: PublishDeps): void {
  const card = program.command("card").description(commandGroup("card").description);

  card
    .command("proposal")
    .description("Validate a proposal gate's card (question, today, after, cause, case, risk) and write it for the gate's card attribute")
    .requiredOption("--words <json>", "The words node's fields in one JSON object (or a file)")
    .requiredOption("--out <file>", "Where the proposal card goes")
    .option("--json", "Print { card, errors, card_json }")
    .action((options: { words: string; out: string; json?: boolean }) => buildProposal(options));

  card
    .command("build")
    .description("Assemble, validate and render the change card for a task (LE10)")
    .requiredOption("--task <ct-N>", "The problem the card is for")
    .option("--eval-result <file>", "The eval station's eval-result.json: verdicts, proven freezes, flipped examples")
    .option("--proof <file>", "A proof recorded outside evals: { before: Check[], after: Check[] }, red then green")
    .option("--headline <text>", stdinText("The card's title in plain words, under 80 characters"))
    .option("--context <text>", stdinText("One sentence: what the affected part of the product is and who sees it"))
    .option("--wrong <text>", stdinText("What is wrong, in the user's terms, one or two sentences"))
    .option("--change <text>", stdinText("What behaves differently after this change, one or two sentences"))
    .option("--recommend <verdict>", `${CHANGE_VERDICTS.join(" | ")}`)
    .option("--why <text>", stdinText("One sentence on why that recommendation"))
    .option("--words <json>", "The author's fields in one JSON object (or a file): headline, context, wrong, change, recommend, why, ask (the suggested Revise note), risk { class, reason }, seen [{ signal, asked, quote, missing }], reach { conversations, of }, stops { per_week, what, next } and examples [{ input, before, after, note }]; a flag of the same name wins")
    .option("--base <ref>", "Base for the diff stats (default: the eval result's base, else origin/main)")
    .option("--dir <dir>", "A run's directory: reads eval-result.json and proof.json from it when present, and writes card.json there")
    .option("--out <file>", "Where card.json goes (default: card.json, in --dir when given); the page goes beside it as .html")
    .option("--publish", "Publish the page and attach it to the task as evidence (only when the card is valid)")
    .option("--json", "Print { card, errors, card_json, card_html, published }")
    .action((options: BuildOptions) => buildCard(deps, options));
}
