// The decision category vocabulary and the server-side assignment rule
// (docs/architecture/decisions-as-documents.md D1).
//
// A category decides who may answer. The open categories may be delegated to a
// role under a grant; the protected ones, `limit` and `unknown` are always held
// by a person. The asker names the category, because only the asker knows
// whose call the answer is: card text describes the situation, not who should
// answer it. `unknown` is the server's own value, which the CLI never offers: a
// decision a workflow run asks of a person (a gate, the card a gate adopts, a
// failure gate, a card a run's session posts) with no category declared, a
// proposal outside the vocabulary, and the admins' areas card.

import { OPEN_CATEGORIES, PROTECTED_CATEGORIES } from "@codecast/shared/contracts/decisionCategory";

export { OPEN_CATEGORIES, PROTECTED_CATEGORIES };
export const DECISION_CATEGORIES = [...OPEN_CATEGORIES, ...PROTECTED_CATEGORIES, "limit", "unknown"] as const;

export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export function isDecisionCategory(value: unknown): value is DecisionCategory {
  return typeof value === "string" && (DECISION_CATEGORIES as readonly string[]).includes(value);
}

// Production, billing, data, access, external and product: a person's call
// that keeps the ask-time routing it always had, never shared out by area.
export function isProtectedCategory(category: string | undefined): boolean {
  return !!category && (PROTECTED_CATEGORIES as readonly string[]).includes(category);
}

// Human held, never grantable to a role.
export function isHumanOnlyCategory(category: string | undefined): boolean {
  return (
    category === undefined ||
    category === "limit" ||
    category === "unknown" ||
    (PROTECTED_CATEGORIES as readonly string[]).includes(category)
  );
}

// The assignment (D1): the asker's proposal from the vocabulary stands. No
// proposal is the fallback: `review`, which a role may answer under a grant,
// for an agent's own card; `unknown`, which a person holds, for a run's. A
// proposal outside the vocabulary (kept in category_proposed by the caller) is
// `unknown`: a word the asker meant as a constraint is never loosened to an
// open category.
export function assignCategory(proposed: string | undefined, fallback: "review" | "unknown" = "review"): DecisionCategory {
  if (proposed === undefined) return fallback;
  return isDecisionCategory(proposed) ? proposed : "unknown";
}

// A decision a workflow run asks (its gate, the card its gate adopts, a failure
// gate): the category the flow declares, else a person's.
export function runCategory(declared: string | undefined): DecisionCategory {
  return assignCategory(declared, "unknown");
}

// The category an ask or an edit leaves a decision with (D1).
// - `current`: the open row's category on a re-ask or an edit (null for a new
//   ask). Without a proposal it stays.
// - `runDeclares`: the run itself asks (its gate, the runner's failure card),
//   so the proposal is the flow's word: runCategory.
// - `runs`: the card serves a run (a session of the run asks it, or a gate took
//   it up). Its asker may only tighten it: a proposal that is not a person's
//   leaves an open card as it was, and a new one with a person.
export function categoryFor(
  proposed: string | undefined,
  o: { current: string | undefined | null; runDeclares: boolean; runs: boolean },
): DecisionCategory {
  if (o.current !== null) {
    const kept: DecisionCategory = isDecisionCategory(o.current) ? o.current : "unknown";
    if (proposed === undefined) return kept;
    const next = assignCategory(proposed);
    return o.runs && !isHumanOnlyCategory(next) ? kept : next;
  }
  if (o.runDeclares) return runCategory(proposed);
  const next = assignCategory(proposed);
  return o.runs && !isHumanOnlyCategory(next) ? "unknown" : next;
}
