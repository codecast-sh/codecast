import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  awaitRun,
  follow,
  ignoredPathsIn,
  localTransport,
  matchJob,
  pickHost,
  planRun,
  readRecord,
  runnerCommand,
  runnerProgram,
  submitRun,
  type Out,
  type Transport,
} from "./client.js";
import { parseRunArgs, parseVerbArgs, shieldCommandArgv } from "./cli.js";
import type { HostInfoWire, RunStateWire } from "./hostRunner.js";
import { pollUntil } from "../test-helpers/pollUntil.js";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

let root: string;
let laptop: string;
let host: string;
let t: Transport;

function capture(): Out & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return { out: (b) => { out += b.toString(); }, err: (b) => { err += b.toString(); }, stdout: () => out, stderr: () => err };
}

const runnerJson = <T>(args: string[], input?: string): T => {
  const r = input === undefined ? t.run(runnerCommand(args), { input: runnerProgram().text, timeoutMs: 30_000 }) : t.run(runnerCommand(args, { install: false }), { input, timeoutMs: 30_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.toString().trim().split("\n").pop()!) as T;
};

async function start(argv: string[], env: Record<string, string> = {}) {
  const plan = planRun(laptop, argv);
  const rec = await submitRun({ plan, transport: t, host: { id: "local", address: "localhost", user: "", keyPath: "", local: host }, hostRepo: path.join(host, "src", "demo"), env, quiet: true, io: capture() });
  return rec;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-run-"));
  laptop = path.join(root, "laptop");
  host = path.join(root, "host");
  fs.mkdirSync(laptop, { recursive: true });
  fs.mkdirSync(path.join(host, "src"), { recursive: true });
  process.env.CAST_RUN_LOCAL_DIR = path.join(root, "records");
  git(laptop, "init", "-q", ".");
  git(laptop, "config", "user.email", "t@t");
  git(laptop, "config", "user.name", "t");
  fs.writeFileSync(path.join(laptop, "bun.lock"), "lock v1\n");
  fs.mkdirSync(path.join(laptop, ".codecast"));
  fs.writeFileSync(path.join(laptop, ".codecast", "workspace.toml"), `[setup]
install = ["mkdir -p node_modules/dep && echo installed > node_modules/dep/marker"]

[run]
deps_key = ["bun.lock"]

[[run.jobs]]
name = "gen"
argv = ["bash", "gen.sh"]
outputs = ["out/**", "gen.txt"]
`);
  fs.writeFileSync(path.join(laptop, "gen.sh"), 'cat src.txt; echo err-line >&2; cat node_modules/dep/marker; mkdir -p out; echo artifact > out/a.txt; sleep "${SLEEP:-0}"; echo from-host > gen.txt; exit "${CODE:-0}"\n');
  fs.writeFileSync(path.join(laptop, "src.txt"), "committed\n");
  fs.writeFileSync(path.join(laptop, "gen.txt"), "original\n");
  fs.writeFileSync(path.join(laptop, ".gitignore"), "out/\nnode_modules/\n.env\n");
  git(laptop, "add", "-A");
  git(laptop, "commit", "-qm", "init");
  git(root, "clone", "-q", laptop, path.join(host, "src", "demo"));
  t = localTransport(host);
});

afterAll(() => {
  delete process.env.CAST_RUN_LOCAL_DIR;
  // Where sudo needs no password (CI), slots get the golden's node_modules as
  // overlayfs mounts, and their root-owned work dirs refuse an rm until the
  // mounts are gone; a hardlinked golden is sealed read-only. Release both.
  if (process.platform === "linux") {
    const mounts = fs.readFileSync("/proc/self/mounts", "utf-8").split("\n").map((l) => l.split(" ")[1]).filter((m) => m?.startsWith(root));
    for (const m of mounts.reverse()) spawnSync("sudo", ["-n", "umount", "-l", m]);
    spawnSync("sudo", ["-n", "rm", "-rf", root]);
  }
  spawnSync("chmod", ["-R", "u+w", root]);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cast run over a local stand-in host", () => {
  test("uncommitted work travels, both streams come back, outputs land, the command's code is the exit code", async () => {
    fs.writeFileSync(path.join(laptop, "src.txt"), "uncommitted\n");
    const rec = await start(["bash", "gen.sh"], { CODE: "3" });
    const io = capture();
    const code = await awaitRun(t, rec, io, { quiet: true });
    expect(code).toBe(3);
    expect(io.stdout()).toBe("uncommitted\ninstalled\n");
    expect(io.stderr()).toBe("err-line\n");
    expect(fs.readFileSync(path.join(laptop, "out", "a.txt"), "utf-8")).toBe("artifact\n");
    expect(fs.readFileSync(path.join(laptop, "gen.txt"), "utf-8")).toBe("from-host\n");
    const saved = readRecord(rec.id)!;
    expect(saved.code).toBe(3);
    expect(saved.outputsApplied).toBe(true);
    for (const k of ["snapshotMs", "pushMs", "submitMs"]) expect(typeof saved.timings[k]).toBe("number");
    const state = runnerJson<RunStateWire>(["status", rec.id]);
    expect(state.deps).toMatchObject({ warm: false });
    expect(state.timings.runMs).toBeGreaterThanOrEqual(0);
    git(laptop, "checkout", "-q", "--", "gen.txt", "src.txt");
  }, 60_000);

  test("a second run reuses the warm dependency tree, and notes print unless quiet", async () => {
    const rec = await start(["bash", "gen.sh"]);
    const io = capture();
    expect(await awaitRun(t, rec, io)).toBe(0);
    expect(io.stderr()).toContain("deps warm");
    expect(runnerJson<RunStateWire>(["status", rec.id]).deps).toMatchObject({ warm: true });
    git(laptop, "checkout", "-q", "--", "gen.txt");
  }, 60_000);

  test("a tracked output edited here during the run is never overwritten: it is diverted and the run exits 75", async () => {
    const rec = await start(["bash", "gen.sh"], { SLEEP: "2" });
    const io = capture();
    const waiting = awaitRun(t, rec, io, { quiet: true });
    fs.writeFileSync(path.join(laptop, "gen.txt"), "edited here\n");
    expect(await waiting).toBe(75);
    expect(io.stderr()).toContain("1 output file changed here during the run and was not overwritten (gen.txt)");
    expect(fs.readFileSync(path.join(laptop, "gen.txt"), "utf-8")).toBe("edited here\n");
    const diverted = path.join(process.env.CAST_RUN_LOCAL_DIR!, rec.id, "outputs", "gen.txt");
    expect(fs.readFileSync(diverted, "utf-8")).toBe("from-host\n");
    git(laptop, "checkout", "-q", "--", "gen.txt");
  }, 60_000);

  test("submit is idempotent by run id, and a cancel that beats its submit is honoured", async () => {
    const rec = await start(["bash", "gen.sh"]);
    const spec = JSON.parse(fs.readFileSync(path.join(host, ".codecast", "run", "runs", rec.id, "spec.json"), "utf-8"));
    const again = runnerJson<{ accepted: boolean; duplicate?: boolean }>(["submit"], JSON.stringify(spec));
    expect(again).toMatchObject({ accepted: true, duplicate: true });
    await awaitRun(t, rec, capture(), { quiet: true });
    git(laptop, "checkout", "-q", "--", "gen.txt");

    runnerJson(["cancel", "rbeforesubmit1"]);
    const late = runnerJson<{ accepted: boolean; error?: string }>(["submit"], JSON.stringify({ ...spec, id: "rbeforesubmit1" }));
    expect(late).toEqual({ accepted: false, error: "cancelled before it started" });
  }, 60_000);

  test("cancel stops a running command and the run ends 130", async () => {
    const rec = await start(["bash", "-c", "echo started; sleep 30"]);
    await pollUntil(() => runnerJson<RunStateWire>(["status", rec.id]).phase === "running", "the run starts", { ms: 20_000, every: 200 });
    runnerJson(["cancel", rec.id]);
    expect(await awaitRun(t, rec, capture(), { quiet: true })).toBe(130);
  }, 60_000);

  test("following again resumes at the byte offsets already printed", async () => {
    const rec = await start(["bash", "-c", "printf 'aaa\\nbbb\\n'; printf 'eee\\n' >&2"]);
    await awaitRun(t, rec, capture(), { quiet: true });
    const io = capture();
    const end = await follow(t, rec.id, io, { offsets: [4, 2], quiet: true, signals: false });
    expect(end.kind).toBe("done");
    expect(io.stdout()).toBe("bbb\n");
    expect(io.stderr()).toBe("e\n");
  }, 60_000);

  test("a runner that dies mid-run is reported lost (70), never left hanging", async () => {
    const rec = await start(["bash", "-c", "sleep 30"]);
    await pollUntil(() => runnerJson<RunStateWire>(["status", rec.id]).phase === "running", "the run starts", { ms: 20_000, every: 200 });
    const state = runnerJson<RunStateWire>(["status", rec.id]);
    process.kill(state.pid!, "SIGKILL");
    process.kill(-state.cmdPid!, "SIGKILL");
    const io = capture();
    expect(await awaitRun(t, rec, io, { quiet: true })).toBe(70);
    expect(io.stderr()).toContain("cast: hint: the host runner stopped");
  }, 60_000);

  test("a command that exits while a child it leaked holds the pipes still finishes with its own code", async () => {
    const rec = await start(["bash", "-c", "sleep 60 & echo leaked; exit 0"]);
    const t0 = Date.now();
    const io = capture();
    expect(await awaitRun(t, rec, io, { quiet: true })).toBe(0);
    expect(io.stdout()).toBe("leaked\n");
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 60_000);

  test("a cancelled run brings no outputs back", async () => {
    const rec = await start(["bash", "gen.sh"], { SLEEP: "30" });
    await pollUntil(() => runnerJson<RunStateWire>(["status", rec.id]).phase === "running", "the run starts", { ms: 20_000, every: 200 });
    runnerJson(["cancel", rec.id]);
    expect(await awaitRun(t, rec, capture(), { quiet: true })).toBe(130);
    expect(runnerJson<RunStateWire>(["status", rec.id]).outputs).toEqual({ files: 0, bytes: 0 });
  }, 60_000);

  test("the shipped runner reads the platform at run time (bun --compile bakes process.platform into source)", () => {
    expect(runnerProgram().text).not.toMatch(/process\.(platform|arch)\b/);
  });

  test("the runner a compiled, minified CLI ships still runs on its own", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-run-compiled-"));
    try {
      fs.writeFileSync(path.join(dir, "probe.ts"), `import { hostRunnerSource } from ${JSON.stringify(path.join(import.meta.dir, "hostRunner.ts"))};\nprocess.stdout.write(hostRunnerSource());\n`);
      const built = spawnSync("bun", ["build", "--compile", "--minify", path.join(dir, "probe.ts"), "--outfile", path.join(dir, "probe")], { encoding: "utf-8" });
      expect(built.status).toBe(0);
      const source = spawnSync(path.join(dir, "probe"), [], { encoding: "utf-8" }).stdout;
      expect(source).not.toMatch(/process\.(platform|arch)\b/);
      fs.writeFileSync(path.join(dir, "runner.js"), source);
      const info = spawnSync("bun", [path.join(dir, "runner.js"), "info"], { encoding: "utf-8", env: { ...process.env, CAST_RUN_ROOT: path.join(dir, "root") } });
      expect(info.status).toBe(0);
      expect(JSON.parse(info.stdout).cpus).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a runner cut off on the way is refused and never saved; the whole one installs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-run-home-"));
    try {
      const fresh = localTransport(home);
      const cut = fresh.run(runnerCommand(["info"]), { input: runnerProgram().text.slice(0, 2000), timeoutMs: 30_000 });
      expect(cut.status).toBe(71);
      expect(cut.stderr).toContain("the runner arrived incomplete");
      expect(fs.readdirSync(path.join(home, ".codecast", "run", "bin"))).toEqual([]);
      const whole = fresh.run(runnerCommand(["info"]), { input: runnerProgram().text, timeoutMs: 30_000 });
      expect(whole.status).toBe(0);
      expect(JSON.parse(whole.stdout.toString()).cpus).toBeGreaterThan(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a submit whose first attempt died before writing state is taken as new, not reported accepted", async () => {
    const rec = await start(["true"]);
    await awaitRun(t, rec, capture(), { quiet: true });
    const spec = JSON.parse(fs.readFileSync(path.join(host, ".codecast", "run", "runs", rec.id, "spec.json"), "utf-8"));
    const id = "rdiedmidsubmit1";
    fs.mkdirSync(path.join(host, ".codecast", "run", "runs", id));
    const answer = runnerJson<{ accepted: boolean; duplicate?: boolean; state?: RunStateWire }>(["submit"], JSON.stringify({ ...spec, id, argv: ["true"] }));
    expect(answer.accepted).toBe(true);
    expect(answer.duplicate).toBeUndefined();
    expect(answer.state?.phase).toBeDefined();
  }, 60_000);

  test("a host whose shell prints at startup is reported, not silently swallowed", async () => {
    const rec = await start(["bash", "-c", "echo real-output"]);
    const noisy: Transport = { ...t, stream: (command) => t.stream(`echo "Welcome to the host"; ${command}`) };
    const io = capture();
    expect(await awaitRun(noisy, rec, io, { quiet: true })).toBe(70);
    expect(io.stderr()).toContain("is not the runner's");
    expect(await awaitRun(t, rec, capture(), { quiet: true })).toBe(0);
  }, 60_000);

  test("only declared outputs land here, whatever the host's tarball holds", async () => {
    const rec = await start(["bash", "gen.sh"]);
    await pollUntil(() => runnerJson<RunStateWire>(["status", rec.id]).phase === "done", "the run finishes", { ms: 20_000, every: 200 });
    const runDir = path.join(host, ".codecast", "run", "runs", rec.id);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-run-tamper-"));
    spawnSync("tar", ["-xzf", path.join(runDir, "outputs.tgz"), "-C", stage]);
    fs.writeFileSync(path.join(stage, "src.txt"), "rewritten by the host\n");
    spawnSync("tar", ["-czf", path.join(runDir, "outputs.tgz"), "-C", stage, "."]);
    fs.rmSync(stage, { recursive: true, force: true });
    const io = capture();
    expect(await awaitRun(t, rec, io, { quiet: true })).toBe(70);
    expect(fs.readFileSync(path.join(laptop, "src.txt"), "utf-8")).toBe("committed\n");
    expect(fs.readFileSync(path.join(laptop, "out", "a.txt"), "utf-8")).toBe("artifact\n");
    expect(io.stderr()).toContain("src.txt (not a declared output)");
    git(laptop, "checkout", "-q", "--", "gen.txt");
  }, 60_000);

  test("a failure on a file git ignores names it", async () => {
    fs.writeFileSync(path.join(laptop, ".env"), "A=1\n");
    const rec = await start(["bash", "-c", "source .env"]);
    const io = capture();
    expect(await awaitRun(t, rec, io, { quiet: true })).toBe(1);
    expect(io.stderr()).toContain("cast: hint: .env exists here but git ignores it");
    fs.rmSync(path.join(laptop, ".env"));
  }, 60_000);
});

describe("pure pieces", () => {
  const job = (argv: string[]) => ({ name: argv.join(" "), argv, outputs: [] });

  test("cast check needs no manifest entry: its watchers stay up between runs", () => {
    expect(planRun(laptop, ["cast", "check", "cli"]).job).toMatchObject({ name: "cast check", keepDaemons: true, memoryGb: 8 });
  });

  test("the longest matching argv prefix wins", () => {
    const jobs = [job(["bun"]), job(["bun", "test"]), job(["cast", "check"])];
    expect(matchJob(jobs, ["bun", "test", "x.test.ts"])?.name).toBe("bun test");
    expect(matchJob(jobs, ["bun", "run", "x"])?.name).toBe("bun");
    expect(matchJob(jobs, ["cast"])).toBeUndefined();
  });

  test("our flags stop at -- or the first word; the command keeps its own", () => {
    const isHost = (w: string) => w === "i-1";
    expect(parseRunArgs(["--host", "i-1", "--max-wait", "5", "--", "bun", "test", "--bail"], isHost)).toEqual({ flags: { env: {}, host: "i-1", maxWaitS: 5 }, rest: ["bun", "test", "--bail"], consumed: 5 });
    expect(parseRunArgs(["--host", "--", "x"], isHost).flags.host).toBe(true);
    expect(parseRunArgs(["--host", "bun", "test"], isHost)).toEqual({ flags: { env: {}, host: true }, rest: ["bun", "test"], consumed: 1 });
    expect(() => parseRunArgs(["--host", "typo-host", "--", "bun", "test"], isHost)).toThrow("no cloud host typo-host is registered");
    expect(parseRunArgs(["--max-wait=5", "bun", "test", "--timeout=5000"], isHost)).toEqual({ flags: { env: {}, maxWaitS: 5 }, rest: ["bun", "test", "--timeout=5000"], consumed: 1 });
    expect(parseRunArgs(["--host=i-1", "--max-wait=5", "bun"], isHost).flags).toEqual({ env: {}, host: "i-1", maxWaitS: 5 });
    expect(() => parseRunArgs(["--env", "HOME", "x"])).toThrow("the host keeps its own");
    expect(parseRunArgs(["bun", "test", "--host"]).rest).toEqual(["bun", "test", "--host"]);
    process.env.CAST_RUN_TEST_VAR = "here";
    expect(parseRunArgs(["--env", "A=b=c", "--env", "CAST_RUN_TEST_VAR", "--", "x"]).flags.env).toEqual({ A: "b=c", CAST_RUN_TEST_VAR: "here" });
    expect(() => parseRunArgs(["--bail", "x"])).toThrow("unknown option --bail");
  });

  test("the command's own flags are shielded from cast's (node --version runs node)", () => {
    const argv = ["bun", "cast", "run", "-q", "node", "--version"];
    shieldCommandArgv(argv);
    expect(argv).toEqual(["bun", "cast", "run", "-q", "--", "node", "--version"]);
    const verb = ["bun", "cast", "run", "show", "rabc123", "--json"];
    shieldCommandArgv(verb);
    expect(verb).toEqual(["bun", "cast", "run", "show", "rabc123", "--json"]);
    const eqFlags = ["bun", "cast", "run", "--max-wait=5", "bun", "test", "--bail=1"];
    shieldCommandArgv(eqFlags);
    expect(eqFlags).toEqual(["bun", "cast", "run", "--max-wait=5", "--", "bun", "test", "--bail=1"]);
    const cmdEq = ["bun", "cast", "run", "bun", "test", "--timeout=5000"];
    shieldCommandArgv(cmdEq);
    expect(cmdEq).toEqual(["bun", "cast", "run", "--", "bun", "test", "--timeout=5000"]);
    const inner = ["bun", "cast", "run", "git", "log", "-h", "--", "path"];
    shieldCommandArgv(inner);
    expect(inner).toEqual(["bun", "cast", "run", "--", "git", "log", "-h", "--", "path"]);
    const already = ["bun", "cast", "run", "--", "x", "--version"];
    shieldCommandArgv(already);
    expect(already).toEqual(["bun", "cast", "run", "--", "x", "--version"]);
  });

  test("a verb's flags work before or after the run id", () => {
    expect(parseVerbArgs(["rabc123", "--json"])).toEqual({ flags: { env: {}, json: true }, rest: ["rabc123"] });
    expect(parseVerbArgs(["--max-wait", "60", "rabc123"])).toEqual({ flags: { env: {}, maxWaitS: 60 }, rest: ["rabc123"] });
    expect(parseVerbArgs(["rabc123", "--max-wait", "60"]).flags.maxWaitS).toBe(60);
  });

  test("hosts: the last one used keeps the run while it has room; otherwise least load per core", () => {
    const info = (o: Partial<HostInfoWire>): HostInfoWire => ({ host: "h", cpus: 16, memAvailGb: 50, memTotalGb: 60, load1: 1, active: 0, queued: 0, slots: 8, ...o });
    const a = { host: { id: "a" }, info: info({ load1: 8 }) };
    const b = { host: { id: "b" }, info: info({ load1: 1 }) };
    const full = { host: { id: "c" }, info: info({ memAvailGb: 2 }) };
    expect(pickHost([a, b], 4)?.host.id).toBe("b");
    expect(pickHost([a, b], 4, "a")?.host.id).toBe("a");
    expect(pickHost([{ ...a, info: info({ load1: 40 }) }, b], 4, "a")?.host.id).toBe("b");
    expect(pickHost([full], 4)).toBeUndefined();
  });

  test("ignored-path hint maps the host's slot paths back and skips what git tracks", () => {
    const rec = { seedCwd: laptop, cwdRel: "" };
    fs.writeFileSync(path.join(laptop, ".env"), "x");
    try {
      const text = `Error: ENOENT: no such file or directory, open '/home/u/.codecast/run/slots/0123456789/2/.env'\ncat: src.txt: No such file or directory\n`;
      expect(ignoredPathsIn(text, rec)).toEqual([".env"]);
    } finally {
      fs.rmSync(path.join(laptop, ".env"));
    }
  });
});
