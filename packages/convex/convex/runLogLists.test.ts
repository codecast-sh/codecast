// A workflow run's own log (isRunLog) is never a row in a list a person
// browses: the team feed, the personal list, title search, `cast search`, the
// killed shelf. A person's own session that hosts a run stays in every one.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { hashToken } from "@platform/auth/convex";
import schema from "./schema";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./conversations.ts": () => import("./conversations"),
  "./workflow_runs.ts": () => import("./workflow_runs"),
};
const token = "r".repeat(64);

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const viewer = await ctx.db.insert("users", { name: "Viewer", email: "v@x.com" } as any);
    await ctx.db.insert("api_tokens", { user_id: viewer, token_hash: await hashToken(token), name: "cli", created_at: now, last_used_at: now } as any);
    const team = await ctx.db.insert("teams", { name: "T", invite_code: "t", created_at: now } as any);
    await ctx.db.insert("team_memberships", { team_id: team, user_id: viewer, role: "member", joined_at: 0, visibility: "full" } as any);
    await ctx.db.patch(viewer, { team_id: team, active_team_id: team } as any);
    const workflow = await ctx.db.insert("workflows", { user_id: viewer, name: "line", slug: "line", nodes: [], edges: [], created_at: now, updated_at: now } as any);
    const run = (created_at: number) =>
      ctx.db.insert("workflow_runs", { user_id: viewer, workflow_id: workflow, status: "running", node_statuses: [], created_at, updated_at: created_at } as any);
    const logRun = await run(now - 5000);
    const rekeyedRun = await run(now - 4000);
    const hostRun = await run(now - 3000);
    const conv = (extra: Record<string, unknown>) =>
      ctx.db.insert("conversations", {
        user_id: viewer, agent_type: "claude_code", status: "active", message_count: 3, is_private: false, team_id: team,
        project_path: "/Users/v/src/repo", subtitle: "", idle_summary: "", ...extra,
      } as any);
    // The log a run opened for itself, as it is born.
    const log = await conv({ session_id: `wf-${logRun}`, title: "line pipeline", workflow_run_id: logRun, is_workflow_primary: true, started_at: now - 5000, updated_at: now - 500 });
    // A log the daemon rebound to a real session id: still the run's log.
    const rekeyed = await conv({ session_id: "7222ec51-real", title: "line pipeline", workflow_run_id: rekeyedRun, is_workflow_primary: true, started_at: now - 4000, updated_at: now - 400 });
    // A person's own session hosting a run: the pointer only.
    const host = await conv({ session_id: "host-session", title: "line pipeline host", workflow_run_id: hostRun, started_at: now - 9000, updated_at: now - 300 });
    const plain = await conv({ session_id: "plain-session", title: "line pipeline notes", started_at: now - 9000, updated_at: now - 200 });
    return { now, viewer, team, workflow, log: String(log), rekeyed: String(rekeyed), host: String(host), plain: String(plain) };
  });
  return { t, ...ids };
}

const as = (t: any, viewer: any) => t.withIdentity({ subject: `${viewer}|test` });

describe("run logs leave every session list", () => {
  test("team feed and personal list: logs out, the hosting session in", async () => {
    const { t, viewer, team, log, rekeyed, host, plain } = await seed();
    for (const args of [{ filter: "team", activeTeamId: team }, { filter: "my" }, { filter: "my", subagentFilter: "main" }]) {
      const r = await as(t, viewer).query(anyApi.conversations.listConversations, args);
      const ids = r.conversations.map((c: any) => String(c._id));
      expect(ids).toContain(host);
      expect(ids).toContain(plain);
      expect(ids).not.toContain(log);
      expect(ids).not.toContain(rekeyed);
    }
  });

  test("a page of run logs does not end the personal list early", async () => {
    const { t, viewer, host, plain } = await seed();
    const r = await as(t, viewer).query(anyApi.conversations.listConversations, { filter: "my", limit: 1 });
    expect(r.conversations.map((c: any) => String(c._id))).toEqual([plain]);
    const next = await as(t, viewer).query(anyApi.conversations.listConversations, { filter: "my", limit: 1, cursor: r.nextCursor });
    expect(next.conversations.map((c: any) => String(c._id))).toEqual([host]);
  });

  test("title search and cast search: logs out, the hosting session in", async () => {
    const { t, viewer, log, rekeyed, host } = await seed();
    const web = await as(t, viewer).query(anyApi.conversations.searchConversationTitles, { query: "pipeline" });
    const webIds = web.results.map((r: any) => String(r.conversationId ?? r.conversation_id ?? r._id));
    expect(webIds).toContain(host);
    expect(webIds).not.toContain(log);
    expect(webIds).not.toContain(rekeyed);
    const cli = await t.query(anyApi.conversations.searchForCLI, { api_token: token, query: "pipeline", titles_only: true });
    const cliTitles = (cli as any).conversations.map((c: any) => c.title).sort();
    expect(cliTitles).toEqual(["line pipeline host", "line pipeline notes"]);
  });

  test("killed shelf: a killed log stays off it", async () => {
    const { t, viewer, log, host } = await seed();
    await t.run(async (ctx) => {
      for (const id of [log, host]) await ctx.db.patch(id as any, { inbox_killed_at: Date.now() } as any);
    });
    const r = await as(t, viewer).query(anyApi.conversations.listKilledSessions, { paginationOpts: { numItems: 20, cursor: null } });
    const ids = r.page.map((c: any) => String(c._id));
    expect(ids).toContain(host);
    expect(ids).not.toContain(log);
  });

  test("launching a run from a person's session leaves it theirs: pointer only, own title", async () => {
    const { t, viewer, workflow, plain } = await seed();
    await as(t, viewer).mutation(anyApi.workflow_runs.create, { workflow_id: workflow, existing_conversation_id: plain });
    const conv: any = await t.run((ctx) => ctx.db.get(plain as any));
    expect(conv.workflow_run_id).toBeTruthy();
    expect(conv.is_workflow_primary).toBeFalsy();
    expect(conv.title).toBe("line pipeline notes");
  });
});
