// What the team's decision inbox (For you) shows about each open decision at a
// glance, read off the decision, its card and its problem: what kind of change
// it decides, who it is assigned to, how many people and findings it settles,
// and how bad the worst finding is (the decision row's problem_severity).
// lineInbox stamps these on each row; the list's filters, sorts and groups
// read them. Pure.

/** What answering the decision changes: a fix to the product, a judge, an expectation, or something else a run asks. */
export type DecisionChange = "fix" | "judge" | "expectation" | "other";

export const DECISION_CHANGES: readonly DecisionChange[] = ["fix", "judge", "expectation", "other"];

export const DECISION_CHANGE_LABEL: Record<DecisionChange, string> = { fix: "Fix", judge: "Judge", expectation: "Expectation", other: "Other" };

type AssignableRow = { passed_to?: { kind: string; id: string } | null } | null | undefined;

/**
 * Who a decision is assigned to: the teammate a person gave it to (passed_to). The people routing asked are not its
 * assignee: assigning is a person's act, and taking it back (unassign) returns the decision to its routing.
 */
export const decisionAssignee = (d: AssignableRow): string | null => (d?.passed_to?.kind === "user" ? String(d.passed_to.id) : null);

export { contactsOf } from "@codecast/shared/contracts/problemReach";

export type SeverityBand = "high" | "mid" | "low";

/** A severity as the band its color shows: 8 and up high, 6 and 7 middling, below that low. */
export const severityBand = (n: number | null | undefined): SeverityBand | null => (n == null ? null : n >= 8 ? "high" : n >= 6 ? "mid" : "low");

/** The larger of counts that may be missing; null when none is known. */
export const mostOf = (...xs: ReadonlyArray<number | null | undefined>): number | null => {
  const known = xs.filter((x): x is number => typeof x === "number" && x > 0);
  return known.length ? Math.max(...known) : null;
};
