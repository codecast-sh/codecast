// A project's outputs (ct-94262): what its sessions, tasks and plans produced,
// found through the derived session rule (session-projects.md SP1), each
// output behind its own access check.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { prGroupOf } from "./projectOutputs";
import { joinProjectOutputs, outputItemArgs } from "@codecast/shared/contracts/projectOutputs";

const ANA = "a".repeat(64);
const BEN = "b".repeat(64);
const CY = "c".repeat(64);
const api = anyApi as any;
const NOW = 1_800_000_000_000;

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = (name: string) => ctx.db.insert("users", { name } as any);
    const ana = await user("Ana");
    const ben = await user("Ben");
    const cy = await user("Cy");
    for (const [u, tok] of [[ana, ANA], [ben, BEN], [cy, CY]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(tok), name: "cli", created_at: 0, last_used_at: 0 } as any);
    }
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 0, invite_code: "x" } as any);
    const otherTeam = await ctx.db.insert("teams", { name: "Other", created_at: 0, invite_code: "y" } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "admin", joined_at: 0 } as any);
    await ctx.db.insert("team_memberships", { user_id: ben, team_id: team, role: "member", joined_at: 0 } as any);
    await ctx.db.insert("team_memberships", { user_id: cy, team_id: otherTeam, role: "admin", joined_at: 0 } as any);
    const ws = `team:${team}`;
    const project = (title: string) => ctx.db.insert("projects", { user_id: ana, team_id: team, workspace: ws, title, short_id: `pj-${title.toLowerCase()}`, status: "active", created_at: 0, updated_at: 0 } as any);
    const perf = await project("Perf");
    const other = await project("Other");
    const task = (title: string, project_id: any, short_id: string) =>
      ctx.db.insert("tasks", { user_id: ana, team_id: team, workspace: ws, title, short_id, status: "in_progress", project_id, created_at: 0, updated_at: NOW } as any);
    const perfTask = await task("Speed up reads", perf, "ct-1");
    const otherTask = await task("Elsewhere", other, "ct-2");
    const conv = (session_id: string, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("conversations", { user_id: ana, team_id: team, agent_type: "claude_code", session_id, title: session_id, short_id: `jx${session_id}`, started_at: 0, updated_at: NOW, message_count: 0, status: "active", is_private: false, ...extra } as any);
    const lead = await conv("lead", { project_id: perf });
    // Inherits Perf from its parent, never stored on it.
    const worker = await conv("worker", { parent_conversation_id: lead, active_task_id: perfTask });
    await ctx.db.patch(perfTask, { conversation_ids: [worker] } as any);
    // Started by the Perf lead, but bound to a task in Other: works in Other.
    const stray = await conv("stray", { parent_conversation_id: lead, active_task_id: otherTask });
    await ctx.db.patch(otherTask, { conversation_ids: [stray] } as any);
    // Ana's private session in Perf: hers alone.
    const secret = await conv("secret", { project_id: perf, is_private: true });

    const pr = (number: number, linked: any[], extra: Record<string, unknown> = {}) =>
      ctx.db.insert("pull_requests", { team_id: team, github_pr_id: number, repository: "acme/app", number, title: `PR ${number}`, body: "", state: "open", author_github_username: "ana", linked_session_ids: linked, created_at: 0, updated_at: NOW - number, ...extra } as any);
    const link = async (prId: any, convId: any, tier: "observed" | "committed" = "observed") => ctx.db.insert("pull_request_sessions", { pull_request_id: prId, conversation_id: convId, tier } as any);
    const red = await pr(1, [worker], { checks_state: "failure" });
    await link(red, worker, "committed");
    await link(red, lead);
    const reviewing = await pr(2, [lead], { checks_state: "success", review_decision: "review_required" });
    await link(reviewing, lead);
    const merged = await pr(3, [lead], { state: "merged" });
    await link(merged, lead);
    const strays = await pr(4, [stray]);
    await link(strays, stray);
    // The stray worker's PR that names a Perf task still belongs to Perf.
    const named = await pr(5, [stray], { task_ids: [perfTask], mergeable_state: "dirty" });
    await link(named, stray);
    const foreign = await ctx.db.insert("pull_requests", { team_id: otherTeam, github_pr_id: 6, repository: "other/app", number: 6, title: "Foreign", body: "", state: "open", author_github_username: "cy", linked_session_ids: [lead], created_at: 0, updated_at: NOW } as any);
    await link(foreign, lead);

    const blob = await ctx.storage.store(new Blob(["<p>hi</p>"]));
    const page = (slug: string, extra: Record<string, unknown>) =>
      ctx.db.insert("artifacts", { slug, user_id: ana, title: slug, storage_id: blob, size: 1, version: 1, created_at: 0, updated_at: NOW, ...extra } as any);
    await page("by-worker", { session_conversation_id: worker });
    await page("by-stray", { session_conversation_id: stray });
    await page("on-perf-task", { task_id: perfTask });
    await page("on-other-task", { task_id: otherTask });
    await page("expired", { session_conversation_id: worker, expires_at: 1 });
    await page("gated", { session_conversation_id: worker, password_hash: "x", thumb_storage_id: blob });

    const doc = (title: string, extra: Record<string, unknown>) =>
      ctx.db.insert("docs", { user_id: ana, team_id: team, workspace: ws, title, content: "", doc_type: "note", source: "agent", created_at: 0, updated_at: NOW, ...extra } as any);
    await doc("Perf design", { project_id: perf, task_ids: [perfTask] });
    await doc("Worker notes", { conversation_id: worker });
    await doc("Stray notes", { conversation_id: stray });

    const image = async (convId: any, key: string) => {
      const msg = await ctx.db.insert("messages", { conversation_id: convId, role: "assistant", timestamp: NOW } as any);
      await ctx.db.insert("conversation_images", { conversation_id: convId, image_key: key, src: `https://img/${key}.png`, message_id: msg, seq: 0, timestamp: NOW } as any);
    };
    await image(worker, "worker");
    await image(stray, "stray");
    await image(secret, "secret");
    return { perf, other, perfTask, worker, stray, lead };
  });
  const outputs = (token: string, project_id: string) => t.query(api.projectOutputs.get, { api_token: token, project_id });
  return { t, ids, outputs };
}

describe("project outputs", () => {
  test("pull requests come from the project's derived sessions, grouped by what they need", async () => {
    const { ids, outputs } = await setup();
    const out = await outputs(BEN, String(ids.perf));
    const byNumber = Object.fromEntries(out.prs.map((p: any) => [p.number, p]));
    expect(Object.keys(byNumber).sort()).toEqual(["1", "2", "3", "5"]);
    expect(byNumber[1].group).toBe("attention");
    expect(byNumber[1].status).toBe("ci_red");
    expect(byNumber[2].group).toBe("review");
    expect(byNumber[3].group).toBe("done");
    expect(byNumber[5].group).toBe("attention");
    expect(byNumber[1].href).toBe("/pr/acme/app/1");
  });

  test("a PR names the session whose commit is on it and that session's task", async () => {
    const { ids, outputs } = await setup();
    const out = await outputs(BEN, String(ids.perf));
    const red = out.prs.find((p: any) => p.number === 1);
    expect(red.session.id).toBe(String(ids.worker));
    expect(red.task.short_id).toBe("ct-1");
    const named = out.prs.find((p: any) => p.number === 5);
    expect(named.task.short_id).toBe("ct-1");
  });

  test("pages, docs and images skip the worker bound to another project's task", async () => {
    const { ids, outputs } = await setup();
    const out = await outputs(BEN, String(ids.perf));
    expect(out.pages.map((p: any) => p.slug).sort()).toEqual(["by-worker", "gated", "on-perf-task"]);
    expect(out.pages.find((p: any) => p.slug === "by-worker").session.id).toBe(String(ids.worker));
    expect(out.docs.map((d: any) => d.title).sort()).toEqual(["Perf design", "Worker notes"]);
    expect(out.docs.find((d: any) => d.title === "Perf design").task.short_id).toBe("ct-1");
    expect(out.images.map((i: any) => i.url)).toEqual(["https://img/worker.png"]);
    expect(out.images[0].href).toStartWith(`/conversation/${ids.worker}#msg-`);
  });

  test("the other project gets the stray worker's outputs", async () => {
    const { ids, outputs } = await setup();
    const out = await outputs(BEN, String(ids.other));
    // PR 5 is the stray worker's own, so it is Other's too, beside Perf's.
    expect(out.prs.map((p: any) => p.number).sort()).toEqual([4, 5]);
    expect(out.pages.map((p: any) => p.slug).sort()).toEqual(["by-stray", "on-other-task"]);
    expect(out.images.map((i: any) => i.url)).toEqual(["https://img/stray.png"]);
  });

  test("a private session's images reach its owner only", async () => {
    const { ids, outputs } = await setup();
    const mine = await outputs(ANA, String(ids.perf));
    expect(mine.images.map((i: any) => i.url).sort()).toEqual(["https://img/secret.png", "https://img/worker.png"]);
  });

  test("a page row carries no storage URL, so a gated page's capture never leaves the server", async () => {
    const { ids, outputs } = await setup();
    const out = await outputs(BEN, String(ids.perf));
    const gated = out.pages.find((p: any) => p.slug === "gated");
    expect(JSON.stringify(gated)).not.toContain("http");
    expect(gated.href).toBe("/a/gated");
  });

  test("an expired page shows its owner only", async () => {
    const { ids, outputs } = await setup();
    expect((await outputs(BEN, String(ids.perf))).pages.some((p: any) => p.slug === "expired")).toBe(false);
    expect((await outputs(ANA, String(ids.perf))).pages.some((p: any) => p.slug === "expired")).toBe(true);
  });

  test("a stranger gets nothing, by id or short id", async () => {
    const { ids, outputs } = await setup();
    expect(await outputs(CY, String(ids.perf))).toBeNull();
    expect(await outputs(CY, "pj-perf")).toBeNull();
    expect((await outputs(BEN, "pj-perf")).project.id).toBe(String(ids.perf));
  });

  test("the view's two parts join to the same outputs, and a new message re-reads only the members", async () => {
    const { t, ids, outputs } = await setup();
    const whole = await outputs(BEN, String(ids.perf));
    const members = await t.query(api.projectOutputs.members, { api_token: BEN, project_id: String(ids.perf) });
    const args = outputItemArgs(members);
    const items = await t.query(api.projectOutputs.items, { api_token: BEN, project_id: String(ids.perf), ...args });
    expect(joinProjectOutputs(members, items)).toEqual(whole);
    // A session's churn (a message, a heartbeat) leaves membership as it was,
    // so the items part is asked again with the same arguments.
    await t.run((ctx) => ctx.db.patch(ids.lead, { message_count: 7, updated_at: NOW + 1 } as any));
    const again = await t.query(api.projectOutputs.members, { api_token: BEN, project_id: String(ids.perf) });
    expect(outputItemArgs(again)).toEqual(args);
  });

  test("the items part is asked by ids newest created first", async () => {
    const { t, ids } = await setup();
    const members = await t.query(api.projectOutputs.members, { api_token: BEN, project_id: String(ids.perf) });
    const created = await t.run(async (ctx) => Promise.all(members.sessions.filter((s: any) => s.in_project).map(async (s: any) => (await ctx.db.get(s.id as any))!._creationTime)));
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  test("the items part gives a stranger nothing", async () => {
    const { t, ids } = await setup();
    const members = await t.query(api.projectOutputs.members, { api_token: BEN, project_id: String(ids.perf) });
    expect(await t.query(api.projectOutputs.items, { api_token: CY, project_id: String(ids.perf), ...outputItemArgs(members) })).toBeNull();
  });

  test("groups follow the shepherd fold", () => {
    expect(prGroupOf("behind")).toBe("attention");
    expect(prGroupOf("changes_requested")).toBe("attention");
    expect(prGroupOf("ci_pending")).toBe("review");
    expect(prGroupOf("approved")).toBe("review");
    expect(prGroupOf("closed")).toBe("done");
  });
});
