/** Who may answer a decision (docs/architecture/decisions-as-documents.md D1): a role under a grant may answer the
 *  open categories; a person alone answers the protected ones and `limit`. An asker names one of these with
 *  `cast decide --category`; the server's own `unknown` is not offered. */
export const OPEN_CATEGORIES = ["approach", "scope", "priority", "retry", "review", "allocation"] as const;
export const PROTECTED_CATEGORIES = ["production", "billing", "data", "access", "external", "product"] as const;
export const PERSON_CATEGORIES = [...PROTECTED_CATEGORIES, "limit"] as const;

/** Why a proposed category is unusable, or null when an asker may name it. */
export function invalidCategory(category: string | undefined): string | null {
  if (category === undefined || ([...OPEN_CATEGORIES, ...PERSON_CATEGORIES] as readonly string[]).includes(category)) return null;
  return `--category ${category} is not a category. A person's alone: ${PERSON_CATEGORIES.join(", ")}. A role's under a grant: ${OPEN_CATEGORIES.join(", ")}.`;
}
