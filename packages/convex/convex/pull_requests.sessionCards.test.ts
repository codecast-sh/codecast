// The inbox's pull request feed (sessionCardPRs): for the sessions the client
// names, their links out of pull_request_sessions with tier, and each linked
// pull request without its heavy fields. Unlinked pull requests never crowd
// linked ones out, and nothing from a team the viewer is not in.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { SESSION_CARD_PR_FIELDS } from "./lib/prSessions";

setDefaultTimeout(120_000);

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Ada", email: "[email protected]" } as any);
    const other = await ctx.db.insert("users", { name: "Bo", email: "[email protected]" } as any);
    const mine = await ctx.db.insert("teams", { name: "Mine", invite_code: "MINE1234", created_at: 1 } as any);
    const theirs = await ctx.db.insert("teams", { name: "Theirs", invite_code: "THEIRS12", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: me, team_id: mine, role: "member", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: other, team_id: theirs, role: "member", joined_at: 1 } as any);
    const conversation = (user: any, team: any, short: string, priv = false) => ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", session_id: short, started_at: 1, updated_at: 1,
      message_count: 0, is_private: priv, status: "active", team_id: team, short_id: short,
    } as any);
    const conv = await conversation(me, mine, "jx7aaaa");
    const hidden = await conversation(other, theirs, "jx7bbbb", true);
    return { me, mine, theirs, conv, hidden };
  });
  return { t, ...ids };
}

const pr = (team: any, number: number, linked: any[], extra: Record<string, unknown> = {}) => ({
  team_id: team, github_pr_id: number, repository: "acme/app", number, title: `PR ${number}`,
  body: "a long body", state: "open", author_github_username: "ada", linked_session_ids: linked,
  created_at: number, updated_at: number,
  files: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@" }],
  commits: [{ sha: "abc", message: "m" }],
  checks: [{ name: "ci", status: "completed", conclusion: "failure", updated_at: 1 }],
  checks_state: "failure",
  ...extra,
});

async function link(t: any, prId: any, conv: any, tier?: "observed" | "committed") {
  await t.run((ctx: any) => ctx.db.insert("pull_request_sessions", { pull_request_id: prId, conversation_id: conv, ...(tier ? { tier } : {}) }));
}

describe("sessionCardPRs", () => {
  test("returns the named sessions' links with tier and slim pull requests", async () => {
    const { t, me, mine, conv } = await setup();
    const [a, b] = await t.run(async (ctx) => [
      await ctx.db.insert("pull_requests", pr(mine, 1, [conv]) as any),
      await ctx.db.insert("pull_requests", pr(mine, 2, [conv], { draft: true }) as any),
    ]);
    await link(t, a, conv, "committed");
    await link(t, b, conv);
    const out: any = await t.withIdentity({ subject: `${me}|s` }).query(api.pull_requests.sessionCardPRs, { conversation_ids: [conv] });
    expect(out.links.map((l: any) => [l.pull_request_id, l.tier]).sort()).toEqual([[a, "committed"], [b, "observed"]].sort());
    expect(out.pull_requests.map((r: any) => r.number).sort()).toEqual([1, 2]);
    const row = out.pull_requests.find((r: any) => r.number === 1);
    expect(row.checks_state).toBe("failure");
    expect(row.title).toBe("PR 1");
    for (const key of Object.keys(row)) expect(SESSION_CARD_PR_FIELDS as readonly string[]).toContain(key);
    for (const withheld of ["body", "files", "commits", "checks", "linked_session_ids"]) expect(withheld in row).toBe(false);
  });

  test("many newer unlinked pull requests never crowd a linked one out", async () => {
    const { t, me, mine, conv } = await setup();
    const old = await t.run((ctx) => ctx.db.insert("pull_requests", pr(mine, 1, [conv]) as any));
    await link(t, old, conv, "committed");
    await t.run(async (ctx) => {
      for (let n = 2; n <= 90; n++) await ctx.db.insert("pull_requests", pr(mine, n, []) as any);
    });
    const out: any = await t.withIdentity({ subject: `${me}|s` }).query(api.pull_requests.sessionCardPRs, { conversation_ids: [conv] });
    expect(out.pull_requests.map((r: any) => r.number)).toEqual([1]);
  });

  test("leaves out pull requests of teams the viewer is not in, and ids that are not conversations", async () => {
    const { t, me, mine, theirs, conv, hidden } = await setup();
    const [own, foreignTeam, privateConv] = await t.run(async (ctx) => [
      await ctx.db.insert("pull_requests", pr(mine, 1, [conv]) as any),
      await ctx.db.insert("pull_requests", pr(theirs, 2, [conv]) as any),
      await ctx.db.insert("pull_requests", pr(theirs, 3, [hidden]) as any),
    ]);
    await link(t, own, conv);
    await link(t, foreignTeam, conv);
    await link(t, privateConv, hidden);
    const out: any = await t.withIdentity({ subject: `${me}|s` }).query(api.pull_requests.sessionCardPRs, { conversation_ids: [conv, hidden, "not-an-id", "optimistic-123"] });
    expect(out.pull_requests.map((r: any) => r.number)).toEqual([1]);
    expect(out.links.map((l: any) => l.pull_request_id)).toEqual([own]);
  });

  test("a session with more links than fit is answered for its first ten, committed ones first", async () => {
    const { t, me, mine, conv } = await setup();
    const other = await t.run((ctx) => ctx.db.insert("conversations", {
      user_id: me, agent_type: "claude_code", session_id: "s2", started_at: 1, updated_at: 1,
      message_count: 0, is_private: false, status: "active", team_id: mine, short_id: "jx7cccc",
    } as any));
    const committedFirst = await t.run((ctx) => ctx.db.insert("pull_requests", pr(mine, 99, [conv]) as any));
    await link(t, committedFirst, conv, "committed");
    for (let n = 1; n <= 12; n++) {
      const id = await t.run((ctx) => ctx.db.insert("pull_requests", pr(mine, n, [conv]) as any));
      await link(t, id, conv);
    }
    const one = await t.run((ctx) => ctx.db.insert("pull_requests", pr(mine, 50, [other]) as any));
    await link(t, one, other);
    const out: any = await t.withIdentity({ subject: `${me}|s` }).query(api.pull_requests.sessionCardPRs, { conversation_ids: [conv, other] });
    const kept = out.links.filter((l: any) => l.conversation_id === conv);
    expect(kept).toHaveLength(10);
    expect(kept.some((l: any) => l.pull_request_id === committedFirst)).toBe(true);
    expect(out.answered).toEqual([conv, other]);
  });

  test("a patch to nothing a chip draws answers the same", async () => {
    const { t, me, mine, conv } = await setup();
    const id = await t.run((ctx) => ctx.db.insert("pull_requests", pr(mine, 1, [conv]) as any));
    await link(t, id, conv, "committed");
    const ask = () => t.withIdentity({ subject: `${me}|s` }).query(api.pull_requests.sessionCardPRs, { conversation_ids: [conv] });
    const before = await ask();
    await t.run((ctx) => ctx.db.patch(id, { updated_at: 999, checks: [], files: [], mergeable_state: "behind" } as any));
    expect(await ask()).toEqual(before);
    await t.run((ctx) => ctx.db.patch(id, { checks_state: "success" } as any));
    expect(await ask()).not.toEqual(before);
  });

  test("stops reading past its byte budget and leaves the rest unanswered", async () => {
    const { t, me, mine } = await setup();
    const patch = "x".repeat(900_000);
    const convs: any[] = [];
    for (let n = 0; n < 12; n++) {
      const conv = await t.run((ctx) => ctx.db.insert("conversations", {
        user_id: me, agent_type: "claude_code", session_id: `big${n}`, started_at: 1, updated_at: 1,
        message_count: 0, is_private: false, status: "active", team_id: mine, short_id: `jx7big${n}`,
      } as any));
      const id = await t.run((ctx) => ctx.db.insert("pull_requests", pr(mine, 100 + n, [conv], { files: [{ filename: "a", status: "modified", additions: 1, deletions: 0, changes: 1, patch }] }) as any));
      await link(t, id, conv, "committed");
      convs.push(conv);
    }
    const out: any = await t.withIdentity({ subject: `${me}|s` }).query(api.pull_requests.sessionCardPRs, { conversation_ids: convs });
    expect(out.answered.length).toBeGreaterThan(0);
    expect(out.answered.length).toBeLessThan(12);
    expect(out.pull_requests.length).toBe(out.answered.length);
  });

  test("stops mid-session when one session alone passes the budget, and leaves it unanswered", async () => {
    const { t, me, mine, conv } = await setup();
    const patch = "é".repeat(500_000);
    for (let n = 0; n < 10; n++) {
      const id = await t.run((ctx) => ctx.db.insert("pull_requests", pr(mine, 200 + n, [conv], { files: [{ filename: "a", status: "modified", additions: 1, deletions: 0, changes: 1, patch }] }) as any));
      await link(t, id, conv, "committed");
    }
    const out: any = await t.withIdentity({ subject: `${me}|s` }).query(api.pull_requests.sessionCardPRs, { conversation_ids: [conv] });
    expect(out.answered).toEqual([]);
    expect(out.pull_requests.length).toBeGreaterThan(0);
    expect(out.pull_requests.length).toBeLessThan(10);
  });
});
