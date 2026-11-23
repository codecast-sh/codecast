import type { Id } from "../_generated/dataModel";

/** Most distinct repositories one team's activity table is walked for. */
const TEAM_REPOSITORY_WALK_CAP = 300;

/**
 * The distinct repositories a team's pull requests or commits name, one row
 * read per repository: each step jumps past every row of the repository it
 * just saw. Both rows are heavy (a pull request carries its files, commits and
 * checks), and taking 500 of each per team to collect a few dozen names ran
 * the query out of memory.
 */
export async function teamRepositories(
  ctx: { db: any },
  table: "pull_requests" | "commits",
  teamId: Id<"teams">,
): Promise<string[]> {
  const repositories: string[] = [];
  // "" sorts below every real name and above a missing one, so rows with no
  // repository are skipped.
  let last = "";
  while (repositories.length < TEAM_REPOSITORY_WALK_CAP) {
    const row = await ctx.db
      .query(table)
      .withIndex("by_team_repository", (q: any) => q.eq("team_id", teamId).gt("repository", last))
      .first();
    if (!row) break;
    repositories.push(row.repository);
    last = row.repository;
  }
  return repositories;
}
