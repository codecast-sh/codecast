// The decision category vocabulary and the server-side assignment rule
// (docs/architecture/decisions-as-documents.md D1).
//
// A category decides who may answer. The open categories may be delegated to a
// role under a grant; the protected ones, `limit` and `unknown` are always held
// by a person. The asker names the category, because only the asker knows
// whose call the answer is: card text describes the situation, not who should
// answer it. `unknown` is the server's own value, never an asker's: a decision
// a workflow run asks of a person (a gate, the card a gate adopts, a failure
// gate) that declares no category, and the admins' areas card.

export const OPEN_CATEGORIES = ["approach", "scope", "priority", "retry", "review", "allocation"] as const;
export const PROTECTED_CATEGORIES = ["production", "billing", "data", "access", "external", "product"] as const;
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
// proposal, or one outside the vocabulary (kept in category_proposed by the
// caller), is the fallback: `review`, which a role may answer under a grant,
// for an agent's own card; `unknown`, which a person holds, for a run's.
export function assignCategory(proposed: string | undefined, fallback: "review" | "unknown" = "review"): DecisionCategory {
  return isDecisionCategory(proposed) && proposed !== "unknown" ? proposed : fallback;
}

// A decision a workflow run asks (its gate, the card its gate adopts, a failure
// gate): the category the flow declares, else a person's.
export function runCategory(declared: string | undefined): DecisionCategory {
  return assignCategory(declared, "unknown");
}
