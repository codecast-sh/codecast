/**
 * Task statuses, Linear-style: the six canonical statuses become fixed
 * CATEGORIES, and a team may define its own named statuses within them
 * ("Working on" under in_progress). `tasks.status` always holds the category,
 * so every index, filter, close-guard and progress predicate keeps working and
 * the CLI keeps its vocabulary; `tasks.status_id` optionally refines it to one
 * of the team's statuses. A team with no config gets DEFAULT_TASK_STATUSES and
 * behaves exactly as before.
 *
 * This is the one vocabulary. The Convex schema union, the mutation validators,
 * the web board and the pickers all derive from it.
 */

export const TASK_STATUS_CATEGORIES = [
  "backlog",
  "open",
  "in_progress",
  "in_review",
  "done",
  "dropped",
] as const;

export type TaskStatusCategory = (typeof TASK_STATUS_CATEGORIES)[number];

/** Categories that close a task (stamp closed_at, leave progress denominators). */
export const TERMINAL_TASK_CATEGORIES: readonly TaskStatusCategory[] = ["done", "dropped"];

export function isTerminalTaskStatus(category: string | undefined | null): boolean {
  return category === "done" || category === "dropped";
}

/** Accent token names a custom status may use; the web maps them to sol-* classes. */
export const TASK_STATUS_COLORS = [
  "blue",
  "green",
  "yellow",
  "red",
  "magenta",
  "cyan",
  "orange",
  "violet",
  "dim",
] as const;

export type TaskStatusColor = (typeof TASK_STATUS_COLORS)[number];

export type TeamTaskStatus = {
  /** Stable id, minted at creation. Defaults use their category name as id. */
  id: string;
  name: string;
  category: TaskStatusCategory;
  /** Accent token; absent = the category's built-in color. */
  color?: TaskStatusColor;
};

export const DEFAULT_TASK_STATUS_NAMES: Record<TaskStatusCategory, string> = {
  backlog: "Backlog",
  open: "Open",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  dropped: "Dropped",
};

export const DEFAULT_TASK_STATUSES: TeamTaskStatus[] = TASK_STATUS_CATEGORIES.map(
  (category) => ({ id: category, name: DEFAULT_TASK_STATUS_NAMES[category], category }),
);

const MAX_STATUSES = 50;
const MAX_NAME_LEN = 40;
const MAX_ID_LEN = 64;

/**
 * Validate a client-supplied status list. Throws with a human message on any
 * violation; returns a cleaned copy (trimmed names, no stray fields). Every
 * category must keep at least one status so any existing task's category still
 * has a home column and a default to resolve to.
 */
export function normalizeTeamTaskStatuses(input: unknown): TeamTaskStatus[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Statuses must be a non-empty list");
  }
  if (input.length > MAX_STATUSES) {
    throw new Error(`At most ${MAX_STATUSES} statuses`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const out: TeamTaskStatus[] = [];
  for (const raw of input as any[]) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    const category = raw?.category;
    if (!id || id.length > MAX_ID_LEN) throw new Error("Each status needs an id");
    if (!name || name.length > MAX_NAME_LEN) {
      throw new Error(`Each status needs a name of at most ${MAX_NAME_LEN} characters`);
    }
    if (!TASK_STATUS_CATEGORIES.includes(category)) {
      throw new Error(`Unknown category '${category}' for status '${name}'`);
    }
    if (ids.has(id)) throw new Error(`Duplicate status id '${id}'`);
    ids.add(id);
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) throw new Error(`Duplicate status name '${name}'`);
    names.add(nameKey);
    const color = raw?.color;
    if (color !== undefined && !TASK_STATUS_COLORS.includes(color)) {
      throw new Error(`Unknown color '${color}' for status '${name}'`);
    }
    out.push({ id, name, category, ...(color ? { color } : {}) });
  }
  for (const category of TASK_STATUS_CATEGORIES) {
    if (!out.some((s) => s.category === category)) {
      throw new Error(`Category '${category}' needs at least one status`);
    }
  }
  return out;
}

/** A team's effective statuses: its config, or the defaults when it has none. */
export function teamTaskStatuses(
  raw: TeamTaskStatus[] | undefined | null,
): TeamTaskStatus[] {
  return raw && raw.length > 0 ? raw : DEFAULT_TASK_STATUSES;
}

/**
 * The default status of a category within a list: the one whose id IS the
 * category (an untouched default), else the first of that category. Falls back
 * to the built-in default so a task always resolves, even when its category
 * was emptied by an old config written before the per-category floor existed.
 */
export function defaultStatusForCategory(
  category: TaskStatusCategory,
  statuses: TeamTaskStatus[],
): TeamTaskStatus {
  return (
    statuses.find((s) => s.id === category) ??
    statuses.find((s) => s.category === category) ?? {
      id: category,
      name: DEFAULT_TASK_STATUS_NAMES[category],
      category,
    }
  );
}

/**
 * The status a task renders as: its status_id when that still exists in the
 * team's list AND still agrees on category (a deleted or re-categorised status
 * never lies about where the task is), else the category's default.
 */
export function resolveTaskStatus(
  task: { status?: string | null; status_id?: string | null },
  statuses: TeamTaskStatus[],
): TeamTaskStatus {
  const category = (
    TASK_STATUS_CATEGORIES.includes(task.status as TaskStatusCategory)
      ? task.status
      : "open"
  ) as TaskStatusCategory;
  if (task.status_id) {
    const match = statuses.find((s) => s.id === task.status_id);
    if (match && match.category === category) return match;
  }
  return defaultStatusForCategory(category, statuses);
}
