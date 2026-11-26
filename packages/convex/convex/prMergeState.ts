// Reading one pull request's merge state from GitHub (mergeability, head and
// base, how far behind its base it is) and writing it through
// prShepherd.applyMergeState. The refresh actions in prShepherd.ts drive it.
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

export const GITHUB_API_BASE = "https://api.github.com";

type PR = Doc<"pull_requests">;

export type MergeStateResult = { ok: boolean; reason?: string; retry?: boolean };

/** Ask GitHub for one pull request's merge state and write it down. */
export async function fetchMergeState(
  ctx: any,
  prId: Id<"pull_requests">,
  tokenFor: (pr: PR) => Promise<string | null>,
): Promise<MergeStateResult> {
  const pr: PR | null = await ctx.runQuery(internal.prShepherd.getPR, { pr_id: prId });
  if (!pr) return { ok: false, reason: "no_pr" };
  if (pr.state !== "open") return { ok: false, reason: "not_open" };

  const token = await tokenFor(pr);
  if (!token) return { ok: false, reason: "no_token" };

  const [owner, repo] = pr.repository.split("/");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pr.number}`, { headers });
  if (!response.ok) {
    return { ok: false, reason: `github ${response.status}` };
  }
  const data = await response.json();

  let behindBy: number | undefined;
  const baseRef = data.base?.ref;
  const headRef = data.head?.ref;
  if (baseRef && headRef) {
    const compare = await fetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`,
      { headers },
    );
    if (compare.ok) {
      const compareData = await compare.json();
      behindBy = compareData.behind_by;
    }
  }

  const result = await ctx.runMutation(internal.prShepherd.applyMergeState, {
    pr_id: prId,
    mergeable: data.mergeable ?? null,
    mergeable_state: data.mergeable_state,
    head_sha: data.head?.sha,
    base_sha: data.base?.sha,
    draft: !!data.draft,
    requested_reviewers: (data.requested_reviewers ?? []).map((r: any) => r.login),
    behind_by: behindBy,
  });
  return { ok: true, retry: result.retry };
}
