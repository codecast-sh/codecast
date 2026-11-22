// Every run pins the graph it started on (ct-98653). A workflows row is one per
// (user, slug), so two checkouts that push `change` (codecast's template and
// union-mobile's line) rewrite one row all day. On 2026-11-21 Union's push of a
// graph with no decide__decide closed a live Codecast run's Decide card
// ("Replaced · station removed") while the run sat paused there. Through the
// real mutations under convex-test: two checkouts push the same slug,
// interleaved, and each run's card, resume, agent set and supersession come
// from its own graph.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { decisionSuperseded, runSuperseded } from "./lib/superseded";

const api = anyApi as any;
const TOKEN = "p".repeat(64);
const T0 = 1_790_000_000_000;

// Codecast's change: a Decide gate presented by the review station, Claude only.
const CODECAST = {
  name: "change", slug: "change", label: "Change",
  source: "digraph change {\n  review -> decide__decide\n}\n",
  nodes: [
    { id: "start", label: "start", shape: "Mdiamond", type: "start" },
    { id: "review", label: "Review", shape: "box", type: "agent" },
    { id: "decide__decide", label: "Decide", shape: "hexagon", type: "human", asker: "review" },
    { id: "done", label: "done", shape: "Msquare", type: "exit" },
  ],
  edges: [{ from: "start", to: "review" }, { from: "review", to: "decide__decide" }, { from: "decide__decide", to: "done" }],
};
// Union's change: no decide__decide, and a Codex station.
const UNION = {
  name: "change", slug: "change", label: "Change",
  source: "digraph change {\n  fix -> card\n}\n",
  nodes: [
    { id: "start", label: "start", shape: "Mdiamond", type: "start" },
    { id: "fix", label: "Fix", shape: "box", type: "agent", agent: "codex" },
    { id: "card", label: "Card", shape: "hexagon", type: "human" },
    { id: "done", label: "done", shape: "Msquare", type: "exit" },
  ],
  edges: [{ from: "start", to: "fix" }, { from: "fix", to: "card" }, { from: "card", to: "done" }],
};
const origin = (root: string, file: string, hash: string, nodes: Array<{ id: string }>) => ({
  device_id: "laptop", root, file, files: [], graph_hash: hash, nodes: nodes.map((n) => ({ id: n.id, h: `${hash}-${n.id}` })),
});
// `cast flow run packages/cli/src/workflow/templates/change.cast --team Codecast --task ...`: a file push from codecast's checkout.
const codecastAt = (nodes: Array<{ id: string } & Record<string, any>>, hash: string) => ({ ...CODECAST, nodes, origin: origin("/code/codecast", "packages/cli/src/workflow/templates/change.cast", hash, nodes) });
const codecastPush = codecastAt(CODECAST.nodes, "hc");
const unionPush = (n: number) => ({ ...UNION, origin: origin(`/code/union-mobile/.codecast/worktrees/s${n}`, ".codecast/flows/change.cast", "hu", UNION.nodes) });

async function setup() {
  const t = convexTest(schema, allModules);
  const owner = await t.run(async (ctx) => {
    const u = await ctx.db.insert("users", { name: "Founder" } as any);
    await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    return u;
  });
  const push = (body: Record<string, any>) => t.mutation(api.workflows.upsert, { api_token: TOKEN, ...body });
  /** `cast workflow run`: its push, then the run it creates, naming the version the push left. */
  const start = async (body: Record<string, any>, between?: () => Promise<unknown>, extra: Record<string, any> = {}) => {
    const pushed = await push(body);
    await between?.();
    const created = await t.mutation(api.workflow_runs.createFromCli, {
      api_token: TOKEN, workflow_name: body.name, workflow_id: pushed.id, project_path: "/code/x",
      ...(pushed.version_id ? { workflow_version_id: pushed.version_id } : {}), ...extra,
    });
    return created.run_id;
  };
  const daemon = (runId: string) => t.mutation(api.workflow_runs.getForDaemon, { api_token: TOKEN, run_id: runId });
  const card = (runId: string) => t.withIdentity({ subject: `${owner}|s` }).query(api.workflow_runs.pinnedGraphOfRun, { run_id: runId });
  /** The run waits at its gate with an open decision, as a runner leaves it. */
  const pauseAt = (runId: string, gate: string) => t.run((ctx) => ctx.db.patch(runId as any, { status: "paused", gate_node_id: gate, current_node_id: gate }));
  const standing = (runId: string, gate: string) => t.run(async (ctx) => {
    const run: any = await ctx.db.get(runId as any);
    return {
      run: await runSuperseded(ctx as any, run, null),
      decision: await decisionSuperseded(ctx as any, { status: "pending", workflow_run_id: run._id, gate_node_id: gate } as any),
    };
  });
  return { t, owner, push, start, daemon, card, pauseAt, standing };
}

const ids = (nodes: Array<{ id: string }>) => nodes.map((n) => n.id);

describe("two checkouts push the same slug, interleaved", () => {
  test("each run's card, resume and supersession come from its own graph, and the other repo's push leaves its open decision open", async () => {
    const { push, start, daemon, card, pauseAt, standing } = await setup();
    await push(unionPush(1));
    const codecastRun = await start(codecastPush);
    const unionRun = await start(unionPush(2));
    await pauseAt(codecastRun, "decide__decide");
    // Union pushes again after the Codecast run stopped at Decide, the row now Union's graph with no decide__decide.
    await push(unionPush(3));

    expect(await standing(codecastRun, "decide__decide")).toEqual({ run: null, decision: null });
    expect(ids((await card(codecastRun)).nodes)).toEqual(ids(CODECAST.nodes));
    expect(ids((await card(unionRun)).nodes)).toEqual(ids(UNION.nodes));

    // A resumed runner reads its own graph and its own checkout's file, never the row's.
    const resumed = await daemon(codecastRun);
    expect(ids(resumed.workflow.nodes)).toEqual(ids(CODECAST.nodes));
    expect(resumed.workflow.source).toBe(CODECAST.source);
    expect(resumed.workflow.origin).toMatchObject({ root: "/code/codecast", file: "packages/cli/src/workflow/templates/change.cast" });
    const other = await daemon(unionRun);
    expect(ids(other.workflow.nodes)).toEqual(ids(UNION.nodes));
    expect(other.workflow.origin.root).toBe("/code/union-mobile/.codecast/worktrees/s2");
  });

  test("a run from before pins reads the row as before: Union's push still closes its card", async () => {
    const { t, push, start, pauseAt, standing } = await setup();
    const old = await start(codecastPush);
    await t.run((ctx) => ctx.db.patch(old as any, { graph_version_id: undefined }));
    await pauseAt(old, "decide__decide");
    await push(unionPush(1));
    expect((await standing(old, "decide__decide")).run).toEqual({ why: "station_gone" });
  });

  test("the run's agents are its graph's, even when another checkout pushes between its push and its start", async () => {
    const { t, owner, start } = await setup();
    await t.run((ctx) => ctx.db.insert("devices", {
      user_id: owner, device_id: "laptop", label: "laptop", platform: "darwin", last_seen: T0,
      cloud_agent_blocks: [{ provider: "codex", kind: "key_missing", cli_signed_out: true }],
    } as any));
    // Union's Codex station would refuse this machine; the Codecast graph the run starts on has none.
    const runId = await start(codecastPush, () => t.mutation(api.workflows.upsert, { api_token: TOKEN, ...unionPush(1) }), { detach: true, run_on_device: "laptop" });
    expect(runId).toBeTruthy();
    const run: any = await t.run((ctx) => ctx.db.get(runId));
    const ver: any = await t.run((ctx) => ctx.db.get(run.graph_version_id));
    expect(ver.graph_hash).toBe("hc");
  });

  test("a runner that loaded a newer graph of its own moves the pin onto that version", async () => {
    const { t, push, start, card } = await setup();
    const runId = await start(codecastPush);
    const edited = codecastAt([...CODECAST.nodes, { id: "verify", label: "Verify", shape: "box", type: "agent" }], "hc2");
    await push(edited);
    await push(unionPush(1));
    await t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: runId, current_node_id: "verify", graph_hash: "hc2" });
    expect(ids((await card(runId)).nodes)).toContain("verify");
  });
});

describe("a version is its graph pushed from one place", () => {
  test("a second worktree's push of the same graph is its own version, so its run's daemon reads its own checkout", async () => {
    const { t, start, daemon } = await setup();
    const at = (root: string) => ({ ...CODECAST, origin: origin(root, "packages/cli/src/workflow/templates/change.cast", "hc", CODECAST.nodes) });
    const first = await start(at("/code/codecast/.codecast/worktrees/s1"));
    const second = await start(at("/code/codecast/.codecast/worktrees/s2"));
    expect((await daemon(first)).workflow.origin.root).toBe("/code/codecast/.codecast/worktrees/s1");
    expect((await daemon(second)).workflow.origin.root).toBe("/code/codecast/.codecast/worktrees/s2");
    // The graph itself is kept once, and no version carries it inline.
    const kept = await t.run(async (ctx) => ({ graphs: (await ctx.db.query("workflow_version_graphs").collect()).length, inline: (await ctx.db.query("workflow_versions").collect()).filter((v) => v.snapshot).length }));
    expect(kept).toEqual({ graphs: 1, inline: 0 });
  });
});

describe("a pinned run's own line still supersedes it (line-versions.md LV1)", () => {
  test("its checkout's later push that makes Decide an agent's station is line changed; another repository's push leaves it open", async () => {
    const { push, start, pauseAt, standing } = await setup();
    const runId = await start(codecastPush);
    await pauseAt(runId, "decide__decide");
    await push(unionPush(1));
    expect(await standing(runId, "decide__decide")).toEqual({ run: null, decision: null });
    const agentDecides = codecastAt(CODECAST.nodes.map((n) => (n.id === "decide__decide" ? { ...n, type: "agent", shape: "box" } : n)), "hc2");
    await push(agentDecides);
    await push(unionPush(2));
    // v1 Codecast, v2 Union, v3 Codecast's agent Decide: the version that replaced the gate, by its number.
    expect((await standing(runId, "decide__decide")).run).toEqual({ why: "line_changed", by: "v3" });
  });

  test("its checkout's later push without the station it stands at is station removed", async () => {
    const { push, start, pauseAt, standing } = await setup();
    const runId = await start(codecastPush);
    await pauseAt(runId, "decide__decide");
    const dropped = codecastAt(CODECAST.nodes.filter((n) => n.id !== "decide__decide"), "hc3");
    await push(dropped);
    expect((await standing(runId, "decide__decide")).run).toEqual({ why: "station_gone" });
  });
});

// `cast flow run change` and `cast flow run change --library` in the Codecast team ran Union's outreach/line/change.cast
// (row td7ezsej), while `--dry-run` and `cast flow show change` showed the library's graph. Both push the graph they
// resolved with no file (the shipped template, or the library's copy outside any checkout).
describe("a run pins what it resolved, never what the shared row last held", () => {
  const LIBRARY = { ...CODECAST, source: "digraph change {\n  // the library's\n  review -> decide__decide\n}\n" };

  for (const [what, body] of [["a plain run (the shipped template)", CODECAST], ["--library (the library's copy)", LIBRARY]] as const) {
    test(`${what}, after another checkout pushed the slug`, async () => {
      const { push, start, daemon, card, pauseAt, standing } = await setup();
      await push(unionPush(1));
      const runId = await start(body);
      await push(unionPush(2));
      const got = await daemon(runId);
      expect(got.workflow.source).toBe(body.source);
      expect(ids(got.workflow.nodes)).toEqual(ids(CODECAST.nodes));
      // No file this run read: never the origin Union's push left on the row.
      expect(got.workflow.origin).toBeUndefined();
      expect((await card(runId)).source).toBe(body.source);
      await pauseAt(runId, "decide__decide");
      expect((await standing(runId, "decide__decide")).decision).toBeNull();
    });
  }
});

// Codecast's main path is a run from no file: `cast flow run change` resolves the built-in template. A card is stale
// only when the graph its run would resume with no longer has its gate, and a run pinned from no file resumes with
// its own pinned graph, which nothing replaces. One person, one active team pointer, every push to one row.
describe("a run pinned from no file is never superseded", () => {
  test("Union's no-file push of a graph without the station leaves Codecast's open decision open", async () => {
    const { push, start, pauseAt, standing } = await setup();
    const runId = await start(CODECAST);
    await pauseAt(runId, "decide__decide");
    await push(UNION);
    expect(await standing(runId, "decide__decide")).toEqual({ run: null, decision: null });
  });

  test("nor does a web save, or its own team's later built-in push without the station: it resumes with the graph it pinned", async () => {
    const { t, owner, push, start, pauseAt, standing, daemon } = await setup();
    const runId = await start(CODECAST);
    await pauseAt(runId, "decide__decide");
    await t.withIdentity({ subject: `${owner}|s` }).mutation(api.workflows.webUpsert, { ...UNION, source: "digraph change { // the web\n}\n" });
    await push({ ...CODECAST, nodes: CODECAST.nodes.filter((n) => n.id !== "decide__decide"), source: "digraph change { // dropped\n}\n" });
    expect(await standing(runId, "decide__decide")).toEqual({ run: null, decision: null });
    const resumed = await daemon(runId);
    expect(ids(resumed.workflow.nodes)).toContain("decide__decide");
    expect(resumed.workflow.origin).toBeUndefined();
  });
});

describe("a library run resumes with the library's current version, so its saves supersede it", () => {
  test("another checkout's push leaves it open; a library save without the station is station removed", async () => {
    const { push, start, pauseAt, standing } = await setup();
    await push({ ...codecastPush, save: true, library: true });
    const runId = await start(codecastPush);
    await pauseAt(runId, "decide__decide");
    await push(unionPush(1));
    expect(await standing(runId, "decide__decide")).toEqual({ run: null, decision: null });
    await push({ ...codecastAt(CODECAST.nodes.filter((n) => n.id !== "decide__decide"), "hc3"), save: true });
    expect((await standing(runId, "decide__decide")).run).toEqual({ why: "station_gone" });
  });
});

describe("a version's changes", () => {
  test("are measured against its line's version before, and a checkout's first push of an unchanged graph shows none", async () => {
    const { t, push } = await setup();
    const at = (root: string, nodes: Array<{ id: string } & Record<string, any>>, h: (id: string) => string, hash: string) => ({
      ...CODECAST, nodes, origin: { ...origin(root, "change.cast", hash, nodes), nodes: nodes.map((n) => ({ id: n.id, h: h(n.id) })) },
    });
    await push(at("/code/codecast/s1", CODECAST.nodes, (id) => `a-${id}`, "a"));
    // A second worktree's first push of the same graph: its line has no version before, so the row's is the basis.
    await push(at("/code/codecast/s2", CODECAST.nodes, (id) => `a-${id}`, "a"));
    await push(unionPush(1));
    // Its own checkout again, with only Review moved: measured against its line, not Union's version in between.
    await push(unionPush(2));
    await push(at("/code/codecast/s1", CODECAST.nodes.map((n) => (n.id === "review" ? { ...n, label: "Review it" } : n)), (id) => (id === "review" ? "b-review" : `a-${id}`), "b"));
    const versions: any[] = await t.run((ctx) => ctx.db.query("workflow_versions").collect());
    expect(versions.map((v) => v.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(versions[1].changed).toEqual([]);
    expect(versions[4].changed).toEqual(["review"]);
  });
});

describe("a run's own line is read through its index, however many other versions came between", () => {
  test("after 55 pushes from other checkouts, its checkout's push without the station still supersedes it", async () => {
    const { push, start, pauseAt, standing } = await setup();
    const runId = await start(codecastPush);
    await pauseAt(runId, "decide__decide");
    for (let i = 1; i <= 55; i++) await push(unionPush(i));
    expect(await standing(runId, "decide__decide")).toEqual({ run: null, decision: null });
    await push(codecastAt(CODECAST.nodes.filter((n) => n.id !== "decide__decide"), "hc3"));
    expect((await standing(runId, "decide__decide")).run).toEqual({ why: "station_gone" });
  });
});

describe("a graph is kept once, and goes with its row", () => {
  test("a push of a graph its line already has keeps no new graph; removing the row removes its graphs", async () => {
    const { t, owner, push } = await setup();
    await push(codecastPush);
    // The same graph_hash with another label: the line's newest version stands, and no graph row is left over.
    await push({ ...codecastPush, label: "Change, renamed" });
    const graphs = () => t.run(async (ctx) => (await ctx.db.query("workflow_version_graphs").collect()).length);
    expect(await graphs()).toBe(1);
    await t.withIdentity({ subject: `${owner}|s` }).mutation(api.workflows.webRemove, { slug: "change" });
    expect(await graphs()).toBe(0);
  });
});
