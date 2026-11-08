import { describe, expect, test } from "bun:test";
import { performGetRecentProjectPaths } from "./users";

// The new-session folder chips, through the real query. The layout is one that
// broke them: every repo two levels below ~/code, so trimming to one level below
// "code" left one chip for a folder that is not a checkout.
const HOME = "/Users/a";
const WORK = `${HOME}/code/work.noindex`;
const LB_REMOTE = "https://github.com/acme/littlebird.git";
const USER = "user1" as any;

const session = (git_root: string | undefined, git_remote_url?: string, project_path = git_root) => ({
  git_root,
  git_remote_url,
  project_path,
  updated_at: Date.now() - 60_000,
});

function ctxWith(conversations: unknown[], roots: string[]) {
  const device = { device_id: "studio", user_id: USER, last_seen: Date.now(), local_project_roots: roots };
  const rows: Record<string, unknown[]> = { conversations, devices: [device], directory_team_mappings: [] };
  const query = (table: string) => {
    const chain = {
      withIndex: () => chain,
      order: () => chain,
      take: async (n: number) => (rows[table] ?? []).slice(0, n),
      collect: async () => rows[table] ?? [],
      first: async () => (rows[table] ?? [])[0] ?? null,
    };
    return chain;
  };
  return { db: { query, get: async () => null } } as any;
}

const repeat = <T,>(n: number, row: T): T[] => Array.from({ length: n }, () => row);

describe("performGetRecentProjectPaths", () => {
  const sessions = [
    ...repeat(30, session(`${WORK}/GitHub/lb-feature`, LB_REMOTE)),
    ...repeat(20, session(`${WORK}/lb2/wt-port-run17`, LB_REMOTE)),
    ...repeat(5, session(`${WORK}/GitHub/littlebird-ts-rewrite`, LB_REMOTE)),
    ...repeat(2, session(`${WORK}/GitHub/littlebird`, LB_REMOTE, `${HOME}/Documents/GitHub/littlebird`)),
    ...repeat(3, session(`${HOME}/code/memex`, "https://github.com/a/memex.git")),
    session(undefined, undefined, `${WORK}/GitHub/not-a-repo`),
  ];
  const roots = [WORK, `${HOME}/code/memex`, `${HOME}/.claude`];

  test("a machine's repos below a nested work folder are offered by name", async () => {
    const projects = await performGetRecentProjectPaths(ctxWith(sessions, roots), USER, { limit: 50, device_id: "studio" });
    const used = projects.filter((p) => !p.suggested).map((p) => [p.path, p.count]);
    expect(used).toEqual([
      [`${WORK}/GitHub/littlebird`, 57],
      [`${HOME}/code/memex`, 3],
      [`${WORK}/GitHub/not-a-repo`, 1],
    ]);
  });

  // Regression from real data: 255 subagent rows carried only the cwd
  // ~/code/work.noindex/GitHub/slack-bot, and trimming it to one level below
  // "code" made a ~/code/work.noindex chip that started sessions outside any repo.
  test("a session with only a cwd joins the checkout that contains it", async () => {
    const bot = `${WORK}/GitHub/slack-bot`;
    const projects = await performGetRecentProjectPaths(
      ctxWith([
        ...repeat(3, session(bot)),
        ...repeat(8, session(undefined, undefined, bot)),
        session(undefined, undefined, `${bot}/src/handlers`),
      ], roots),
      USER,
      { limit: 50, device_id: "studio" },
    );
    expect(projects.filter((p) => !p.suggested).map((p) => [p.path, p.count])).toEqual([[bot, 12]]);
  });

  test("the unscoped list folds the same way", async () => {
    const projects = await performGetRecentProjectPaths(ctxWith(sessions, roots), USER, { limit: 50 });
    expect(projects[0]).toMatchObject({ path: `${WORK}/GitHub/littlebird`, count: 57, repository: "acme/littlebird" });
  });

  test("worktrees spend one slot of the limit, so other projects stay listed", async () => {
    const worktrees = Array.from({ length: 60 }, (_, i) => session(`${WORK}/GitHub/lb-${i}`, LB_REMOTE));
    const projects = await performGetRecentProjectPaths(
      ctxWith([...worktrees, session(`${HOME}/code/memex`, "https://github.com/a/memex.git")], roots),
      USER,
      { limit: 10, device_id: "studio" },
    );
    expect(projects.filter((p) => !p.suggested).map((p) => p.path.split("/").pop())).toEqual(["lb-0", "memex"]);
  });

  test("a checkout outside the machine's roots is still hidden", async () => {
    const projects = await performGetRecentProjectPaths(
      ctxWith([session("/Users/other/src/app", "https://github.com/acme/app.git")], roots),
      USER,
      { limit: 50, device_id: "studio" },
    );
    expect(projects.filter((p) => !p.suggested)).toEqual([]);
  });
});
