// Session search and the CLI feed read one workspace, and a teammate's session
// shared as a summary shows its title, never its text. Search used to walk
// every team the viewer belonged to when no team was named, so a viewer in
// teams T and O, working in T, found sessions of O-only members; and a match
// snippet returned message text for sessions whose team saw only a summary.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { hashToken } from "@platform/auth/convex";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

const token = "w".repeat(64);

async function seed() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (name: string) => ctx.db.insert("users", { name, email: `${name.toLowerCase()}@x.com` } as any);
    const viewer = await user("Viewer");
    const full = await user("Fulltm");
    const summary = await user("Summarytm");
    const other = await user("Otheronly");
    await ctx.db.insert("api_tokens", { user_id: viewer, token_hash: await hashToken(token), name: "cli", created_at: now, last_used_at: now } as any);
    const T = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "t" });
    const O = await ctx.db.insert("teams", { name: "O", created_at: now, invite_code: "o" });
    const join = (user_id: any, team_id: any, visibility = "full") =>
      ctx.db.insert("team_memberships", { user_id, team_id, role: "member", joined_at: 0, visibility } as any);
    await join(viewer, T);
    await join(viewer, O);
    await join(full, T);
    await join(summary, T, "summary");
    await join(other, O);
    await ctx.db.patch(viewer, { active_team_id: T });
    const session = async (user_id: any, team_id: any, label: string, title: string) => {
      const conversation_id = await ctx.db.insert("conversations", {
        user_id, team_id, is_private: false, agent_type: "claude_code", session_id: label, title, subtitle: "", idle_summary: "",
        first_prompt: `quokka opening prompt of ${label}`,
        started_at: now - 1000, updated_at: now, message_count: 1, status: "active",
      } as any);
      await ctx.db.insert("messages", { conversation_id, message_uuid: label, role: "user", content: `quokka secret text of ${label}`, timestamp: now } as any);
    };
    await session(viewer, T, "mine", "quokka mine");
    await session(full, T, "full", "quokka full");
    await session(summary, T, "summary", "quokka summary");
    // Only its text matches: a summary-level session never surfaces for it.
    await session(summary, T, "summary-text-only", "unrelated work");
    await session(other, O, "other", "quokka other");
    return { viewer, T, O };
  });
  return { t, ...ids };
}

const byTitle = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.title, r]));

test("web search reads the active team, and summary sessions match on their title alone", async () => {
  const { t, viewer, T, O } = await seed();
  const as = t.withIdentity({ subject: viewer });

  for (const args of [{}, { activeTeamId: T }]) {
    const res: any = await as.query(api.conversations.searchConversations, { query: "quokka", ...args });
    const rows = byTitle(res.results);
    expect(Object.keys(rows).sort()).toEqual(["quokka full", "quokka mine", "quokka summary"]);
    expect(rows["quokka full"].matches.map((m: any) => m.content).join(" ")).toContain("secret text of full");
    expect(rows["quokka summary"].matches).toEqual([]);
    expect(rows["quokka summary"].origin?.started_as).toBeUndefined();
    expect(rows["quokka summary"].workspace).toBe(`team:${T}`);

    const titles: any = await as.query(api.conversations.searchConversationTitles, { query: "quokka", ...args });
    expect(titles.results.map((r: any) => r.title).sort()).toEqual(["quokka full", "quokka mine", "quokka summary"]);
  }

  const all: any = await as.query(api.conversations.searchConversations, { query: "quokka", allTeams: true });
  const allRows = byTitle(all.results);
  expect(allRows["quokka other"]?.teamName).toBe("O");
  expect(allRows["quokka other"].workspace).toBe(`team:${O}`);
  expect(allRows["quokka full"].teamName).toBe("T");
  expect(allRows["quokka summary"].matches).toEqual([]);
  expect(allRows["unrelated work"]).toBeUndefined();
});

test("cast search and the CLI feed read the active team unless asked for every team", async () => {
  const { t } = await seed();

  // A content search never surfaces a summary session by its text.
  const search: any = await t.query(api.conversations.searchForCLI, { api_token: token, query: "quokka" });
  const rows = byTitle(search.conversations);
  expect(Object.keys(rows).sort()).toEqual(["quokka full", "quokka mine"]);
  expect(rows["quokka full"].matches.length).toBeGreaterThan(0);
  expect(rows["quokka full"].workspace).toMatch(/^team:/);

  // Its title still finds it, with no text.
  const titled: any = await t.query(api.conversations.searchForCLI, { api_token: token, query: "quokka", titles_only: true });
  const titledRows = byTitle(titled.conversations);
  expect(Object.keys(titledRows).sort()).toEqual(["quokka full", "quokka mine", "quokka summary"]);
  expect(titledRows["quokka summary"].origin?.started_as).toBeUndefined();

  const global: any = await t.query(api.conversations.searchForCLI, { api_token: token, query: "quokka", all_teams: true });
  expect(byTitle(global.conversations)["quokka other"]?.team).toBe("O");

  const feed: any = await t.query(api.conversations.feedForCLI, { api_token: token });
  const cards = byTitle(feed.conversations);
  expect(cards["quokka other"]).toBeUndefined();
  expect(JSON.stringify(cards["quokka summary"].preview)).not.toContain("secret");
  expect(cards["quokka summary"].tail).toBeUndefined();
  expect(JSON.stringify(cards["quokka full"].preview)).toContain("secret text of full");

  const feedAll: any = await t.query(api.conversations.feedForCLI, { api_token: token, all_teams: true });
  expect(byTitle(feedAll.conversations)["quokka other"]?.team).toBe("O");
});
