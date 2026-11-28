import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { publish, recordLiveRead, request, view } from "./deployTargets";
import { stampMainOrder } from "./deployTargetsCi";

// A release target's own version bump for the version live there (isLiveVersionBump) waits on no deploy and is
// carried by none, when the release names the target and bumps the package its paths name first: desktop's
// `chore(desktop): bump version to X` edits packages/electron/package.json (8c2272f). Synthetic data only.

const TEAM = "team1".padEnd(32, "0") as any;
const WS = `team:${TEAM}`;
const ME = "user_me";
const TOKEN = "cast_bump_token";
const REPO = "acme/app";
const NOW = Date.now();
const sha = (n: number) => String(n).padStart(2, "0").repeat(20);

const DESKTOP = {
  name: "desktop", command: "scripts/cut-desktop-release.sh", runs: "here", policy: "press", ship_stage: "press",
  live: { kind: "json", url: "https://dl.acme.dev/desktop/release.json", sha_field: "sourceCommit", version_field: "version" },
  paths: ["packages/electron/**"], unless: ["**/*.test.ts"],
};

async function world() {
  const t: Record<string, any[]> = {
    users: [{ _id: ME, name: "Ana" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    devices: [{ _id: "dev_row", user_id: ME, device_id: "ana-mac" }],
    repo_sources: [{ _id: "rs1", repository: REPO, team_id: TEAM }],
    github_app_installations: [], conversations: [], tasks: [], commits: [], commit_ci: [], deploy_targets: [], deploys: [], deploy_pauses: [],
    org_roles: [], ship_passes: [], external_events: [], event_groups: [], workflow_runs: [], signals: [], counters: [], daemon_commands: [],
    agent_tasks: [], projects: [],
  };
  const ctx = { db: makeFakeDb(t), auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } } as any;
  await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, targets: [DESKTOP], device_id: "ana-mac", root: "/repo" });
  return { t, ctx, targetId: t.deploy_targets[0]._id };
}

async function pushMain(t: Record<string, any[]>, ctx: any, n: number, message: string, files: string[], at: number) {
  t.commits.push({
    _id: `commit_${n}`, sha: sha(n), message, author_name: "Ana", author_email: "a@x", timestamp: at, files_changed: files.length, insertions: 0, deletions: 0,
    repository: REPO, team_id: TEAM, branch: "main", files: files.map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0, changes: 1 })),
  });
  await stampMainOrder(ctx, [`commit_${n}`], at);
}

describe("desktop's own version bump (8c2272f)", () => {
  test("waits on nothing in the queue, and neither a requested deploy nor one the live reader records carries it", async () => {
    const { t, ctx, targetId } = await world();
    await pushMain(t, ctx, 1, "feat(desktop): updater", ["packages/electron/main.js"], NOW - 10_000);
    await (recordLiveRead as any)._handler(ctx, { target_id: targetId, sha: sha(1), version: "1.1.135" });
    // The bump also rewrites the web server's download link, which ships to web, not desktop.
    await pushMain(t, ctx, 2, "chore(desktop): bump version to 1.1.135", ["packages/electron/package.json", "packages/web/server/index.ts"], NOW - 8_000);
    const [desktop] = (await (view as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "desktop" })).targets;
    expect(desktop.queue.commits).toBe(0);

    await pushMain(t, ctx, 3, "fix(desktop): tray icon", ["packages/electron/tray.js"], NOW - 6_000);
    const r = await (request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "desktop" });
    expect(t.deploys.find((d) => d.short_id === r.short_id).commits.map((c: any) => c.sha)).toEqual([sha(3)]);

    t.deploys = t.deploys.filter((d) => d.short_id !== r.short_id);
    await (recordLiveRead as any)._handler(ctx, { target_id: targetId, sha: sha(3), version: "1.1.136" });
    expect(t.deploys.find((d) => d.sha === sha(3)).commits.map((c: any) => c.sha)).toEqual([sha(3)]);
  });
});
