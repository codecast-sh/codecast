// changesQueries.storySessions under convex-test: the sessions behind a story
// for its evidence drawer pass teamVisibleInputs() again at read time. A
// session shared in full shows its headline, summary and turns (each "did"
// trimmed); one shared at summary shows no turns; a hidden-level member's
// session, a session made private after the story was built and a non-member
// caller get nothing.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

setDefaultTimeout(120_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./changesQueries.ts": () => import("./changesQueries"),
};

const NOW = Date.now();
const HOUR = 3_600_000;
const SECRET = "the walrus protocol";
const LONG_DID = `Rewrote the launcher ${"x".repeat(300)}`;

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "acme", created_at: NOW, invite_code: "acme", features: { changes: true } } as any);
    const user = (name: string) => ctx.db.insert("users", { name } as any);
    const ana = await user("Ana");
    const ben = await user("Ben");
    const outsider = await user("Out");
    const member = (u: Id<"users">, visibility: string) =>
      ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: NOW - 30 * 24 * HOUR, visibility } as any);
    await member(ana, "full");
    await member(ben, "hidden");

    const conv = (owner: Id<"users">, shortId: string, over: Record<string, unknown> = {}) => ctx.db.insert("conversations", {
      user_id: owner, team_id: team, agent_type: "claude_code", session_id: `s-${shortId}`, short_id: shortId, title: `session ${shortId}`,
      started_at: NOW - 6 * HOUR, updated_at: NOW - HOUR, message_count: 3, is_private: false, status: "active", project_path: "/repo", ...over,
    } as any);
    const full = await conv(ana, "jx7full");
    const summary = await conv(ana, "jx7summ", { team_visibility: "summary" });
    const hidden = await conv(ben, "jx7hide");
    const madePrivate = await conv(ana, "jx7priv", { is_private: true });
    for (const [c, actor, headline] of [
      [full, ana, "Agent helpers stop starving"],
      [summary, ana, "Summary-level work"],
      [hidden, ben, `Hidden: ${SECRET}`],
      [madePrivate, ana, `Private: ${SECRET}`],
    ] as const) {
      await ctx.db.insert("session_insights", {
        conversation_id: c, team_id: team, actor_user_id: actor, source: "idle", generated_at: NOW - HOUR,
        summary: `${headline}, in summary`, headline, outcome_type: "shipped", themes: [],
        turns: [{ ask: `Why is ${headline} slow?`, did: [LONG_DID, "Added a test"] }],
      } as any);
    }
    const story = await ctx.db.insert("change_stories", {
      team_id: team, repository: "acme/app", date: "2026-10-02", story_key: "k", area: "cli", branch: "main", on_default_branch: true,
      commit_shas: ["a1"], conversation_ids: [full, summary, hidden, madePrivate], pr_ids: [], author_names: ["Ana"], actor_user_ids: [ana],
      insertions: 1, deletions: 0, files_changed: 1, area_counts: { cli: 1 }, risks: [], first_at: NOW - 2 * HOUR, last_at: NOW - HOUR,
      headline: "h", dek: "", kind: "fix", importance: 2, prose_status: "pending", inputs_hash: "x", private_session_count: 0,
    } as any);
    return { ana, outsider, full, summary, story };
  });
  return { t, ids, as: (u: Id<"users">) => t.withIdentity({ subject: `${u}|test` }) };
}

describe("storySessions", () => {
  test("a session shared in full shows its turns, one shared at summary shows none, and hidden or private sessions are absent", async () => {
    const { ids, as } = await seed();
    const rows = (await as(ids.ana).query(api.changesQueries.storySessions, { story_id: ids.story }))!;
    expect(rows.map((r) => r.conversation_id)).toEqual([ids.full, ids.summary]);
    const [full, summary] = rows;
    expect(full._id).toBe(`${ids.story}|${ids.full}`);
    expect(full.headline).toBe("Agent helpers stop starving");
    expect(full.summary).toBe("Agent helpers stop starving, in summary");
    expect(full.turns).toHaveLength(1);
    expect(full.turns[0].ask).toBe("Why is Agent helpers stop starving slow?");
    expect(full.turns[0].did[0].length).toBe(160);
    expect(full.turns[0].did[0].endsWith("…")).toBe(true);
    expect(full.turns[0].did[1]).toBe("Added a test");
    expect(summary.headline).toBe("Summary-level work");
    expect(summary.turns).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  test("a caller outside the team gets null", async () => {
    const { t, ids, as } = await seed();
    expect(await as(ids.outsider).query(api.changesQueries.storySessions, { story_id: ids.story })).toBeNull();
    expect(await t.query(api.changesQueries.storySessions, { story_id: ids.story })).toBeNull();
  });
});
