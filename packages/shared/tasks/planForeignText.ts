/**
 * A plan's own prose, rendered for an agent to read.
 *
 * `cast plan context` exists to hand an agent everything a plan knows, and
 * `cast plan show` prints the same material for a human with an agent watching
 * the terminal. Both used to interpolate the goal, the plan doc, every comment
 * and every task title straight into stdout. Plan prose is written inside
 * codecast, so it is less hostile than an imported issue body, but a plan
 * lists tasks whose titles arrive from GitHub or Linear through issueSync, and
 * a raw escape or bidi character in any of those repaints the terminal the
 * agent is reading.
 *
 * The treatment is the one the task renderer uses (./foreignText): provenance
 * plus bounds. Two blocks per plan, because a plan has two foreign sources —
 * the plan's own prose, and the tasks filed under it — and a reader deserves
 * to know which is which. Guidance is always "reference": nobody is being
 * assigned a plan, they are being shown one.
 *
 * The plan title is NOT repeated inside the block. It is one line, the fence
 * already names the plan in its `source`, and both callers print it as a
 * heading — escaped inline, which is the right treatment for a single line.
 */

import {
  FOREIGN_TEXT_CAPS,
  fenceForeignText,
  inlineForeignText,
} from "../contracts/fence";
import { foreignProse, referenceGuidance } from "./foreignText";
import { blockerList, notReadyLabel, prWords, type GraphTask, type WaitLabelOptions } from "./graph";
import { isTaskStatusCategory, isTerminalTaskStatus } from "./statuses";
import { openBlockerLabels, planVerdicts, type GraphOutside, type ReadinessViewer } from "./planVerdicts";

/**
 * Caps the task renderer has no equivalent for.
 *
 * A plan body is a design doc an agent is meant to work from, not an issue
 * description, so the 3000 char description cap would cut a real plan in half.
 * It is still bounded: an unbounded body pushes the instructions around it out
 * of the model's attention, and `cast doc show` serves the whole document when
 * a reader needs it.
 */
export const FOREIGN_PLAN_CAPS = {
  /** The plan doc. */
  bodyChars: 8000,
  /** The whole plan prose block, delimiters and guidance included. */
  blockChars: 20000,
  /** The whole task list block. */
  tasksBlockChars: 12000,
} as const;

export type ForeignPlanComment = {
  type?: string | null;
  author?: string | null;
  content?: string | null;
  rationale?: string | null;
  path_or_url?: string | null;
  timestamp?: number | null;
};

/** A plan task as `plans.get` returns it: its graph fields decide which group
 *  it is listed in (graph.ts readiness, as `cast task ready` judges it). */
export type ForeignPlanTask = GraphTask & {
  _id?: unknown;
  short_id?: string | null;
  title?: string | null;
  description?: string | null;
  external?: { provider?: string | null; identifier?: string | null } | null;
};

export type ForeignPlanRecord = {
  short_id?: string | null;
  title?: string | null;
  goal?: string | null;
  /** The plan's doc body, as `plans.get` returns it. */
  doc_content?: string | null;
  acceptance_criteria?: string[] | null;
  /** Oldest first, as `mergePlanEntries` orders them. */
  comments?: ForeignPlanComment[] | null;
  /** The rows the tasks' blockers and parents name outside the plan, and
   *  every ref looked up (`plans.get`); without it those stay unknown and block. */
  graph_outside?: GraphOutside | null;
};

/** Names the plan concretely, the way the task renderer names an issue. */
export function foreignPlanSource(plan: ForeignPlanRecord): string {
  return inlineForeignText(plan.short_id ? `plan ${plan.short_id}` : "plan");
}

export type PlanBodyOptions = {
  /** Renders a comment's age. Omitted, comments carry no timestamp. */
  formatAge?: (timestamp: number) => string;
};

function commentLine(entry: ForeignPlanComment, opts: PlanBodyOptions): string {
  const age = opts.formatAge && typeof entry.timestamp === "number" && entry.timestamp > 0
    ? `[${opts.formatAge(entry.timestamp)} ago] `
    : "";
  const author = inlineForeignText(entry.author);
  const who = author ? `${author}: ` : "";
  const text = foreignProse(entry.content, FOREIGN_TEXT_CAPS.commentChars) || "";
  const why = inlineForeignText(entry.rationale);
  const ref = inlineForeignText(entry.path_or_url);
  return `- ${age}${who}${text}${why ? ` (${why})` : ""}${ref ? ` → ${ref}` : ""}`;
}

/** The foreign body, before it is fenced. Exported so a test can pin the per-field caps. */
export function renderForeignPlanBody(
  plan: ForeignPlanRecord,
  opts: PlanBodyOptions = {},
): string {
  const sections: string[] = [];

  const goal = foreignProse(plan.goal, FOREIGN_TEXT_CAPS.descriptionChars);
  if (goal) sections.push(`Goal: ${goal}`);

  const body = foreignProse(plan.doc_content, FOREIGN_PLAN_CAPS.bodyChars);
  if (body) sections.push(`Body:\n${body}`);

  const criteria = (plan.acceptance_criteria || [])
    .map((c) => inlineForeignText(c))
    .filter((c) => c.length > 0);
  if (criteria.length > 0) {
    sections.push(`Acceptance criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}`);
  }

  const all = plan.comments || [];
  // Decisions are why the plan is shaped the way it is, so they survive the
  // recency window that trims the rest of the timeline.
  const decisions = all.filter((e) => e.type === "decision").slice(-FOREIGN_TEXT_CAPS.comments);
  if (decisions.length > 0) {
    sections.push(`Decisions:\n${decisions.map((d) => commentLine(d, opts)).join("\n")}`);
  }

  // Whatever the Decisions section already carries is skipped here: one block
  // means a duplicated entry now reads as two events instead of one.
  const shown = new Set(decisions);
  const rest = all.filter((e) => !shown.has(e));
  const recent = rest.slice(-FOREIGN_TEXT_CAPS.comments);
  if (recent.length > 0) {
    const heading = recent.length < rest.length
      ? `Recent activity (latest ${recent.length} of ${rest.length}):`
      : `Recent activity (${recent.length}):`;
    sections.push([heading, ...recent.map((e) => commentLine(e, opts))].join("\n"));
  }

  return sections.join("\n\n");
}

/**
 * The plan's own prose as one fenced, capped block.
 *
 * Returns null when the plan carries no prose, so a caller prints nothing
 * rather than an empty fence.
 */
export function renderFencedPlanRecord(
  plan: ForeignPlanRecord,
  opts: PlanBodyOptions = {},
): string | null {
  const body = renderForeignPlanBody(plan, opts);
  if (!body) return null;
  const source = foreignPlanSource(plan);
  return fenceForeignText(body, source, {
    maxChars: FOREIGN_PLAN_CAPS.blockChars,
    note: referenceGuidance(source),
  });
}

export type PlanTaskListOptions = {
  /**
   * Print one capped line of each unfinished task's description. `cast plan
   * context` wants it — it is the agent's whole view of the work — and `cast
   * plan show` does not, because a human is scanning for status.
   */
  descriptions?: boolean;
  /** How a PR is named (the CLI's checkoutWords); in full by default. */
  words?: WaitLabelOptions;
  /** Who the Ready/Not ready split is judged for (`plans.get`'s
   *  `graph_viewer`): the reader of this list, so their own ephemeral steps
   *  read as ready rather than as another session's bookkeeping. None (the
   *  default) judges for nobody in particular, which is right for a list a
   *  spawned session is handed. */
  viewer?: ReadinessViewer | null;
};

/**
 * `why` is what holds the task back, printed after its title.
 *
 * `showStatus` brackets the task's own status the way graph.ts's `taskRefLine`
 * does. Every group but the residual one is named after the status its rows
 * share, so only that one needs it: a line with no status and no heading that
 * implies one reads as a task whose status nobody recorded.
 */
function taskLine(
  task: ForeignPlanTask,
  opts: PlanTaskListOptions,
  why: string | null,
  showStatus = false,
): string[] {
  const id = inlineForeignText(task.short_id) || "?";
  const title = inlineForeignText(task.title);
  const provider = task.external?.provider;
  // The origin belongs on the line: a title from a connected repo was written
  // by whoever could open an issue there, not by the plan's author.
  const origin = provider
    ? ` [imported from ${inlineForeignText(
      `${provider}${task.external?.identifier ? ` ${task.external.identifier}` : ""}`,
    )}]`
    : "";
  const state = showStatus ? ` [${inlineForeignText(task.status) || "no status"}]` : "";
  const by = why ? ` (${inlineForeignText(why)})` : "";
  const lines = [`- ${id}: ${title}${state}${by}${origin}`];
  if (opts.descriptions && !isTerminalTaskStatus(task.status)) {
    const desc = inlineForeignText(task.description);
    if (desc) lines.push(`  ${desc}`);
  }
  return lines;
}

/**
 * Every task in the plan as one fenced, capped block.
 *
 * One block rather than one per task: a plan with thirty tasks would otherwise
 * print thirty fences and teach the reader that a delimiter means nothing.
 * They share a provenance — filed under this plan — and the ones that came
 * from a provider say so on their own line.
 */
export function renderFencedPlanTasks(
  tasks: ForeignPlanTask[] | null | undefined,
  plan: ForeignPlanRecord,
  opts: PlanTaskListOptions = {},
): string | null {
  const all = tasks || [];
  if (all.length === 0) return null;

  // Readiness is graph.ts's, the rule `cast task ready` and `cast plan wave`
  // apply: a finished blocker clears, a wait holds, a worked parent holds.
  const { statusOf, verdicts } = planVerdicts(all, plan.graph_outside, opts.viewer);
  const words = opts.words ?? prWords(null);
  const why = (t: ForeignPlanTask): string | null => {
    const v = verdicts.get(t)!;
    if (!v.ready && v.reason !== "status" && v.reason !== "blocked") return notReadyLabel(t, v, words);
    if (isTerminalTaskStatus(t.status)) return null;
    const open = openBlockerLabels(t, statusOf, words);
    return open.length ? `blocked by: ${blockerList(open)}` : null;
  };

  // Every status category gets a heading of its own, so where the plan stands
  // is readable from the headings alone. A plan whose twelve tasks are all in
  // review used to render them as twelve statusless lines under "Other",
  // indistinguishable from backlog, dropped or a task nobody has triaged.
  const inStatus = (status: string) => all.filter((t) => t.status === status);
  const done = inStatus("done");
  const inProgress = inStatus("in_progress");
  const inReview = inStatus("in_review");
  const backlog = inStatus("backlog");
  const dropped = inStatus("dropped");
  const open = inStatus("open");
  const ready = open.filter((t) => verdicts.get(t)!.ready);
  const waiting = open.filter((t) => !verdicts.get(t)!.ready);
  // Only a status outside the six categories lands here — a row from a future
  // schema, or one that arrived without a status at all. It carries its status
  // on the line, because no heading above it names one.
  const other = all.filter((t) => !isTaskStatusCategory(t.status));

  const group = (heading: string, rows: ForeignPlanTask[], showStatus = false): string[] =>
    rows.length === 0
      ? []
      : [`\n${heading}:`, ...rows.flatMap((t) => taskLine(t, opts, why(t), showStatus))];

  const body = [
    `Tasks (${done.length}/${all.length} done)`,
    ...group("In progress", inProgress),
    ...group("In review", inReview),
    ...group("Ready", ready),
    ...group("Not ready", waiting),
    ...group("Backlog", backlog),
    ...group("Done", done),
    ...group("Dropped", dropped),
    ...group("Other", other, true),
  ].join("\n");

  const source = `tasks of ${foreignPlanSource(plan)}`;
  return fenceForeignText(body, source, {
    maxChars: FOREIGN_PLAN_CAPS.tasksBlockChars,
    note: referenceGuidance(source),
  });
}
