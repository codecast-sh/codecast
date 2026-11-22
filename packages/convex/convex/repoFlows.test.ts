// A repository's own flows as a person's checkouts report them (repoFlows.ts): the newest report replaces the row,
// an unchanged one writes nothing, an empty one removes the row, and only the reporter reads it.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
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
  const report = (hash: string, flows: any[], token = "tok-ana", repository = "union-ai/union-mobile") =>
    t.mutation(api.repoFlows.report, { api_token: token, repository, hash, flows });
  const mine = (u: string) => t.withIdentity({ subject: `${u}|test` }).query(api.repoFlows.mine, {});
  return { t, ...ids, report, mine };
}

describe("a repository's own flows", () => {
  test("the newest report replaces the row, and only its reporter reads it", async () => {
    const s = await seed();
    await s.report("h1", [flow("Change")]);
    await s.report("h2", [flow("Change v2")]);
    const rows = await s.mine(s.ana);
    expect(rows.map((r: any) => [r.repository, r.flows[0].label])).toEqual([["union-ai/union-mobile", "Change v2"]]);
    // A node keeps fields the parser added that this table does not name.
    expect(rows[0].flows[0].nodes[1].timeout).toBe(600);
    expect(await s.mine(s.bo)).toEqual([]);
  });

  test("an unchanged report writes nothing, and an empty one removes the row", async () => {
    const s = await seed();
    await s.report("h1", [flow("Change")]);
    const at = (await s.mine(s.ana))[0].updated_at;
    expect(await s.report("h1", [flow("Change")])).toEqual({ ok: true, unchanged: true });
    expect((await s.mine(s.ana))[0].updated_at).toBe(at);
    await s.report("h0", []);
    expect(await s.mine(s.ana)).toEqual([]);
  });

  test("a bad token writes nothing", async () => {
    const s = await seed();
    expect(await s.report("h1", [flow("Change")], "nope")).toEqual({ error: "Unauthorized" });
    expect(await s.mine(s.ana)).toEqual([]);
  });
});
