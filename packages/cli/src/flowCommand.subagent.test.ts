// ct-101911: `cast flow run` from a Task-tool subagent adopts no session from the
// process tree. The subagent runs with its parent's session id, so callingSession
// names the parent; subjectSession (subagentCaller.ts) names none, and the run
// takes the parent's edits only when they are named with --session. --no-subject
// says outright that no session is the run's subject.
import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerFlowCommands, spawnerArgs, type FlowDeps } from "./flowCommand";

const PARENT = "00000000-0000-4000-8000-000000000002";
const tmp: string[] = [];
const savedCache = process.env.CODECAST_FLOWS_CACHE;
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (savedCache === undefined) delete process.env.CODECAST_FLOWS_CACHE;
  else process.env.CODECAST_FLOWS_CACHE = savedCache;
});
const mkdtemp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-subagent-"))); tmp.push(d); return d; };
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf-8" });

/** A repo whose own flow "ship-now" takes a task or a branch. */
function repo(): string {
  const root = mkdtemp();
  git(root, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(root, ".codecast", "flows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codecast", "flows", "ship-now.cast"), `digraph ship_now {
  graph [kind="line", label="Ship now", takes="task,branch"]
  start [shape=Mdiamond]
  review [label="Review", prompt="Read the change."]
  exit [shape=Msquare]
  start -> review -> exit
}
`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "first");
  return root;
}

/** `cast flow run ship-now <args>` inside a session's tree: `subagent` says a subagent of that session ran it. */
async function run(args: string[], subagent: boolean) {
  process.env.CODECAST_FLOWS_CACHE = mkdtemp();
  const cwd = repo();
  const err: string[] = [];
  const deps: FlowDeps = {
    cliPost: async (route) => {
      if (route === "/cli/workflows/pool") return { flows: [], default_flow: null };
      if (route === "/cli/flow/live/show") return [];
      throw new Error(`not asked: ${route}`);
    },
    callingSession: () => PARENT,
    subjectSession: async () => (subagent ? false : PARENT),
    realCwd: () => cwd,
    readWorkspace: async () => ({ kind: "personal" }),
    directoryTeam: async () => null,
    writeWorkspace: async () => ({ kind: "personal" }),
    requireFlows: async () => {},
  };
  const program = new Command().exitOverride();
  registerFlowCommands(program, deps);
  const [log, error, exit] = [console.log, console.error, process.exit];
  console.log = () => {};
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  let code = null as number | null;
  process.exit = ((c?: number) => { code = c ?? 0; throw new Error("exit"); }) as typeof process.exit;
  try {
    await program.parseAsync(["node", "cast", "flow", "run", "ship-now", ...args, "--dry-run"]).catch((e: Error) => { if (code === null) throw e; });
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
  return { err: err.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), code };
}

describe("cast flow run from a subagent", () => {
  test("a task named alone takes no session's edits: the parent's are not adopted", async () => {
    const r = await run(["--task", "ct-7"], true);
    expect(r.code).toBe(1);
    expect(r.err).toContain("ct-7 has no branch here yet; a subagent's run takes no session's edits, so name the change with --branch or --pr");
    expect(r.err).not.toContain(PARENT);
  });

  test("from the session's own agent, a task named alone still takes that session's edits", async () => {
    const r = await run(["--task", "ct-7"], false);
    expect(r.err).not.toContain("has no branch here yet");
    expect(r.err).toContain(PARENT);
  });

  test("with nothing named, a subagent is told to name the change rather than ship its parent's edits", async () => {
    const r = await run([], true);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Name the change: a subagent's run takes no session's edits, so name a branch with --branch or --pr");
  });

  test("--session names the session outright, from a subagent too", async () => {
    const r = await run(["--session", PARENT], true);
    expect(r.err).not.toContain("Name the change");
    expect(r.err).toContain(PARENT);
  });

  test("--no-subject takes no session, even from the session's own agent", async () => {
    const r = await run(["--task", "ct-7", "--no-subject"], false);
    expect(r.code).toBe(1);
    expect(r.err).toContain("ct-7 has no branch here yet; a --no-subject run takes no session's edits");
  });

  test("--no-subject with a session's own edits is refused", async () => {
    const r = await run(["--session", PARENT, "--no-subject"], false);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--no-subject runs a named change with no session");
  });
});

describe("spawnerArgs: what the run's own process is told", () => {
  test("a subagent's run names no spawner, or the session named with --session, never the parent", () => {
    expect(spawnerArgs(false, undefined)).toEqual(["--no-subject"]);
    expect(spawnerArgs(false, true)).toEqual(["--no-subject"]);
    expect(spawnerArgs(false, PARENT)).toEqual(["--spawner", PARENT]);
  });

  test("a session's own run, and a plain shell's, leave the run to find its spawner as before", () => {
    expect(spawnerArgs(PARENT, undefined)).toEqual([]);
    expect(spawnerArgs(undefined, undefined)).toEqual([]);
  });
});
