// The task graph on the command line (docs/architecture/task-graph.md): one
// blocker grammar for every flag (TG3), the graph lines `cast task show` and
// `context` print (TG12), links that do not block (TG5), and plans that write
// their own order (TG6).

import type { Command } from "commander";
import {
  holdsBack,
  isPrWaitTarget,
  isTerminalTaskStatus,
  isWaitId,
  notReadyLabel,
  numberedWaveError,
  parseBlockerRef,
  parseStepLines,
  planTail,
  stepsFromWaves,
  taskRefLine,
  templateSteps,
  topologicalOrder,
  UNKNOWN_BLOCKER_STATUS,
  waitingOnLabel,
  waitLabel,
  waitMetLabel,
  type Blocker,
  type GraphTask,
  type NotReadyReason,
  type PlanStep,
  type TaskWait,
  type WaitLabelOptions,
} from "@codecast/shared/tasks";
import { localTimeZone } from "@codecast/shared/time";
import { checkoutRepository, checkoutWords } from "./checkoutWords.js";
import { c, fmt } from "./colors.js";
import { shq } from "./remote/session-move.js";
import { stdinText } from "./sendBody.js";
import { workOriginStamp } from "./sessionIdentity.js";

/** What the commands here need from index.ts. */
export type GraphDeps = {
  cliPost: (path: string, body: Record<string, any>, opts?: { throwOnError?: boolean }) => Promise<any>;
  sessionId: () => string | null;
  cwd: () => string;
  printJson: (value: unknown) => void;
  /** The workspace a read resolves to: `--team`, else the directory's or the active one. */
  workspace: (team?: string) => Promise<{ workspace: "team"; team_id: string } | { workspace: "personal" }>;
};

// ---------------------------------------------------------------------------
// Blocker refs (TG3)
// ---------------------------------------------------------------------------

/** A ref routed to its route: a task edge, a wait, or (removal only) a wait by id. */
export type RoutedRef =
  | { kind: "task"; ref: string }
  | { kind: "wait"; ref: string; barePr: boolean }
  | { kind: "wait_id"; id: string };

/** `--blocked-by` help, on every command that takes it. */
export const BLOCKER_REFS_HELP = `Comma-separated blockers of any kind: a task (ct-12), a PR to merge ("#42", quoted since # starts a shell comment; owner/repo#42, a PR URL; add :checks to wait on green CI), a decision (sd-4) or a time (2h, 2026-10-14T09:00)`;

/** `--blocked-by ct-4,#42:checks` → each ref, trimmed. */
export function splitRefs(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Where a blocker ref goes: a task to the dependency routes, anything else
 * to the wait routes. Throws the grammar's own error, which lists the
 * accepted forms. `removing` also takes a wait's id.
 */
export function routeBlockerRef(text: string, opts: { now?: number; removing?: boolean } = {}): RoutedRef {
  const trimmed = text.trim();
  // A met time wait stays as history, so removing one may name a past time.
  const parsed = parseBlockerRef(trimmed, { now: opts.now, allowPast: opts.removing });
  if (!parsed.ok) {
    // A wait's id (isWaitId) is checked after the grammar, which it could pass for.
    if (opts.removing && isWaitId(trimmed)) return { kind: "wait_id", id: trimmed };
    throw new Error(opts.removing ? `${parsed.error}. A wait can also be removed by its id, the w… code cast task show prints after it` : parsed.error);
  }
  if (parsed.kind === "task") return { kind: "task", ref: parsed.ref };
  return { kind: "wait", ref: trimmed, barePr: isPrWaitTarget(parsed) && !parsed.repository };
}


/** What adding waits sends beside the refs: this machine's zone, and this
 *  checkout's repository, the fallback for a bare `#42` when the task's
 *  project names none. */
export function waitScope(refs: Array<Exclude<RoutedRef, { kind: "task" }>>, cwd: string): { time_zone: string; repository?: string } {
  const repository = refs.some((r) => r.kind === "wait" && r.barePr) ? checkoutRepository(cwd) : null;
  return { time_zone: localTimeZone(), ...(repository ? { repository } : {}) };
}

/** The body of `/cli/work/wait` or `/cli/work/unwait` for one routed ref.
 *  Removal sends no repository: a bare `#42` removes that number's waits in
 *  any repository, and the route's validator has no such field. */
export function waitBody(shortId: string, r: Exclude<RoutedRef, { kind: "task" }>, ctx: { cwd: string; sessionId?: string | null; removing?: boolean }): Record<string, any> {
  const body: Record<string, any> = { short_id: shortId, ...(ctx.removing ? { time_zone: localTimeZone() } : waitScope([r], ctx.cwd)) };
  if (r.kind === "wait_id") body.wait_id = r.id;
  else body.ref = r.ref;
  if (ctx.sessionId) body.conversation_id = ctx.sessionId;
  return body;
}

/** "waiting on PR #42", "waiting until 09:00". */
const waitingOn = (w: TaskWait, words: WaitLabelOptions) => waitingOnLabel(w, { ...words, lower: true });

/** What adding a wait printed: met at once, already there, or now waiting.
 *  `words` names PRs as the checkout reads them (checkoutWords). */
export function waitAddedLine(shortId: string, result: { wait: TaskWait; met: boolean; existing?: boolean }, words: WaitLabelOptions = {}): string {
  if (result.existing) return `${shortId} was already ${waitingOn(result.wait, words)}`;
  if (result.met) return `${shortId} has nothing to wait for: ${waitMetLabel(result.wait, words)} already`;
  return `${shortId} is ${waitingOn(result.wait, words)}`;
}

/** What adding a task blocker printed. A done or dropped blocker holds
 *  nothing, so the edge is recorded but the task is not blocked. */
export function depAddedLine(shortId: string, blocker: string, result: { blocker_status?: string } | null | undefined): string {
  const status = result?.blocker_status;
  return isTerminalTaskStatus(status) ? `${blocker} is already ${status}, so it does not block ${shortId}` : `${shortId} is blocked by ${blocker}`;
}

/**
 * Add or remove blockers of any kind on one task: tasks through the
 * dependency routes, waits through the wait routes. Every ref is parsed
 * before the first write, so a ref the grammar rejects changes nothing; one
 * the server refuses stops the run after the earlier ones, each printed `ok`.
 */
export async function applyBlockers(deps: GraphDeps, shortId: string, refs: string[], mode: "add" | "remove"): Promise<void> {
  const routed = refs.map((r) => routeBlockerRef(r, { removing: mode === "remove" }));
  const ctx = { cwd: deps.cwd(), sessionId: deps.sessionId() };
  const words = checkoutWords(ctx.cwd);
  for (const r of routed) {
    if (r.kind === "task") {
      const result = await deps.cliPost(mode === "add" ? "/cli/work/dep" : "/cli/work/undep", { short_id: shortId, blocked_by: r.ref, ...writerOf(deps) });
      console.log(`${c.green}ok${c.reset} ${mode === "add" ? depAddedLine(shortId, r.ref, result) : `${shortId} is no longer blocked by ${r.ref}`}`);
    } else if (mode === "add") {
      const result = await deps.cliPost("/cli/work/wait", waitBody(shortId, r, ctx));
      console.log(`${c.green}ok${c.reset} ${waitAddedLine(shortId, result, words)}`);
    } else {
      const result = await deps.cliPost("/cli/work/unwait", waitBody(shortId, r, { ...ctx, removing: true }));
      for (const w of (result?.removed ?? []) as TaskWait[]) console.log(`${c.green}ok${c.reset} ${shortId} is no longer ${waitingOn(w, words)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The graph lines of `cast task show` and `context` (TG12)
// ---------------------------------------------------------------------------

type LinkRef = { short_id: string; title?: string; status: string; missing?: true };

/** `tasks.get` / `tasks.context` `links`. Absent on a server older than the graph. */
export type GraphLinks = {
  blocked_by?: LinkRef[];
  blocks?: LinkRef[];
  found_during?: LinkRef | null;
  found_here?: LinkRef[];
  related?: LinkRef[];
  superseded_by?: LinkRef | null;
};

export type GraphSection = { label: string; items: string[]; holds?: boolean };

type GraphTaskRow = { blocked_by?: string[] | null; blocks?: string[] | null; waits?: TaskWait[] | null };

type Inline = (s: string) => string;
const asIs: Inline = (s) => s;

/** "Superseded by: ct-12 New plan [open]", printed right under the task's
 *  header, as the web shows the replacement at the top (TG12). */
export function supersededLine(links: GraphLinks | null | undefined, inline: Inline = asIs): string | null {
  return links?.superseded_by ? `Superseded by: ${taskRefLine(links.superseded_by, inline)}` : null;
}

/**
 * The task's graph, in the web's order and words: Blocked by (tasks with
 * their status, then waits with their state), Blocks, Found during, Found
 * here, Related. Empty sections are left out. `holds` marks a Blocked by
 * section with something still open; one with nothing open says "cleared".
 * Each wait ends with its id, which `--remove-blocked-by` takes (`waitId`
 * styles it). `inline` cleans a title for a reader that feeds the output to
 * an agent.
 */
export function taskGraphSections(t: GraphTaskRow, links: GraphLinks | null | undefined, opts: WaitLabelOptions & { inline?: Inline; waitId?: Inline } = {}): GraphSection[] {
  const inline = opts.inline ?? asIs;
  const waitId = opts.waitId ?? asIs;
  const task = (l: LinkRef) => taskRefLine(l, inline);
  const wait = (w: TaskWait) => `${waitLabel(w, opts)} (${w.state}${w.note ? `: ${inline(w.note)}` : ""})${waitId(` · id ${w.id}`)}`;
  const waits = t.waits ?? [];
  // A server older than the graph sends no links; its raw ids are all it can say.
  const blockers: LinkRef[] = links?.blocked_by ?? (t.blocked_by ?? []).map((ref) => ({ short_id: ref, status: UNKNOWN_BLOCKER_STATUS }));
  // The shared rule (graph.ts), not a copy: a cleared or missing entry holds nothing.
  const entries: Blocker[] = [...blockers.map((b): Blocker => (b.missing ? { kind: "task", ref: b.short_id, missing: true } : { kind: "task", ref: b.short_id, status: b.status })), ...waits];
  const holds = entries.some(holdsBack);
  const sections: GraphSection[] = [
    { label: holds ? "Blocked by" : "Blocked by (cleared)", items: [...blockers.map(task), ...waits.map(wait)], holds },
    { label: "Blocks", items: links?.blocks ? links.blocks.map(task) : (t.blocks ?? []) },
    { label: "Found during", items: links?.found_during ? [task(links.found_during)] : [] },
    { label: "Found here", items: (links?.found_here ?? []).map(task) },
    { label: "Related", items: (links?.related ?? []).map(task) },
  ];
  return sections.filter((s) => s.items.length);
}

/**
 * Why `cast task ready` leaves an open task out when no blocker says: the
 * server's `not_ready` reason ("Not ready: its parent is being worked"), and
 * whose an ephemeral task is, since only its owner gets it (TG9).
 */
export function offFrontierLines(t: GraphTask, reason: NotReadyReason | null | undefined): string[] {
  const lines = reason ? [`Not ready: ${notReadyLabel(t, { ready: false, reason })}`] : [];
  if (t.ephemeral && t.status === "open") lines.push(`Ephemeral: only the ${t.created_from_conversation ? "session" : "person"} that filed it gets it from cast task ready`);
  return lines;
}

// ---------------------------------------------------------------------------
// Plans that write their own order (TG6)
// ---------------------------------------------------------------------------

/** A step to create, and any tasks already filed it waits on besides the
 *  steps its `after` names (`stepsFromTitles`). */
export type FiledStep = PlanStep & { blocked_by?: string[] };

/**
 * Create `steps` in `planId` in order, each blocked by the steps its `after`
 * names. A step that waits on no other step waits on `roots` instead (the
 * plan's last wave, when appending). Plan steps are the plan's own
 * decomposition, so none is recorded as found while working on the
 * session's task. A refused create throws with what was filed and how to
 * add the rest (`unfiledStepsAdvice`).
 */
export async function createPlanSteps(
  deps: GraphDeps,
  planId: string,
  steps: FiledStep[],
  opts: { roots?: string[]; base?: Record<string, any>; say?: (line: string) => void } = {},
): Promise<Array<{ short_id: string; title: string; blocked_by: string[] }>> {
  const created: Array<{ short_id: string; title: string; blocked_by: string[] }> = [];
  for (const step of steps) {
    const blocked_by = [...(step.after.length ? step.after.map((i) => created[i].short_id) : opts.roots ?? []), ...(step.blocked_by ?? [])];
    const { after: _after, blocked_by: _filed, ...fields } = step;
    let result: any;
    try {
      result = await deps.cliPost("/cli/work/create", {
        ...opts.base,
        ...fields,
        plan_id: planId,
        found_during: "none",
        ...(blocked_by.length ? { blocked_by } : {}),
      }, { throwOnError: true });
    } catch (err) {
      throw new Error(`${(err as Error).message}\n${unfiledStepsAdvice(planId, steps, created, opts.roots ?? [], opts.base)}`);
    }
    created.push({ short_id: result.short_id, title: step.title, blocked_by });
    const needs = blocked_by.length ? fmt.muted(`  needs ${blocked_by.join(", ")}`) : "";
    opts.say?.(`  ${c.green}+${c.reset} ${c.cyan}${result.short_id}${c.reset}: ${step.title}${needs}`);
  }
  return created;
}

/**
 * How to add the steps a refused create left unfiled, in their order. Each one
 * whose blockers were all filed gets its own `cast task create` with them,
 * filed where `base` files steps (a person's board, the plan's project and
 * workspace). The steps that need those follow as a `cast plan steps`
 * heredoc in waves, which puts them after the plan's last wave: by then the
 * steps just created. Appending the whole remainder that way would make the
 * rest of a half-filed wave wait on its own filed siblings.
 */
function unfiledStepsAdvice(planId: string, steps: FiledStep[], created: Array<{ short_id: string }>, roots: string[], base: Record<string, any> = {}): string {
  const filed = created.length ? `${created.length} of ${steps.length} steps filed (${created.map((s) => s.short_id).join(", ")}); ` : "";
  const rest = steps.slice(created.length);
  const now = rest.filter((s) => s.after.every((i) => i < created.length));
  const human = base.source === "human" ? " --human" : "";
  const where = [
    human,
    base.project_id ? ` --project ${shq(String(base.project_id))}` : "",
    base.workspace === "team" && base.team_id ? ` --team ${shq(String(base.team_id))}` : base.workspace === "personal" ? " --team personal" : "",
  ].join("");
  const commands = now.map((s) => {
    const blockers = [...(s.after.length ? s.after.map((i) => created[i].short_id) : roots), ...(s.blocked_by ?? [])];
    return [
      `  cast task create ${shq(s.title)} --plan ${planId} --found-during none${where}`,
      s.description ? ` -d ${shq(s.description)}` : "",
      s.task_type ? ` -t ${s.task_type}` : "",
      s.priority ? ` -p ${s.priority}` : "",
      s.labels?.length ? ` --labels ${shq(s.labels.join(","))}` : "",
      blockers.length ? ` --blocked-by ${blockers.join(",")}` : "",
    ].join("");
  });
  const later = rest.filter((s) => !now.includes(s));
  // Each later step's wave: one past the latest later step it needs.
  const wave = new Map<FiledStep, number>();
  for (const s of later) wave.set(s, Math.max(0, ...s.after.map((i) => steps[i]).filter((p) => wave.has(p)).map((p) => wave.get(p)! + 1)));
  const waves: string[][] = [];
  for (const s of later) (waves[wave.get(s)!] ??= []).push(`${s.title}${s.description ? ` :: ${s.description.replace(/\s*\n\s*/g, " ")}` : ""}`);
  const heredoc = `cast plan steps ${planId}${human} - <<'STEPS'\n${waves.map((w) => w.join("\n")).join("\n\n")}\nSTEPS`;
  const then = later.length ? `\nthen the ${later.length} step${later.length === 1 ? "" : "s"} after them, which go after the plan's last wave:\n${heredoc}` : "";
  return `${filed}"${rest[0].title}" and the steps after it were not. Add them with:\n${commands.join("\n")}${then}`;
}

/**
 * Steps that name what they need by title (`cast plan import`, `decompose`),
 * ordered so each comes after what it needs: a step may name one further
 * down. A name that is no step's title is a task already filed: `filed` maps
 * an existing title to its id, and a task id (ct-12) passes as is; those ride
 * on the step as `blocked_by`. Names that resolve to nothing come back in
 * `unknown`, and the steps of each loop in `loops`, with the edge that closes
 * it dropped; a caller refuses either or says what it left out.
 */
export function stepsFromTitles<S extends Omit<PlanStep, "after"> & { blocked_by?: string[] }>(
  items: S[],
  filed: ReadonlyMap<string, string> = new Map(),
): { steps: Array<Omit<S, "blocked_by"> & FiledStep>; unknown: Array<{ step: string; needs: string }>; loops: string[][] } {
  const index = new Map<string, number>();
  items.forEach((s, i) => { if (!index.has(s.title)) index.set(s.title, i); });
  const unknown: Array<{ step: string; needs: string }> = [];
  const nodes = items.map((item, i) => {
    const inner: string[] = [];
    const outer: string[] = [];
    for (const name of item.blocked_by ?? []) {
      const j = index.get(name);
      if (j !== undefined) { inner.push(`#${j}`); continue; }
      const parsed = parseBlockerRef(name);
      const ref = filed.get(name) ?? (parsed.ok && parsed.kind === "task" ? parsed.ref : null);
      if (ref) outer.push(ref);
      else unknown.push({ step: item.title, needs: name });
    }
    return { short_id: `#${i}`, blocked_by: inner, item, outer };
  });
  const titleOf = (id: string) => items[Number(id.slice(1))].title;
  const loops = topologicalOrder(nodes).cycles.map((cycle) => cycle.map(titleOf));
  const steps = templateSteps(nodes).map(({ task: { item, outer }, blocked_by_indices }) => {
    const { blocked_by: _names, ...fields } = item;
    return { ...fields, after: blocked_by_indices, ...(outer.length ? { blocked_by: outer } : {}) };
  });
  return { steps, unknown, loops };
}

/** `--steps`/`steps` input as steps, refusing an empty list with the form,
 *  and numbered lines in one wave (numberedWaveError). */
export function stepsFromText(text: string): PlanStep[] {
  const waves = parseStepLines(text);
  const numbered = numberedWaveError(waves);
  if (numbered) throw new Error(numbered);
  const steps = stepsFromWaves(waves.map((wave) => wave.map((l) => l.text)));
  if (!steps.length) throw new Error("No steps given: one per line, a blank line between waves (steps in a wave run in parallel; each wave needs the one before)");
  return steps;
}

/** A saved template's steps (plan_templates.task_templates). */
export function stepsFromTemplate(template: { task_templates: Array<{ title: string; description?: string; task_type?: string; priority?: string; blocked_by_indices?: number[]; estimated_minutes?: number }> }): PlanStep[] {
  return template.task_templates.map(({ blocked_by_indices, ...t }, i) => ({ ...t, after: (blocked_by_indices ?? []).filter((j) => j < i) }));
}

/** Built-in plan templates: each step needs the one before it. */
const BUILTIN_TEMPLATES: Record<string, Array<{ title: string; description: string; labels: string[] }>> = {
  "plan-implement-verify": [
    { title: "Research and plan approach", description: "Investigate the codebase, understand requirements, and outline the implementation strategy.", labels: ["planning"] },
    { title: "Implement core changes", description: "Build the feature or fix based on the plan.", labels: ["coding"] },
    { title: "Write tests", description: "Add unit and integration tests covering the implementation.", labels: ["testing"] },
    { title: "Verify and polish", description: "Run full test suite, typecheck, review diff, fix issues.", labels: ["verification"] },
  ],
  "implement-review-fix": [
    { title: "Initial implementation", description: "Build the feature or fix.", labels: ["coding"] },
    { title: "Self-review and identify issues", description: "Review the diff, run tests, identify problems.", labels: ["review"] },
    { title: "Fix identified issues", description: "Address all issues found during review.", labels: ["coding"] },
    { title: "Final verification", description: "Confirm all issues resolved, tests pass, code is clean.", labels: ["verification"] },
  ],
  "full-lifecycle": [
    { title: "Research and scope", description: "Understand the problem space, read relevant code, define scope.", labels: ["planning"] },
    { title: "Design approach", description: "Outline the technical approach, identify risks and dependencies.", labels: ["planning"] },
    { title: "Implement", description: "Build the feature following the design.", labels: ["coding"] },
    { title: "Test", description: "Write and run tests.", labels: ["testing"] },
    { title: "Review", description: "Self-review the changes, check for issues.", labels: ["review"] },
    { title: "Fix review findings", description: "Address any issues found during review.", labels: ["coding"] },
    { title: "Final verification and cleanup", description: "Run full CI, clean up dead code, verify everything.", labels: ["verification"] },
  ],
};

export const BUILTIN_TEMPLATE_NAMES = Object.keys(BUILTIN_TEMPLATES);

/** Template names match in any case, built-in or saved (planTemplates.ts). */
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A `planTemplates.list` row. The labels are absent on a server older than them. */
type SavedTemplate = { name: string; description?: string; goal_template?: string; team_id?: string; task_templates: any[]; workspace_label?: string; author?: string; mine?: boolean };

/** "personal", "Acme, by Ann": where a template lives, for telling copies apart. */
const templateWhere = (t: SavedTemplate) => [t.workspace_label, t.author && !t.mine ? `by ${t.author}` : ""].filter(Boolean).join(", ");

/** `--template <name>`: a built-in, else a template saved with `cast plan
 *  template save`. A name saved in several workspaces takes this
 *  workspace's, and within it your own copy; anything still ambiguous is
 *  refused rather than guessed, naming where each copy lives. Unknown names
 *  list what exists. A saved template also carries the goal of the plan it
 *  was saved from. */
export async function planTemplate(deps: GraphDeps, name: string): Promise<{ steps: PlanStep[]; goal?: string }> {
  const builtin = Object.entries(BUILTIN_TEMPLATES).find(([n]) => sameName(n, name))?.[1];
  if (builtin) return { steps: builtin.map((s, i) => ({ ...s, after: i ? [i - 1] : [] })) };
  const saved: SavedTemplate[] = (await deps.cliPost("/cli/plans/templates", {})) ?? [];
  let matches = saved.filter((t) => sameName(t.name, name));
  const copies = () => matches.map(templateWhere).filter(Boolean).join("; ");
  if (matches.length > 1) {
    const here = await deps.workspace();
    const teamId = here.workspace === "team" ? here.team_id : undefined;
    const all = copies();
    matches = matches.filter((t) => (t.team_id ?? undefined) === teamId);
    if (!matches.length) throw new Error(`"${name}" names saved templates in other workspaces${all ? ` (${all})` : ""}, none of them this one; run from a directory of the workspace you mean`);
  }
  if (matches.length > 1 && matches.some((t) => t.mine)) matches = matches.filter((t) => t.mine);
  if (matches.length > 1 && matches.some((t) => t.author)) throw new Error(`"${name}" names templates saved by several people in this workspace (${copies()}); save your own copy under that name to use it`);
  // The list is newest first: an older server without authors gets the newest copy.
  if (matches.length) return { steps: stepsFromTemplate(matches[0]), ...(matches[0].goal_template ? { goal: matches[0].goal_template } : {}) };
  const names = [...BUILTIN_TEMPLATE_NAMES, ...saved.map((t) => `"${t.name}"`)];
  throw new Error(`Unknown template "${name}". Available: ${names.join(", ")}`);
}

/** The session a write names, so the server records an agent's own change
 *  as the agent's and wakes it for nothing (TG2, TG11). */
export function writerOf(deps: Pick<GraphDeps, "sessionId">): { conversation_id?: string } {
  const sessionId = deps.sessionId();
  return sessionId ? { conversation_id: sessionId } : {};
}

/** What every plan step is created with: this checkout, the plan's workspace
 *  and project when known (a directory mapped elsewhere would file the step
 *  outside the plan, and a create inherits no project from its plan), and
 *  the origin the plan itself is stamped with (a person's terminal or
 *  --human files a person's steps, which the board shows). `sessionId` is
 *  the session the plan was stamped with, when its create detected one. */
export function planStepBase(
  deps: GraphDeps,
  opts: { human?: boolean; sessionId?: string | null; plan?: { workspace?: string; team_id?: string; project_id?: string } } = {},
): Record<string, any> {
  const sessionId = opts.sessionId !== undefined ? opts.sessionId : deps.sessionId();
  return {
    project_path: deps.cwd(),
    ...planWorkspace(opts.plan),
    ...(opts.plan?.project_id ? { project_id: opts.plan.project_id } : {}),
    ...workOriginStamp({ sessionId, human: opts.human, stdoutIsTTY: !!process.stdout.isTTY }),
  };
}

/** A plan row's stored access key (`team:<id>` / `user:<id>`) as the
 *  workspace a create names; nothing when the row carries neither. */
export function planWorkspace(plan: { workspace?: string; team_id?: string } | undefined): { workspace: "team"; team_id: string } | { workspace: "personal" } | {} {
  const key = plan?.workspace;
  if (key?.startsWith("team:")) return { workspace: "team", team_id: key.slice(5) };
  if (key?.startsWith("user:")) return { workspace: "personal" };
  return plan?.team_id ? { workspace: "team", team_id: plan.team_id } : {};
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerTaskGraphCommands(work: Command, plan: Command, deps: GraphDeps): void {
  work
    .command("supersede")
    .description("Replace a task with another: the old one is dropped with a note, and whatever waited on it now waits on the replacement")
    .argument("<old_id>", "The task being replaced")
    .requiredOption("--with <new_id>", "The task that replaces it")
    .option("--note <text>", "Why, for the old task's history")
    .action(async (oldId: string, options: any) => {
      const result = await deps.cliPost("/cli/work/supersede", { short_id: oldId, by: options.with, ...(options.note ? { note: options.note } : {}), ...writerOf(deps) });
      console.log(`${c.green}ok${c.reset} ${result.short_id} superseded by ${c.cyan}${result.superseded_by}${c.reset}`);
      if (result.moved?.length) console.log(fmt.muted(`  ${result.moved.join(", ")} now wait${result.moved.length === 1 ? "s" : ""} on ${result.superseded_by}`));
    });

  work
    .command("relate")
    .description("Link two tasks as related (see also); it never blocks either")
    .argument("<a>", "Task short ID")
    .argument("<b>", "Task short ID")
    .option("--remove", "Remove the link")
    .action(async (a: string, b: string, options: any) => {
      await deps.cliPost(options.remove ? "/cli/work/unrelate" : "/cli/work/relate", { short_id: a, other: b, ...writerOf(deps) });
      console.log(`${c.green}ok${c.reset} ${a} and ${b} ${options.remove ? "are no longer related" : "are related"}`);
    });

  plan
    .command("steps")
    .description("Append steps to a plan, after its current last wave (its open tasks nothing else in the plan waits on)")
    .argument("<plan_id>", "Plan short ID")
    .argument("<steps>", stdinText("Steps, one per line (\"Title :: what done means\" adds a description); a blank line starts a wave that needs the one before"))
    .option("--human", "File them as a person's steps (a terminal is detected on its own)")
    .option("--json", "Output the created steps as JSON")
    .action(async (planId: string, text: string, options: any) => {
      let steps: PlanStep[];
      try {
        steps = stepsFromText(text);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      const current = await deps.cliPost("/cli/plans/get", { short_id: planId });
      if (!current) {
        console.error(`Plan not found: ${planId}`);
        process.exit(1);
      }
      const roots = planTail<any>(current.tasks ?? []).map((t) => t.short_id as string);
      const say = options.json ? undefined : (line: string) => console.log(line);
      say?.(roots.length ? fmt.muted(`  after ${roots.join(", ")}`) : fmt.muted("  no open steps to follow; the first wave can start now"));
      let created: Awaited<ReturnType<typeof createPlanSteps>>;
      try {
        created = await createPlanSteps(deps, current.short_id, steps, { roots, base: planStepBase(deps, { human: options.human, plan: current }), say });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      if (options.json) deps.printJson(created);
      else console.log(fmt.muted(`\n  ${created.length} step${created.length === 1 ? "" : "s"} added to ${current.short_id}`));
    });

  const template = plan
    .command("template")
    .description("Save, list or remove plan templates: a plan's steps and their order, which cast plan create --template <name> writes again");

  template
    .command("save")
    .description("Save a plan's steps and their order as a template")
    .argument("<plan_id>", "Plan short ID")
    .option("--name <name>", "Template name (default: the plan's title); saving the same name again replaces your own template of that name in this workspace")
    .option("-d, --description <text>", "What the template is for")
    .action(async (planId: string, options: any) => {
      const result = await deps.cliPost("/cli/plans/template-save", { plan: planId, ...(options.name ? { name: options.name } : {}), ...(options.description ? { description: options.description } : {}) });
      console.log(`${c.green}ok${c.reset} ${result.replaced ? "Replaced" : "Saved"} template "${result.name}": ${result.steps} steps, ${result.edges} edges`);
      console.log(fmt.muted(`  cast plan create "<title>" --template "${result.name}"`));
    });

  template
    .command("rm")
    .description("Remove a template you saved")
    .argument("<name>", "Template name (any case)")
    .option("--team <name|id|personal>", "The workspace to remove it from, when the name is saved in more than one")
    .action(async (name: string, options: any) => {
      const result = await deps.cliPost("/cli/plans/template-remove", { name, ...(options.team ? await deps.workspace(options.team) : {}) });
      console.log(`${c.green}ok${c.reset} Removed template "${name}"${result.removed > 1 ? ` (${result.removed} copies)` : ""}`);
    });

  template
    .command("ls")
    .alias("list")
    .description("List the plan templates you can use")
    .option("--json", "Output as JSON")
    .action(async (options: any) => {
      const templates = await deps.cliPost("/cli/plans/templates", {});
      if (options.json) return deps.printJson(templates ?? []);
      if (!templates?.length) return console.log(fmt.muted("No saved templates. Save one with cast plan template save <plan>."));
      for (const t of templates as SavedTemplate[]) {
        const where = templateWhere(t);
        console.log(`  ${t.name}  ${fmt.muted(`${where ? `${where} · ` : ""}${t.task_templates.length} steps${t.description ? ` · ${t.description}` : ""}`)}`);
      }
    });
}
