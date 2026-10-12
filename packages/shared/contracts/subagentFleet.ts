/**
 * The subagent fleet: how many workers one session and one machine may run at
 * once, the queue a spawn joins when either limit is full, and what happened
 * to an isolated worker's changes when it finished.
 *
 * A subagent spawned with `cast spawn --subagent` takes a slot. The slot is the
 * row's own field (`subagent_slot`): "running" while the worker holds it,
 * "queued" while it waits, absent once the worker ends (done, blocked or
 * killed) or for rows the fleet never counted. The limits come from the
 * spawning machine's config (`cast config subagents.per_session 6`) and ride
 * on each row, so a queued row is judged by the limits it was spawned under.
 *
 * Everything here is pure: the server feeds it rows and acts on the answer,
 * and the web derives a queued row's place in line from the same function.
 */

/**
 * No cap unless a person configures one (sd-460): 0 means no limit, and it is
 * the default for both. A configured limit is a positive whole number from
 * `cast config set subagents.per_session N` (or per_machine).
 */
export const SUBAGENT_CAP_DEFAULTS = { per_session: 0, per_machine: 0 } as const;
export const NO_SUBAGENT_CAP = 0;

export interface SubagentCaps {
  /** 0 = no limit. */
  per_session: number;
  /** 0 = no limit. */
  per_machine: number;
}

/** A configured value (0 or a positive whole number), or the default when it is missing or malformed. */
export function normalizeSubagentCaps(raw?: { per_session?: unknown; per_machine?: unknown } | null): SubagentCaps {
  const pick = (v: unknown, fallback: number) => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    per_session: pick(raw?.per_session, SUBAGENT_CAP_DEFAULTS.per_session),
    per_machine: pick(raw?.per_machine, SUBAGENT_CAP_DEFAULTS.per_machine),
  };
}

export type SubagentSlot = "running" | "queued";

export interface SlotRow {
  id: string;
  /** The session the worker reports to. */
  parent: string | null;
  /** The machine the worker counts against. */
  device: string | null;
  slot: SubagentSlot;
  /** When the row took its slot or joined the queue: the queue's order. */
  at: number;
  caps: SubagentCaps;
}

export type Admission = { start: true } | { start: false; full: "session" | "machine" };

/** Whether a worker with these facts may start beside the running ones. */
export function admit(candidate: Pick<SlotRow, "parent" | "device" | "caps">, running: Pick<SlotRow, "parent" | "device">[]): Admission {
  const sameSession = candidate.parent ? running.filter((r) => r.parent === candidate.parent).length : 0;
  if (candidate.parent && candidate.caps.per_session > NO_SUBAGENT_CAP && sameSession >= candidate.caps.per_session) return { start: false, full: "session" };
  const sameMachine = candidate.device ? running.filter((r) => r.device === candidate.device).length : 0;
  if (candidate.device && candidate.caps.per_machine > NO_SUBAGENT_CAP && sameMachine >= candidate.caps.per_machine) return { start: false, full: "machine" };
  return { start: true };
}

const byQueueOrder = (a: SlotRow, b: SlotRow) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The queued rows that may start now, in the order they start. First in, first
 * out, but a row whose own limits are full does not hold up one behind it that
 * belongs to another session or machine.
 */
export function drainQueue(rows: SlotRow[]): string[] {
  const running = rows.filter((r) => r.slot === "running");
  const started: string[] = [];
  for (const row of rows.filter((r) => r.slot === "queued").sort(byQueueOrder)) {
    if (!admit(row, running).start) continue;
    running.push(row);
    started.push(row.id);
  }
  return started;
}

/** Queued rows ahead of this one that compete for the same session or machine. */
export function queueAhead(id: string, rows: SlotRow[]): number {
  const me = rows.find((r) => r.id === id && r.slot === "queued");
  if (!me) return 0;
  return rows.filter((r) =>
    r.slot === "queued" && r.id !== id && byQueueOrder(r, me) < 0 &&
    ((me.parent && r.parent === me.parent) || (me.device && r.device === me.device)),
  ).length;
}

export function queuedLabel(ahead: number): string {
  return ahead === 0 ? "queued, next" : `queued, ${ahead} ahead`;
}

// ── Merge back ───────────────────────────────────────────────────────────────

/** How a worker ended, as far as its slot and its worktree are concerned. */
export type SubagentOutcome = "done" | "blocked" | "killed";

/**
 * What became of an isolated worker's changes:
 *   pending   a merge was asked of the machine holding the worktree
 *   merged    its changes are in the parent's checkout
 *   empty     it changed nothing the parent lacked
 *   conflict  the parent changed the same lines; nothing was merged
 *   kept      it ended blocked or killed, so its worktree stays as it is
 *   failed    the machine could not merge (another device, a git error)
 */
export type MergeBackState = "pending" | "merged" | "empty" | "conflict" | "kept" | "failed";

export interface MergeBackStatus {
  state: MergeBackState;
  at: number;
  files?: string[];
  reason?: string;
}

export function mergeBackLabel(m: Pick<MergeBackStatus, "state" | "files">): string {
  const n = m.files?.length ?? 0;
  const files = `${n} file${n === 1 ? "" : "s"}`;
  switch (m.state) {
    case "pending": return "merging back";
    case "merged": return `merged ${files}`;
    case "empty": return "nothing to merge";
    case "conflict": return `conflict, ${files}`;
    case "kept": return "kept in worktree";
    case "failed": return "merge failed";
  }
}

/** The note the parent session receives about a worker's changes. */
export function mergeBackNote(worker: { short_id: string; worktree_path?: string | null }, m: Pick<MergeBackStatus, "state" | "files" | "reason">, outcome: SubagentOutcome): string | null {
  const where = worker.worktree_path ? ` Its worktree: ${worker.worktree_path}` : "";
  const list = (m.files ?? []).map((f) => `- ${f}`).join("\n");
  switch (m.state) {
    case "merged":
      return `Worker ${worker.short_id} finished done and its changes are now in your checkout (uncommitted):\n${list}`;
    case "conflict":
      return `Worker ${worker.short_id} finished done, but nothing was merged: your checkout changed the same lines in these files:\n${list}\n\nResolve by hand.${where}`;
    case "kept":
      return `Worker ${worker.short_id} ended ${outcome}, so its changes stay in its worktree and were not merged.${where}`;
    case "failed":
      return `Worker ${worker.short_id} finished done, but its changes could not be merged${m.reason ? `: ${m.reason}` : ""}.${where}`;
    default:
      return null;
  }
}
