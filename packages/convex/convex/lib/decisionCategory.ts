// The decision category vocabulary and the server-side assignment rule
// (docs/architecture/decisions-as-documents.md D1).
//
// A category decides who may answer. The open categories may be delegated to a
// role under a grant; the protected ones, `limit` and `unknown` are always
// held by a person. The SERVER assigns the category: an asker may propose one,
// and the proposal stands only when it is not looser than what a conservative
// keyword read of the question and options finds. Any option that names a
// deploy, a purchase, a deletion, an access change, an external message or a
// product choice pins the decision to that protected category, whatever the
// asker proposed.

export const OPEN_CATEGORIES = ["approach", "scope", "priority", "retry", "review", "allocation"] as const;
export const PROTECTED_CATEGORIES = ["production", "billing", "data", "access", "external", "product"] as const;
export const DECISION_CATEGORIES = [...OPEN_CATEGORIES, ...PROTECTED_CATEGORIES, "limit", "unknown"] as const;

export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export function isDecisionCategory(value: unknown): value is DecisionCategory {
  return typeof value === "string" && (DECISION_CATEGORIES as readonly string[]).includes(value);
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

// Word-boundary phrase lists. Each phrase is matched as a whole word or word
// sequence on the lowercased text, so "deploy" does not fire on "deployment
// notes" being merely mentioned... it does, and that is the conservative side:
// a false pin costs a person one answer; a false release costs an unattended
// production change.
const PROTECTED_KEYWORDS: Record<(typeof PROTECTED_CATEGORIES)[number], string[]> = {
  production: [
    "deploy", "deploys", "deploying", "deployment", "ship to prod", "to production", "in production", "on production",
    "prod deploy", "release to", "roll out", "rollout", "rollback", "roll back", "go live", "cut a release", "cut the release",
    "publish the release", "hotfix", "restart prod", "migrate prod", "prod database", "production database",
  ],
  billing: [
    "purchase", "buy", "pay for", "payment", "subscription", "subscribe", "invoice", "charge the card", "credit card",
    "spend", "spending", "budget", "billing", "upgrade the plan", "quota", "cost money", "dollars", "$",
  ],
  data: [
    "delete", "deletes", "deleting", "drop the table", "drop table", "truncate", "wipe", "purge", "erase",
    "migrate data", "data migration", "migration", "backfill", "irreversible", "permanently remove", "hard delete",
    "reset the database", "destructive",
  ],
  access: [
    "grant access", "revoke access", "permission", "permissions", "admin role", "make admin", "api key", "api token",
    "rotate the key", "rotate key", "credentials", "secret", "secrets", "share access", "invite", "remove from the team",
    "access change", "auth", "oauth", "sso",
  ],
  external: [
    "send the email", "send an email", "email the", "email to", "message the customer", "reply to the customer",
    "post to slack", "post on", "tweet", "publish the post", "announce", "announcement", "notify the customer",
    "notify users", "contact", "reach out", "external", "press release", "newsletter", "dm ",
  ],
  product: [
    "product decision", "product choice", "product direction", "feature flag", "pricing", "user-facing", "user facing",
    "ux change", "the product should", "what the product", "roadmap", "launch", "rename the product", "positioning",
    "which feature", "should the product", "default behavior", "default behaviour",
  ],
};

const LIMIT_KEYWORDS = ["raise the cap", "raise the limit", "increase the limit", "increase the cap", "lift the limit", "rate limit", "raise quota", "higher limit"];

// Order matters only for the pinning read: the first protected category whose
// phrase appears wins, and the order is the one a person would expect to be
// the most consequential first.
const PIN_ORDER: (typeof PROTECTED_CATEGORIES)[number][] = ["production", "data", "billing", "access", "external", "product"];

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[\s\n]+/g, " ")} `;
}

function hasPhrase(haystack: string, phrase: string): boolean {
  if (phrase === "$") return haystack.includes("$");
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").trim();
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

export type ClassifiableDecision = {
  question: string;
  options: Array<{ label: string; description?: string; body_md?: string; cost?: string; risk?: string }>;
  context_md?: string;
};

// The conservative read: what a keyword scan of the question, the option
// labels, descriptions and bodies finds. Returns a protected category or
// `limit` when a phrase pins it, else null (the text does not force a
// category). Cost and risk strings are NOT scanned: "$2k" on an option's
// cost would pin every priced approach decision to billing and defeat grants.
export function pinnedCategory(input: ClassifiableDecision): DecisionCategory | null {
  const parts = [input.question, ...input.options.flatMap((o) => [o.label, o.description ?? "", o.body_md ?? ""])];
  const text = normalize(parts.join(" "));
  for (const category of PIN_ORDER) {
    if (PROTECTED_KEYWORDS[category].some((p) => hasPhrase(text, p))) return category;
  }
  if (LIMIT_KEYWORDS.some((p) => hasPhrase(text, p))) return "limit";
  return null;
}

// The assignment (D1): a pinned protected category beats any proposal. An
// open proposal stands when nothing pins. No proposal and nothing pinned is
// `unknown`, which a person holds. A proposal outside the vocabulary is
// ignored (kept in category_proposed by the caller for the audit trail).
export function assignCategory(
  input: ClassifiableDecision,
  proposed: string | undefined,
): { category: DecisionCategory; pinned: boolean } {
  const pinned = pinnedCategory(input);
  if (pinned) return { category: pinned, pinned: true };
  if (isDecisionCategory(proposed)) return { category: proposed, pinned: false };
  return { category: "unknown", pinned: false };
}
