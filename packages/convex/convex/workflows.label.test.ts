// A flow's display label (the graph's `label`): stored on its workflow row by
// a push, kept by a write that does not mention it, cleared by a push that says
// it has none, and read by every run feed from that one row (enrichRun). The
// flow's name stays its key.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { enrichRun } from "./workflow_runs";

const api = anyApi as any;
setDefaultTimeout(120_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./workflows.ts": () => import("./workflows"),
};
const NODES = [
  { id: "start", label: "Start", shape: "Mdiamond", type: "start" },
  { id: "build", label: "Build", shape: "box", type: "agent", prompt: "build it" },
  { id: "exit", label: "Done", shape: "Msquare", type: "exit" },
];
const EDGES = [{ from: "start", to: "build" }, { from: "build", to: "exit" }];

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const user = await t.run(async (ctx) => {
    const u = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com" } as any);
    await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken("tok"), name: "cli", created_at: now, last_used_at: now } as any);
    return u;
  });
  const push = (extra: Record<string, unknown>) =>
    t.mutation(api.workflows.upsert, { api_token: "tok", name: "agentwatch", slug: "agentwatch", source: "digraph agentwatch {}", nodes: NODES, edges: EDGES, ...extra });
  const row = () => t.run(async (ctx) => (await ctx.db.query("workflows").collect())[0]) as Promise<any>;
  return { t, user, push, row };
}

describe("a flow's display label", () => {
  test("a push stores it, a write that leaves it out keeps it, a push with none clears it; the name stays the key", async () => {
    const s = await seed();
    await s.push({ label: "Union fix flow" });
    expect(await s.row()).toMatchObject({ name: "agentwatch", slug: "agentwatch", label: "Union fix flow" });

    // The web's line settings edit never sends a label.
    await s.t.withIdentity({ subject: `${s.user}|test` }).mutation(api.workflows.webUpsert, { name: "agentwatch", slug: "agentwatch", nodes: NODES, edges: EDGES });
    expect((await s.row()).label).toBe("Union fix flow");

    await s.push({ label: "" });
    const cleared = await s.row();
    expect(cleared.label).toBeUndefined();
    expect(cleared.name).toBe("agentwatch");
  });

  test("every run feed reads the label from the run's workflow row, and keeps the name it was keyed by", async () => {
    const s = await seed();
    await s.push({ label: "Union fix flow" });
    const enriched = await s.t.run(async (ctx) => {
      const wf = (await ctx.db.query("workflows").collect())[0];
      const run = await ctx.db.insert("workflow_runs", { user_id: s.user, workflow_id: wf._id, workflow_name: "agentwatch", status: "paused", node_statuses: [], created_at: 1, updated_at: 1 } as any);
      return enrichRun(ctx as any, await ctx.db.get(run));
    });
    expect(enriched).toMatchObject({ workflow_name: "agentwatch", workflow_slug: "agentwatch", workflow_label: "Union fix flow" });
  });
});
