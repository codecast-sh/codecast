// Flows live in the library (ct-70169): a flow in library mode runs its
// current version on every machine; only a save changes it; each run records
// the versions it executes, a variant's base at its current version; restore
// is one step; a flow with no mode resolves as before. Through the real
// mutations under convex-test.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

const api = anyApi as any;
const TOKEN = "v".repeat(64);
const T0 = 1_790_000_000_000;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./workflow_runs.ts": () => import("./workflow_runs"),
  "./workflows.ts": () => import("./workflows"),
  "./flowVersions.ts": () => import("./flowVersions"),
  "./flowLibrary.ts": () => import("./flowLibrary"),
};

const nodes = (text: string) => [
  { id: "start", label: "start", shape: "Mdiamond", type: "start" },
  { id: "fix", label: "Fix", shape: "box", type: "session", prompt: text },
  { id: "done", label: "done", shape: "Msquare", type: "exit" },
];
const edges = [{ from: "start", to: "fix" }, { from: "fix", to: "done" }];
const push = (slug: string, hash: string, text: string, extra: Record<string, any> = {}) => ({
  api_token: TOKEN, name: slug.replace(/-/g, "_"), slug, label: "", source: `digraph ${slug.replace(/-/g, "_")} {\n  fix [prompt="@${slug}/fix.md"]\n}\n`,
  nodes: nodes(text), edges,
  origin: { device_id: "laptop", root: "/repo", file: `outreach/line/${slug}.cast`, files: [{ node: "fix", prompt: `outreach/line/${slug}/fix.md` }], graph_hash: hash, nodes: [{ id: "fix", h: hash.slice(0, 8) }] },
  ...extra,
});

async function setup() {
  const t = convexTest(schema, modules);
  const owner = await t.run(async (ctx) => {
    const u = await ctx.db.insert("users", { name: "Founder" } as any);
    await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    return u;
  });
  const upsert = (body: Record<string, any>) => t.mutation(api.workflows.upsert, body);
  const row = (slug: string) => t.run(async (ctx) => (await ctx.db.query("workflows").collect()).find((w: any) => w.slug === slug) as any);
  const versions = (slug: string) => t.mutation(api.flowVersions.fromCli, { api_token: TOKEN, op: "versions", flow: slug });
  /** A run created the way the sweep creates one, and what its runner gets. */
  const run = async (slug: string) => {
    const wf = await row(slug);
    const runId = await t.run(async (ctx) => {
      const { createRunCore } = await import("./workflow_runs");
      return (await createRunCore(ctx as any, owner, { workflow_name: wf.name, workflow_id: wf._id, project_path: "/repo" })).run_id;
    });
    const got = await t.mutation(api.workflow_runs.getForDaemon, { api_token: TOKEN, run_id: runId });
    return { runId, got, recorded: (await t.run((ctx) => ctx.db.get(runId)) as any).flow_versions };
  };
  return { t, owner, upsert, row, versions, run };
}

describe("a flow with no mode", () => {
  test("resolves as before: pushes rewrite it, versions keep hashes only, runs record nothing", async () => {
    const { upsert, row, versions, run } = await setup();
    await upsert(push("spine", "aaaaaaaaaaaaaaaa", "Fix it."));
    await upsert(push("spine", "bbbbbbbbbbbbbbbb", "Fix it well."));
    expect((await row("spine")).nodes[1].prompt).toBe("Fix it well.");
    expect((await row("spine")).runs_from).toBeUndefined();
    const vs = await versions("spine");
    expect(vs.versions.map((x: any) => [x.n, x.restorable, x.current])).toEqual([[2, false, false], [1, false, false]]);
    const { recorded, got } = await run("spine");
    expect(recorded).toBeUndefined();
    expect(got.workflow.library).toBeUndefined();
  });
});

describe("a flow in the library", () => {
  test("save switches it, a run's own push leaves it, a later save is the next version, runs read what they started on", async () => {
    const { upsert, row, versions, run } = await setup();
    await upsert(push("spine", "aaaaaaaaaaaaaaaa", "Fix it."));
    // The switch-over: the file's graph, already the last version, now with its content.
    await upsert(push("spine", "aaaaaaaaaaaaaaaa", "Fix it.", { save: true, library: true }));
    expect((await row("spine")).runs_from).toBe("library");
    let vs = await versions("spine");
    expect(vs.versions.map((x: any) => [x.n, x.restorable, x.current])).toEqual([[1, true, true]]);

    const first = await run("spine");
    expect(first.got.workflow.library.versions).toHaveLength(1);
    expect(first.got.workflow.library.versions[0].snapshot.nodes[1].prompt).toBe("Fix it.");
    expect(first.got.workflow.library.versions[0].snapshot.files).toEqual([{ node: "fix", prompt: "outreach/line/spine/fix.md" }]);

    // `cast workflow run` of an edited file pushes without saying save: the library flow is unmoved.
    const held = await upsert(push("spine", "cccccccccccccccc", "Local experiment."));
    expect(held.held).toBe(true);
    expect((await row("spine")).nodes[1].prompt).toBe("Fix it.");
    expect((await versions("spine")).versions).toHaveLength(1);

    // A save (cast workflow push, the Flows page's step edit) is the next version.
    await upsert(push("spine", "dddddddddddddddd", "Fix it, then prove it.", { save: true }));
    vs = await versions("spine");
    expect(vs.versions.map((x: any) => [x.n, x.current])).toEqual([[2, true], [1, false]]);
    const second = await run("spine");
    expect(second.got.workflow.library.versions[0].snapshot.nodes[1].prompt).toBe("Fix it, then prove it.");
    expect(String(first.recorded[0].version_id)).not.toBe(String(second.recorded[0].version_id));
  });

  test("a run records its first run's versions for a resume", async () => {
    const { t, upsert, run } = await setup();
    await upsert(push("spine", "aaaaaaaaaaaaaaaa", "Fix it.", { save: true, library: true }));
    const first = await run("spine");
    await upsert(push("spine", "dddddddddddddddd", "Changed.", { save: true }));
    const resumed = await t.mutation(api.workflow_runs.getForDaemon, { api_token: TOKEN, run_id: first.runId });
    expect(resumed.workflow.library.versions[0].snapshot.nodes[1].prompt).toBe("Fix it.");
  });

  test("repinLiveRuns moves waiting runs onto the current version, unless their station is gone", async () => {
    const { t, upsert, run, row } = await setup();
    await upsert(push("spine", "aaaaaaaaaaaaaaaa", "Fix it.", { save: true, library: true }));
    const waiting = await run("spine");
    const lost = await run("spine");
    await upsert(push("spine", "dddddddddddddddd", "Fixed eval line.", { save: true }));
    const flow = await row("spine");
    await t.run(async (ctx) => {
      // A station the graph source declares but the version's node list leaves out still counts.
      await ctx.db.patch(waiting.runId, { status: "paused", current_node_id: "fix", workspace: flow.workspace } as any);
      await ctx.db.patch(lost.runId, { status: "paused", current_node_id: "gone_station", workspace: flow.workspace } as any);
    });
    const { internal } = await import("./_generated/api");
    const dry = await t.mutation((internal as any).flowVersions.repinLiveRuns, { workflow_id: flow._id, dry: true });
    expect(dry.moved).toHaveLength(1);
    expect(dry.kept).toEqual([{ run: String(lost.runId), why: "the current graph has no gone_station" }]);
    await t.mutation((internal as any).flowVersions.repinLiveRuns, { workflow_id: flow._id });
    const resumed = await t.mutation(api.workflow_runs.getForDaemon, { api_token: TOKEN, run_id: waiting.runId });
    expect(resumed.workflow.library.versions[0].snapshot.nodes[1].prompt).toBe("Fixed eval line.");
    const unmoved = await t.mutation(api.workflow_runs.getForDaemon, { api_token: TOKEN, run_id: lost.runId });
    expect(unmoved.workflow.library.versions[0].snapshot.nodes[1].prompt).toBe("Fix it.");
  });

  test("a failed run resumed with --current-flow reads the current version; its check, or a station the version lacks, moves nothing", async () => {
    const { t, owner, upsert, run } = await setup();
    await upsert(push("spine", "aaaaaaaaaaaaaaaa", "Fix it.", { save: true, library: true }));
    const failed = await run("spine");
    await upsert(push("spine", "dddddddddddddddd", "Fixed eval line.", { save: true }));
    await t.run((ctx) => ctx.db.patch(failed.runId, { status: "failed", current_node_id: "fix", runner_device: "laptop", fail_reason: "Eval failed" } as any));
    const { resumeFailedRunCore } = await import("./workflow_runs");
    const resume = (at: string, opts: Record<string, boolean>) => t.run((ctx) => resumeFailedRunCore(ctx as any, owner, failed.runId, at, opts));
    const prompt = async () => (await t.mutation(api.workflow_runs.getForDaemon, { api_token: TOKEN, run_id: failed.runId })).workflow.library.versions[0].snapshot.nodes[1].prompt;
    await expect(resume("gone_station", { currentFlow: true, check: true })).rejects.toThrow("no station gone_station");
    await resume("fix", { currentFlow: true, check: true });
    expect(await prompt()).toBe("Fix it.");
    await resume("fix", { currentFlow: true });
    expect(await prompt()).toBe("Fixed eval line.");
    await upsert(push("plain", "eeeeeeeeeeeeeeee", "Fix it."));
    const outside = await run("plain");
    await t.run((ctx) => ctx.db.patch(outside.runId, { status: "failed", current_node_id: "fix", runner_device: "laptop" } as any));
    await expect(t.run((ctx) => resumeFailedRunCore(ctx as any, owner, outside.runId, "fix", { currentFlow: true }))).rejects.toThrow("does not run from the library");
  });

  test("a variant runs on its base's current version, and an edit to the base reaches it", async () => {
    const { upsert, run } = await setup();
    await upsert(push("spine", "aaaaaaaaaaaaaaaa", "Spine fix.", { save: true, library: true }));
    const variant = push("spine-system", "eeeeeeeeeeeeeeee", "System fix.", { save: true, library: true });
    variant.source = `digraph spine_system {\n  graph [extends="spine.cast"]\n}\n`;
    await upsert(variant);
    const before = await run("spine-system");
    expect(before.got.workflow.library.versions.map((x: any) => x.snapshot.name)).toEqual(["spine_system", "spine"]);
    await upsert(push("spine", "ffffffffffffffff", "Spine fix, better.", { save: true }));
    const after = await run("spine-system");
    expect(after.got.workflow.library.versions[1].snapshot.nodes[1].prompt).toBe("Spine fix, better.");
    expect(String(after.recorded[1].version_id)).not.toBe(String(before.recorded[1].version_id));
  });

  test("restore makes an earlier version current in one step; pin --repo sends runs back to the file", async () => {
    const { t, upsert, row, versions, run } = await setup();
    await upsert(push("spine", "aaaaaaaaaaaaaaaa", "Good.", { save: true, library: true }));
    await upsert(push("spine", "bbbbbbbbbbbbbbbb", "Bad edit.", { save: true }));
    const r = await t.mutation(api.flowVersions.fromCli, { api_token: TOKEN, op: "restore", flow: "spine", version: "v1" });
    expect(r).toMatchObject({ slug: "spine", restored: 1, version: 3 });
    expect((await row("spine")).nodes[1].prompt).toBe("Good.");
    expect((await row("spine")).origin.graph_hash).toBe("aaaaaaaaaaaaaaaa");
    expect((await versions("spine")).versions.map((x: any) => [x.n, x.current])).toEqual([[3, true], [2, false], [1, false]]);
    expect((await run("spine")).got.workflow.library.versions[0].snapshot.nodes[1].prompt).toBe("Good.");

    await t.mutation(api.flowVersions.fromCli, { api_token: TOKEN, op: "pin", flow: "spine", to: "repo" });
    const pinned = await run("spine");
    expect(pinned.recorded).toBeUndefined();
    expect(pinned.got.workflow.library).toBeUndefined();
    // Pinned to its file, a push rewrites it as before the library.
    await upsert(push("spine", "cccccccccccccccc", "From the file."));
    expect((await row("spine")).nodes[1].prompt).toBe("From the file.");
  });

  test("a flow the web creates is in the library from birth, and the web's edit is a version", async () => {
    const { t, owner, row, versions } = await setup();
    const web = t.withIdentity({ subject: owner });
    const base = { name: "line_calls", slug: "line-calls", source: "digraph line_calls { fix [prompt=\"Fix.\"] }", nodes: nodes("Fix."), edges };
    await web.mutation(api.workflows.webUpsert, { ...base, create_only: true });
    expect((await row("line-calls")).runs_from).toBe("library");
    await web.mutation(api.workflows.webUpsert, { ...base, nodes: nodes("Fix carefully.") });
    const vs = await versions("line-calls");
    expect(vs.versions.map((x: any) => [x.n, x.restorable, x.current])).toEqual([[2, true, true], [1, true, false]]);
  });

  test("a variant that extends a library flow by slug records that flow's current version", async () => {
    const { upsert, run } = await setup();
    await upsert(push("backbone", "aaaaaaaaaaaaaaaa", "Backbone.", { save: true, library: true }));
    const variant = push("backbone-calls", "bbbbbbbbbbbbbbbb", "Calls.", { save: true, library: true });
    variant.source = `digraph backbone_calls {\n  graph [extends="backbone"]\n}\n`;
    await upsert(variant);
    const r = await run("backbone-calls");
    expect(r.got.workflow.library.versions.map((x: any) => x.slug)).toEqual(["backbone-calls", "backbone"]);
  });

  test("a restore names a version that holds content, else says why", async () => {
    const { t, upsert } = await setup();
    await upsert(push("spine", "aaaaaaaaaaaaaaaa", "Old."));
    await upsert(push("spine", "bbbbbbbbbbbbbbbb", "New.", { save: true, library: true }));
    await expect(t.mutation(api.flowVersions.fromCli, { api_token: TOKEN, op: "restore", flow: "spine", version: "v1" })).rejects.toThrow(/before versions held their content/);
    await expect(t.mutation(api.flowVersions.fromCli, { api_token: TOKEN, op: "restore", flow: "spine", version: "v9" })).rejects.toThrow(/no version v9/);
  });
});
