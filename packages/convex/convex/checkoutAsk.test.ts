import { afterAll, describe, expect, mock, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";

// The pipeline page's ask on a stuck checkout (checkoutAsk.ts): the writer hears the daemon's words about its own files,
// the files nobody wrote become the daemon's finding, and the row keeps the ask so the page reads it as told.
const sent: any[] = [];
const real = { ...(await import("./pendingMessages")) };
mock.module("./pendingMessages", () => ({ ...real, performSessionSend: async (_ctx: any, userId: string, args: any) => { sent.push({ userId, ...args }); return { ok: true }; } }));
// bun applies mock.module to the whole test process, so put the real module back for the files that run after this one.
afterAll(() => { mock.module("./pendingMessages", () => real); });
const { askCheckoutCore } = await import("./checkoutAsk");
const { forTeam, report } = await import("./checkouts");

const TEAM = "team_1" as any;
const ME = "user_me";
const TOKEN = "cast_ask_token";

async function setup() {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Ana" }, { _id: "user_x", name: "Xu" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    devices: [{ _id: "dv1", user_id: ME, device_id: "dev-1", label: "Mac-mini" }],
    repo_sources: [{ _id: "rs1", repository: "acme/app", team_id: TEAM }],
    github_app_installations: [],
    checkouts: [],
  };
  const scheduled: any[] = [];
  const db = makeFakeDb(tables) as any;
  db.normalizeId = (_t: string, id: string) => id;
  const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async (_ms: number, _fn: any, args: any) => { scheduled.push(args); } } } as any;
  await (report as any)._handler(ctx, {
    api_token: TOKEN, device_id: "dev-1", reports: [{
      repository: "acme/app", device_id: "dev-1", path: "/work/app", branch: "main", upstream: "origin/main", head_sha: "a".repeat(40), ahead: 0, behind: 364, fetched_at: 1,
      uncommitted: { total: 3, sessions: [{ conversation_id: "conv_1", session_id: "s1", client: "claude", state: "finished", last_activity: 5, paths: ["x.ts"], more: 0 }], unattributed: ["y.md"], unattributed_more: 0 },
      level: { state: "stuck", files: ["x.ts", "y.md"], reason: "2 file(s) changed here and in abc without a clean merge", since: 10, told: [] },
    }],
  });
  return { tables, ctx, scheduled, id: tables.checkouts[0]._id };
}

describe("asking about a stuck checkout from the page", () => {
  test("the writer hears of its own files in the daemon's words, and the row reads it as told", async () => {
    const { ctx, id } = await setup();
    sent.length = 0;
    expect(await askCheckoutCore(ctx, ME as any, id, "conv_1")).toEqual({ told: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: ME, to: "conv_1", intent: "request", wake: true });
    expect(sent[0].body.split("\n")[0]).toBe("app on Mac-mini: 1 of your files conflicts with origin/main");
    expect(sent[0].body).toContain("  x.ts\n");
    const [row] = await (forTeam as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: "acme/app" });
    expect(row.level.told).toEqual([expect.objectContaining({ to: "session", conversation_id: "conv_1", files: 1 })]);
  });

  test("the files nobody wrote become the daemon's finding, by the same fingerprint", async () => {
    const { ctx, id, scheduled } = await setup();
    await askCheckoutCore(ctx, ME as any, id, "finding");
    expect(scheduled[0]).toMatchObject({ user_id: ME, source: "level", kind: "bug", subject: "level:acme/app", project_path: "/work/app", team_id: TEAM });
    expect(scheduled[0].fingerprint.startsWith("level:dev-1:/work/app:")).toBe(true);
    expect(scheduled[0].title).toBe("app on Mac-mini: 1 file no session wrote conflicts with origin/main");
  });

  test("someone outside the team, a session that wrote none of the files, or a checkout no longer stuck is refused", async () => {
    const { ctx, id, tables } = await setup();
    await expect(askCheckoutCore(ctx, "user_x" as any, id, "conv_1")).rejects.toThrow("Checkout not found");
    await expect(askCheckoutCore(ctx, ME as any, id, "conv_9")).rejects.toThrow("wrote none of the conflicting files");
    tables.checkouts[0].report.level = { state: "level", levelled_at: 20 };
    await expect(askCheckoutCore(ctx, ME as any, id, "conv_1")).rejects.toThrow("not stuck any more");
  });
});
