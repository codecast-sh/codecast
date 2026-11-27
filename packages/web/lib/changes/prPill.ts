// A pull request row's state, in the names its chips draw (lib/prStateGlyph):
// the inline pill, the phone pill and the chips all show one pull request the
// same way. Checked in the order the change lifecycle reads them
// (changeLifecycle), so a pill and the Branches grid agree on what it waits on.
// Pure, with relative imports only.
import { isMerged, pullRequestFacts, type ChangePullRequest } from "./pullRequest";

export function prRowState(pr: Omit<ChangePullRequest, "updated_at" | "number"> & { updated_at?: number; number?: number }): string {
  if (isMerged(pr)) return "merged";
  if (pr.state === "closed") return "closed";
  const { check, land } = pullRequestFacts(pr as ChangePullRequest);
  const failing = check?.ci === "failure";
  if (land?.state === "conflict") return "conflicts";
  if (land?.state === "behind" && !failing) return "behind";
  if (pr.draft && !failing) return "draft";
  if (failing) return "ci_red";
  if (check?.review === "changes") return "changes_requested";
  if (check?.ci === "pending") return "ci_pending";
  if (check?.review === "required") return "review_pending";
  if (check?.review === "approved") return check.ci === "success" ? "ready" : "approved";
  return check?.ci === "success" ? "ready" : "open";
}
