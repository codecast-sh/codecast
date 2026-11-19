// Team read keys under convex-test: an admin mints a key, a server reads
// GET /cli/v1/team/sessions with it and sees what every member of the team
// sees (the member feed agrees row for row), as metadata only: no prompt as a
// title, no project path, no remote outside GitHub. A private session and an
// activity-level member's session never leak. Revoked and expired keys are
// refused, an address over its
// unknown-key window is refused before any lookup, a team holds a capped
// number of live keys, and minting, use and revoking show in the audit every
// member reads.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { httpRouter } from "convex/server";
import { hashToken } from "@platform/auth/convex";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { TEAM_SESSIONS_PATH, teamSessionsHttp } from "./lib/teamReadKeyHttp";
import { MAX_LIVE_TEAM_READ_KEYS } from "./lib/teamReadKey";
import { USE_WINDOW_MS } from "./teamReadKeys";

setDefaultTimeout(120_000);

const router = httpRouter();
router.route({ path: TEAM_SESSIONS_PATH, method: "GET", handler: teamSessionsHttp });
const modules = { ...allModules, "./http.ts": async () => ({ default: router }) };

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const VIEWER_TOKEN = "v".repeat(64);
const SECRETS = ["OPENING PROMPT", "PREVIEW TEXT", "MESSAGE TEXT", "/Users/someone", "secret-folder"];

/** Team Acme: Ada (admin, full), Mo (summary), Act (activity), Hal (hidden),
 *  and Vi, a member with no sessions of her own whose CLI token reads the feed. */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const user = (name: string) => ctx.db.insert("users", { name, email: `${name.toLowerCase()}@acme.dev` } as any);
    const [ada, mo, act, hal, vi] = [await user("Ada"), await user("Mo"), await user("Act"), await user("Hal"), await user("Vi")];
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    const other = await ctx.db.insert("teams", { name: "Other", invite_code: "OTHR1234", created_at: 1 } as any);
    const join = (user_id: Id<"users">, role: string, visibility: string, team_id = team) =>
      ctx.db.insert("team_memberships", { user_id, team_id, role, visibility, joined_at: 1 } as any);
    await join(ada, "admin", "full");
    await join(mo, "member", "summary");
    await join(act, "member", "activity");
    await join(hal, "member", "hidden");
    await join(vi, "member", "full");
    await join(ada, "member", "full", other);
    await ctx.db.insert("api_tokens", { user_id: vi, token_hash: await hashToken(VIEWER_TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any);
    return { ada, mo, act, hal, vi, team, other };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  return { t, ...ids, as };
}

/** A session with content a key must never return. */
async function session(t: any, user: Id<"users">, fields: Record<string, unknown>) {
  return await t.run(async (ctx: any) => {
    const id = await ctx.db.insert("conversations", {
      user_id: user,
      agent_type: "claude_code",
      session_id: crypto.randomUUID(),
      started_at: NOW - 2 * HOUR,
      updated_at: NOW - HOUR,
      message_count: 1,
      is_private: false,
      status: "completed",
      project_path: "/Users/someone/secret-folder",
      git_remote_url: "git@github.com:acme/api.git",
      git_branch: "feat/x",
      subtitle: "A summary",
      first_prompt: "OPENING PROMPT",
      last_message_preview: "PREVIEW TEXT",
      ...fields,
    } as any);
    await ctx.db.insert("messages", { conversation_id: id, message_uuid: crypto.randomUUID(), role: "user", content: "MESSAGE TEXT", timestamp: NOW - HOUR } as any);
    return id;
  });
}

async function get(t: any, key: string | null, query = "") {
  const res = await t.fetch(`${TEAM_SESSIONS_PATH}${query}`, { method: "GET", headers: key ? { Authorization: `Bearer ${key}` } : {} });
  return { status: res.status, body: await res.json() };
}

/** Every page of the key's read, one session per page. */
async function readAll(t: any, key: string, window = "") {
  const sessions: any[] = [];
  const raw: string[] = [];
  let cursor: string | null = null;
  do {
    const { status, body }: { status: number; body: any } = await get(t, key, cursor ? `?limit=1&cursor=${cursor}` : `?limit=1${window}`);
    expect(status).toBe(200);
    raw.push(JSON.stringify(body));
    sessions.push(...body.sessions);
    cursor = body.next_cursor;
  } while (cursor);
  return { sessions, raw: raw.join("\n") };
}

const mint = (as: any, team: Id<"teams">, name = "eng site") =>
  as.mutation(api.teamReadKeys.create, { team_id: team, name, expires_in_days: 90 });

describe("team read keys", () => {
  test("a private session and an activity-level member's session never leak", async () => {
    const { t, ada, mo, act, team, as } = await setup();
    await session(t, ada, { team_id: team, title: "Ada shared", subtitle: "Ada summary" });
    await session(t, mo, { team_id: team, is_private: true, title: "Mo private", subtitle: "Mo private summary" });
    await session(t, act, { team_id: team, title: "Act activity", subtitle: "Act activity summary" });
    const { key } = await mint(as(ada), team);

    const { sessions, raw } = await readAll(t, key);
    expect(sessions.map((s) => s.title)).toEqual(["Ada shared"]);
    for (const leak of ["Mo private", "Act activity", ...SECRETS]) expect(raw).not.toContain(leak);
  });

  test("rows are the team floor at each member's level, metadata only, without child sessions", async () => {
    const { t, ada, mo, hal, team, other, as } = await setup();
    await session(t, ada, { team_id: team, title: "Ada shared", subtitle: "Ada summary", updated_at: NOW - HOUR });
    await session(t, mo, { team_id: team, title: "Mo work", subtitle: "Mo summary", updated_at: NOW - 2 * HOUR });
    await session(t, hal, { team_id: team, title: "Hal hidden" });
    await session(t, ada, { team_id: other, title: "Ada other team" });
    await session(t, ada, { title: "Ada personal", is_private: true });
    await session(t, ada, { team_id: team, title: "Ada subagent", is_subagent: true });
    await session(t, ada, { team_id: team, title: "Ada workflow child", is_workflow_sub: true });
    await session(t, ada, { team_id: team, title: "Ada last week", updated_at: NOW - 7 * 24 * HOUR });
    // Run by Ada, assigned to Mo: Mo is its owner, and Ada's sharing decides who sees it.
    await session(t, ada, { team_id: team, title: "Assigned to Mo", owner_user_id: mo, updated_at: NOW - 3 * HOUR, git_remote_url: "/srv/clients/acme/private.git" });
    const { key } = await mint(as(ada), team);

    const { sessions, raw } = await readAll(t, key);
    expect(sessions).toEqual([
      {
        id: expect.any(String),
        owner: { id: String(ada), name: "Ada", github_username: null },
        agent: "claude_code",
        branch: "feat/x",
        repo: "acme/api",
        title: "Ada shared",
        summary: "Ada summary",
        sharing: "full",
        work_state: expect.any(String),
        started_at: new Date(NOW - 2 * HOUR).toISOString(),
        updated_at: new Date(NOW - HOUR).toISOString(),
      },
      expect.objectContaining({ title: "Mo work", summary: "Mo summary", sharing: "summary", owner: expect.objectContaining({ name: "Mo" }) }),
      expect.objectContaining({ title: "Assigned to Mo", sharing: "full", owner: expect.objectContaining({ id: String(mo) }), repo: null }),
    ]);
    for (const leak of SECRETS) expect(raw).not.toContain(leak);

    // A cursor keeps the window it was given: last week's session is out on every page.
    const week = await readAll(t, key, `&since=${NOW - 8 * 24 * HOUR}&until=${NOW - 6 * 24 * HOUR}`);
    expect(week.sessions.map((s) => s.title)).toEqual(["Ada last week"]);
  });

  test("the key and a member's feed list the same sessions", async () => {
    const { t, ada, mo, team, as } = await setup();
    // A member who switched to full going forward: the earlier session stays a summary.
    await t.run(async (ctx) => {
      const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q) => q.eq("user_id", mo).eq("team_id", team)).first();
      await ctx.db.patch(m!._id, { visibility: "full", visibility_history: [{ before: NOW - 90 * 60 * 1000, visibility: "summary" }] } as any);
    });
    const joiner = (name: string, fields: Record<string, unknown> = {}) =>
      t.run(async (ctx) => {
        const id = await ctx.db.insert("users", { name, email: `${name.toLowerCase()}@acme.dev`, ...fields } as any);
        await ctx.db.insert("team_memberships", { user_id: id, team_id: team, role: "member", visibility: "full", joined_at: 1 } as any);
        return id;
      });
    const leaver = await joiner("Lee");
    // Shares in full with the team, but hid their activity for the whole account.
    const hider = await joiner("Hid", { activity_visibility: "hidden" });
    const at = (minutesAgo: number) => NOW - minutesAgo * 60 * 1000;
    await session(t, ada, { team_id: team, title: "Ada shared", updated_at: at(60) });
    await session(t, ada, { team_id: team, title: "Ada run log", workflow_run_id: "run", is_workflow_primary: true, updated_at: at(65) });
    await session(t, mo, { team_id: team, title: "Mo before the switch", started_at: at(120), updated_at: at(70) });
    await session(t, mo, { team_id: team, title: "Mo after the switch", started_at: at(60), updated_at: at(30) });
    await session(t, mo, { team_id: team, title: "Mo shared as summary", team_visibility: "summary", started_at: at(60), updated_at: at(50) });
    await session(t, leaver, { team_id: team, title: "Lee before leaving", updated_at: at(55) });
    await session(t, hider, { team_id: team, title: "Hid's work", updated_at: at(45) });
    await t.run(async (ctx) => {
      const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q) => q.eq("user_id", leaver).eq("team_id", team)).first();
      await ctx.db.delete(m!._id);
    });
    const { key } = await mint(as(ada), team);

    const keyRows = (await readAll(t, key)).sessions;
    const feed: any = await t.query(api.conversations.feedForCLI, { api_token: VIEWER_TOKEN, team_id: team, start_time: NOW - 24 * HOUR, end_time: NOW });
    const listed = (rows: any[]) => rows.map((r) => r.title).sort();
    expect(listed(keyRows)).toEqual(listed(feed.conversations));
    expect(listed(keyRows)).toEqual(["Ada shared", "Mo after the switch", "Mo before the switch", "Mo shared as summary"]);
    expect(Object.fromEntries(keyRows.map((s) => [s.title, s.sharing]))).toMatchObject({
      "Mo before the switch": "summary",
      "Mo after the switch": "full",
      "Mo shared as summary": "summary",
    });
  });

  test("a session's title counts once it is named, and not while it echoes the opening prompt", async () => {
    const { t, ada, team, as } = await setup();
    await t.run((ctx) => ctx.db.patch(ada, { active_team_id: team }));
    const { conversation_id, short_id } = await as(ada).mutation(api.assistant.entry.startConversation, { firstMessage: "Deploy the billing fix tonight. Then tell me." });
    await as(ada).mutation(api.conversations.setPrivacy, { conversation_id, is_private: false });
    const echo = await session(t, ada, { team_id: team, title: "OPENING PROMPT…" });
    await session(t, ada, { team_id: team, title: "Mirror", git_remote_url: "https://bot:tok3n@gitlab.example.com/acme/api.git" });
    const { key } = await mint(as(ada), team);

    const before = await readAll(t, key);
    expect(before.sessions.find((s) => s.id === short_id)).toMatchObject({ title: null });
    expect(before.sessions.find((s) => s.id === String(echo))).toMatchObject({ title: null });
    expect(before.sessions.find((s) => s.title === "Mirror")).toMatchObject({ repo: null });
    for (const leak of ["Deploy the billing fix", "OPENING PROMPT", "tok3n"]) expect(before.raw).not.toContain(leak);

    await t.mutation(internal.titleGeneration.setTitleAndSubtitle, { conversation_id, title: "Billing fix deploy", subtitle: "Deployed the billing fix" });
    expect((await readAll(t, key)).sessions.find((s) => s.id === short_id)).toMatchObject({ title: "Billing fix deploy", summary: "Deployed the billing fix" });
  });

  test("an address over its unknown-key window is refused before any key is looked up", async () => {
    const { t, ada, team, as } = await setup();
    const { key } = await mint(as(ada), team);
    for (let i = 0; i < 30; i++) expect((await get(t, "cc_trk_" + "0".repeat(48))).status).toBe(401);
    expect((await get(t, "cc_trk_" + "0".repeat(48))).status).toBe(429);
    expect((await get(t, key)).status).toBe(429);
  });

  test("a revoked or expired key is refused, as is a missing or unknown one", async () => {
    const { t, ada, team, as } = await setup();
    const revoked = await mint(as(ada), team, "revoked");
    const expired = await mint(as(ada), team, "expired");
    expect((await get(t, revoked.key)).status).toBe(200);
    await as(ada).mutation(api.teamReadKeys.revoke, { team_id: team, key_id: revoked.key_id });
    await t.run((ctx) => ctx.db.patch(expired.key_id, { expires_at: Date.now() - 1 }));
    expect((await get(t, revoked.key)).status).toBe(401);
    expect((await get(t, expired.key)).status).toBe(401);
    expect((await get(t, null)).status).toBe(401);
    expect((await get(t, "cc_trk_" + "0".repeat(48))).status).toBe(401);
    const live = await mint(as(ada), team, "live");
    expect((await get(t, live.key, "?since=yesterday")).status).toBe(400);
  });

  test("only a team admin mints, lists and revokes; the key is stored as a hash", async () => {
    const { t, ada, mo, team, as } = await setup();
    await expect(mint(as(mo), team)).rejects.toThrow();
    expect(await as(mo).query(api.teamReadKeys.list, { team_id: team })).toBeNull();
    const minted = await mint(as(ada), team);
    expect(minted.key).toMatch(/^cc_trk_[0-9a-f]{48}$/);
    const row = (await t.run((ctx) => ctx.db.get(minted.key_id)))!;
    expect(JSON.stringify(row)).not.toContain(minted.key);
    expect((await as(ada).query(api.teamReadKeys.list, { team_id: team }))!.map((k) => k.name)).toEqual(["eng site"]);
    await expect(as(mo).mutation(api.teamReadKeys.revoke, { team_id: team, key_id: minted.key_id })).rejects.toThrow();
  });

  test(`a team holds at most ${MAX_LIVE_TEAM_READ_KEYS} live keys; a revoked one frees a place`, async () => {
    const { ada, team, as } = await setup();
    const first = await mint(as(ada), team, "key 0");
    for (let i = 1; i < MAX_LIVE_TEAM_READ_KEYS; i++) await mint(as(ada), team, `key ${i}`);
    await expect(mint(as(ada), team, "one too many")).rejects.toThrow(/active read keys/);
    await as(ada).mutation(api.teamReadKeys.revoke, { team_id: team, key_id: first.key_id });
    await mint(as(ada), team, "replacement");
  });

  test("minting, use once per window and revoking show in every member's audit", async () => {
    const { t, ada, mo, team, as } = await setup();
    const { key, key_id } = await mint(as(ada), team);
    await get(t, key);
    await get(t, key);
    await t.run((ctx) => ctx.db.patch(key_id, { last_used_at: Date.now() - USE_WINDOW_MS }));
    await get(t, key);
    await as(ada).mutation(api.teamReadKeys.revoke, { team_id: team, key_id });

    const events = (await as(mo).query(api.authorityEvents.list, {})).sort((a: any, b: any) => a._creationTime - b._creationTime);
    expect(events.map((e: any) => e.kind)).toEqual([
      "team_read_key_minted",
      "team_read_key_used",
      "team_read_key_used",
      "team_read_key_revoked",
    ]);
    for (const e of events) {
      expect(e.actor_user_id).toBe(ada);
      expect(e.detail.after).toMatchObject({ key_id, name: "eng site" });
      expect(JSON.stringify(e)).not.toContain(key);
    }
  });
});
