// The release sweep (pl-1146 piece 7): one read of what a workspace's Release
// Captain must act on, empty on a quiet hour. Each kind of exception, and the
// near misses that are not one. Synthetic data only.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";

setDefaultTimeout(60_000);

const TOKEN = "r".repeat(64);
const OUTSIDER = "o".repeat(64);
const REPO = "acme/app";
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const sha = (n: number) => `${n.toString(16).padStart(2, "0")}cd`.repeat(10);
const file = (filename: string) => ({ filename, status: "modified", additions: 1, deletions: 0, changes: 1 });

async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const me = await ctx.db.insert("users", { name: "Ana" });
    const bo = await ctx.db.insert("users", { name: "Bo" });
    const out = await ctx.db.insert("users", { name: "Outsider" });
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 });
    await ctx.db.insert("api_tokens", { user_id: out, token_hash: await hashToken(OUTSIDER), name: "cli", created_at: 1, last_used_at: 1 });
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 1 });
    for (const u of [me, bo]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 });
    const ws = `team:${team}`;
    const wf = await ctx.db.insert("workflows", { user_id: me, name: "change", slug: "change", label: "Change", nodes: [], edges: [], created_at: 1, updated_at: 1 });
    return { me, bo, out, team, ws, wf };
  });
  const sweep = (token = TOKEN) => t.query(api.releaseSweep.sweep, { api_token: token, workspace: "team", team_id: ids.team });
  const insert = (table: string, row: Record<string, unknown>) => t.run((ctx: any) => ctx.db.insert(table, row));
  const task = (short_id: string, status = "in_progress") =>
    insert("tasks", { user_id: ids.me, team_id: ids.team, workspace: ids.ws, short_id, title: short_id, status, task_type: "task", priority: "medium", source: "human", created_at: 1, updated_at: 1 });
  const run = (taskId: any, fields: Record<string, unknown>) =>
    insert("workflow_runs", {
      user_id: ids.me, workflow_id: ids.wf, task_id: taskId, workspace: ids.ws, team_id: ids.team, status: "failed", current_node_id: "stopped",
      node_statuses: [{ node_id: "land__ci", status: "failed", completed_at: NOW - 20 * MIN }, { node_id: "stopped", status: "failed", completed_at: NOW - 19 * MIN }],
      fail_reason: "Stopped: CI failed", created_at: NOW - HOUR, updated_at: NOW - 10 * MIN, ...fields,
    });
  const target = (name: string, paths: string[]) =>
    insert("deploy_targets", { workspace: ids.ws, team_id: ids.team, repository: REPO, name, runs: "push", live: { kind: "marker" }, policy: "press", paths, publisher_user_id: ids.me, published_at: 1, updated_at: 1 });
  /** A commit on main at `mainAt`, made by the session `conv` (its trailer names it) when given. */
  const commit = (n: number, files: string[], mainAt: number, conv?: any) =>
    insert("commits", { sha: sha(n), message: conv ? `change ${n}\n\nCodecast-Session: https://codecast.sh/conversation/${conv}` : `change ${n}`, author_name: "Ana", author_email: "a@x", timestamp: mainAt, files_changed: files.length, insertions: 1, deletions: 0, repository: REPO, team_id: ids.team, branch: "main", files: files.map(file), main_at: mainAt, ...(conv ? { conversation_id: conv } : {}) });
  /** A live deploy of `target` at commit `n`, written as a row so no retire pass is scheduled under the test. */
  const live = (name: string, n: number, createdAt = NOW - 5 * MIN) =>
    insert("deploys", { short_id: `dp-${name}-${n}`, workspace: ids.ws, team_id: ids.team, target: name, status: "live", trigger: "outside", source: "m", event_ids: [], carries: [], repository: REPO, sha: sha(n), created_at: createdAt, live_at: createdAt, updated_at: createdAt });
  return { t, ids, sweep, insert, task, run, target, commit, live };
}

const QUIET = { incidents: [], late_targets: [], failed_runs: [], laggards: [], unretired: [] };

describe("cast release sweep's read", () => {
  test("a quiet workspace has nothing in any list; a person outside the team is refused", async () => {
    const w = await world();
    await w.target("web", ["web/**"]);
    await w.commit(1, ["web/a.tsx"], NOW - 3 * HOUR);
    await w.live("web", 1);
    expect(await w.sweep()).toMatchObject(QUIET);
    await expect(w.sweep(OUTSIDER)).rejects.toThrow();
  });

  test("an open incident is listed with its runs, and its runs are not listed again as failed", async () => {
    const w = await world();
    const fingerprint = "flowstop:acme/app:ci_unread";
    const cause = await w.task("ct-500");
    await w.t.run((ctx: any) => ctx.db.patch(cause, { cause: { signal_count: 2, first_seen: NOW, last_seen: NOW, fingerprints: [fingerprint] } }));
    await w.insert("signals", { user_id: w.ids.me, team_id: w.ids.team, workspace: w.ids.ws, short_id: "sg-1", source: "flow", kind: "flowstop", fingerprint, title: "Change stopped at CI", observed_at: NOW, created_at: NOW, task_id: cause, attach: "fingerprint" });
    for (const short of ["ct-501", "ct-502"]) await w.run(await w.task(short), { incident_task_id: cause, stop_station: "land__ci", stop_fingerprint: fingerprint });
    const s: any = await w.sweep();
    expect(s.incidents.map((i: any) => i.short_id)).toEqual(["ct-500"]);
    expect(s.incidents[0].runs.map((r: any) => r.task_short_id).sort()).toEqual(["ct-501", "ct-502"]);
    expect(s.failed_runs).toEqual([]);
  });

  test("a target holding a commit merged past its deadline is late; one inside it, or touching other paths, is not; a dormant target is skipped", async () => {
    const w = await world();
    await w.target("web", ["web/**"]);
    await w.target("old", ["old/**"]);
    await w.commit(1, ["web/a.tsx"], NOW - 5 * HOUR);
    await w.live("web", 1);
    await w.live("old", 1, NOW - 10 * 24 * HOUR);
    // A push target waits half an hour: commit 2 is late, commit 3 is not yet, commit 4 ships nothing to web.
    await w.commit(2, ["web/b.tsx", "old/x.ts"], NOW - 2 * HOUR);
    await w.commit(3, ["web/c.tsx"], NOW - 10 * MIN);
    await w.commit(4, ["api/d.ts"], NOW - 3 * HOUR);
    const s: any = await w.sweep();
    expect(s.late_targets).toEqual([{ target: "web", repository: REPO, commits: 1, oldest_sha: sha(2), waiting_since: NOW - 2 * HOUR, deadline_ms: 30 * MIN, open: null }]);
  });

  test("a run failed in the last two hours, outside any incident, is listed at its station; cancelled, older, re-run and closed ones are not", async () => {
    const w = await world();
    // Each a crash, so each near miss is left out for its own reason, not for being a stop.
    const crash = { fail_reason: "Runner exited: the machine went to sleep" };
    await w.run(await w.task("ct-601"), crash);
    await w.run(await w.task("ct-602"), { fail_reason: "Cancelled by user" });
    await w.run(await w.task("ct-603"), { ...crash, updated_at: NOW - 3 * HOUR });
    const rerun = await w.task("ct-604");
    await w.run(rerun, crash);
    await w.run(rerun, { status: "running", fail_reason: undefined, updated_at: NOW });
    await w.run(await w.task("ct-605", "done"), crash);
    await w.run(await w.task("ct-606"), { ...crash, resume_queued: { since: NOW - MIN, at_node: "land__ci" } });
    const s: any = await w.sweep();
    expect(s.failed_runs.map((r: any) => [r.task_short_id, r.station, r.flow])).toEqual([["ct-601", "land__ci", "change"]]);
  });

  test("of stops, only one at a shared exit still held is the sweep's: a stop about the change itself is its own run's", async () => {
    const w = await world();
    await w.run(await w.task("ct-701"), { fail_reason: "Stopped: The reviewer rejected the change: no tests", stop_station: "land__review" });
    await w.run(await w.task("ct-702"), { fail_reason: "Stopped: Review found 3 findings", stop_station: "land__review" });
    await w.run(await w.task("ct-703"), { fail_reason: "Stopped: main stayed red", stop_station: "land__wait_main", stop_fingerprint: "flowstop:acme/app:main_red" });
    await w.run(await w.task("ct-704"), { fail_reason: "Station land__ci failed: exit code 137" });
    const s: any = await w.sweep();
    expect(s.failed_runs.map((r: any) => [r.task_short_id, r.station]).sort()).toEqual([["ct-703", "land__wait_main"], ["ct-704", "land__ci"]]);
  });

  test("an online team machine below a floor raised half an hour ago lags; below a floor raised just now, offline, or on it, it does not", async () => {
    const w = await world();
    const dev = (user: any, device_id: string, cli_version: string, last_seen = NOW) =>
      w.insert("devices", { user_id: user, device_id, label: device_id, platform: "darwin", last_seen, cli_version });
    await w.insert("system_config", { key: "min_cli_version", value: "1.1.300", updated_at: NOW - 2 * HOUR });
    await w.t.run((ctx: any) => ctx.db.patch(w.ids.team, { min_cli_version: "1.1.306", min_cli_version_at: NOW - 40 * MIN }));
    await dev(w.ids.me, "ana-mac", "1.1.305");
    await dev(w.ids.bo, "bo-mac", "1.1.299");
    await dev(w.ids.bo, "bo-away", "1.1.299", NOW - HOUR);
    await dev(w.ids.me, "ana-new", "1.1.306");
    const s: any = await w.sweep();
    expect(s.laggards.map((l: any) => [l.label, l.floor, l.own]).sort()).toEqual([["ana-mac", "1.1.306", true], ["bo-mac", "1.1.306", false]]);

    // The team floor raised a minute ago: only the global one, held for two hours, counts yet.
    await w.t.run((ctx: any) => ctx.db.patch(w.ids.team, { min_cli_version_at: NOW - MIN }));
    expect(((await w.sweep()) as any).laggards.map((l: any) => [l.label, l.floor])).toEqual([["bo-mac", "1.1.300"]]);
  });

  test("a settled session whose change is live everywhere and that nothing keeps is listed; a retired one is not", async () => {
    const w = await world();
    await w.target("web", ["web/**"]);
    const session = (short_id: string, extra: Record<string, unknown> = {}) => w.insert("conversations", {
      user_id: w.ids.me, team_id: w.ids.team, agent_type: "claude_code", started_at: NOW - HOUR, updated_at: NOW - 40 * MIN, status: "active", short_id, session_id: `s-${short_id}`, title: `Fix ${short_id}`,
      message_count: 12, is_private: false, git_root: "/work/app", thread_state: "Shipped", thread_state_status: "done", thread_state_at: NOW - 30 * MIN, thread_state_msg_count: 12, ...extra,
    });
    const done = await session("jx7done");
    const gone = await session("jx7gone", { inbox_killed_at: NOW - MIN });
    await w.commit(1, ["web/a.tsx"], NOW - HOUR, done);
    await w.commit(2, ["web/b.tsx"], NOW - HOUR + 1, gone);
    await w.live("web", 2);
    const s: any = await w.sweep();
    expect(s.unretired.map((u: any) => u.short_id)).toEqual(["jx7done"]);
  });
});
