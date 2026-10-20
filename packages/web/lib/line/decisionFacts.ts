// What the team's decision inbox (For you) shows about each open decision at a
// glance, read off the decision, its card and its problem: what kind of change
// it decides, who it is assigned to, how many people and findings it settles,
// and how bad the worst finding is. lineInbox stamps these on each row; the
// list's filters, sorts and groups read them. Pure.

/** What answering the decision changes: a fix to the product, a judge, an expectation, or something else a run asks. */
export type DecisionChange = "fix" | "judge" | "expectation" | "other";

export const DECISION_CHANGES: readonly DecisionChange[] = ["fix", "judge", "expectation", "other"];

export const DECISION_CHANGE_LABEL: Record<DecisionChange, string> = { fix: "Fix", judge: "Judge", expectation: "Expectation", other: "Other" };

type AssignableRow = { passed_to?: { kind: string; id: string } | null; asked_user_ids?: ReadonlyArray<string> | null };

/**
 * Who a decision is assigned to: the teammate a person gave it to (passed_to), else the one person it was asked of.
 * Asked of several people (a session's owners), or of nobody's queue (a trial owner's question), it is unassigned.
 */
export function decisionAssignee(d: AssignableRow | null | undefined): string | null {
  if (!d) return null;
  if (d.passed_to?.kind === "user") return String(d.passed_to.id);
  return d.asked_user_ids?.length === 1 ? String(d.asked_user_ids[0]) : null;
}

/** The distinct contacts a problem's evidence names (fingerprints "evidence:contacts/<id>:..."): the people it reached. */
export function contactsOf(fingerprints: ReadonlyArray<string> | null | undefined): number {
  const ids = new Set<string>();
  for (const f of fingerprints ?? []) {
    const m = /^evidence:contacts\/([^:]+)/.exec(f);
    if (m) ids.add(m[1]);
  }
  return ids.size;
}

/** The worst finding's severity (1 to 10, as its judge scored it) on each problem; a problem none scored is absent. */
export function severityByTask(signals: ReadonlyArray<{ task_id?: string | null; severity?: number | null }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of signals) {
    if (!s.task_id || typeof s.severity !== "number") continue;
    if (s.severity > (out.get(s.task_id) ?? 0)) out.set(s.task_id, s.severity);
  }
  return out;
}

export type SeverityBand = "high" | "mid" | "low";

/** A severity as the band its color shows: 8 and up high, 6 and 7 middling, below that low. */
export const severityBand = (n: number | null | undefined): SeverityBand | null => (n == null ? null : n >= 8 ? "high" : n >= 6 ? "mid" : "low");

/** The larger of counts that may be missing; null when none is known. */
export const mostOf = (...xs: ReadonlyArray<number | null | undefined>): number | null => {
  const known = xs.filter((x): x is number => typeof x === "number" && x > 0);
  return known.length ? Math.max(...known) : null;
};
