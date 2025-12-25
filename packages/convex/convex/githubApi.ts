import { action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

export const postPRComment = action({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    comment_body: v.string(),
    github_access_token: v.string(),
  },
  handler: async (ctx, args) => {
    const [owner, repo] = args.repository.split("/");

    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${args.pr_number}/comments`;

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
