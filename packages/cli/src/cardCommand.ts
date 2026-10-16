// `cast card build`: the change card (docs/architecture/the-line-end-to-end.md
// LE10) for one task. It reads what the line's nodes recorded (the task's cause
// and ground fields, its evidence, its runs, the eval station's
// eval-result.json, a recorded proof, the branch's diff), takes what the
// author decided (its recommendation, and the findings the change covers, from
// which reach is counted) plus any optional card words, validates, writes
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
  type CardReach,
  type ChangeCard,
  type ChangeVerdict,
  type RiskClass,
} from "@codecast/shared/contracts/changeCard";
import { alongsideMissing, validateProposalCard, type ProposalProof } from "@codecast/shared/contracts/proposalCard";
import { findingConversation } from "@codecast/shared/contracts/judges";
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
  fail("--words takes a JSON object (or a file holding one): recommend, why, and covers (the sg-N the change reaches), plus any of the card's optional fields");
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

/**
 * What reaching the card took: the minutes the runs' stations worked, the
 * tokens their sessions read and wrote, the money the runs billed (call
 * nodes, sessions on a metered key) and their subscription sessions at API
 * list price, an equivalent never billed (lineTrial.problemCost's run part).
 * A run's wall clock is not its work: a card asked again after a night at its
 * gate read "Built in 1059 min" for a 41 minute build. Where the server does
 * not say the working minutes, the stations' own start-to-finish times are
 * summed here, a waiting gate (no finish) left out.
 */
export function runCost(runs: Array<{ node_statuses?: Array<{ started_at?: number; completed_at?: number }> }>, priced?: { tokens?: number; run_billed_usd?: number; run_list_usd?: number; minutes?: number } | null): { tokens: number; minutes: number; usd: number; list_usd: number } {
  let ms = 0;
  for (const r of runs) for (const n of r.node_statuses ?? []) if (n.started_at !== undefined && n.completed_at !== undefined) ms += Math.max(0, n.completed_at - n.started_at);
  return { tokens: priced?.tokens ?? 0, minutes: priced?.minutes ?? ms / 60_000, usd: priced?.run_billed_usd ?? 0, list_usd: priced?.run_list_usd ?? 0 };
}

/**
 * The problem as it stands when a card is built: its live findings, each with
 * the conversation it belongs to (c1, c2, ... so two findings of one
 * conversation show as one), and how many conversations that is. The card's
 * author reads reach from this and nothing else; null when the findings could
 * not be read.
 */
export type ProblemFacts = { conversations: number; findings: Array<{ signal: string; conversation: string }> };
export function problemFacts(signals: Array<{ _id: string; short_id?: string; fingerprint?: string; moment?: string }> | null): ProblemFacts | null {
  if (!signals) return null;
  const names = new Map<string, string>();
  const findings = signals.filter((sg) => typeof sg.short_id === "string").map((sg) => {
    const key = findingConversation(sg);
    if (!names.has(key)) names.set(key, `c${names.size + 1}`);
    return { signal: sg.short_id!, conversation: names.get(key)! };
  });
  return { conversations: names.size, findings };
}

/**
 * The author's reach with its counts taken from the record, never from the
 * author: `of` is the problem's conversations now (none is 0, not the
 * author's number: tc-68 said "1 of 1" over a problem with no finding left),
 * `conversations` the distinct conversations among the live findings it says
 * the change covers, and `read` the live findings, so a later reader can tell
 * a finding that arrived after the card from one its author left out. With no
 * `covers`, or findings that could not be read, the author's own counts stand.
 */
export function countedReach<R extends Record<string, any>>(reach: R, problem: ProblemFacts | null): R {
  if (!problem) return reach;
  const covers: string[] | null = Array.isArray(reach.covers) ? reach.covers.filter((x: unknown): x is string => typeof x === "string") : null;
  const covered = covers ? new Set(problem.findings.filter((f) => covers.includes(f.signal)).map((f) => f.conversation)).size : null;
  return {
    ...reach,
    of: problem.conversations,
    ...(covered !== null ? { conversations: covered } : typeof reach.conversations === "number" ? { conversations: Math.min(reach.conversations, problem.conversations) } : {}),
    ...(problem.findings.length ? { read: problem.findings.map((f) => f.signal) } : {}),
  };
}

/**
 * The reach a card carries from its author's words: `reach` as written, or the
 * bare `covers` a presenting station pins (the findings its change reaches),
 * with both counted from the problem's live findings (countedReach). Bare
 * covers with no findings to count against say nothing a card can show, so
 * they give no reach rather than a made-up count.
 */
export function authorReach(words: Record<string, any>, problem: ProblemFacts | null): CardReach | null {
  if (words.reach && typeof words.reach === "object") return countedReach(words.reach, problem);
  if (!Array.isArray(words.covers) || !problem) return null;
  return countedReach({ covers: words.covers } as CardReach, problem);
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
  const { project: _project, ...scope } = taskWorkspaceScope(task) as ReturnType<typeof taskWorkspaceScope> & { project?: string };
  const priced = await optional(apiPost(deps, "/cli/line/problem-cost", { ...scope, task: task.short_id }, { read: true, exitOnError: false }));
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
  // `of` is the problem's conversations now, counted here from its live findings, so every card counts the same set; the author says how many of them the change reaches.
  const problem = problemFacts(Array.isArray(signals?.signals) ? signals.signals : null);
  const liveConversations = problem?.conversations ?? 0;
  const reach = authorReach(words, problem);
  const stops = words.stops && typeof words.stops === "object" ? words.stops : null;
  const overturns = words.overturns && typeof words.overturns === "object" ? words.overturns : null;
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
    overturns,
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
    console.log(JSON.stringify({ card, ...(problem ? { problem } : {}), errors, card_json: outJson, card_html: outHtml, ...(published ? { published } : {}) }, null, 2));
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

/** The proof station's facts a proposal card carries (ProposalProof), from its prove.json; null when it names no rung. */
export function proposalProof(raw: string | undefined): ProposalProof | null {
  if (!raw?.trim()) return null;
  let p: Record<string, unknown>;
  try {
    const v = JSON.parse(fs.existsSync(raw) ? fs.readFileSync(raw, "utf-8") : raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    p = v;
  } catch { return null; }
  const rung = typeof p.rung === "string" ? p.rung.trim() : "";
  if (!rung) return null;
  const prior = typeof p.prior_art === "string" ? p.prior_art.trim() : "";
  return { rung, outcome: typeof p.outcome === "string" ? p.outcome.trim() : "", ...(prior ? { prior_art: prior } : {}) };
}

/** Why a proposal's case cannot stand: it must be one of the problem's live findings, the conversation the card shows. */
export function caseNotLive(card: { case?: { signal?: unknown } | null }, live: string[]): string | null {
  const signal = card.case && typeof card.case.signal === "string" ? card.case.signal : null;
  if (!signal || live.includes(signal)) return null;
  return live.length
    ? `case.signal: ${signal} is not one of this problem's live findings; pick one of ${live.join(", ")}`
    : `case.signal: ${signal} is not one of this problem's findings, and it has none live; set case to null`;
}

/** Waiting trial cards on other problems whose fix changes the same code as this proposal and that its `alongside` leaves out. */
async function alongsideUnsaid(deps: PublishDeps, task: string, card: { alongside?: []; cause?: { where?: unknown } }): Promise<string[]> {
  const where = Array.isArray(card.cause?.where) ? (card.cause!.where as unknown[]).filter((w): w is string => typeof w === "string") : [];
  if (!where.length) return [];
  const { scopeFor } = await import("./lineScope.js");
  const scope: Record<string, unknown> = { ...(await scopeFor(deps, undefined, true).catch(() => ({}))) };
  delete scope.project;
  const projects: Array<{ title: string }> | null = await apiPost(deps, "/cli/line/trial/projects", scope, { read: true, exitOnError: false }).catch(() => null);
  const others: Array<{ card: string; where: string[] }> = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    const cards: Array<{ short_id: string; status: string; task_short_id: string; proposal?: { cause?: { where?: string[] } }; card?: { cause?: { where?: string[] } } }> | null =
      await apiPost(deps, "/cli/line/trial/cards", { ...scope, project: p.title }, { read: true, exitOnError: false }).catch(() => null);
    if (!Array.isArray(cards) || !cards.some((c) => c.task_short_id === task)) continue;
    for (const c of cards) {
      const w = c.proposal?.cause?.where ?? c.card?.cause?.where ?? [];
      if (c.status === "waiting" && c.task_short_id !== task && w.length) others.push({ card: c.short_id, where: w });
    }
  }
  return alongsideMissing(card, where, others);
}

/** `cast card proposal`: a proposal gate's card from its words node's fields, validated and written where the gate's card attribute reads it. */
async function buildProposal(deps: PublishDeps, options: { words: string; out: string; json?: boolean; task?: string; prove?: string }): Promise<void> {
  const words = parseWords(options.words);
  const proof = proposalProof(options.prove);
  const card = { kind: "proposal", ...words, ...(proof ? { proof } : {}) };
  const checked = validateProposalCard(card, { line: true });
  const errors = checked.ok ? [] : [...checked.errors];
  // The case is a conversation on this problem now: a finding judged away or filed elsewhere is not its evidence.
  if (options.task) {
    const ls = await apiPost(deps, "/cli/signal/ls", { task: options.task, limit: 200 }, { read: true, exitOnError: false }).catch(() => null);
    if (ls && Array.isArray(ls.signals)) {
      const notLive = caseNotLive(card as { case?: { signal?: unknown } | null }, ls.signals.map((sg: { short_id: string }) => sg.short_id));
      if (notLive) errors.push(notLive);
    }
    const missing = await alongsideUnsaid(deps, options.task, card as { alongside?: []; cause?: { where?: unknown } });
    if (missing.length) errors.push(`alongside: ${missing.join(", ")} ${missing.length === 1 ? "waits" : "wait"} on a fix to the same code; read ${missing.length === 1 ? "it" : "them"} (cast line trial --json) and say in one line each how the two meet: which applies when both fire, or that they do not conflict`);
  }
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
    .option("--task <ct-N>", "The problem: the case must be one of its live findings")
    .option("--prove <json>", "The proof station's prove.json (or a file): its rung, outcome and prior art go on the card")
    .option("--json", "Print { card, errors, card_json }")
    .action((options: { words: string; out: string; json?: boolean; task?: string; prove?: string }) => buildProposal(deps, options));

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
    .option("--words <json>", "The author's fields in one JSON object (or a file), such as a presenting station's pinned result: recommend and why, covers [sg-N] (the findings the change reaches; the card counts reach from them), and optionally headline, context, wrong, change, ask (the suggested Revise note), risk { class, reason }, seen [{ signal, asked, quote, missing }], reach { conversations, of, covers }, stops { per_week, what, next, basis }, overturns { ref, by, what, why } and examples [{ input, before, after, note }]; other keys (question, page) are the author's decision's and are ignored; a flag of the same name wins")
    .option("--base <ref>", "Base for the diff stats (default: the eval result's base, else origin/main)")
    .option("--dir <dir>", "A run's directory: reads eval-result.json and proof.json from it when present, and writes card.json there")
    .option("--out <file>", "Where card.json goes (default: card.json, in --dir when given); the page goes beside it as .html")
    .option("--publish", "Publish the page and attach it to the task as evidence (only when the card is valid)")
    .option("--json", "Print { card, errors, card_json, card_html, published }")
    .action((options: BuildOptions) => buildCard(deps, options));
}
