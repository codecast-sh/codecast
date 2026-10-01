// The ground node's inputs and outputs (docs/architecture/the-line-end-to-end.md
// LE5). The brief is the workspace's goals as one compact document: active
// initiatives with their metrics read against their targets, each project's
// charter, and the product principles. The ground node reads it and writes
// four fields on the cause task: goal_ref, category, risk, readiness.
//
// Server (convex/goals.ts) gathers the rows; the renderer here is pure, so the
// CLI, a wake frame and a test all print the same document.
import { metricLine, metricReadings, type InitiativeHealth, type InitiativeMetric, type InitiativeScore } from "./initiative";

export const LINE_CATEGORIES = ["code", "prompt", "ux", "infra", "data"] as const;
export type LineCategory = (typeof LINE_CATEGORIES)[number];
export const LINE_RISKS = ["low", "review", "plan"] as const;
export type LineRisk = (typeof LINE_RISKS)[number];
export const LINE_READINESS = ["ready", "needs_context", "not_actionable"] as const;
export type LineReadiness = (typeof LINE_READINESS)[number];
/** The goal_ref a cause carries when it threatens no goal in the brief. */
export const NO_GOAL = "none";

export type GroundOptions = { goalRef?: string; category?: string; risk?: string; readiness?: string; readinessNote?: string };

function pick(flag: string, values: readonly string[], raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase().replace(/-/g, "_");
  if (value === "" || values.includes(value)) return value;
  throw new Error(`--${flag} must be one of ${values.join(", ")} (or "" to clear)`);
}

/** The ground fields of a `cast task update` body from its flags; "" clears a
 *  field. Throws the one line that names a bad value. */
export function groundUpdateBody(options: GroundOptions): Record<string, string> {
  const body: Record<string, string> = {};
  if (options.goalRef !== undefined) body.goal_ref = options.goalRef.trim();
  const category = pick("category", LINE_CATEGORIES, options.category);
  if (category !== undefined) body.category = category;
  const risk = pick("risk", LINE_RISKS, options.risk);
  if (risk !== undefined) body.risk = risk;
  const readiness = pick("readiness", LINE_READINESS, options.readiness);
  if (readiness !== undefined) body.readiness = readiness;
  if (options.readinessNote !== undefined) body.readiness_note = options.readinessNote.trim();
  return body;
}

export type GoalPriority = "p0" | "p1" | "p2" | "p3";

export type GoalsBriefInitiative = {
  short_id: string;
  title: string;
  priority?: GoalPriority;
  owner?: string;
  target_date?: number;
  health: InitiativeHealth;
  description?: string;
  metrics: InitiativeMetric[];
  scoreboard?: Record<string, InitiativeScore>;
  /** Short ids of the projects it carries, in its own order. */
  project_short_ids: string[];
};

export type GoalsBriefProject = {
  short_id: string;
  title: string;
  status: string;
  goal?: string;
  success_metrics?: string[];
  non_goals?: string[];
  risks?: string[];
  priority?: GoalPriority;
  /** The owner role's @handle. */
  owner_role?: string;
};

export type GoalsBrief = {
  /** The access key read: team:<id> or user:<id>. */
  workspace: string;
  workspace_name?: string;
  initiatives: GoalsBriefInitiative[];
  projects: GoalsBriefProject[];
};

/** The goal_ref for one initiative metric. */
export const metricGoalRef = (initiative: string, key: string) => `${initiative}:${key}`;

const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const byPriorityThenId = (a: { priority?: string; short_id: string }, b: { priority?: string; short_id: string }) =>
  (PRIORITY_RANK[a.priority ?? ""] ?? 4) - (PRIORITY_RANK[b.priority ?? ""] ?? 4) || a.short_id.localeCompare(b.short_id, undefined, { numeric: true });

const HEALTH_WORD: Record<InitiativeHealth, string | null> = { none: null, on_track: "on track", at_risk: "at risk", off_track: "off track" };
const DESCRIPTION_CHARS = 280;
const PRINCIPLES_CHARS = 2400;
const LIST_ITEMS = 5;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const list = (items?: string[]) => (items ?? []).map(oneLine).filter(Boolean).slice(0, LIST_ITEMS).join("; ");

export type RenderGoalsBriefOptions = {
  /** Drop descriptions: the shape a prompt reads. */
  brief?: boolean;
  /** docs/principles.md as read from the repository, when present. */
  principles?: string | null;
  now?: number;
};

/**
 * The brief as markdown, in a stable order: initiatives by priority then short
 * id, each metric with its ref; projects by priority then short id; then the
 * principles. Anything absent is left out rather than printed as empty.
 */
export function renderGoalsBrief(data: GoalsBrief, opts: RenderGoalsBriefOptions = {}): string {
  const now = opts.now ?? Date.now();
  const out: string[] = [`# Goals${data.workspace_name ? ` of ${oneLine(data.workspace_name)}` : ""}`];
  const initiatives = [...data.initiatives].sort(byPriorityThenId);
  const projects = [...data.projects].sort(byPriorityThenId);
  if (!initiatives.length && !projects.length) {
    out.push("", "No active initiatives and no project charters in this workspace.");
  } else {
    out.push("", `A goal_ref is a metric ref (\`in-N:key\`), a project's short id, or \`${NO_GOAL}\`.`);
  }

  if (initiatives.length) {
    out.push("", "## Initiatives");
    for (const i of initiatives) {
      const facts = [
        i.priority,
        i.owner ? `owner ${i.owner}` : null,
        i.target_date ? `target ${day(i.target_date)}` : null,
        HEALTH_WORD[i.health],
      ].filter(Boolean);
      out.push("", `### ${i.short_id} ${oneLine(i.title)}${facts.length ? ` (${facts.join(", ")})` : ""}`);
      if (!opts.brief && i.description?.trim()) out.push(clip(oneLine(i.description), DESCRIPTION_CHARS));
      for (const r of metricReadings(i)) {
        out.push(`- \`${metricGoalRef(i.short_id, r.key)}\` ${metricLine(r, now)}${r.source ? `, from ${oneLine(r.source)}` : ""}`);
      }
      if (!i.metrics.length) out.push("- no metrics");
      if (i.project_short_ids.length) out.push(`- projects: ${i.project_short_ids.join(", ")}`);
    }
  }

  if (projects.length) {
    out.push("", "## Projects");
    for (const p of projects) {
      const facts = [p.priority, p.owner_role ? `owner ${p.owner_role}` : null, p.status].filter(Boolean);
      out.push("", `### ${p.short_id} ${oneLine(p.title)} (${facts.join(", ")})`);
      if (p.goal?.trim()) out.push(`- goal: ${oneLine(p.goal)}`);
      const rows: Array<[string, string[] | undefined]> = [["success", p.success_metrics], ["non-goals", p.non_goals], ["risks", p.risks]];
      for (const [label, items] of rows) {
        const text = list(items);
        if (text) out.push(`- ${label}: ${text}`);
      }
    }
  }

  const principles = opts.principles?.trim();
  if (principles) {
    // The file's own top heading is replaced by the section's.
    const body = principles.replace(/^#\s+[^\n]*\n+/, "").trim();
    out.push("", "## Principles", "", clip(body, PRINCIPLES_CHARS));
  }
  return `${out.join("\n")}\n`;
}
