import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api } from "./_generated/api";

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

        await ctx.runMutation(api.comments.updateGitHubCommentId, {
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
