// `cast flow run` with no flow named runs the workspace's default flow (flows.md FL4): the slug its team set
// (`default_flow` on the pool read) when that flow is here and takes a session's change, else Change, else the first
// that does: the web's rule (defaultFlowOf). `cast flow ls` marks it, and session start's <flows> line names it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerFlowCommands, type FlowDeps } from "./flowCommand";
import { poolFlows, workspaceDefaultFlow } from "./workflow/flowPool.js";
import { flowsLine } from "./stableContext";

const tmp: string[] = [];
const mkdtemp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "default-flow-"))); tmp.push(d); return d; };
const savedCache = process.env.CODECAST_FLOWS_CACHE;
beforeEach(() => { process.env.CODECAST_FLOWS_CACHE = mkdtemp(); });
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (savedCache === undefined) delete process.env.CODECAST_FLOWS_CACHE;
  else process.env.CODECAST_FLOWS_CACHE = savedCache;
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const line = (slug: string, label: string, takes: string) => `digraph ${slug.replace(/-/g, "_")} {
  graph [kind="line", label="${label}", takes="${takes}"]
  start [shape=Mdiamond]
  review [label="Review", prompt="Read the change."]
  exit [shape=Msquare]
  start -> review -> exit
}
`;

/** A repo with its own flows (a ship-now that takes a branch, a triage that takes only a task, one that does not parse) and a branch to run. */
function repo(): string {
  const root = mkdtemp();
  git(root, "init", "-q", "-b", "main");
  const flows = path.join(root, ".codecast", "flows");
  fs.mkdirSync(flows, { recursive: true });
  fs.writeFileSync(path.join(flows, "ship-now.cast"), line("ship-now", "Ship now", "task,branch"));
  fs.writeFileSync(path.join(flows, "triage.cast"), line("triage", "Triage", "task"));
  fs.writeFileSync(path.join(flows, "broken.cast"), `digraph broken { graph [kind="line", takes="branch"] start [shape=Mdiamond] start -> nowhere }`);
  fs.writeFileSync(path.join(root, "README.md"), "repo\n");
  git(root, "add", ".");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "first");
  git(root, "branch", "feature");
  return root;
}

describe("workspaceDefaultFlow (the web's defaultFlowOf over the CLI's pool)", () => {
  test("the slug the workspace set, when it is here and takes a session's change", () => {
    expect(workspaceDefaultFlow(poolFlows(repo(), null, []), "ship-now")?.slug).toBe("ship-now");
  });

  test("Change when the workspace set none, set one not here, one that takes only a task, or one that does not parse", () => {
    const pool = poolFlows(repo(), null, []);
    expect(pool.find((f) => f.slug === "broken")?.errors.length).toBeGreaterThan(0);
    for (const set of [null, "deleted", "triage", "broken"]) expect(workspaceDefaultFlow(pool, set)?.slug).toBe("change");
  });

  test("Change for a workspace that set Quick, which the library retired", () => {
    expect(workspaceDefaultFlow(poolFlows(repo(), null, []), "quick-change")?.slug).toBe("change");
  });
});

/** The flow team "dir" publishes to its own pool: in no repo and shipped by no CLI, so only a read of that pool finds it. */
const DIR_SHIP = {
  _id: "k57dir", slug: "dir-ship", name: "dir_ship", workspace: "team:dir", by: "Ana", mine: false, origin: null,
  source: line("dir-ship", "Dir ship", "task,branch"),
  nodes: [{ id: "start" }, { id: "review", prompt: "Read the change." }, { id: "exit" }],
};

/** The row a run of quick-change left in its runner's pool before the library retired it. */
const STORED_QUICK = {
  _id: "k57quick", slug: "quick-change", name: "quick-change", workspace: "team:dir", by: "Ana", mine: true, origin: null,
  source: line("quick-change", "Quick", "task,branch"),
  nodes: [{ id: "start" }, { id: "review", prompt: "Read the change." }, { id: "exit" }],
};

/** Run `cast flow <args>` from inside `cwd`, a directory mapped to team "dir" (or, with `mapped` false, to none) while
 *  the active team is "active". Team "dir"'s pool holds DIR_SHIP and `stored`, and carries `defaultFlow` (or fails with
 *  it, an Error); team "active"'s carries `activeDefault`. */
async function castFlow(cwd: string, args: string[], defaultFlow: string | null | Error, activeDefault: string | null = null, mapped = true, stored: unknown[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const posted: string[] = [];
  const poolReads: Array<string | null> = [];
  const gated: Array<string | null> = [];
  let mappedReads = 0;
  const deps: FlowDeps = {
    cliPost: async (route, body) => {
      posted.push(route);
      if (route === "/cli/workflows/pool") {
        poolReads.push(body.team_id ?? null);
        if (!body.team_id) return { flows: [], default_flow: null };
        if (body.team_id === "active") return { flows: [], default_flow: activeDefault };
        if (defaultFlow instanceof Error) throw defaultFlow;
        return { flows: [DIR_SHIP, ...stored], default_flow: defaultFlow };
      }
      if (route === "/cli/flow/live/show") return [];
      throw new Error(`not asked: ${route}`);
    },
    callingSession: () => undefined,
    subjectSession: async () => undefined,
    realCwd: () => cwd,
    readWorkspace: async (team) => ({ kind: "team", teamId: team ?? "active" }),
    directoryTeam: async () => { mappedReads++; return mapped ? "dir" : null; },
    writeWorkspace: async () => ({ kind: "team", teamId: "active" }),
    requireFlows: async (ws) => void gated.push(ws.kind === "team" ? ws.teamId : null),
  };
  const program = new Command().exitOverride();
  registerFlowCommands(program, deps);
  const [log, error, exit] = [console.log, console.error, process.exit];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  let code = null as number | null;
  process.exit = ((c?: number) => { code = c ?? 0; throw new Error("exit"); }) as typeof process.exit;
  try {
    await program.parseAsync(["node", "cast", "flow", ...args]).catch((e: Error) => { if (code === null) throw e; });
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
  const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  return { out: plain(out), err: plain(err), posted, poolReads, gated, mappedReads, code };
}

describe("cast flow run with no flow named", () => {
  test("runs the workspace's default and says so (--dry-run)", async () => {
    const r = await castFlow(repo(), ["run", "--branch", "feature", "--dry-run"], "ship-now");
    expect(r.err).toContain("No flow named: running ship-now, the workspace's default");
    expect(r.out).toMatch(/^Ship now: Review\non branch feature, bound to a new task "Run feature through Ship now"/);
  });

  test("runs Change when the workspace set no default", async () => {
    const r = await castFlow(repo(), ["run", "--branch", "feature", "--dry-run"], null);
    expect(r.err).toContain("running change, the workspace's default");
    expect(r.out).toContain("on branch feature");
  });

  test("reads the default of the team this directory is mapped to, as session start does, not the active team's", async () => {
    const root = repo();
    const here = await castFlow(root, ["run", "--branch", "feature", "--dry-run"], "ship-now", "change");
    expect(here.poolReads).toEqual(["dir"]);
    expect(here.err).toContain("running ship-now, the workspace's default");
    const named = await castFlow(root, ["run", "--branch", "feature", "--dry-run", "--team", "active"], "ship-now", "change");
    expect(named.err).toContain("running change, the workspace's default");
  });

  test("checks Flows is on in the team whose pool it reads: the mapped one, not the active one", async () => {
    const root = repo();
    expect((await castFlow(root, ["run", "--branch", "feature", "--dry-run"], null)).gated).toEqual(["dir"]);
    expect((await castFlow(root, ["run", "--branch", "feature", "--dry-run", "--team", "active"], null)).gated).toEqual(["active"]);
    expect((await castFlow(root, ["run", "--branch", "feature", "--dry-run"], null, null, false)).gated).toEqual(["active"]);
  });

  test("an unmapped folder reads the active team's pool but takes no team's default, as session start names none", async () => {
    const r = await castFlow(repo(), ["run", "--branch", "feature", "--dry-run"], "ship-now", "ship-now", false);
    expect(r.poolReads).toEqual(["active"]);
    expect(r.err).toContain("running change, the workspace's default");
  });

  test("a mapped team's own published default runs nameless, and ls, show and a named run all find it", async () => {
    const root = repo();
    const nameless = await castFlow(root, ["run", "--branch", "feature", "--dry-run"], "dir-ship", "change");
    expect(nameless.err).toContain("running dir-ship, the workspace's default");
    expect(nameless.out).toMatch(/^Dir ship: Review\n/);
    const named = await castFlow(root, ["run", "dir-ship", "--branch", "feature", "--dry-run"], "dir-ship", "change");
    expect(named.code).toBeNull();
    expect(named.out).toMatch(/^Dir ship: Review\n/);
    const shown = await castFlow(root, ["show", "dir-ship"], "dir-ship", "change");
    expect(shown.code).toBeNull();
    expect(shown.out).toContain("Dir ship");
    const listed = await castFlow(root, ["ls"], "dir-ship", "change");
    expect(listed.out.split("\n").find((l) => l.includes("(default)"))).toMatch(/^\s*dir-ship\b/);
    expect(listed.poolReads).toEqual(["dir"]);
    expect(listed.mappedReads).toBe(1);
    expect(shown.mappedReads).toBe(1);
    expect(nameless.mappedReads).toBe(1);
  });

  test("a pool read that fails stops it, saying why, rather than run Change as the default", async () => {
    const r = await castFlow(repo(), ["run", "--branch", "feature", "--dry-run"], new Error("network down"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("Could not read the workspace's flows, so its default flow is unknown (network down): name the flow to run (cast flow ls)");
    expect(r.err).not.toContain("No flow named");
    expect(r.out).toBe("");
  });

  test("a workspace whose default is the retired Quick runs Change", async () => {
    const r = await castFlow(repo(), ["run", "--branch", "feature", "--dry-run"], "quick-change");
    expect(r.err).toContain("running change, the workspace's default");
    expect(r.out).toContain("on branch feature");
  });

  test("naming the retired Quick fails in one line that names Change", async () => {
    const r = await castFlow(repo(), ["run", "quick-change", "--branch", "feature", "--dry-run"], null);
    expect(r.code).toBe(1);
    expect(r.err).toBe("✗ quick-change is no longer in the library: use change (Ship), which asks a person only when the change edits CI");
    expect(r.out).toBe("");
  });

  test("a Quick row a run left in the pool brings it back to no listing, show, run or default", async () => {
    const root = repo();
    const retired = "✗ quick-change is no longer in the library: use change (Ship), which asks a person only when the change edits CI";
    const run = await castFlow(root, ["run", "quick-change", "--branch", "feature", "--dry-run"], null, null, true, [STORED_QUICK]);
    expect([run.code, run.err]).toEqual([1, retired]);
    const shown = await castFlow(root, ["show", "quick-change"], null, null, true, [STORED_QUICK]);
    expect([shown.code, shown.err]).toEqual([1, retired]);
    expect((await castFlow(root, ["ls"], null, null, true, [STORED_QUICK])).out).not.toContain("quick-change");
    const nameless = await castFlow(root, ["run", "--branch", "feature", "--dry-run"], "quick-change", null, true, [STORED_QUICK]);
    expect(nameless.err).toContain("running change, the workspace's default");
  });

  test("a flow named still runs that flow, and says nothing of the default", async () => {
    const r = await castFlow(repo(), ["run", "change", "--branch", "feature", "--dry-run"], "ship-now");
    expect(r.err).not.toContain("No flow named");
    expect(r.out).not.toContain("Ship now");
    expect(r.out).toContain("on branch feature");
  });
});

describe("cast flow ls marks the default", () => {
  test("--json names it, and the listing marks its row", async () => {
    const root = repo();
    const json = JSON.parse((await castFlow(root, ["ls", "--json"], "ship-now")).out);
    expect(json.default).toBe("ship-now");
    const text = (await castFlow(root, ["ls"], "ship-now")).out;
    expect(text.split("\n").find((l) => l.includes("(default)"))).toMatch(/^\s*(└ )?ship-now\b/);
    expect(text).toContain("Run this session's change through ship-now, the default:  cast flow run");
  });
});

describe("session start's <flows> line", () => {
  test("names the workspace's default first, and the nameless command", async () => {
    const root = repo();
    expect(await flowsLine(root, [], "ship-now")).toContain("the default is ship-now (Review)");
    const none = await flowsLine(root, [], null);
    expect(none).toContain("the default is change (");
    expect(none).toContain("`cast flow run` sends this session's own edits through the default");
  });
});
