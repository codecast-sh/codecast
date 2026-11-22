import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { CHECKOUT_REPORT_MAX_BYTES, forTeam, report } from "./checkouts";

// Every device's checkouts (ct-98780): a device's owner reports them on change, a row per device and path in the
// repository's team (else the reporter's own workspace), read back only by that team. Synthetic data only.

const TEAM = "team_1" as any;
const ME = "user_me";
const STRANGER = "user_x";
const TOKEN = "cast_checkouts_token";
const STRANGER_TOKEN = "cast_checkouts_stranger";

async function seed() {
  return {
    users: [{ _id: ME, name: "Ana" }, { _id: STRANGER, name: "Xu" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }, { _id: "tok_2", user_id: STRANGER, token_hash: await hashToken(STRANGER_TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    devices: [{ _id: "dv1", user_id: ME, device_id: "dev-1", label: "laptop" }, { _id: "dv2", user_id: STRANGER, device_id: "dev-x", label: "other" }],
    repo_sources: [{ _id: "rs1", repository: "acme/app", team_id: TEAM }],
    github_app_installations: [],
    checkouts: [] as any[],
  } as Record<string, any[]>;
}
const ctxFor = (tables: Record<string, any[]>) => ({ db: makeFakeDb(tables), auth: { getUserIdentity: async () => null } }) as any;

const checkout = (over: any = {}) => ({
  repository: "Acme/App", device_id: "dev-1", path: "/work/app", branch: "main", upstream: "origin/main", head_sha: "a".repeat(40), ahead: 0, behind: 159, fetched_at: 1,
  uncommitted: { total: 2, sessions: [{ conversation_id: "conv_1", session_id: "s1", client: "claude", state: "finished", last_activity: 5, paths: ["x.ts"], more: 0 }], unattributed: ["y.md"], unattributed_more: 0 },
  level: { state: "stuck", files: ["x.ts"], reason: "1 file(s) changed here and in abc without a clean merge", since: 10, filed: null },
  ...over,
});
const send = (ctx: any, reports: any[], extra: any = {}) => (report as any)._handler(ctx, { api_token: TOKEN, device_id: "dev-1", reports, ...extra });

describe("checkouts", () => {
  test("a report lands in the repository's team, one row per device and path; the same report again writes nothing", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    expect(await send(ctx, [checkout()])).toEqual({ written: 1, removed: 0 });
    expect(t.checkouts[0]).toMatchObject({ workspace: `team:${TEAM}`, team_id: TEAM, repository: "acme/app", device_id: "dev-1", path: "/work/app", reporter_user_id: ME });
    expect(await send(ctx, [checkout()])).toEqual({ written: 0, removed: 0 });
    expect(await send(ctx, [checkout({ behind: 0, level: { state: "level", levelled_at: 20 } })])).toEqual({ written: 1, removed: 0 });
    expect(t.checkouts).toHaveLength(1);
    expect(t.checkouts[0].report.level).toEqual({ state: "level", levelled_at: 20 });
  });

  test("a repository no team of the reporter works on stays in the reporter's own workspace", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    await send(ctx, [checkout({ repository: "someone/solo", path: "/work/solo" })]);
    expect(t.checkouts[0]).toMatchObject({ workspace: `user:${ME}`, repository: "someone/solo" });
    expect(t.checkouts[0].team_id).toBeUndefined();
  });

  test("the team reads every device's checkouts with their sessions and level state; anyone else reads none", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    await send(ctx, [checkout(), checkout({ path: "/work/app-wt" })]);
    const rows = await (forTeam as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: "ACME/app" });
    expect(rows.map((r: any) => r.path).sort()).toEqual(["/work/app", "/work/app-wt"]);
    expect(rows[0]).toMatchObject({ _id: expect.any(String), workspace: `team:${TEAM}`, device_id: "dev-1", device_label: "laptop", repository: "acme/app", behind: 159, level: { state: "stuck", files: ["x.ts"] }, uncommitted: { total: 2 } });
    expect(await (forTeam as any)._handler(ctx, { api_token: STRANGER_TOKEN, team_id: TEAM })).toEqual([]);
  });

  test("only the device's owner reports it, for that device; a checkout gone from disk is removed", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    await expect((report as any)._handler(ctx, { api_token: STRANGER_TOKEN, device_id: "dev-1", reports: [checkout()] })).rejects.toThrow("not one of your devices");
    await expect(send(ctx, [checkout({ device_id: "dev-x" })])).rejects.toThrow("not dev-1");
    await send(ctx, [checkout()]);
    expect(await send(ctx, [], { gone: ["/work/app", "/never/reported"] })).toEqual({ written: 0, removed: 1 });
    expect(t.checkouts).toHaveLength(0);
  });

  test("a report that is not a checkout's, or too heavy, is refused", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    await expect(send(ctx, [checkout({ level: { state: "maybe" } })])).rejects.toThrow("level.state");
    const heavy = checkout({ uncommitted: { total: 1, sessions: [], unattributed: ["€".repeat(Math.ceil(CHECKOUT_REPORT_MAX_BYTES / 2))], unattributed_more: 0 } });
    await expect(send(ctx, [heavy])).rejects.toThrow(`over ${CHECKOUT_REPORT_MAX_BYTES}`);
    expect(t.checkouts).toHaveLength(0);
  });
});
