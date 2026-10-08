// The task graph on the command line (docs/architecture/task-graph.md): one
// blocker grammar for every flag (TG3), the graph lines `cast task show` and
// `context` print (TG12), links that do not block (TG5), and plans that write
// their own order (TG6).

import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";
import {
  blockerLabel,
  isTerminalTaskStatus,
  parseBlockerRef,
  parseStepWaves,
  planTail,
  stepsFromWaves,
  UNKNOWN_BLOCKER_STATUS,
  waitLabel,
  waitingOnLabel,
  waitMetLabel,
  type PlanStep,
  type TaskWait,
  type WaitLabelOptions,
} from "@codecast/shared/tasks";
import { c, fmt } from "./colors.js";
import { stdinText } from "./sendBody.js";

/** What the commands here need from index.ts. */
export type GraphDeps = {
  cliPost: (path: string, body: Record<string, any>, opts?: { throwOnError?: boolean }) => Promise<any>;
  sessionId: () => string | null;
  cwd: () => string;
  printJson: (value: unknown) => void;
};

// ---------------------------------------------------------------------------
// Blocker refs (TG3)
// ---------------------------------------------------------------------------

/** A ref routed to its route: a task edge, a wait, or (removal only) a wait by id. */
export type RoutedRef =
  | { kind: "task"; ref: string }
  | { kind: "wait"; ref: string; barePr: boolean }
  | { kind: "wait_id"; id: string };

/** The id a server-made wait carries ("w", a base36 clock, 1-3 random base36
 *  digits; taskWaits.addWaitCore), which a time wait is removed by. */
const WAIT_ID = /^w(?=[0-9a-z]*\d)[0-9a-z]{9,11}$/;

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
  if (opts.removing && WAIT_ID.test(trimmed)) return { kind: "wait_id", id: trimmed };
  const parsed = parseBlockerRef(trimmed, { now: opts.now });
  if (!parsed.ok) throw new Error(opts.removing ? `${parsed.error}, or a wait's id (w…, from cast task show)` : parsed.error);
  if (parsed.kind === "task") return { kind: "task", ref: parsed.ref };
  return { kind: "wait", ref: trimmed, barePr: (parsed.kind === "pr_merged" || parsed.kind === "pr_checks_green") && !parsed.repository };
}

/** This machine's zone, so "2026-10-14T09:00" means 09:00 here, not in UTC. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** This checkout's repository (`owner/name`), the fallback for a bare `#42`
 *  when the task's project names none. */
function checkoutRepository(cwd: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return repositoryKeyOfRemote(url);
  } catch {
    return null;
  }
}

/** The body of `/cli/work/wait` or `/cli/work/unwait` for one routed ref. */
export function waitBody(shortId: string, r: Exclude<RoutedRef, { kind: "task" }>, ctx: { cwd: string; sessionId?: string | null }): Record<string, any> {
  const body: Record<string, any> = { short_id: shortId, time_zone: localTimeZone() };
  if (r.kind === "wait_id") body.wait_id = r.id;
  else {
    body.ref = r.ref;
    const repository = r.barePr ? checkoutRepository(ctx.cwd) : null;
    if (repository) body.repository = repository;
  }
  if (ctx.sessionId) body.conversation_id = ctx.sessionId;
  return body;
}

/** "waiting on PR #42", "waiting until 09:00": the timeline's phrase, mid-sentence. */
const waitingOn = (w: TaskWait) => {
  const label = waitingOnLabel(w);
  return label[0].toLowerCase() + label.slice(1);
};

/** What adding a wait printed: met at once, already there, or now waiting. */
export function waitAddedLine(shortId: string, result: { wait: TaskWait; met: boolean; existing?: boolean }): string {
  if (result.existing) return `${shortId} was already ${waitingOn(result.wait)}`;
  if (result.met) return `${shortId} has nothing to wait for: ${waitMetLabel(result.wait)} already`;
  return `${shortId} is ${waitingOn(result.wait)}`;
}

/**
 * Add or remove blockers of any kind on one task: tasks through the
 * dependency routes, waits through the wait routes. Every ref is parsed
 * before the first write, so a typo changes nothing.
 */
export async function applyBlockers(deps: GraphDeps, shortId: string, refs: string[], mode: "add" | "remove"): Promise<void> {
  const routed = refs.map((r) => routeBlockerRef(r, { removing: mode === "remove" }));
  const ctx = { cwd: deps.cwd(), sessionId: deps.sessionId() };
  for (const r of routed) {
    if (r.kind === "task") {
      await deps.cliPost(mode === "add" ? "/cli/work/dep" : "/cli/work/undep", { short_id: shortId, blocked_by: r.ref, ...writerOf(deps) });
      console.log(`${c.green}ok${c.reset} ${shortId} ${mode === "add" ? "is blocked by" : "is no longer blocked by"} ${r.ref}`);
    } else if (mode === "add") {
      const result = await deps.cliPost("/cli/work/wait", waitBody(shortId, r, ctx));
      console.log(`${c.green}ok${c.reset} ${waitAddedLine(shortId, result)}`);
    } else {
      const result = await deps.cliPost("/cli/work/unwait", waitBody(shortId, r, ctx));
      for (const w of (result?.removed ?? []) as TaskWait[]) console.log(`${c.green}ok${c.reset} ${shortId} is no longer ${waitingOn(w)}`);
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

/**
 * The task's graph, in the web's order and words: Blocked by (tasks with
 * their status, then waits with their state), Blocks, Found during, Found
 * here, Related, Superseded by. Empty sections are left out. `holds` marks a
 * Blocked by section with something still open. `inline` cleans a title for
 * a reader that feeds the output to an agent.
 */
export function taskGraphSections(t: GraphTaskRow, links: GraphLinks | null | undefined, opts: WaitLabelOptions & { inline?: (s: string) => string } = {}): GraphSection[] {
  const inline = opts.inline ?? ((s: string) => s);
  const task = (l: LinkRef) => {
    if (l.missing) return blockerLabel({ kind: "task", ref: l.short_id, missing: true });
    if (l.status === UNKNOWN_BLOCKER_STATUS || l.title === undefined) return blockerLabel({ kind: "task", ref: l.short_id, status: UNKNOWN_BLOCKER_STATUS });
    return `${l.short_id} ${inline(l.title)} [${l.status}]`;
  };
  const wait = (w: TaskWait) => `${waitLabel(w, opts)} (${w.state}${w.note ? `: ${inline(w.note)}` : ""})`;
  const waits = t.waits ?? [];
  // A server older than the graph sends no links; its raw ids are all it can say.
  const blockers: LinkRef[] = links?.blocked_by ?? (t.blocked_by ?? []).map((ref) => ({ short_id: ref, status: UNKNOWN_BLOCKER_STATUS }));
  const holds = blockers.some((b) => !b.missing && !isTerminalTaskStatus(b.status)) || waits.some((w) => w.state !== "met");
  const sections: GraphSection[] = [
    { label: "Blocked by", items: [...blockers.map(task), ...waits.map(wait)], holds },
    { label: "Blocks", items: links?.blocks ? links.blocks.map(task) : (t.blocks ?? []) },
    { label: "Found during", items: links?.found_during ? [task(links.found_during)] : [] },
    { label: "Found here", items: (links?.found_here ?? []).map(task) },
    { label: "Related", items: (links?.related ?? []).map(task) },
    { label: "Superseded by", items: links?.superseded_by ? [task(links.superseded_by)] : [] },
  ];
  return sections.filter((s) => s.items.length);
}

// ---------------------------------------------------------------------------
// Plans that write their own order (TG6)
// ---------------------------------------------------------------------------

/**
 * Create `steps` in `planId` in order, each blocked by the steps its `after`
 * names. A step that waits on no other step waits on `roots` instead (the
 * plan's last wave, when appending). Plan steps are the plan's own
 * decomposition, so none is recorded as found while working on the
 * session's task.
 */
export async function createPlanSteps(
  deps: GraphDeps,
  planId: string,
  steps: PlanStep[],
  opts: { roots?: string[]; base?: Record<string, any>; say?: (line: string) => void } = {},
): Promise<Array<{ short_id: string; title: string; blocked_by: string[] }>> {
  const created: Array<{ short_id: string; title: string; blocked_by: string[] }> = [];
  for (const step of steps) {
    const blocked_by = step.after.length ? step.after.map((i) => created[i].short_id) : opts.roots ?? [];
    const { after: _after, ...fields } = step;
    const result = await deps.cliPost("/cli/work/create", {
      ...opts.base,
      ...fields,
      plan_id: planId,
      found_during: "none",
      ...(blocked_by.length ? { blocked_by } : {}),
    });
    created.push({ short_id: result.short_id, title: step.title, blocked_by });
    const needs = blocked_by.length ? fmt.muted(`  needs ${blocked_by.join(", ")}`) : "";
    opts.say?.(`  ${c.green}+${c.reset} ${c.cyan}${result.short_id}${c.reset}: ${step.title}${needs}`);
  }
  return created;
}

/** `--steps`/`steps` input as steps, refusing an empty list with the form. */
export function stepsFromText(text: string): PlanStep[] {
  const steps = stepsFromWaves(parseStepWaves(text));
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

/** `--template <name>`: a built-in, else a template saved with `cast plan
 *  template save` (by name, any case). Unknown names list what exists. */
export async function planTemplateSteps(deps: GraphDeps, name: string): Promise<PlanStep[]> {
  const builtin = BUILTIN_TEMPLATES[name];
  if (builtin) return builtin.map((s, i) => ({ ...s, after: i ? [i - 1] : [] }));
  const saved: Array<{ name: string; task_templates: any[] }> = (await deps.cliPost("/cli/plans/templates", {})) ?? [];
  const match = saved.find((t) => t.name === name) ?? saved.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (match) return stepsFromTemplate(match);
  const names = [...BUILTIN_TEMPLATE_NAMES, ...saved.map((t) => `"${t.name}"`)];
  throw new Error(`Unknown template "${name}". Available: ${names.join(", ")}`);
}

/** The session a write names, so the server records an agent's own change
 *  as the agent's and wakes it for nothing (TG2, TG11). */
export function writerOf(deps: Pick<GraphDeps, "sessionId">): { conversation_id?: string } {
  const sessionId = deps.sessionId();
  return sessionId ? { conversation_id: sessionId } : {};
}

/** What every plan step is created with: this checkout, and the session. */
export function planStepBase(deps: GraphDeps): Record<string, any> {
  return { project_path: deps.cwd(), source: "agent", ...writerOf(deps) };
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
    .argument("<steps>", stdinText("Steps, one per line; a blank line starts a wave that needs the one before"))
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
      const created = await createPlanSteps(deps, current.short_id, steps, { roots, base: planStepBase(deps), say });
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
    .option("--name <name>", "Template name (default: the plan's title); saving the same name again replaces it")
    .option("-d, --description <text>", "What the template is for")
    .action(async (planId: string, options: any) => {
      const result = await deps.cliPost("/cli/plans/template-save", { plan: planId, ...(options.name ? { name: options.name } : {}), ...(options.description ? { description: options.description } : {}) });
      console.log(`${c.green}ok${c.reset} ${result.replaced ? "Replaced" : "Saved"} template "${result.name}": ${result.steps} steps, ${result.edges} edges`);
      console.log(fmt.muted(`  cast plan create "<title>" --template "${result.name}"`));
    });

  template
    .command("rm")
    .description("Remove a template you saved")
    .argument("<name>", "Template name")
    .action(async (name: string) => {
      const result = await deps.cliPost("/cli/plans/template-remove", { name });
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
      for (const t of templates) console.log(`  ${t.name}  ${fmt.muted(`${t.task_templates.length} steps${t.description ? ` · ${t.description}` : ""}`)}`);
    });
}
