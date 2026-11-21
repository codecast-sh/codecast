// The decision category vocabulary and the server-side assignment rule
// (docs/architecture/decisions-as-documents.md D1).
//
// A category decides who may answer. The open categories may be delegated to a
// role under a grant; the protected ones and `limit` are always held by a
// person. The asker names the category, because only the asker knows whose
// call the answer is: card text describes the situation, not who should
// answer it. `unknown` is read on older rows only: the server never assigns
// it, and a person holds a row that carries it.

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
// caller), is `review`, which a role may answer under a grant.
export function assignCategory(proposed: string | undefined): DecisionCategory {
  return isDecisionCategory(proposed) && proposed !== "unknown" ? proposed : "review";
}
