import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { recordDeployMarker, report } from "./deploys";
import { closeSupersededDeploys } from "./deploysBackfill";

// A deploy left open (requested, running) when a newer deploy of its target went live never will as asked: it is
// closed as superseded, naming that deploy, and a later report of its own still lands. Synthetic data only.

const TEAM = "team_1" as any;
const WS = `team:${TEAM}`;
const ME = "user_me";
const TOKEN = "cast_supersede_token";
const REPO = "acme/app";
const sha = (n: number) => String(n).padStart(2, "0").repeat(20);
const HOUR = 3_600_000;

async function seed(deploys: any[] = []) {
  return {
    users: [{ _id: ME, name: "Ana" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    deploys,
    deploy_targets: [], commits: [], commit_ci: [], external_events: [], event_groups: [], workflow_runs: [], signals: [], counters: [{ _id: "c1", name: "dp", value: 100 }],
    agent_tasks: [], tasks: [], projects: [], conversations: [], ship_passes: [], daemon_commands: [], repo_sources: [], github_app_installations: [],
    triggers: [], trigger_runs: [],
  } as Record<string, any[]>;
}
const ctxFor = (tables: Record<string, any[]>) =>
  ({ db: makeFakeDb(tables), auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } }) as any;

const open = (n: number, status: "requested" | "running", created_at: number, target = "production", extra: any = {}) =>
  ({ _id: `d${n}`, short_id: `dp-${n}`, workspace: WS, team_id: TEAM, target, repository: REPO, status, trigger: "person", source: "codecast", event_ids: [], carries: [], created_at, updated_at: created_at, _creationTime: created_at, ...extra });
const live = (n: number, created_at: number, target = "production") => ({ ...open(n, "requested", created_at, target), status: "live", sha: sha(n % 100), live_at: created_at, finished_at: created_at });

describe("superseded deploys", () => {
  test("a deploy going live closes its target's older open ones, naming it; another target's stay open", async () => {
    const now = Date.now();
    const t = await seed([open(1, "requested", now - 30 * HOUR), open(2, "running", now - 2 * HOUR), open(3, "requested", now - 30 * HOUR, "dashboard")]);
    const ctx = ctxFor(t);
    const id = await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", repository: REPO, sha: sha(42), source: "deploy.sh", at: now });
    const byId = (s: string) => t.deploys.find((d) => d.short_id === s);
    // The marker finishes the open deploy it belongs to (the running one, a day old at most); the older request is superseded.
    expect(byId("dp-2")).toMatchObject({ status: "live" });
    expect(id).toBe("dp-2");
    expect(byId("dp-1")).toMatchObject({ status: "cancelled", superseded_by: "dp-2", note: "superseded by dp-2, never reported live" });
    expect(byId("dp-3").status).toBe("requested");
  });

  test("a superseded deploy that reports its own outcome later takes it", async () => {
    const now = Date.now();
    const t = await seed([open(1, "running", now - 3 * HOUR), live(2, now - HOUR)]);
    const ctx = ctxFor(t);
    await (closeSupersededDeploys as any)._handler(ctx, { dry: false });
    expect(t.deploys[0]).toMatchObject({ status: "cancelled", superseded_by: "dp-2" });
    await (report as any)._handler(ctx, { api_token: TOKEN, deploy: "dp-1", status: "live", sha: sha(1) });
    expect(t.deploys[0].status).toBe("live");
    expect(t.deploys[0].superseded_by).toBeUndefined();
  });

  test("the backfill lists without writing when dry, then closes each open deploy older than a live one of its target", async () => {
    const now = Date.now();
    const rows = () => [open(1, "requested", now - 50 * HOUR), live(2, now - 40 * HOUR), live(3, now - HOUR), open(4, "requested", now - 30 * HOUR, "web"), open(5, "running", now - 10 * 60_000)];
    const t = await seed(rows());
    const ctx = ctxFor(t);
    const dry = await (closeSupersededDeploys as any)._handler(ctx, { dry: true });
    expect(dry.closed.map((c: any) => [c.short_id, c.target, c.status, c.superseded_by])).toEqual([["dp-1", "production", "requested", "dp-2"]]);
    expect(t.deploys.find((d) => d.short_id === "dp-1").status).toBe("requested");
    const real = await (closeSupersededDeploys as any)._handler(ctx, { dry: false });
    expect(real.closed.map((c: any) => c.short_id)).toEqual(["dp-1"]);
    expect(t.deploys.find((d) => d.short_id === "dp-1")).toMatchObject({ status: "cancelled", superseded_by: "dp-2", note: "superseded by dp-2, never reported live" });
    // Opened after the newest live, and on a target with none: still going out.
    expect(t.deploys.find((d) => d.short_id === "dp-5").status).toBe("running");
    expect(t.deploys.find((d) => d.short_id === "dp-4").status).toBe("requested");
  });
});
