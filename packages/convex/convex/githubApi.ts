import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const GITHUB_API_BASE = "https://api.github.com";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${errorText}`);
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
async function ghFetch(url: string, token: string): Promise<any> {
  const response = await fetch(url, { headers: ghHeaders(token) });
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
      size: data.size as number,
      truncated: false,
      sha: data.sha as string,
    };
  },
});

export const listCommits = internalAction({
  args: {
    repository: v.string(),
    sha: v.optional(v.string()),
    path: v.optional(v.string()),
    per_page: v.optional(v.number()),
    page: v.optional(v.number()),
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

    const data = await ghFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?${params.toString()}`,
      args.github_access_token,
    );
    return {
      commits: data.map((commit: any) => ({
        sha: commit.sha as string,
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
      files: (data.files ?? []).map((file: any) => ({
        filename: file.filename as string,
        status: file.status as string,
        additions: (file.additions ?? 0) as number,
        deletions: (file.deletions ?? 0) as number,
      })),
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

    const response = await fetch(`${GITHUB_API_BASE}/graphql`, {
      method: "POST",
      headers: { ...ghHeaders(args.github_access_token), "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { owner, repo, expression: args.ref, path: args.path },
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub GraphQL error: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    if (body.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${body.errors.map((e: any) => e.message).join("; ")}`);
    }

    const ranges = body.data?.repository?.object?.blame?.ranges ?? [];
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
