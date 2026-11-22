// A checkout's own flows as a person's machines report them (repoFlows.ts): one row per checkout, read for a session's
// own checkout first and its repository's newest report second, only by the reporter; an unchanged report keeps its
// row alive, an empty one removes it, and a checkout silent for two weeks goes when its repository reports again.
import { describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

const api = anyApi as any;
setDefaultTimeout(120_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./repoFlows.ts": () => import("./repoFlows"),
};

const REPO = "union-ai/union-mobile";
const flow = (label: string) => ({
  slug: "change", name: "change", kind: "line" as const, label, description: null, takes: ["task", "branch"],
  nodes: [{ id: "start", label: "start", type: "start" }, { id: "pr", label: "PR", type: "command", timeout: 600 }],
  edges: [{ from: "start", to: "pr" }],
});

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com" } as any);
    const bo = await ctx.db.insert("users", { name: "Bo", email: "bo@example.com" } as any);
    for (const [u, tok] of [[ana, "tok-ana"], [bo, "tok-bo"]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(tok), name: "cli", created_at: now, last_used_at: now } as any);
    }
    return { ana, bo };
  });
  const report = (root: string, hash: string, flows: any[], token = "tok-ana") =>
    t.mutation(api.repoFlows.report, { api_token: token, root, repository: REPO, hash, flows });
  const read = (u: string, root: string | null, repository: string | null = REPO) =>
    t.withIdentity({ subject: `${u}|test` }).query(api.repoFlows.forCheckout, { root, repository });
  const labels = (rows: any[]) => rows.map((r) => r.flows[0]?.label);
  return { t, ...ids, report, read, labels };
}

describe("a checkout's own flows", () => {
  test("each checkout keeps its own report, and a session reads its own checkout's", async () => {
    const s = await seed();
    await s.report("/repo", "h1", [flow("Main")]);
    await s.report("/repo-wt", "h2", [flow("Old branch")]);
    expect(s.labels(await s.read(s.ana, "/repo"))).toEqual(["Main"]);
    expect(s.labels(await s.read(s.ana, "/repo-wt"))).toEqual(["Old branch"]);
    // A node keeps fields the parser added that this table does not name.
    expect((await s.read(s.ana, "/repo"))[0].flows[0].nodes[1].timeout).toBe(600);
    expect(await s.read(s.bo, "/repo")).toEqual([]);
  });

  test("a checkout that never reported reads its repository's newest report", async () => {
    const s = await seed();
    await s.report("/repo", "h1", [flow("Main")]);
    setSystemTime(new Date(Date.now() + 60_000));
    await s.report("/repo-wt", "h2", [flow("Newer")]);
    setSystemTime();
    expect(s.labels(await s.read(s.ana, "/never-reported"))).toEqual(["Newer"]);
    expect(await s.read(s.ana, "/never-reported", "other/repo")).toEqual([]);
  });

  test("an unchanged report keeps the row alive, an empty one removes it", async () => {
    const s = await seed();
    await s.report("/repo", "h1", [flow("Main")]);
    const at = (await s.read(s.ana, "/repo"))[0].updated_at;
    setSystemTime(new Date(Date.now() + 60_000));
    expect(await s.report("/repo", "h1", [flow("Main")])).toEqual({ ok: true, unchanged: true });
    setSystemTime();
    expect((await s.read(s.ana, "/repo"))[0].updated_at).toBeGreaterThan(at);
    await s.report("/repo", "h0", []);
    expect(await s.read(s.ana, "/repo", null)).toEqual([]);
  });

  test("a checkout silent for two weeks goes when its repository reports again", async () => {
    const s = await seed();
    await s.report("/gone-wt", "h1", [flow("Gone")]);
    setSystemTime(new Date(Date.now() + 15 * 24 * 60 * 60 * 1000));
    await s.report("/repo", "h2", [flow("Main")]);
    expect(s.labels(await s.read(s.ana, "/gone-wt"))).toEqual(["Main"]);
    setSystemTime();
  });

  test("a bad token writes nothing", async () => {
    const s = await seed();
    expect(await s.report("/repo", "h1", [flow("Main")], "nope")).toEqual({ error: "Unauthorized" });
    expect(await s.read(s.ana, "/repo")).toEqual([]);
  });
});
