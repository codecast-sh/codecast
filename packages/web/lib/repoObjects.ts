// Pull requests and commits as reference objects: the pure helpers the pill,
// the hover card and the shared-object card all read. They live here rather
// than beside the components so the component modules stay Fast Refresh
// boundaries (lib/__tests__/fastRefreshBoundaries.guard.test.ts).
import { repoObjectId, type EntityType } from "@codecast/shared/entities";

/** Pull request state as the app reads it: GitHub's three states, one color each. */
const PR_STATE: Record<string, { label: string; color: string }> = {
  open: { label: "Open", color: "text-sol-green" },
  merged: { label: "Merged", color: "text-sol-violet" },
  closed: { label: "Closed", color: "text-sol-red" },
};
export function prState(state?: string | null): { label: string; color: string } {
  return PR_STATE[state ?? "open"] ?? PR_STATE.open;
}

/**
 * The `owner/repo#482` / `owner/repo@sha` reference for a resolved pull
 * request or commit row — what routes and labels are built from once the row
 * is in hand, whichever id the reference arrived with. `shaLength` is 12 for
 * display; routes pass 40 because the commit page matches the sha exactly.
 */
export function repoObjectRefOf(type: EntityType, entity: any, shaLength = 12): string | null {
  if (!entity?.repository) return null;
  if (type === "pr" && typeof entity.number === "number") return repoObjectId({ type: "pr", repository: entity.repository, number: entity.number });
  if (type === "commit" && typeof entity.sha === "string") return repoObjectId({ type: "commit", repository: entity.repository, sha: entity.sha.slice(0, shaLength) });
  return null;
}

/** The one-line name a pull request or commit reads as: its number or short sha, then its title. */
export function repoObjectTitle(type: EntityType, entity: any): string | undefined {
  if (type === "pr" && entity?.number != null) return `#${entity.number}${entity.title ? ` ${entity.title}` : ""}`;
  if (type === "commit" && entity?.sha) {
    const subject = String(entity.message ?? "").split("\n")[0].trim();
    return `${entity.sha.slice(0, 7)}${subject ? ` ${subject}` : ""}`;
  }
  return undefined;
}
