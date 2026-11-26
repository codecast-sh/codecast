// Pure readers of GitHub pull request and review payloads, in the shapes the
// pull_requests and reviews rows store (githubWebhooks.ts writes them).

// GitHub's review states, mapped onto the ones this schema stores. A dismissed
// review has been withdrawn: it stays in the history as dismissed, and the
// review decision counts it as nothing.
export function mapReviewState(state: string | undefined): "approved" | "changes_requested" | "commented" | "dismissed" {
  const normalized = (state ?? "").toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "changes_requested") return "changes_requested";
  if (normalized === "dismissed") return "dismissed";
  return "commented";
}

/** GitHub's auto-merge request on a pull request payload, in the row's shape. */
export function autoMergeFrom(prPayload: any): { merge_method?: string; enabled_by?: string } | null {
  const auto = prPayload?.auto_merge;
  if (!auto) return null;
  return { merge_method: auto.merge_method ?? undefined, enabled_by: auto.enabled_by?.login ?? undefined };
}

/** GitHub's labels and assignees on a pull request payload, in the row's shape. */
export function prMetadataFrom(prPayload: any): {
  labels: Array<{ name: string; color?: string }>;
  assignees: string[];
} {
  return {
    labels: (prPayload?.labels ?? [])
      .filter((l: any) => typeof l?.name === "string")
      .map((l: any) => ({ name: l.name as string, color: typeof l.color === "string" ? l.color : undefined })),
    assignees: (prPayload?.assignees ?? []).map((a: any) => a?.login).filter((l: any) => typeof l === "string"),
  };
}
