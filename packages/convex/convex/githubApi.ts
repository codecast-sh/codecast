import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { belongsToSearchRepository, scopedRepoSearch } from "./lib/repoSearch";

const GITHUB_API_BASE = "https://api.github.com";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * What GitHub actually said, for showing to a person.
 *
 * GitHub puts the useful sentence in two different places. A refusal it has a
 * rule for arrives as {"message": "Pull Request is not mergeable"}. A
 * validation failure arrives as {"message": "Unprocessable Entity"} with the
 * real reason buried in errors[]: approving your own pull request is one of
 * those, and "Unprocessable Entity" tells the caller nothing. So read the
 * details first and fall back to the summary.
 */
export function githubErrorMessage(status: number, rawBody: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody.trim() ? `${status}: ${rawBody.trim()}` : `GitHub returned ${status}`;
  }

  const details: string[] = Array.isArray(parsed?.errors)
    ? parsed.errors
        .map((e: any) => (typeof e === "string" ? e : e?.message))
        .filter((m: any): m is string => typeof m === "string" && m.trim() !== "")
    : [];
  if (details.length) return details.join("; ");
  if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message;
  return `GitHub returned ${status}`;
}

/** One call, one place that turns a failure into GitHub's own words. */
async function githubFetch(
  url: string,
  token: string,
  init: { method: string; body?: unknown },
): Promise<any> {
  const response = await fetch(url, {
    method: init.method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    throw new Error(githubErrorMessage(response.status, await response.text()));
  }
  // A 204 has no body to read (deleting a branch answers with one).
  if (response.status === 204) return {};
  return await response.json();
}

/** owner and repo, or a clear failure naming what was wrong. */
function splitRepository(repository: string): [string, string] {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository format: ${repository}. Expected: owner/repo`);
  }
  return [owner, repo];
}

export const postPRComment = action({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    comment_body: v.string(),
    github_access_token: v.string(),
  },
  handler: async (ctx, args) => {
    const [owner, repo] = args.repository.split("/");

    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${args.pr_number}/comments`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${args.github_access_token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: args.comment_body,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return {
      success: true,
      comment_id: data.id,
      comment_url: data.html_url,
    };
  },
});

export const submitPRReview = action({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    event: v.union(
      v.literal("APPROVE"),
      v.literal("REQUEST_CHANGES"),
      v.literal("COMMENT")
    ),
    body: v.optional(v.string()),
    github_access_token: v.string(),
  },
  handler: async (ctx, args) => {
    const [owner, repo] = args.repository.split("/");

    if (!owner || !repo) {
      throw new Error(`Invalid repository format: ${args.repository}. Expected: owner/repo`);
    }

    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${args.pr_number}/reviews`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${args.github_access_token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event: args.event,
        body: args.body,
      }),
    });

    if (!response.ok) {
      throw new Error(githubErrorMessage(response.status, await response.text()));
    }

    const data = await response.json();
    return {
      success: true,
      review_id: data.id,
      review_url: data.html_url,
      state: data.state,
    };
  },
});

/**
 * Merge a pull request. GitHub decides whether it may be merged, so a branch
 * that is behind, conflicted or blocked by a required check comes back as a
 * refusal in its own words rather than something guessed here.
 */
export const mergePullRequest = internalAction({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    method: v.union(v.literal("merge"), v.literal("squash"), v.literal("rebase")),
    github_access_token: v.string(),
    delete_branch: v.optional(v.boolean()),
    head_ref: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ merged: boolean; sha?: string; message?: string; branch_deleted: boolean }> => {
    const [owner, repo] = splitRepository(args.repository);
    const data = await githubFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${args.pr_number}/merge`,
      args.github_access_token,
      { method: "PUT", body: { merge_method: args.method } },
    );

    // Deleting the branch is a courtesy after the merge, never the point of it:
    // a merge that landed must not report failure because the ref was already
    // gone or the token may not delete it.
    let branchDeleted = false;
    if (args.delete_branch && args.head_ref) {
      try {
        await githubFetch(
          `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/refs/heads/${args.head_ref}`,
          args.github_access_token,
          { method: "DELETE" },
        );
        branchDeleted = true;
      } catch (error) {
        console.warn(`[githubApi] merged #${args.pr_number} but could not delete ${args.head_ref}:`, error);
      }
    }

    return { merged: !!data.merged, sha: data.sha, message: data.message, branch_deleted: branchDeleted };
  },
});

/** Close a pull request without merging it. */
export const closePullRequest = internalAction({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    github_access_token: v.string(),
  },
  handler: async (ctx, args): Promise<{ state: string }> => {
    const [owner, repo] = splitRepository(args.repository);
    const data = await githubFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${args.pr_number}`,
      args.github_access_token,
      { method: "PATCH", body: { state: "closed" } },
    );
    return { state: data.state };
  },
});

export const postCommentToGitHub = internalAction({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    content: v.string(),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    github_access_token: v.string(),
    comment_id: v.id("comments"),
  },
  handler: async (ctx, args) => {
    const [owner, repo] = args.repository.split('/');

    if (!owner || !repo) {
      throw new Error(`Invalid repository format: ${args.repository}. Expected: owner/repo`);
    }

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        let url: string;
        let body: any;

        if (args.file_path && args.line_number) {
          url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${args.pr_number}/comments`;
          body = {
            body: args.content,
            path: args.file_path,
            line: args.line_number,
            side: "RIGHT",
          };
        } else {
          url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${args.pr_number}/comments`;
          body = {
            body: args.content,
          };
        }

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${args.github_access_token}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (response.status === 403) {
          const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
          const rateLimitReset = response.headers.get("X-RateLimit-Reset");

          if (rateLimitRemaining === "0" && rateLimitReset) {
            const resetTime = parseInt(rateLimitReset) * 1000;
            const waitTime = Math.min(resetTime - Date.now(), 60000);

            if (waitTime > 0 && attempt < maxRetries - 1) {
              console.log(`Rate limited. Waiting ${waitTime}ms before retry...`);
              await sleep(waitTime);
              continue;
            }
          }
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const githubComment = await response.json();

        await ctx.runMutation(internal.comments.updateGitHubCommentId, {
          comment_id: args.comment_id,
          github_comment_id: githubComment.id,
        });

        return {
          success: true,
          github_comment_id: githubComment.id,
          github_comment_url: githubComment.html_url,
        };

      } catch (error) {
        lastError = error as Error;

        if (attempt < maxRetries - 1) {
          const backoffTime = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.log(`Attempt ${attempt + 1} failed. Retrying in ${backoffTime}ms...`);
          await sleep(backoffTime);
        }
      }
    }

    throw new Error(`Failed to post GitHub comment after ${maxRetries} attempts: ${lastError?.message}`);
  },
});

export const syncRepositoryCommits = action({
  args: {
    repository: v.string(),
    github_access_token: v.string(),
    per_page: v.optional(v.number()),
    max_pages: v.optional(v.number()),
    since: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const [owner, repo] = args.repository.split("/");

    if (!owner || !repo) {
      throw new Error(`Invalid repository format: ${args.repository}. Expected: owner/repo`);
    }

    const perPage = args.per_page ?? 100;
    const maxPages = args.max_pages ?? 5;
    let synced = 0;
    let total = 0;
    let page = 1;

    while (page <= maxPages) {
      let url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?per_page=${perPage}&page=${page}`;
      if (args.since) {
        url += `&since=${args.since}`;
      }

      const response = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${args.github_access_token}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} ${errorText}`);
      }

      const commits = await response.json();
      if (commits.length === 0) {
        break;
      }

      total += commits.length;

      for (const commit of commits) {
        const commitUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${commit.sha}`;
        const detailResponse = await fetch(commitUrl, {
          headers: {
            "Authorization": `Bearer ${args.github_access_token}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });

        if (!detailResponse.ok) {
          console.error(`Failed to fetch commit details for ${commit.sha}`);
          continue;
        }

        const commitDetail = await detailResponse.json();

        const files = commitDetail.files?.map((file: any) => {
          let patch = file.patch;
          if (patch && patch.length > MAX_PATCH_SIZE) {
            patch = patch.substring(0, MAX_PATCH_SIZE) + "\n... [truncated, patch too large]";
          }
          return {
            filename: file.filename,
            status: file.status,
            additions: file.additions || 0,
            deletions: file.deletions || 0,
            changes: file.changes || 0,
            patch,
          };
        }) || [];

        try {
          await ctx.runMutation(api.commits.addCommit, {
            sha: commit.sha,
            message: commit.commit.message,
            author_name: commit.commit.author?.name || commit.author?.login || "Unknown",
            author_email: commit.commit.author?.email || "",
            timestamp: new Date(commit.commit.author?.date || commit.commit.committer?.date).getTime(),
            files_changed: commitDetail.files?.length || 0,
            insertions: commitDetail.stats?.additions || 0,
            deletions: commitDetail.stats?.deletions || 0,
            repository: args.repository,
            files,
          });
          synced++;
        } catch (e) {
          console.error(`Failed to add commit ${commit.sha}:`, e);
        }

        await sleep(100);
      }

      if (commits.length < perPage) {
        break;
      }

      page++;
    }

    return { synced, total, pages_fetched: page };
  },
});

export const getUserRepositories = action({
  args: {
    github_access_token: v.string(),
    per_page: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const perPage = args.per_page ?? 30;
    const url = `${GITHUB_API_BASE}/user/repos?per_page=${perPage}&sort=pushed&affiliation=owner,collaborator`;

    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${args.github_access_token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${errorText}`);
    }

    const repos = await response.json();
    return repos.map((repo: any) => ({
      full_name: repo.full_name,
      name: repo.name,
      owner: repo.owner.login,
      private: repo.private,
      pushed_at: repo.pushed_at,
      default_branch: repo.default_branch,
    }));
  },
});

const MAX_PATCH_SIZE = 50 * 1024;

export const getPRFiles = internalAction({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    github_access_token: v.string(),
  },
  handler: async (ctx, args) => {
    const [owner, repo] = args.repository.split("/");

    if (!owner || !repo) {
      throw new Error(`Invalid repository format: ${args.repository}. Expected: owner/repo`);
    }

    const prUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${args.pr_number}`;
    const prResponse = await fetch(prUrl, {
      headers: {
        "Authorization": `Bearer ${args.github_access_token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!prResponse.ok) {
      const errorText = await prResponse.text();
      throw new Error(`GitHub API error fetching PR: ${prResponse.status} ${errorText}`);
    }

    const prData = await prResponse.json();

    const filesUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${args.pr_number}/files?per_page=100`;
    const filesResponse = await fetch(filesUrl, {
      headers: {
        "Authorization": `Bearer ${args.github_access_token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!filesResponse.ok) {
      const errorText = await filesResponse.text();
      throw new Error(`GitHub API error fetching files: ${filesResponse.status} ${errorText}`);
    }

    const filesData = await filesResponse.json();

    const files = filesData.map((file: any) => {
      let patch = file.patch;
      if (patch && patch.length > MAX_PATCH_SIZE) {
        patch = patch.substring(0, MAX_PATCH_SIZE) + "\n... [truncated, patch too large]";
      }
      return {
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch,
      };
    });

    return {
      files,
      additions: prData.additions,
      deletions: prData.deletions,
      changed_files: prData.changed_files,
      commits_count: prData.commits,
      base_ref: prData.base?.ref,
      head_ref: prData.head?.ref,
      state: prData.merged ? "merged" : prData.state === "closed" ? "closed" : "open",
      merged_at: prData.merged_at ? new Date(prData.merged_at).getTime() : undefined,
    };
  },
});

// ── Repository browsing ──
//
// Read-only wrappers over the contents, git and GraphQL APIs, used by repos.ts
// behind a cache. Each one takes an already-minted token and returns plain
// data: the caching, the freshness rules and the access checks all live in
// repos.ts, so these stay a thin, testable edge onto GitHub.

const MAX_BLOB_BYTES = 1024 * 1024;

function repoParts(repository: string): [string, string] {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository format: ${repository}. Expected: owner/repo`);
  return [owner, repo];
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * One place to turn a GitHub failure into a sentence a person can act on.
 * A 404 through an App token usually means the installation does not cover the
 * repository, which reads nothing like "not found" to whoever asked.
 */
async function ghFetch(url: string, token: string, accept?: string): Promise<any> {
  const headers = ghHeaders(token);
  const response = await fetch(url, { headers: accept ? { ...headers, Accept: accept } : headers });
  if (response.status === 404) {
    throw new Error(`GitHub returned 404 for ${url} — the ref or path does not exist, or the installation does not cover this repository`);
  }
  if (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0") {
    const reset = response.headers.get("X-RateLimit-Reset");
    throw new Error(`GitHub rate limit reached${reset ? `, resets at ${new Date(Number(reset) * 1000).toISOString()}` : ""}`);
  }
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

/**
 * One GraphQL call. Blame, per directory last commits and the branch table all
 * need fields the REST API does not expose, and an App installation token works
 * on the GraphQL endpoint unchanged.
 *
 * GraphQL answers 200 with an `errors` array, so a caller that only checks the
 * HTTP status reads `undefined` and reports nothing wrong. `soft` hands those
 * errors back instead of throwing, which is what lets listBranchDetails retry
 * without the `compare` field when an installation cannot see it.
 */
async function ghGraphQL(
  query: string,
  variables: Record<string, unknown>,
  token: string,
  soft = false,
): Promise<{ data: any; errors?: { message: string }[] }> {
  const response = await fetch(`${GITHUB_API_BASE}/graphql`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL error: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  if (body.errors?.length && !soft) {
    throw new Error(`GitHub GraphQL error: ${body.errors.map((e: any) => e.message).join("; ")}`);
  }
  return { data: body.data, errors: body.errors };
}

/** A path as a GraphQL string literal. GraphQL string syntax is JSON's. */
function gqlString(value: string): string {
  return JSON.stringify(value);
}

export const listBranches = internalAction({
  args: {
    repository: v.string(),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const repoInfo = await ghFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, args.github_access_token);
    const branches = await ghFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/branches?per_page=100`,
      args.github_access_token,
    );
    return {
      default_branch: repoInfo.default_branch as string,
      truncated: branches.length === 100,
      branches: branches.map((b: any) => ({
        name: b.name as string,
        sha: b.commit?.sha as string,
        protected: !!b.protected,
      })),
    };
  },
});

export const getTree = internalAction({
  args: {
    repository: v.string(),
    ref: v.string(),
    recursive: v.optional(v.boolean()),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const suffix = args.recursive ? "?recursive=1" : "";
    const data = await ghFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(args.ref)}${suffix}`,
      args.github_access_token,
    );
    return {
      sha: data.sha as string,
      truncated: !!data.truncated,
      entries: (data.tree ?? []).map((entry: any) => ({
        path: entry.path as string,
        type: entry.type as string,
        sha: entry.sha as string,
        size: entry.size as number | undefined,
      })),
    };
  },
});

export const getBlob = internalAction({
  args: {
    repository: v.string(),
    ref: v.string(),
    path: v.string(),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const data = await ghFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${args.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(args.ref)}`,
      args.github_access_token,
    );
    if (Array.isArray(data)) {
      throw new Error(`${args.path} is a directory, not a file`);
    }
    if (typeof data.size === "number" && data.size > MAX_BLOB_BYTES) {
      return { content: "", size: data.size, truncated: true, sha: data.sha as string };
    }
    // GitHub returns base64 with newlines, which atob rejects.
    const raw = typeof data.content === "string" ? atob(data.content.replace(/\n/g, "")) : "";
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    return {
      content: new TextDecoder().decode(bytes),
      ...(/\.(png|jpe?g|webp|gif|ico|avif)$/i.test(args.path) ? { base64: data.content.replace(/\s/g, "") } : {}),
      size: data.size as number,
      truncated: false,
      sha: data.sha as string,
    };
  },
});

async function commitSummaries(owner: string, repo: string, shas: string[], token: string): Promise<Record<string, any>> {
  const summaries: Record<string, any> = {};
  for (let start = 0; start < shas.length; start += 50) {
    const batch = shas.slice(start, start + 50);
    const fields = batch.map((sha, i) => `c${i}: object(expression: ${gqlString(sha)}) { ... on Commit { oid messageHeadline committedDate additions deletions changedFilesIfAvailable author { name user { login avatarUrl } } } }`).join("\n");
    const result = await ghGraphQL(`query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`, { owner, repo }, token, true);
    batch.forEach((sha, i) => {
      const commit = result.data?.repository?.[`c${i}`];
      if (commit?.oid) summaries[sha] = commit;
    });
  }
  return summaries;
}

export const listCommits = internalAction({
  args: {
    repository: v.string(),
    sha: v.optional(v.string()),
    path: v.optional(v.string()),
    per_page: v.optional(v.number()),
    page: v.optional(v.number()),
    author: v.optional(v.string()),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const params = new URLSearchParams({
      per_page: String(args.per_page ?? 50),
      page: String(args.page ?? 1),
    });
    if (args.sha) params.set("sha", args.sha);
    if (args.path) params.set("path", args.path);
    if (args.author) params.set("author", args.author);

    const data = await ghFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?${params.toString()}`,
      args.github_access_token,
    );
    const summaries = await commitSummaries(owner, repo, data.map((commit: any) => commit.sha), args.github_access_token);
    return {
      commits: data.map((commit: any) => ({
        sha: commit.sha as string,
        additions: summaries[commit.sha]?.additions as number | undefined,
        deletions: summaries[commit.sha]?.deletions as number | undefined,
        changed_files: summaries[commit.sha]?.changedFilesIfAvailable as number | undefined,
        message: (commit.commit?.message ?? "") as string,
        author_name: (commit.commit?.author?.name ?? "") as string,
        author_login: commit.author?.login as string | undefined,
        author_avatar_url: commit.author?.avatar_url as string | undefined,
        timestamp: new Date(commit.commit?.author?.date ?? commit.commit?.committer?.date ?? 0).getTime(),
        html_url: commit.html_url as string,
      })),
    };
  },
});

/**
 * One commit with its per-file diff.
 *
 * A commit that arrived by webhook carries only its message and counts, because
 * the push payload has no patch in it. This is the call that fills the rest in,
 * and a sha never moves, so the answer is good forever.
 */
export const getCommit = internalAction({
  args: {
    repository: v.string(),
    sha: v.string(),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const data = await ghFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${encodeURIComponent(args.sha)}`,
      args.github_access_token,
    );
    const files = (data.files ?? []).map((file: any) => ({
      filename: file.filename as string,
      status: file.status as string,
      additions: (file.additions ?? 0) as number,
      deletions: (file.deletions ?? 0) as number,
      changes: (file.changes ?? 0) as number,
      patch: typeof file.patch === "string" ? file.patch : undefined,
    }));
    return {
      sha: data.sha as string,
      message: (data.commit?.message ?? "") as string,
      author_login: data.author?.login as string | undefined,
      author_avatar_url: data.author?.avatar_url as string | undefined,
      html_url: data.html_url as string,
      files,
      additions: (data.stats?.additions ?? 0) as number,
      deletions: (data.stats?.deletions ?? 0) as number,
    };
  },
});

export const compare = internalAction({
  args: {
    repository: v.string(),
    base: v.string(),
    head: v.string(),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const data = await ghFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`,
      args.github_access_token,
    );
    return {
      ahead_by: data.ahead_by as number,
      behind_by: data.behind_by as number,
      total_commits: data.total_commits as number,
      status: data.status as string,
      commits: (data.commits ?? []).map((commit: any) => ({
        sha: commit.sha as string,
        message: (commit.commit?.message ?? "") as string,
        author_name: (commit.commit?.author?.name ?? "") as string,
        author_login: commit.author?.login as string | undefined,
        author_avatar_url: commit.author?.avatar_url as string | undefined,
        timestamp: new Date(commit.commit?.author?.date ?? commit.commit?.committer?.date ?? 0).getTime(),
      })),
      files: (data.files ?? []).map((file: any) => {
        // Same cap as getPRFiles. A generated lockfile diff alone can outrun
        // the row a cached compare is written into, so an oversized patch is
        // dropped and named rather than truncated into invalid diff text.
        const patch = typeof file.patch === "string" ? file.patch : undefined;
        const oversized = !!patch && patch.length > MAX_PATCH_SIZE;
        return {
          filename: file.filename as string,
          status: file.status as string,
          additions: (file.additions ?? 0) as number,
          deletions: (file.deletions ?? 0) as number,
          patch: oversized ? undefined : patch,
          patch_truncated: oversized,
        };
      }),
    };
  },
});

/**
 * Blame for one file, which only GraphQL answers. The App installation token
 * works there too, so this needs no extra credential.
 */
export const getBlame = internalAction({
  args: {
    repository: v.string(),
    ref: v.string(),
    path: v.string(),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const query = `
      query($owner: String!, $repo: String!, $expression: String!, $path: String!) {
        repository(owner: $owner, name: $repo) {
          object(expression: $expression) {
            ... on Commit {
              blame(path: $path) {
                ranges {
                  startingLine
                  endingLine
                  age
                  commit {
                    oid
                    message
                    committedDate
                    author { name user { login avatarUrl } }
                  }
                }
              }
            }
          }
        }
      }`;

    const { data } = await ghGraphQL(
      query,
      { owner, repo, expression: args.ref, path: args.path },
      args.github_access_token,
    );

    const ranges = data?.repository?.object?.blame?.ranges ?? [];
    return {
      ranges: ranges.map((range: any) => ({
        start_line: range.startingLine as number,
        end_line: range.endingLine as number,
        sha: range.commit?.oid as string,
        message: ((range.commit?.message ?? "") as string).split("\n")[0],
        author_name: range.commit?.author?.name as string | undefined,
        author_login: range.commit?.author?.user?.login as string | undefined,
        author_avatar_url: range.commit?.author?.user?.avatarUrl as string | undefined,
        committed_at: new Date(range.commit?.committedDate ?? 0).getTime(),
      })),
    };
  },
});

// ── Repository browsing: the calls GitHub parity needs ──

/**
 * The repository itself: what the overview header and the sidebar render.
 *
 * Two calls, because the language bar has its own endpoint. Both are cheap and
 * neither is useful alone, so they travel together as one cache row.
 */
export const getRepoMeta = internalAction({
  args: {
    repository: v.string(),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const [info, languages, counts] = await Promise.all([
      ghFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, args.github_access_token),
      ghFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/languages`, args.github_access_token),
      ghGraphQL('query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { pullRequests(states: OPEN) { totalCount } } }', { owner, repo }, args.github_access_token),
    ]);
    return {
      private: !!info.private,
      description: (info.description ?? null) as string | null,
      homepage: (info.homepage ?? null) as string | null,
      topics: (info.topics ?? []) as string[],
      default_branch: info.default_branch as string,
      size: (info.size ?? 0) as number,
      stargazers_count: (info.stargazers_count ?? 0) as number,
      forks_count: (info.forks_count ?? 0) as number,
      open_issues_count: (info.open_issues_count ?? 0) as number,
      open_pulls_count: counts.data?.repository?.pullRequests?.totalCount as number | undefined,
      pushed_at: info.pushed_at ? new Date(info.pushed_at).getTime() : null,
      archived: !!info.archived,
      html_url: info.html_url as string,
      license: (info.license?.spdx_id ?? null) as string | null,
      languages: (languages ?? {}) as Record<string, number>,
    };
  },
});

export const listTags = internalAction({
  args: {
    repository: v.string(),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const data = await ghFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/tags?per_page=100`,
      args.github_access_token,
    );
    const summaries = await commitSummaries(owner, repo, (data ?? []).map((tag: any) => tag.commit?.sha).filter(Boolean), args.github_access_token);
    return {
      truncated: data.length === 100,
      tags: (data ?? []).map((tag: any) => ({
        name: tag.name as string,
        sha: tag.commit?.sha as string,
        subject: summaries[tag.commit?.sha]?.messageHeadline as string | undefined,
        committed_at: summaries[tag.commit?.sha]?.committedDate ? new Date(summaries[tag.commit.sha].committedDate).getTime() : undefined,
        author_login: summaries[tag.commit?.sha]?.author?.user?.login as string | undefined,
      })),
    };
  },
});

/**
 * The README at a ref, or null.
 *
 * A repository without one is ordinary, so a 404 is an answer rather than a
 * failure: throwing would make the overview page report an error for a
 * repository that is merely undocumented.
 */
export const getReadme = internalAction({
  args: {
    repository: v.string(),
    ref: v.string(),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(args.ref)}`;
    const response = await fetch(url, { headers: ghHeaders(args.github_access_token) });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    // GitHub returns base64 with newlines in it, which atob rejects.
    const raw = typeof data.content === "string" ? atob(data.content.replace(/\n/g, "")) : "";
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    return {
      path: data.path as string,
      content: new TextDecoder().decode(bytes),
      sha: data.sha as string,
    };
  },
});

/** Up to this many paths ride in one GraphQL query. */
const LAST_COMMIT_CHUNK = 40;

/**
 * The commit that last touched each of these paths.
 *
 * This is the column GitHub shows beside every row of a directory listing, and
 * REST answers it one path at a time: a folder of thirty files would be thirty
 * round trips. GraphQL takes aliased history fields instead, so a whole
 * directory costs one call.
 */
export const lastCommitsForPaths = internalAction({
  args: {
    repository: v.string(),
    ref: v.string(),
    /** Full repository-relative paths. Left unset, `dir` is listed instead. */
    paths: v.optional(v.array(v.string())),
    /** The directory to list when `paths` is not given. "" is the root. */
    dir: v.optional(v.string()),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const out: Record<string, any> = {};

    // A caller with the directory already cached hands over the names. One
    // without (the public route knows only a ref and a path) pays a call to
    // resolve it, which is what git's `ref:path` expression is for.
    let paths: string[] = args.paths ?? [];
    if (!args.paths) {
      const dir = args.dir ?? "";
      const { data } = await ghGraphQL(
        `query($owner: String!, $repo: String!, $expression: String!) {
          repository(owner: $owner, name: $repo) {
            object(expression: $expression) { ... on Tree { entries { name } } }
          }
        }`,
        { owner, repo, expression: `${args.ref}:${dir}` },
        args.github_access_token,
      );
      const entries = data?.repository?.object?.entries ?? [];
      paths = entries.map((entry: any) => (dir ? `${dir}/${entry.name}` : (entry.name as string)));
    }

    for (let start = 0; start < paths.length; start += LAST_COMMIT_CHUNK) {
      const chunk = paths.slice(start, start + LAST_COMMIT_CHUNK);
      const fields = chunk
        .map(
          (path, i) => `p${i}: history(first: 1, path: ${gqlString(path)}) {
            nodes { oid messageHeadline committedDate author { name user { login avatarUrl } } }
          }`,
        )
        .join("\n");

      const query = `
        query($owner: String!, $repo: String!, $expression: String!) {
          repository(owner: $owner, name: $repo) {
            object(expression: $expression) {
              ... on Commit {
                ${fields}
              }
            }
          }
        }`;

      const { data: page } = await ghGraphQL(
        query,
        { owner, repo, expression: args.ref },
        args.github_access_token,
      );

      const object = page?.repository?.object ?? {};
      chunk.forEach((path, i) => {
        const commit = object[`p${i}`]?.nodes?.[0];
        if (!commit) return;
        out[path] = {
          sha: commit.oid as string,
          subject: (commit.messageHeadline ?? "") as string,
          committed_at: new Date(commit.committedDate ?? 0).getTime(),
          author_name: commit.author?.name as string | undefined,
          author_login: commit.author?.user?.login as string | undefined,
          author_avatar_url: commit.author?.user?.avatarUrl as string | undefined,
        };
      });
    }

    return out;
  },
});

/**
 * Every branch with the tip commit, the drift from the default branch and the
 * open pull request that carries it — the whole branch table in one call.
 *
 * `compare` sits on the ref and takes the OTHER side as its head, so a branch
 * asked to compare itself against the default branch is the base: what GitHub
 * calls `aheadBy` there is how far the default has moved past this branch, and
 * `behindBy` is what this branch has that the default does not. The names are
 * therefore crossed on the way out, so callers read the branch's own drift.
 *
 * Some installations cannot resolve `compare` at all. That is one field failing
 * in an otherwise good answer, so the retry drops the field rather than the
 * branch table.
 */
export const listBranchDetails = internalAction({
  args: {
    repository: v.string(),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);

    const build = (defaultBranch: string | null) => `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          defaultBranchRef { name }
          refs(refPrefix: "refs/heads/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
            nodes {
              name
              target {
                ... on Commit { oid messageHeadline committedDate author { name user { login avatarUrl } } }
              }
              ${defaultBranch ? `compare(headRef: ${gqlString(defaultBranch)}) { aheadBy behindBy }` : ""}
              associatedPullRequests(first: 1, states: [OPEN]) { nodes { number title } }
            }
          }
        }
      }`;

    // The default branch name is a literal inside the query, so it has to be
    // known before the branch list is asked for. One cheap call buys it.
    const head = await ghFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, args.github_access_token);
    const defaultBranch = (head.default_branch ?? null) as string | null;

    let result = await ghGraphQL(build(defaultBranch), { owner, repo }, args.github_access_token, true);
    if (result.errors?.length) {
      result = await ghGraphQL(build(null), { owner, repo }, args.github_access_token);
    }

    const repository = result.data?.repository;
    return {
      default_branch: (repository?.defaultBranchRef?.name ?? defaultBranch ?? "") as string,
      truncated: (repository?.refs?.nodes?.length ?? 0) === 100,
      branches: (repository?.refs?.nodes ?? []).map((node: any) => {
        const pr = node.associatedPullRequests?.nodes?.[0];
        return {
          name: node.name as string,
          sha: node.target?.oid as string,
          subject: (node.target?.messageHeadline ?? "") as string,
          committed_at: new Date(node.target?.committedDate ?? 0).getTime(),
          author_name: node.target?.author?.name as string | undefined,
          author_login: node.target?.author?.user?.login as string | undefined,
          author_avatar_url: node.target?.author?.user?.avatarUrl as string | undefined,
          ahead_by: node.compare ? (node.compare.behindBy as number) : undefined,
          behind_by: node.compare ? (node.compare.aheadBy as number) : undefined,
          open_pr: pr ? { number: pr.number as number, title: pr.title as string } : null,
        };
      }),
    };
  },
});

/**
 * Code search inside one repository.
 *
 * GitHub's code search index only covers the default branch and takes no ref,
 * so the answer says so rather than letting a page imply it searched the ref
 * the reader is standing on.
 */
export const searchCode = internalAction({
  args: {
    repository: v.string(),
    q: v.string(),
    per_page: v.optional(v.number()),
    page: v.optional(v.number()),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const params = new URLSearchParams({
      q: scopedRepoSearch(args.repository, args.q),
      per_page: String(args.per_page ?? 30),
      page: String(args.page ?? 1),
    });
    const data = await ghFetch(
      `${GITHUB_API_BASE}/search/code?${params.toString()}`,
      args.github_access_token,
      "application/vnd.github.text-match+json",
    );
    if ((data.items ?? []).some((item: any) => !belongsToSearchRepository(item, args.repository))) {
      throw new Error("GitHub code search returned a result outside the requested repository");
    }
    return {
      ref_scoped: false,
      total_count: (data.total_count ?? 0) as number,
      incomplete_results: !!data.incomplete_results,
      items: (data.items ?? []).map((item: any) => ({
        path: item.path as string,
        sha: item.sha as string,
        html_url: item.html_url as string,
        matches: (item.text_matches ?? []).map((match: any) => ({
          fragment: (match.fragment ?? "") as string,
          indices: (match.matches ?? []).map((m: any) => m.indices as [number, number]),
        })),
      })),
    };
  },
});

/**
 * A page of pull requests. Counts only: reviews and checks are a call per pull
 * request, which is what makes GitHub's own list slow, and the codecast row
 * already carries that state for the ones we shepherd.
 */
export const listPulls = internalAction({
  args: {
    repository: v.string(),
    state: v.string(),
    page: v.optional(v.number()),
    github_access_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const [owner, repo] = repoParts(args.repository);
    const params = new URLSearchParams({
      state: args.state,
      per_page: "50",
      sort: "updated",
      direction: "desc",
      page: String(args.page ?? 1),
    });
    const data = await ghFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls?${params.toString()}`,
      args.github_access_token,
    );
    return {
      pulls: (data ?? []).map((pull: any) => ({
        number: pull.number as number,
        title: pull.title as string,
        state: pull.state as string,
        draft: !!pull.draft,
        merged_at: pull.merged_at ? new Date(pull.merged_at).getTime() : null,
        created_at: pull.created_at ? new Date(pull.created_at).getTime() : null,
        updated_at: pull.updated_at ? new Date(pull.updated_at).getTime() : null,
        closed_at: pull.closed_at ? new Date(pull.closed_at).getTime() : null,
        author_login: pull.user?.login as string | undefined,
        author_avatar_url: pull.user?.avatar_url as string | undefined,
        head_ref: pull.head?.ref as string | undefined,
        base_ref: pull.base?.ref as string | undefined,
        labels: (pull.labels ?? []).map((label: any) => ({
          name: label.name as string,
          color: label.color as string,
        })),
        html_url: pull.html_url as string,
      })),
    };
  },
});
