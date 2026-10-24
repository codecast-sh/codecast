// Ask first (docs/architecture/vault.md "Second round"): a read of a secret
// that needs a person's approval for this session comes back with no values
// and the decision that person answers. Every read path (get, run, env, otp,
// cast dev, the browser's sign-in) says it the same way and stops with
// NEEDS_APPROVAL_EXIT, so a script can tell "wait for a person" from a failure.
import type { SecretNeedsApproval } from "@codecast/shared/contracts/secrets";

/** The exit code of a read held for a person's approval. */
export const NEEDS_APPROVAL_EXIT = 3;

export function isNeedsApproval(res: unknown): res is SecretNeedsApproval {
  return !!res && typeof res === "object" && "needs_approval" in res;
}

/**
 * The decision ids and the dormant line naming them. Names and ids only, never
 * a value. A read's --why words the decision's context, and a later read with a
 * new why rewrites the open decision in place, so only a read without one is
 * told to add it.
 */
export function approvalLines(res: SecretNeedsApproval, why?: string): string[] {
  const held = res.approvals?.length ? res.approvals : [res.needs_approval];
  const ids = held.map((a) => a.decision).join(", ");
  const names = held.map((a) => a.secret).join(", ");
  return [
    `Ask first: ${names} ${held.length > 1 ? "wait" : "waits"} on a person's approval for this session (${ids}). Nothing was read.`,
    ...(why ? [] : [`Add --why "…" so the person sees what it is for; a read with one updates the open decision.`]),
    `End your turn dormant naming it, and run this again once the answer wakes you: cast state --status dormant "Waiting on ${ids} to use ${names}"`,
  ];
}

/** Print the approval lines on stderr and exit NEEDS_APPROVAL_EXIT. */
export function exitForApproval(res: SecretNeedsApproval, why?: string): never {
  for (const line of approvalLines(res, why)) console.error(line);
  process.exit(NEEDS_APPROVAL_EXIT);
}
