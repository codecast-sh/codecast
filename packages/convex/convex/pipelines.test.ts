import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { forTeam, PIPELINE_MAX_BYTES, publish } from "./pipelines";

// A repository's pipeline (docs/architecture/pipeline.md PL6): published from
// the checkout into its team's workspace, replaced whole, read back only by
// members of that team. Synthetic data only.

const TEAM = "team_1" as any;
const OTHER = "team_2" as any;
const ME = "user_me";
const STRANGER = "user_x";
const TOKEN = "cast_pipe_token";
const STRANGER_TOKEN = "cast_pipe_stranger";

async function seed() {
  return {
    users: [{ _id: ME, name: "Ana" }, { _id: STRANGER, name: "Xu" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }, { _id: "tok_2", user_id: STRANGER, token_hash: await hashToken(STRANGER_TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }, { _id: "m2", user_id: STRANGER, team_id: OTHER, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }, { _id: OTHER, name: "Other" }],
    repo_sources: [{ _id: "rs1", repository: "acme/app", team_id: TEAM }],
    github_app_installations: [],
    pipelines: [] as any[],
  } as Record<string, any[]>;
}

const ctxFor = (tables: Record<string, any[]>) => ({ db: makeFakeDb(tables), auth: { getUserIdentity: async () => null } }) as any;

const flow = (slug: string, label: string) => ({
  slug, label, base: slug, file: null, removed: [],
  graph: { nodes: [{ id: "start", label: "start", type: "start" }], edges: [] },
  stations: [{ id: "check", label: "Check", who: "command", own: "inherited", main: true }],
});

const PIPE = { repository: "Acme/App", device_id: "ana-mac", head_sha: "a".repeat(40), head_at: 1_000, change: flow("change", "Change"), release: { ...flow("line-deploy", "Release"), targets: [{ name: "backend", policy: "release", runs: "here", when: [] }] } };

describe("pipelines", () => {
  test("a publish lands in the repository's team, keyed by its lowercased name; the same files again write nothing", async () => {
    const tables = await seed();
    const ctx = ctxFor(tables);
    expect(await (publish as any)._handler(ctx, { api_token: TOKEN, ...PIPE })).toEqual({ team_id: TEAM, repository: "acme/app", changed: true });
    expect(tables.pipelines).toHaveLength(1);
    expect(tables.pipelines[0]).toMatchObject({ workspace: `team:${TEAM}`, team_id: TEAM, repository: "acme/app", device_id: "ana-mac" });
    const at = tables.pipelines[0].published_at;
    expect((await (publish as any)._handler(ctx, { api_token: TOKEN, ...PIPE })).changed).toBe(false);
    expect(tables.pipelines[0].published_at).toBe(at);
    const edited = { ...PIPE, change: { ...PIPE.change, stations: [{ ...PIPE.change.stations[0], own: "changed", changed: ["guide"] }] } };
    expect((await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, ...edited })).changed).toBe(true);
    expect(tables.pipelines).toHaveLength(1);
    expect(tables.pipelines[0].change.stations[0].own).toBe("changed");
  });

  test("a team's members read its pipelines; anyone else reads none", async () => {
    const tables = await seed();
    const ctx = ctxFor(tables);
    await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, ...PIPE });
    const mine = await (forTeam as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ _id: tables.pipelines[0]._id, workspace: `team:${TEAM}`, head_sha: "a".repeat(40), repository: "acme/app", device_id: "ana-mac", change: { slug: "change" }, release: { slug: "line-deploy", targets: [{ name: "backend" }] } });
    expect(await (forTeam as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: "ACME/app" })).toHaveLength(1);
    expect(await (forTeam as any)._handler(ctx, { api_token: STRANGER_TOKEN, team_id: TEAM })).toEqual([]);
  });

  test("a publish into a team the caller is not in, or not shaped as a pipeline, is refused", async () => {
    const tables = await seed();
    const ctx = ctxFor(tables);
    await expect((publish as any)._handler(ctx, { api_token: STRANGER_TOKEN, team_id: TEAM, ...PIPE })).rejects.toThrow();
    await expect((publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, ...PIPE, change: { slug: "change" } })).rejects.toThrow("not a PipelineFlow");
    expect(tables.pipelines).toHaveLength(0);
  });

  test("a publish from an older commit than the stored one is refused; a newer one replaces it", async () => {
    const tables = await seed();
    const ctx = ctxFor(tables);
    await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, ...PIPE });
    const stale = { ...PIPE, head_sha: "b".repeat(40), head_at: 500, change: { ...PIPE.change, label: "Old change" } };
    const r = await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, ...stale });
    expect(r).toMatchObject({ changed: false, refused: expect.stringContaining("newer commit") });
    expect(tables.pipelines[0]).toMatchObject({ head_sha: "a".repeat(40), change: { label: "Change" } });
    const unheaded = await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, ...PIPE, head_sha: undefined, head_at: undefined, change: { ...PIPE.change, label: "No head" } });
    expect(unheaded.refused).toBeTruthy();
    const newer = await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, ...PIPE, head_sha: "c".repeat(40), head_at: 2_000 });
    expect(newer.changed).toBe(true);
    expect(tables.pipelines[0].head_sha).toBe("c".repeat(40));
  });

  test("the size cap counts bytes, not characters", async () => {
    const tables = await seed();
    const ctx = ctxFor(tables);
    // Three bytes a character in UTF-8: under the cap in characters, over it in bytes.
    const prompt = "€".repeat(Math.floor(PIPELINE_MAX_BYTES / 2));
    const heavy = { ...PIPE, change: { ...PIPE.change, stations: [{ ...PIPE.change.stations[0], prompt }] } };
    await expect((publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, ...heavy })).rejects.toThrow(`over ${PIPELINE_MAX_BYTES}`);
    expect(tables.pipelines).toHaveLength(0);
  });
});
