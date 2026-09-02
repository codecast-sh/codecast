// Sync-log cargo → store row fields (docs/architecture/sync-log-cargo.md E6/E7).
//
// The log carries RAW document fields. The store renders ENRICHED rows (the
// byIds/list channels join users, plans, conversations onto them). This module
// is the pure, unit-tested bridge: per collection it says which raw fields land
// directly, how they are renamed or normalized, which derived twins to recompute
// from the merged row, and when the row still needs a byIds refetch for joins
// the replica cannot derive (the enrichment audit's verdicts, pl-498).
import {
  INBOX_FACT_FIELDS,
  isSettleVerdictCurrent,
  isUserDormant,
} from "@codecast/shared/contracts";

export type CargoCollection = "sessions" | "tasks" | "docs" | "plans" | "projects";

export type Cargo = {
  patch?: Record<string, any>;
  unset?: string[];
  full?: boolean;
  partial?: boolean;
  omitted?: string[];
};

export type CargoPlan = {
  // Fields to merge onto the row (after rename/normalize/twins).
  fields: Record<string, any>;
  // Keys to remove (sessions rows null them instead — enrichment spells
  // "absent" as null, and Convex drops undefined keys on the wire).
  unset: string[];
  // A byIds refetch is needed for joins the replica cannot derive from this
  // patch (or because the server flagged the cargo partial).
  refetch: boolean;
};

// Raw field changes that invalidate a join the replica does not hold
// (enrichment audit, pl-498). A patch touching one of these applies its raw
// fields first (the visible change is instant) and then refetches the row.
export const ENRICH_TRIGGER_FIELDS: Record<CargoCollection, ReadonlySet<string>> = {
  // last_comment_at: stamped by every task_comments insert — the comments
  // join lives on another table, so this is the only signal a replica gets.
  tasks: new Set(["plan_id", "last_comment_at"]),
  docs: new Set(["plan_id", "doc_type"]),
  plans: new Set([]),
  projects: new Set([]),
  sessions: new Set(["active_plan_id", "active_task_id", "workflow_run_id"]),
};

// Sessions rows rename three raw fields (enrichInboxSessionRow).
const SESSION_RENAMES: Record<string, string> = {
  has_pending_messages: "has_pending",
  unresolved_comment_count: "open_comment_threads",
  last_message_preview: "last_user_message",
};

const FACT_FIELDS = new Set<string>(INBOX_FACT_FIELDS as readonly string[]);

function teamIdFromWorkspace(ws: unknown): string | undefined {
  return typeof ws === "string" && ws.startsWith("team:") ? ws.slice(5) : undefined;
}

// Pure. `existing` is the row currently in the store (undefined when absent —
// the caller only asks for a plan when it has a base or the cargo is full).
export function planCargoApply(
  coll: CargoCollection,
  cargo: Cargo,
  existing: Record<string, any> | undefined,
): CargoPlan {
  const raw = cargo.patch ?? {};
  const unsetIn = cargo.unset ?? [];
  const triggers = ENRICH_TRIGGER_FIELDS[coll];
  let refetch = !!cargo.partial;
  for (const k of [...Object.keys(raw), ...unsetIn]) if (triggers.has(k)) refetch = true;

  if (coll === "sessions") return planSessions(raw, unsetIn, existing, refetch);

  const fields: Record<string, any> = { ...raw };
  const unset = [...unsetIn];
  if (coll === "docs" || coll === "plans") {
    // The list channels stamp team_id to the EFFECTIVE team (the workspace
    // key's team, or none for personal); the server never ships raw team_id
    // for these two (payload denylist), so derive it from `workspace` here.
    if ("workspace" in raw) {
      const t = teamIdFromWorkspace(raw.workspace);
      if (t) fields.team_id = t; else unset.push("team_id");
    }
  }
  if (coll === "tasks") {
    if ("conversation_ids" in raw) fields.session_count = Array.isArray(raw.conversation_ids) ? raw.conversation_ids.length : 0;
  }
  if (coll === "docs" && cargo.omitted?.includes("content") && existing?.source === "plan_mode") {
    // display_title derives from the body for plan-mode docs; the body never
    // rides the log, so a content change means the title may have moved.
    refetch = true;
  }
  return { fields, unset, refetch };
}

function planSessions(
  raw: Record<string, any>,
  unsetIn: string[],
  existing: Record<string, any> | undefined,
  refetchIn: boolean,
): CargoPlan {
  const fields: Record<string, any> = {};
  let refetch = refetchIn;
  for (const [k, v] of Object.entries(raw)) {
    // The liveness overlay is the single writer of fact fields (convergence
    // C1) — a conversations patch must never write them, even the raw ones
    // like updated_at/message_count.
    if (FACT_FIELDS.has(k)) continue;
    const target = SESSION_RENAMES[k] ?? k;
    let value = v;
    if (k === "loop_state" && value && typeof value === "object" && value.status === "stopped") value = null;
    fields[target] = value === undefined ? null : value;
  }
  // Absent → null: enrichment spells every optional as `?? null`.
  const unset: string[] = [];
  for (const k of unsetIn) {
    if (FACT_FIELDS.has(k)) continue;
    fields[SESSION_RENAMES[k] ?? k] = null;
  }
  // Derived twins, recomputed from the merged row with the shared helpers.
  const merged = { ...(existing ?? {}), ...fields };
  if ("inbox_pinned_at" in fields) fields.is_pinned = !!fields.inbox_pinned_at;
  if ("anchor_id" in fields) fields.is_anchor = !!fields.anchor_id;
  if ("is_subagent" in fields) fields.is_subagent = fields.is_subagent === true;
  const updatedAt = typeof merged.updated_at === "number" ? merged.updated_at : 0;
  if ("inbox_deferred_at" in fields) {
    fields.is_deferred = !!merged.inbox_deferred_at && merged.inbox_deferred_at >= updatedAt;
  }
  if ("inbox_dormant_at" in fields) {
    fields.is_dormant = isUserDormant({ inbox_dormant_at: merged.inbox_dormant_at, updated_at: updatedAt });
  }
  if ("settle_verdict" in fields || "settle_verdict_at" in fields) {
    fields.settle_verdict = isSettleVerdictCurrent({ settle_verdict_at: merged.settle_verdict_at, updated_at: updatedAt })
      ? (merged.settle_verdict ?? null)
      : null;
  }
  // A row leaving the inbox's admitted statuses would be OMITTED by byIds
  // (pruned), which a patch alone cannot express — refetch decides.
  if ("status" in raw && raw.status !== "active" && raw.status !== "completed") refetch = true;
  return { fields, unset, refetch };
}
