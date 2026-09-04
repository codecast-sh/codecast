// GitHub issues REST client for issue sync (S5, S6).
//
// Same shape as linearApi.ts: plain functions taking an already-resolved
// installation token, so the sync engine reads top to bottom. Headers and base
// url follow githubApi.ts / githubApp.ts.
//
// One rule runs through every read here: GitHub returns pull requests from the
// issues endpoints, and a PR carries a `pull_request` key. We drop those. A PR
// is already a first-class codecast citizen (the pull_requests table); letting
// one in through this door would mint a second, half-populated twin of it.

const GITHUB_API_BASE = "https://api.github.com";
const TIMEOUT_MS = 15_000;

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

async function githubJson(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: headers(token, init.body ? { "Content-Type": "application/json" } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${path}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.status === 204 ? null : await res.json();
}

export function isPullRequest(row: any): boolean {
  return !!row?.pull_request;
}

/** One page of issues (never pull requests), open and closed. */
export async function listIssues(
  token: string,
  repo: string,
  opts: { since?: number; page?: number } = {},
): Promise<any[]> {
  const params = new URLSearchParams({
    state: "all",
    per_page: "100",
    page: String(opts.page ?? 1),
    sort: "updated",
    direction: "desc",
  });
  if (opts.since) params.set("since", new Date(opts.since).toISOString());
  const rows = await githubJson(token, `/repos/${repo}/issues?${params.toString()}`);
  return Array.isArray(rows) ? rows.filter((r) => !isPullRequest(r)) : [];
}

export async function getIssue(token: string, repo: string, number: number): Promise<any | null> {
  const row = await githubJson(token, `/repos/${repo}/issues/${number}`);
  return isPullRequest(row) ? null : row;
}

export async function listIssueComments(token: string, repo: string, number: number): Promise<any[]> {
  const rows = await githubJson(token, `/repos/${repo}/issues/${number}/comments?per_page=100`);
  return Array.isArray(rows) ? rows : [];
}

export type GithubIssuePatch = {
  title?: string;
  body?: string;
  state?: string;
  state_reason?: string;
  labels?: string[];
  assignees?: string[];
};

export async function updateIssue(
  token: string,
  repo: string,
  number: number,
  patch: GithubIssuePatch,
): Promise<any> {
  return await githubJson(token, `/repos/${repo}/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function createIssue(token: string, repo: string, issue: GithubIssuePatch): Promise<any> {
  return await githubJson(token, `/repos/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify(issue),
  });
}

export async function createIssueComment(
  token: string,
  repo: string,
  number: number,
  body: string,
): Promise<{ id: string; url?: string }> {
  const row = await githubJson(token, `/repos/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  // node_id is what inbound webhooks carry, so it is the id we store (S1.2) —
  // storing the numeric id would never match the echo and every pushed comment
  // would come back as a duplicate.
  return { id: String(row?.node_id ?? row?.id ?? ""), url: row?.html_url };
}

/** Repos an installation can reach when its selection is "all". */
export async function listInstallationRepos(token: string): Promise<Array<{ full_name: string; html_url?: string }>> {
  const out: Array<{ full_name: string; html_url?: string }> = [];
  for (let page = 1; page <= 5; page++) {
    const data = await githubJson(token, `/installation/repositories?per_page=100&page=${page}`);
    const repos = data?.repositories ?? [];
    out.push(...repos);
    if (repos.length < 100) break;
  }
  return out;
}
