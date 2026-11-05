// A group's state as a person reads it (regressed is its own state) and who
// resolved it. No React, no store.
import type { OpsEvent, OpsGroup } from "./opsTypes";

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

// ── A group's state ──

export type IssueState = "regressed" | "open" | "ok" | "resolved" | "ignored";

/**
 * Open again after a resolve: the server stamps regressed_at on the
 * occurrence that broke the resolve (lib/ingestGroups), and a later resolve
 * moves resolved_at past it, so the newer of the two says which holds.
 */
type RegressFields = Pick<OpsGroup, "status" | "regressed_at" | "resolved_at"> & Partial<Pick<OpsGroup, "kind" | "meta" | "last_seen" | "last_transition" | "last_transition_at">>;

const FAILING_AGAIN = new Set(["check_failed", "metric_alert", "job_failed"]);

/**
 * When a group came back after a resolve, or null. An error carries the
 * server's regressed_at. A check or metric recovers on its own (its recovery
 * stamps resolved_at) and fails again without one, so for those failing
 * again after the last resolve or recovery is the regression, dated by the
 * failure that reopened it.
 */
export function regressedAt(g: RegressFields): number | null {
  if (g.status !== "open") return null;
  if (g.regressed_at !== undefined && g.regressed_at >= (g.resolved_at ?? 0)) return g.regressed_at;
  if ((g.kind === "check" || g.kind === "metric") && g.resolved_at !== undefined && g.meta?.ok !== true) {
    const failedAt = g.last_transition && FAILING_AGAIN.has(g.last_transition) ? g.last_transition_at : undefined;
    if (failedAt !== undefined && failedAt > g.resolved_at) return failedAt;
    if (failedAt === undefined && (g.last_seen ?? 0) > g.resolved_at) return g.last_seen!;
  }
  return null;
}

/** Open again after a resolve (or, for a check or metric, after a recovery). */
export function isRegressed(g: RegressFields): boolean {
  return regressedAt(g) !== null;
}

export function issueState(g: RegressFields & Pick<OpsGroup, "kind" | "meta">): IssueState {
  if (g.status === "resolved") return "resolved";
  if (g.status === "ignored" || g.status === "muted") return "ignored";
  if (isRegressed(g)) return "regressed";
  // An open check or metric that is currently fine reads as watched, not red.
  if ((g.kind === "check" || g.kind === "metric") && g.meta?.ok === true) return "ok";
  return "open";
}

/**
 * The release a regressed group came back in: the one the server stamped when
 * it regressed, else its regression's transition row (the newest one at or
 * after regressed_at). Null when neither names one: the newest release it was
 * seen in is a different fact, so the pill shows the age instead.
 */
export function regressedIn(g: Pick<OpsGroup, "_id" | "short_id" | "regressed_at"> & Partial<Pick<OpsGroup, "regressed_in">>, events: OpsEvent[]): string | null {
  if (g.regressed_in) return g.regressed_in;
  const since = (g.regressed_at ?? 0) - 5 * 60_000;
  let hit: OpsEvent | null = null;
  for (const e of events) {
    if (e.group_id !== g._id && e.data?.group_short_id !== g.short_id) continue;
    if (e.data?.transition !== "regressed" && e.kind !== "error_regressed") continue;
    if (e.created_at >= since && (!hit || e.created_at > hit.created_at)) hit = e;
  }
  return hit?.data?.release ?? null;
}

// ── Who resolved it ──

export type Resolver = { via: "person" | "recovered" | "vendor" | null; by?: string };

const RECOVERY = new Set(["check_recovered", "metric_recovered"]);

/**
 * What put a group to rest. The server stamps it (resolved_via, resolved_by);
 * a row resolved before it did is read from what is known: a check or metric
 * whose recovery transition sits at its resolve recovered on its own, and a
 * mirrored group resolved with no recovery was resolved at the vendor. Null
 * `via` is a resolve nobody can name, which is never called a person's.
 */
export function resolverOf(g: Partial<Pick<OpsGroup, "_id" | "short_id" | "kind" | "resolved_at" | "resolved_via" | "resolved_by" | "external" | "last_transition" | "last_transition_at">>, events: OpsEvent[] = []): Resolver {
  if (g.resolved_via) return { via: g.resolved_via, ...(g.resolved_by ? { by: g.resolved_by } : {}) };
  if (g.resolved_at === undefined) return { via: null };
  if (g.kind === "check" || g.kind === "metric") {
    const near = (at: number | undefined) => at !== undefined && Math.abs(at - g.resolved_at!) < 5 * 60_000;
    if (g.last_transition && RECOVERY.has(g.last_transition) && near(g.last_transition_at)) return { via: "recovered" };
    const hit = events.some((e) => (e.group_id === g._id || e.data?.group_short_id === g.short_id) && RECOVERY.has(e.data?.transition ?? e.kind) && near(e.created_at));
    if (hit) return { via: "recovered" };
  }
  if (g.external) return { via: "vendor" };
  return { via: null };
}

/** A resolver in a few words; `name` is the person's, "you" for the viewer. Never "by hand" for a resolve nobody can attribute. */
export function resolverWords(resolver: Resolver, name: string | null, provider?: string): string {
  if (resolver.via === "recovered") return "recovered on its own";
  if (resolver.via === "vendor") return provider ? `resolved in ${provider[0].toUpperCase()}${provider.slice(1)}` : "resolved at the source";
  if (resolver.via === "person") return name ? `resolved by ${name}` : "resolved by a person";
  return "resolved";
}
