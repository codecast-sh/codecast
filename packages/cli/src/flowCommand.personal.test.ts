// Which flow Ship runs in a personal workspace (flows.md FL2, FL4): a directory established as personal, with no
// --team, ships through `personal` (the default, and what `cast flow run change` runs), unless the repo has its own
// `.codecast/flows/change.cast`. Personal is established by the calling session's own stamp (its team_id, which the
// web reads), or by the server's rule replayed on the git_root the daemon syncs (directoryTeam.ts over the shared
// matchDirectoryMapping). Any doubt reads as before and never ships personal. Team workspaces are unchanged.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PERSONAL_FLOW_SLUG } from "@codecast/shared/contracts/flowPool";
import { registerFlowCommands, workflowRunArgs, type FlowDeps } from "./flowCommand";
import { checkoutLocation, directoryWorkspace, runSubjects, shippedPersonalRefusal, type DirectoryIO, type DirectoryRule } from "./directoryTeam";
import { matchDirectoryMapping } from "@codecast/shared/team/directoryRules";
import { changeFlowOf } from "./pipeline";
import { poolFlows } from "./workflow/flowPool.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./workflow/templates.js";
import { flowsLine } from "./stableContext";
import { writeTaskPulse } from "./taskPulse";
import { workspacePool } from "@codecast/shared/contracts/flowPool";

// Each run freezes a real checkout with git, several to a test: slow on a loaded machine.
setDefaultTimeout(60_000);

// The shipped personal template, or a stand-in of its shape until it is in the library: a whole line labelled Ship
// that takes a session's change.
const templates = BUILTIN_WORKFLOW_TEMPLATES as Record<string, string>;
let stubbed = false;
beforeAll(() => {
  if (templates[PERSONAL_FLOW_SLUG]) return;
  stubbed = true;
  templates[PERSONAL_FLOW_SLUG] = `digraph personal {
  graph [kind="line", label="Ship", takes="task,branch"]
  start [shape=Mdiamond]
  land [label="Land", shape=parallelogram, script="true"]
  exit [shape=Msquare, label="Live"]
  start -> land -> exit
}
`;
});
afterAll(() => { if (stubbed) delete templates[PERSONAL_FLOW_SLUG]; });

const tmp: string[] = [];
const mkdtemp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "personal-flow-"))); tmp.push(d); return d; };
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

const ownChange = `digraph change {
  graph [kind="line", label="Repo change", takes="task,branch"]
  start [shape=Mdiamond]
  review [label="Repo review", prompt="Read the change."]
  exit [shape=Msquare]
  start -> review -> exit
}
`;

/** A repo with a branch to run, and (with `own`) its own `.codecast/flows/change.cast`. */
function repo(own = false): string {
  const root = mkdtemp();
  git(root, "init", "-q", "-b", "main");
  // An origin that names a repository and that nothing reaches: the personal Ship needs one.
  git(root, "remote", "add", "origin", "https://git.invalid/jb/repo.git");
  if (own) {
    fs.mkdirSync(path.join(root, ".codecast", "flows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codecast", "flows", "change.cast"), ownChange);
  }
  fs.writeFileSync(path.join(root, "README.md"), "repo\n");
  git(root, "add", ".");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "first");
  git(root, "branch", "feature");
  return root;
}

/** What the server knows: the folder rules (`mappings`; undefined is a server from before them), what the calling
 *  session is stamped into (undefined: no session; "unread": the facts read failed, as on a server without the
 *  route), the repositories the person's teams know, whether they are in any team (default yes), and whether the
 *  listing read fails. */
type World = { mappings?: DirectoryRule[]; stamped?: string | null | "unread"; stamps?: Record<string, string | null>; teamRepos?: string[]; inTeam?: boolean; taskSession?: string; taskTeam?: string; taskUnreadable?: boolean; calling?: string; pulseAs?: string; boundTeam?: string; poolRows?: unknown[]; defaultFlow?: string; listingFails?: boolean; projects?: Array<{ path: string; team_id: string | null }> };

/** The resolver as `cast flow` runs it (index.ts), over a stub server, the real checkout read and the real matcher;
 *  the active team pointer names team "active". */
function io(cwd: string, w: World, location?: DirectoryIO["location"]): DirectoryIO {
  return {
    post: async (route, body) => {
      if (route === "/cli/teams/projects") {
        if (w.listingFails) throw new Error("network down");
        return { projects: w.projects ?? [], ...(w.mappings ? { mappings: w.mappings } : {}) };
      }
      if (route === "/cli/workflows/workspace-facts") {
        if (w.stamped === "unread") throw new Error("/cli/workflows/workspace-facts route not found");
        const workspace = !body.session ? null : body.session === "jx7abcd" ? w.stamped ?? null : w.stamps?.[String(body.session)] ?? null;
        return { workspace, team_repository: !!body.repository && (w.teamRepos ?? []).includes(String(body.repository)), in_team: w.inTeam ?? true };
      }
      throw new Error(`not asked: ${route}`);
    },
    session: w.stamped === undefined ? undefined : "jx7abcd",
    cwd,
    active: async () => ({ kind: "team", teamId: "active" }),
    location: location ?? (() => checkoutLocation(cwd)),
  };
}

/** A folder rule elsewhere, so the person has rules and none covers the temp repos. */
const ELSEWHERE: DirectoryRule[] = [{ path_prefix: "/nowhere/team-repo", team_id: "dir" }];
const PERSONAL: World = { mappings: ELSEWHERE };
// A rule on the folder every temp repo sits in, as the listing and the rules both carry it.
const TMP = fs.realpathSync(os.tmpdir());
const TEAM: World = { mappings: [{ path_prefix: TMP, team_id: "dir" }], projects: [{ path: TMP, team_id: "dir" }] };

/** Run `cast flow <args>` in `cwd` in `world`. Every pool read answers with no published flows. */
async function castFlow(cwd: string, args: string[], world: World) {
  const out: string[] = [];
  const err: string[] = [];
  const poolReads: Array<string | null> = [];
  const gated: Array<string | null> = [];
  const deps: FlowDeps = {
    cliPost: async (route, body) => {
      if (route === "/cli/workflows/pool") { poolReads.push(body.team_id ?? null); return { flows: world.poolRows ?? [], default_flow: world.defaultFlow ?? null }; }
      if (route === "/cli/flow/live/show") return [];
      if (route === "/cli/work/get") {
        if (world.taskUnreadable) throw new Error("network down");
        if (body.short_id === "ct-bound") return { short_id: "ct-bound", status: "in_progress", ...(world.boundTeam ? { team_id: world.boundTeam } : {}) };
        return { short_id: body.short_id, ...(world.taskTeam ? { team_id: world.taskTeam } : {}), change_session: world.taskSession ? { short_id: "jx7task", conversation_id: world.taskSession } : null };
      }
      throw new Error(`not asked: ${route}`);
    },
    callingSession: () => world.calling,
    subjectSession: async () => world.calling,
    pulseSession: () => world.pulseAs,
    realCwd: () => cwd,
    readWorkspace: async (team) => ({ kind: "team", teamId: team ?? "active" }),
    directoryWorkspace: (subjects) => directoryWorkspace({ ...io(cwd, world), subjects }),
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
  return { out: plain(out), err: plain(err), poolReads, gated, code };
}

describe("a directory established as personal, whatever team is active", () => {
  test("its pool and its Flows check are the personal workspace's, never the active team's", async () => {
    const r = await castFlow(repo(), ["run", "--branch", "feature", "--dry-run"], PERSONAL);
    expect(r.code).toBeNull();
    expect(r.poolReads).toEqual([null]);
    expect(r.gated).toEqual([null]);
  });

  test("in doubt (a session whose stamp cannot be read) it reads the active team's pool and runs change, as before", async () => {
    const r = await castFlow(repo(), ["run", "change", "--branch", "feature", "--dry-run"], { ...PERSONAL, stamped: "unread" });
    expect(r.poolReads).toEqual(["active"]);
    expect(r.err).not.toContain("personal Ship");
    expect(r.out).not.toMatch(/^Ship: Land/);
  });

  test("a session stamped personal runs personal; one stamped into a team only rules personal out, and reads as before", async () => {
    expect((await castFlow(repo(), ["run", "change", "--branch", "feature", "--dry-run"], { ...PERSONAL, stamped: "personal" })).err).toContain("change runs personal");
    const team = await castFlow(repo(), ["run", "change", "--branch", "feature", "--dry-run"], { ...PERSONAL, stamped: "team:t9" });
    expect(team.poolReads).toEqual(["active"]);
    expect(team.err).not.toContain("personal Ship");
  });

  test("a run of another session's change ships personal only when that session is stamped personal too", async () => {
    const run = (stamps: Record<string, string | null>) => castFlow(repo(), ["run", "change", "--session", "jx7other", "--dry-run"], { ...PERSONAL, stamps });
    expect((await run({ jx7other: "personal" })).poolReads).toEqual([null]);
    expect((await run({ jx7other: "team:T" })).poolReads).toEqual(["active"]);
    expect((await run({})).poolReads).toEqual(["active"]);
  });

  test("a run of a task's change ships personal only when the session its change came from is stamped personal", async () => {
    const run = (stamps: Record<string, string | null>) => castFlow(repo(), ["run", "change", "--task", "ct-9", "--dry-run"], { ...PERSONAL, stamps, taskSession: "jx7worker" });
    expect((await run({ jx7worker: "personal" })).poolReads).toEqual([null]);
    expect((await run({ jx7worker: "team:T" })).poolReads).toEqual(["active"]);
  });

  test("a session's own run bound to a team's task is not personal; bound to a personal task it is", async () => {
    const saved = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = mkdtemp();
    try {
      writeTaskPulse("agent-1", "ct-bound");
      const run = (w: Partial<World>) => castFlow(repo(), ["run", "change", "--dry-run"], { ...PERSONAL, stamped: "personal", calling: "agent-1", ...w });
      expect((await run({ boundTeam: "T" })).poolReads).toEqual(["active"]);
      expect((await run({})).poolReads).toEqual([null]);
    } finally {
      if (saved === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = saved;
    }
  });

  test("a session bound to a team's task is not personal whatever change it runs: a branch, too", async () => {
    const saved = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = mkdtemp();
    try {
      writeTaskPulse("agent-1", "ct-bound");
      const run = (w: Partial<World>) => castFlow(repo(), ["run", "change", "--branch", "feature", "--dry-run"], { ...PERSONAL, stamped: "personal", calling: "agent-1", ...w });
      expect((await run({ boundTeam: "T" })).poolReads).toEqual(["active"]);
      expect((await run({})).poolReads).toEqual([null]);
    } finally {
      if (saved === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = saved;
    }
  });

  test("a task pulse written under the agent's own session id is read too, not only the calling id", async () => {
    const saved = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = mkdtemp();
    try {
      writeTaskPulse("agent-uuid", "ct-bound");
      const run = (w: Partial<World>) => castFlow(repo(), ["run", "change", "--branch", "feature", "--dry-run"], { ...PERSONAL, stamped: "personal", calling: "codecast-id", pulseAs: "agent-uuid", ...w });
      expect((await run({ boundTeam: "T" })).poolReads).toEqual(["active"]);
      expect((await run({})).poolReads).toEqual([null]);
    } finally {
      if (saved === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = saved;
    }
  });

  test("a nameless --library run takes the library's change, never the personal Ship", async () => {
    const r = await castFlow(repo(), ["run", "--library", "--branch", "feature", "--dry-run"], PERSONAL);
    expect(r.code).toBeNull();
    expect(r.out).toMatch(/^Ship: PR\b/);
    expect(r.out).not.toContain("Find check");
  });

  test("--library runs the library's change by its name, never the personal Ship", async () => {
    const r = await castFlow(repo(), ["run", "change", "--library", "--branch", "feature", "--dry-run"], PERSONAL);
    expect(r.code).toBeNull();
    expect(r.err).not.toContain("personal Ship");
    expect(r.out).toMatch(/^Ship: PR\b/);
    expect(r.out).not.toContain("Find check");
    // Without --library the same name runs the personal Ship here.
    expect((await castFlow(repo(), ["run", "change", "--branch", "feature", "--dry-run"], PERSONAL)).out).toContain("Find check");
  });

  test("a run of a team's task, or of a task that cannot be read, is not personal", async () => {
    const run = (w: Partial<World>) => castFlow(repo(), ["run", "change", "--task", "ct-9", "--dry-run"], { ...PERSONAL, stamps: { jx7worker: "personal" }, taskSession: "jx7worker", ...w });
    expect((await run({ taskTeam: "T" })).poolReads).toEqual(["active"]);
    expect((await run({ taskUnreadable: true })).poolReads).toEqual(["active"]);
    // A personal task no session worked yet: the calling session's own stamp decides, as for any run.
    expect((await run({ taskSession: undefined })).poolReads).toEqual([null]);
  });

  test("--team still names a team's pool", async () => {
    const r = await castFlow(repo(), ["run", "--branch", "feature", "--dry-run", "--team", "active"], PERSONAL);
    expect(r.poolReads).toEqual(["active"]);
    expect(r.err).toContain("running change, the workspace's default");
  });
});

describe("in a personal workspace", () => {
  test("a nameless run runs personal, the default", async () => {
    const r = await castFlow(repo(), ["run", "--branch", "feature", "--dry-run"], PERSONAL);
    expect(r.err).toContain("No flow named: running personal, the workspace's default");
    expect(r.out).toMatch(/^Ship: /);
  });

  test("`cast flow run change` runs personal, and says so", async () => {
    const r = await castFlow(repo(), ["run", "change", "--branch", "feature", "--dry-run"], PERSONAL);
    expect(r.code).toBeNull();
    expect(r.err).toContain("change runs personal, the personal Ship");
    expect(r.out).toMatch(/^Ship: /);
  });

  test("a flow named by its file runs that file, with no word of a stand-in", async () => {
    const root = repo(true);
    const file = path.join(root, ".codecast", "flows", "change.cast");
    const r = await castFlow(root, ["run", file, "--branch", "feature", "--dry-run"], PERSONAL);
    expect(r.code).toBeNull();
    expect(r.err).not.toContain("No team shares this directory");
  });

  test("ls marks personal as the default and offers no second Ship", async () => {
    const json = JSON.parse((await castFlow(repo(), ["ls", "--json"], PERSONAL)).out);
    expect(json.default).toBe("personal");
    const slugs = json.library.map((f: { slug: string }) => f.slug);
    expect(slugs).toContain("personal");
    expect(slugs).not.toContain("change");
  });

  test("a repo's own change.cast still wins: named, nameless and in the pipeline", async () => {
    const root = repo(true);
    const named = await castFlow(root, ["run", "change", "--branch", "feature", "--dry-run"], PERSONAL);
    expect(named.out).toMatch(/^Repo change: Repo review\n/);
    expect(named.err).not.toContain("personal Ship");
    const nameless = await castFlow(root, ["run", "--branch", "feature", "--dry-run"], PERSONAL);
    expect(nameless.err).toContain("running change, the workspace's default");
    expect(nameless.out).toMatch(/^Repo change: /);
    expect(changeFlowOf(poolFlows(root, null, []), null, true)?.where).toBe("repo");
  });

  test("a checkout cut before the repo's own change.cast landed is refused, as origin/main refuses it, for the named and the nameless run", async () => {
    const origin = repo();
    fs.mkdirSync(path.join(origin, ".codecast", "flows"), { recursive: true });
    fs.writeFileSync(path.join(origin, ".codecast", "flows", "change.cast"), ownChange);
    git(origin, "add", ".");
    git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "the repo's own change");
    const clone = path.join(mkdtemp(), "clone");
    if (spawnSync("git", ["clone", "-q", origin, clone]).status !== 0) throw new Error("clone failed");
    git(clone, "reset", "-q", "--hard", "HEAD~1");
    git(clone, "branch", "feature");
    for (const args of [["run", "change"], ["run"]]) {
      const r = await castFlow(clone, [...args, "--branch", "feature", "--dry-run"], PERSONAL);
      expect(r.code).toBe(1);
      expect(r.err).toContain("predates the repo's own change flow");
      expect(r.out).toBe("");
    }
    expect((await castFlow(clone, ["show", "change"], PERSONAL)).err + (await castFlow(clone, ["show", "change"], PERSONAL)).out).toContain("predates the repo's own change flow");
    // --library skips the check for the library's own flows, never for the personal Ship.
    const named = await castFlow(clone, ["run", "personal", "--library", "--branch", "feature", "--dry-run"], PERSONAL);
    expect([named.code, named.err]).toEqual([1, expect.stringContaining("predates the repo's own change flow")]);
    const nameless = await castFlow(clone, ["run", "--library", "--branch", "feature", "--dry-run"], PERSONAL);
    expect(nameless.out).not.toContain("Find check");
  });

  test("with a repo's own change, the shipped personal Ship is not offered beside it", () => {
    const pool = workspacePool(poolFlows(repo(true), null, []), true);
    expect(pool.find((f) => f.slug === "change")?.where).toBe("repo");
    expect(pool.some((f) => f.slug === "personal")).toBe(false);
  });

  test("the pipeline's change flow is personal", () => {
    expect(changeFlowOf(poolFlows(repo(), null, []), null, true)?.slug).toBe("personal");
  });

  test("session start's <flows> line names the Ship as change and never says whether it ships personal: the run decides", async () => {
    const root = repo();
    const line = await flowsLine(root, [], null, true);
    expect(line).toContain("the default is change (Ship: `cast flow run change` decides when it runs how this checkout's change ships)");
    expect(line).not.toContain("personal");
    // The line a team checkout reads is the one it always read.
    expect(await flowsLine(root, [], null, false)).toBe(await flowsLine(root, [], null));
    expect(await flowsLine(root, [], null, false)).not.toContain("personal");
  });
});

describe("a team workspace is unchanged", () => {
  test("its default and `cast flow run change` stay the shipped change, and personal is not offered", async () => {
    const root = repo();
    const nameless = await castFlow(root, ["run", "--branch", "feature", "--dry-run"], TEAM);
    expect(nameless.poolReads).toEqual(["dir"]);
    expect(nameless.err).toContain("running change, the workspace's default");
    const named = await castFlow(root, ["run", "change", "--branch", "feature", "--dry-run"], TEAM);
    expect(named.err).not.toContain("personal Ship");
    const json = JSON.parse((await castFlow(root, ["ls", "--json"], TEAM)).out);
    expect(json.default).toBe("change");
    const slugs = json.library.map((f: { slug: string }) => f.slug);
    expect(slugs).toContain("change");
    expect(slugs).not.toContain("personal");
    expect(changeFlowOf(poolFlows(root, null, []), null, false)?.slug).toBe("change");
    expect(await flowsLine(root, [], null, false)).toContain("the default is change (");
  });
});

describe("a team's pool keeps what it had before the personal Ship", () => {
  const teamPersonal = {
    _id: "k57tp", slug: "personal", name: "personal", workspace: "team:dir", by: "Ana", mine: false, origin: null,
    source: `digraph personal {\n  graph [kind="line", label="Team personal", takes="task,branch"]\n  start [shape=Mdiamond]\n  review [label="Team review", prompt="Read it."]\n  exit [shape=Msquare]\n  start -> review -> exit\n}\n`,
    nodes: [{ id: "start" }, { id: "review", prompt: "Read it." }, { id: "exit" }],
  };

  test("the bare name personal is always the shipped personal Ship, whatever this machine's team-flow index holds", async () => {
    const { resolveFlowSource, parseWorkflowSource } = await import("./workflow/parser.js");
    const { resolveWorkflowSource } = await import("./workflow/templates.js");
    const { writeTeamFlowIndex } = await import("./workflow/teamFlowIndex.js");
    // An index entry for personal: a team's published copy (stale or not), as a team pool read can leave one.
    const stale = path.join(mkdtemp(), "personal.cast");
    fs.writeFileSync(stale, teamPersonal.source);
    writeTeamFlowIndex(new Map([["personal", stale]]));
    poolFlows(repo(), null, [teamPersonal]);
    expect(resolveWorkflowSource("personal", mkdtemp())?.label).toBe("builtin:personal");
    expect(resolveFlowSource("personal", mkdtemp())?.src).toBe(BUILTIN_WORKFLOW_TEMPLATES.personal);
    const variant = parseWorkflowSource(`digraph v {\n  graph [kind="line", extends="personal"]\n}\n`, mkdtemp());
    expect([...variant.nodes.values()].map((n) => n.label)).toContain("Find check");
    expect(variant.shipped).toContain("personal");
  });

  test("in a team checkout the shipped personal Ship is refused by name, --library too; a team's own personal runs by its file", async () => {
    for (const args of [["run", "personal"], ["run", "personal", "--library"]]) {
      const r = await castFlow(repo(), [...args, "--branch", "feature", "--dry-run"], TEAM);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/personal is the personal Ship, and this checkout is not established as personal|not found|No flow/i);
      expect(r.out).toBe("");
    }
    const refused = await castFlow(repo(), ["run", "personal", "--library", "--branch", "feature", "--dry-run"], TEAM);
    expect(refused.err).toContain("personal is the personal Ship, and this checkout is not established as personal");
    // A team's own flow named personal runs only by its file, and runs there when it is not the personal Ship's shape.
    const file = path.join(mkdtemp(), "personal.cast");
    fs.writeFileSync(file, teamPersonal.source);
    const own = await castFlow(repo(), ["run", file, "--branch", "feature", "--dry-run"], TEAM);
    expect(own.code).toBeNull();
    expect(own.out).toMatch(/^Team personal: Team review/);
  });

  // Every copy of the personal Ship, however it got here, is the personal Ship: refused in a team checkout, run in a personal one.
  const template = path.join(import.meta.dir, "workflow", "templates", "personal.cast");
  const copies: Array<[string, () => string]> = [
    ["the raw template file", () => template],
    ["a CRLF copy", () => { const f = path.join(mkdtemp(), "personal.cast"); fs.writeFileSync(f, fs.readFileSync(template, "utf-8").replace(/\n/g, "\r\n")); return f; }],
    ["a stale team-synced copy", () => path.join(import.meta.dir, "workflow", "__fixtures__", "stale-personal.cast")],
  ];
  for (const [what, fileOf] of copies) {
    test(`${what} is refused in a team checkout and runs in a personal one`, async () => {
      const file = fileOf();
      const team = await castFlow(repo(), ["run", file, "--branch", "feature", "--dry-run"], TEAM);
      expect([team.code, team.err]).toEqual([1, expect.stringContaining("not established as personal")]);
      const mine = await castFlow(repo(), ["run", file, "--branch", "feature", "--dry-run"], PERSONAL);
      expect(mine.code).toBeNull();
      expect(mine.out).toContain("Find check");
    });
  }

  test("a team-pool row named personal never stands in for the shipped one: not run in a team checkout, the shipped Ship in a personal one", async () => {
    const team = await castFlow(repo(), ["run", "personal", "--branch", "feature", "--dry-run"], { ...TEAM, poolRows: [teamPersonal] });
    expect(team.code).toBe(1);
    expect(team.out).toBe("");
    const mine = await castFlow(repo(), ["run", "personal", "--branch", "feature", "--dry-run"], { ...PERSONAL, poolRows: [teamPersonal] });
    expect(mine.code).toBeNull();
    expect(mine.out).toContain("Find check");
    expect(mine.out).not.toContain("Team review");
  });

  test("the run `cast flow run` starts for the shipped personal Ship is never refused in its own world", () => {
    expect(workflowRunArgs({ slug: "personal", file: null }, "ct-9", true)).toEqual(["workflow", "run", "personal", "--task", "ct-9", "--personal-established"]);
    expect(workflowRunArgs({ slug: "mine", file: "/r/.codecast/flows/mine.cast" }, "ct-9", true)).toEqual(["workflow", "run", "/r/.codecast/flows/mine.cast", "--task", "ct-9", "--personal-established"]);
    expect(workflowRunArgs({ slug: "change", file: null }, "ct-9", false)).toEqual(["workflow", "run", "change", "--task", "ct-9"]);
    // The real CLI, as that run starts it: an agent's env with no session id, a server it cannot reach, so nothing
    // could be told there. The marked run goes ahead; the same command typed without it is refused.
    const home = mkdtemp();
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({ auth_token: "x", convex_url: "http://127.0.0.1:9", web_url: "http://127.0.0.1:9", user_id: "u" }));
    const env = { PATH: process.env.PATH!, HOME: home, CODECAST_DIR: path.join(home, ".codecast"), CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" };
    const cli = path.join(import.meta.dir, "index.ts");
    const cast = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: repo(), env, encoding: "utf-8", timeout: 60_000 });
    const started = cast("workflow", "run", "personal", "--personal-established", "--dry-run");
    expect(started.stderr).not.toContain("not established as personal");
    // Past the check, the graph starts (a dry run stops where a station would have answered).
    expect(started.stdout).toContain("Workflow: personal");
    expect(started.stdout).toContain("Find check");
    const typed = cast("workflow", "run", "personal", "--dry-run");
    expect([typed.status, typed.stderr]).toEqual([1, expect.stringContaining("not established as personal")]);
    // A flow built on the personal Ship, typed by hand, is refused the same way; with the hand-off it starts.
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, "mine.cast"), `digraph mine {\n  graph [kind="line", extends="personal"]\n}\n`);
    const built = spawnSync(process.execPath, [cli, "workflow", "run", path.join(dir, "mine.cast"), "--dry-run"], { cwd: repo(), env, encoding: "utf-8", timeout: 60_000 });
    expect([built.status, built.stderr]).toEqual([1, expect.stringContaining("not established as personal")]);
    const handed = spawnSync(process.execPath, [cli, "workflow", "run", path.join(dir, "mine.cast"), "--personal-established", "--dry-run"], { cwd: repo(), env, encoding: "utf-8", timeout: 60_000 });
    expect(handed.stdout).toContain("Find check");
  });

  test("a run's subjects: a named team task, an unreadable one, and every open team task a pulse binds rule personal out", async () => {
    const saved = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = mkdtemp();
    try {
      const tasks: Record<string, any> = { "ct-mine": { status: "in_progress" }, "ct-team": { status: "in_progress", team_id: "T" }, "ct-done": { status: "done", team_id: "T" } };
      const post = async (_route: string, body: Record<string, unknown>) => {
        const t = tasks[String(body.short_id)];
        if (!t) throw new Error("not found");
        return { short_id: body.short_id, ...t };
      };
      await expect(runSubjects({ post, task: "ct-team", pulseIds: [] })()).rejects.toThrow("team's task");
      await expect(runSubjects({ post, task: "ct-gone", pulseIds: [] })()).rejects.toThrow();
      expect(await runSubjects({ post, task: "ct-mine", session: "jx7other", pulseIds: [] })()).toEqual(["jx7other"]);
      // The calling id is bound to a personal task, the agent id to a team's: both are read, not the first alone.
      writeTaskPulse("codecast-id", "ct-mine");
      writeTaskPulse("agent-uuid", "ct-team");
      await expect(runSubjects({ post, pulseIds: ["codecast-id", "agent-uuid"] })()).rejects.toThrow("ct-team");
      writeTaskPulse("agent-uuid", "ct-done");
      expect(await runSubjects({ post, pulseIds: ["codecast-id", "agent-uuid"] })()).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = saved;
    }
  });

  test("`cast workflow run personal` runs the shipped personal Ship only where personal is established", async () => {
    const at = (personal: boolean) => async () => ({ ws: { kind: personal ? "personal" : "team", teamId: "dir" } as any, ownsDefault: true, personal });
    expect(await shippedPersonalRefusal(true, at(false))).toContain("not established as personal");
    expect(await shippedPersonalRefusal(true, async () => { throw new Error("offline"); })).toContain("not established as personal");
    expect(await shippedPersonalRefusal(true, at(true))).toBeNull();
    // A flow that does not ship through the personal Ship is not this check's.
    expect(await shippedPersonalRefusal(false, at(false))).toBeNull();
  });

  test("a flow built on the personal Ship is the personal Ship: refused in a team checkout, from the repo or stdin's draft", async () => {
    const root = repo();
    fs.mkdirSync(path.join(root, ".codecast", "flows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codecast", "flows", "fast.cast"), `digraph fast {\n  graph [kind="line", label="Fast", takes="task,branch", extends="personal"]\n}\n`);
    const team = await castFlow(root, ["run", "fast", "--branch", "feature", "--dry-run"], TEAM);
    expect([team.code, team.err]).toEqual([1, expect.stringContaining("fast is built on the personal Ship, and this checkout is not established as personal")]);
    const mine = await castFlow(root, ["run", "fast", "--branch", "feature", "--dry-run"], PERSONAL);
    expect(mine.code).toBeNull();
    expect(mine.out).toContain("Find check");
  });

  test("reachesShippedFlow walks extends: the shipped personal at any depth, never a team's own personal or change", async () => {
    const { reachesShippedFlow } = await import("./workflow/parser.js");
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, "mid.cast"), `digraph mid {\n  graph [kind="line", extends="personal"]\n}\n`);
    expect(reachesShippedFlow(BUILTIN_WORKFLOW_TEMPLATES.personal, undefined, "personal")).toBe(true);
    expect(reachesShippedFlow(`digraph a { graph [extends="personal"] }`, dir, "personal")).toBe(true);
    expect(reachesShippedFlow(`digraph a { graph [extends="mid.cast"] }`, dir, "personal")).toBe(true);
    expect(reachesShippedFlow(`digraph a { graph [extends="change"] }`, dir, "personal")).toBe(false);
    // A repo's own personal.cast that extends "personal" names the shipped one beneath it.
    const repoDir = path.join(mkdtemp(), ".codecast", "flows");
    fs.mkdirSync(repoDir, { recursive: true });
    const own = `digraph personal {\n  graph [kind="line", extends="personal"]\n}\n`;
    fs.writeFileSync(path.join(repoDir, "personal.cast"), own);
    expect(reachesShippedFlow(own, repoDir, "personal")).toBe(true);
    // A team's own personal, run by its file, is not the shipped one; one that extends the name reaches it.
    expect(reachesShippedFlow(teamPersonal.source, mkdtemp(), "personal")).toBe(false);
    const { writeTeamFlowIndex } = await import("./workflow/teamFlowIndex.js");
    const indexed = path.join(mkdtemp(), "personal.cast");
    fs.writeFileSync(indexed, teamPersonal.source);
    writeTeamFlowIndex(new Map([["personal", indexed]]));
    expect(reachesShippedFlow(`digraph a { graph [extends="personal"] }`, mkdtemp(), "personal")).toBe(true);
  });

  test("a segment node running the personal Ship is the personal Ship: reached, and refused in a team checkout", async () => {
    const { reachesShippedFlow } = await import("./workflow/parser.js");
    const seg = `digraph seg {\n  graph [kind="line", label="Seg", takes="task,branch"]\n  start [shape=Mdiamond]\n  ship [flow="personal"]\n  exit [shape=Msquare]\n  start -> ship\n  ship -> exit\n}\n`;
    expect(reachesShippedFlow(seg, mkdtemp(), "personal")).toBe(true);
    expect(reachesShippedFlow(seg.replace('flow="personal"', 'flow="review"'), mkdtemp(), "personal")).toBe(false);
    const root = repo();
    fs.mkdirSync(path.join(root, ".codecast", "flows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codecast", "flows", "seg.cast"), seg);
    const team = await castFlow(root, ["run", "seg", "--branch", "feature", "--dry-run"], TEAM);
    expect([team.code, team.err]).toEqual([1, expect.stringContaining("seg is built on the personal Ship, and this checkout is not established as personal")]);
  });

  test("a nameless --library run in a team checkout whose default names personal runs change, as before", async () => {
    const r = await castFlow(repo(), ["run", "--library", "--branch", "feature", "--dry-run"], { ...TEAM, defaultFlow: "personal" });
    expect(r.code).toBeNull();
    expect(r.out).toMatch(/^Ship: PR\b/);
  });

  test("a team default naming personal never pulls the shipped personal Ship into a team's pipeline", () => {
    expect(changeFlowOf(poolFlows(repo(), null, []), "personal", false)?.slug).toBe("change");
  });

  test("a team's published flow named personal is not in its pool, and a default naming it falls back to change", () => {
    const pool = workspacePool(poolFlows(repo(), null, [teamPersonal]), false);
    expect(pool.some((f) => f.slug === "personal")).toBe(false);
    expect(changeFlowOf(poolFlows(repo(), null, [teamPersonal]), "personal", false)?.slug).toBe("change");
  });
});

describe("the workspace a directory resolves to (directoryWorkspace)", () => {
  const home = "/Users/jb/code";
  const rules: DirectoryRule[] = [
    // A rule stamped with no repository, as older rules are.
    { path_prefix: `${home}/codecast`, team_id: "codecast" },
    { path_prefix: `${home}/acme-app`, team_id: "acme", repository: "acme/acme-app" },
    { path_prefix: `${home}/acme-app/private-notes`, team_id: null, private: true },
    { path_prefix: `${home}/mono/teampart`, team_id: "mono-team" },
  ];
  const listing = [{ path: `${home}/codecast`, team_id: "codecast" }, { path: `${home}/acme-app`, team_id: "acme" }, { path: `${home}/mono/teampart`, team_id: "mono-team" }];
  const at = (root: string | null, repository: string | null = null) => async () => ({ root, repository });
  // Every checkout here has an origin unless a test says it has none.
  const resolve = (cwd: string, w: World, root: string | null, repository: string | null = "jb/elsewhere") =>
    directoryWorkspace(io(cwd, { projects: listing, ...w }, at(root, repository)));
  // "doubt:<workspace>" is the read as before: the active workspace standing in, owning no default, never personal.
  const kind = async (p: Promise<{ ws: { kind: string; teamId?: string }; ownsDefault: boolean; personal: boolean }>) => {
    const r = await p;
    const ws = r.ws.kind === "team" ? `team:${r.ws.teamId}` : r.ws.kind;
    return r.personal ? "personal" : r.ownsDefault ? ws : `doubt:${ws}`;
  };

  test("a team rule in another spelling of the same path or repository still rules personal out", async () => {
    const loose: DirectoryRule[] = [{ path_prefix: `${home}/Mono`, team_id: "mono-team", repository: "Acme/Mono" }];
    expect(await kind(resolve(`/tmp/elsewhere`, { mappings: loose }, "/tmp/elsewhere", "acme/mono"))).toBe("doubt:team:active");
    if (process.platform === "darwin") expect(await kind(resolve(`${home}/mono/x`, { mappings: loose }, `${home}/mono`))).toBe("doubt:team:active");
  });

  test("a folder no team rule touches is personal", async () => {
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: rules }, `${home}/tweet-only`, "jb/tweet-only"))).toBe("personal");
    expect(await kind(resolve(`${home}/codecast-old`, { mappings: rules }, `${home}/codecast-old`))).toBe("personal");
  });

  test("a worktree outside the mapped folder, under a rule with no repository, is not personal: its git_root is the main checkout", async () => {
    expect(await kind(resolve("/private/tmp/scratch/wt", { mappings: rules }, `${home}/codecast`))).toBe("doubt:team:active");
  });

  test("a lock on a subfolder of a team's repository is not personal", async () => {
    expect(await kind(resolve(`${home}/acme-app/private-notes/x`, { mappings: rules }, `${home}/acme-app`))).toBe("team:acme");
  });

  test("a team share on a subfolder of an unmapped repository is not personal, from the subfolder or the root", async () => {
    expect(await kind(resolve(`${home}/mono/teampart`, { mappings: rules }, `${home}/mono`, "jb/mono"))).toBe("team:mono-team");
    expect(await kind(resolve(`${home}/mono`, { mappings: rules }, `${home}/mono`, "jb/mono"))).toBe("doubt:team:active");
    expect(await kind(resolve(`${home}/mono/teampart`, { mappings: rules, stamped: "personal" }, `${home}/mono`, "jb/mono"))).toBe("team:mono-team");
  });

  test("a second clone of a team's repository, locked or not, is not personal when the team rule names the repository", async () => {
    const locked = [...rules, { path_prefix: "/tmp/um2", team_id: null, private: true, repository: "acme/acme-app" }];
    expect(await kind(resolve("/tmp/um2", { mappings: locked }, "/tmp/um2", "acme/acme-app"))).toBe("doubt:team:active");
    expect(await kind(resolve("/tmp/um3", { mappings: rules }, "/tmp/um3", "acme/acme-app"))).toBe("doubt:team:active");
  });

  test("a second clone outside every rule's folder, under a team rule that names no repository, reads personal when no team knows the repository, as the server stamps it", async () => {
    expect(await kind(resolve("/tmp/cc2", { mappings: rules }, "/tmp/cc2", "acme/codecast"))).toBe("personal");
    // The server's own rule (privacy.ts resolveTeamForPath) finds no rule for it either.
    expect(matchDirectoryMapping(rules, "/tmp/cc2", "acme/codecast")).toBeNull();
  });

  test("that second clone is not personal when a team the person is in already knows its repository", async () => {
    expect(await kind(resolve("/tmp/cc2", { mappings: rules, teamRepos: ["acme/codecast"] }, "/tmp/cc2", "acme/codecast"))).toBe("doubt:team:active");
    // Without a session, and with one stamped personal: the team's knowledge still rules personal out.
    expect(await kind(resolve("/tmp/cc2", { mappings: rules, teamRepos: ["acme/codecast"], stamped: "personal" }, "/tmp/cc2", "acme/codecast"))).toBe("doubt:team:active");
    // A repository no team knows stays personal.
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: rules, teamRepos: ["acme/codecast"] }, `${home}/tweet-only`, "jb/tweet-only"))).toBe("personal");
  });

  test("inside a session with no stamp yet (not synced, or a worker that will take its parent's team) it is not personal", async () => {
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: rules, stamped: null }, `${home}/tweet-only`, "jb/tweet-only"))).toBe("doubt:team:active");
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: [], inTeam: false, stamped: null }, `${home}/tweet-only`))).toBe("doubt:team:active");
  });

  test("an agent that runs this with no session id resolved is not personal: its stamp cannot be known", async () => {
    expect(await kind(directoryWorkspace({ ...io(`${home}/tweet-only`, { projects: listing, mappings: rules }, at(`${home}/tweet-only`, "jb/tweet-only")), sessionUnknown: true }))).toBe("doubt:team:active");
  });

  test("a checkout with no origin, or whose git read fails, is never personal", async () => {
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: rules }, `${home}/tweet-only`, null))).toBe("doubt:team:active");
    const failing = directoryWorkspace({ ...io(`${home}/tweet-only`, { projects: listing, mappings: rules }), location: async () => { throw new Error("git timed out"); } });
    expect(await kind(failing)).toBe("doubt:team:active");
    await expect(checkoutLocation(mkdtemp())).rejects.toThrow("git could not read the checkout");
  });

  test("a server without the facts route never establishes personal", async () => {
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: rules, stamped: "unread" }, `${home}/tweet-only`, "jb/tweet-only"))).toBe("doubt:team:active");
  });

  test("a person with no rules who is in a team is not personal: the daemon stamps the active team", async () => {
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: [] }, `${home}/tweet-only`))).toBe("doubt:team:active");
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: [], inTeam: true, stamped: "personal" }, `${home}/tweet-only`))).toBe("doubt:team:active");
  });

  test("a person in no team with no rules is personal, unless the facts cannot be read or the session is a team's", async () => {
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: [], inTeam: false }, `${home}/tweet-only`))).toBe("personal");
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: [], inTeam: false, stamped: "personal" }, `${home}/tweet-only`))).toBe("personal");
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: [], inTeam: false, stamped: "unread" }, `${home}/tweet-only`))).toBe("doubt:team:active");
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: [], inTeam: false, stamped: "team:X" }, `${home}/tweet-only`))).toBe("doubt:team:active");
  });

  test("a listing read that fails stops the read; an older server without rules reads as before", async () => {
    await expect(resolve(`${home}/tweet-only`, { listingFails: true }, `${home}/tweet-only`)).rejects.toThrow("network down");
    expect(await kind(resolve(`${home}/tweet-only`, {}, `${home}/tweet-only`))).toBe("doubt:team:active");
    expect(await kind(resolve(`${home}/acme-app/wt`, {}, `${home}/acme-app`))).toBe("team:acme");
  });

  test("a session stamped personal in a personal folder is personal; a stamp that cannot be read is not", async () => {
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: rules, stamped: "personal" }, `${home}/tweet-only`))).toBe("personal");
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: rules, stamped: "unread" }, `${home}/tweet-only`))).toBe("doubt:team:active");
  });

  test("a team stamp never picks the team: stamped X in a folder ruled Y reads Y, in an unmapped folder the active team, as before", async () => {
    expect(await kind(resolve(`${home}/codecast`, { mappings: rules, stamped: "team:X" }, `${home}/codecast`))).toBe("team:codecast");
    expect(await kind(resolve(`${home}/tweet-only`, { mappings: rules, stamped: "team:X" }, `${home}/tweet-only`))).toBe("doubt:team:active");
  });

  test("the checkout read names the main checkout of a worktree, as the daemon does", async () => {
    const root = repo();
    const wt = path.join(mkdtemp(), "wt");
    git(root, "worktree", "add", "-q", wt, "feature");
    expect((await checkoutLocation(wt)).root).toBe(root);
  });
});
