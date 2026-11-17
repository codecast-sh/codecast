// The harness's side of --fake: answering one call through the fake in a
// process of its own in the closed world, and loading its world. The process
// that runs the fake's code is prompt-dry-run-fake.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ctx } from "./prompt-dry-run-context.ts";
import { loggedArgv, markCall } from "./prompt-dry-run-record.ts";
import { realCast } from "./prompt-dry-run-realcast.ts";
import { refuse, scratchIsolationGap, scratchSandbox } from "./prompt-dry-run-sandbox.ts";

/** The fake's closed world, once loadFake has checked this machine can give it one: null without --fake. */
let fakeBox: { prefix: string[]; env: Record<string, string> } | null = null;
/** One call at a time, in the order they came: the world is a single file. */
let fakeQueue: Promise<unknown> = Promise.resolve();

/** One call to the fake: the first `stdinBytes` of the body are its stdin, the rest its argv, \0 separated. */
export async function answerFake(body: Buffer, stdinBytes: number, callId: string | null): Promise<Response> {
  const { harnessDir } = ctx();
  const stdin = body.subarray(0, stdinBytes).toString("utf8");
  const argv = body.subarray(stdinBytes).toString("utf8").split("\0");
  if (argv[argv.length - 1] === "") argv.pop();
  const turn = fakeQueue.then(() => fakeCall(argv, stdin));
  fakeQueue = turn.catch(() => undefined);
  let a: FakeAnswer | null = null;
  try {
    a = await turn;
  } catch (e) {
    fs.appendFileSync(path.join(harnessDir, "fake-errors.log"), `${loggedArgv(argv)}: ${(e as Error).message}\n`);
  }
  if (!a) return new Response("125\n");
  markCall(callId, argv, a.cli ? "CLI" : a.exit === 0 ? "FAKED" : "FAKEERR");
  return new Response(`${a.exit}\n${a.out}`);
}

type FakeAnswer = { out: string; exit: number; cli?: true };

/** The most an answer (or its stderr) may hold, and the most the fake's dir may hold after a call: past either, the call is an error. */
const FAKE_OUTPUT_CAP = 4 << 20;
const FAKE_DIR_CAP = 64 << 20;

/**
 * A regular file read whole only when it is under `cap` bytes. Opened with
 * O_NOFOLLOW and measured on the open fd, so a link swapped in at any moment is
 * refused rather than followed: the fake writes these files, and a link would
 * have the harness, outside the sandbox, read whatever it points at.
 */
function readCapped(file: string, cap: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
    if (st.size > cap) throw new Error(`${path.basename(file)} holds ${st.size} bytes, over its cap of ${cap}`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Every process of this user in the fake call's session `sid` (getsid: macOS's
 * ps and pkill cannot name a session). The session's leader, the call's own
 * process, has exited by now, so a live process whose pid is `sid` can only be
 * an unrelated one that took the recycled pid and started a session of its own:
 * then the session id names someone else's session, and nothing is returned.
 * (XNU keeps a session id's pid out of reuse while any member of the session
 * lives, so when the call left survivors, no such process can exist.)
 */
function sessionPids(sid: number): number[] {
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const libc = dlopen("/usr/lib/libSystem.B.dylib", { getsid: { args: [FFIType.i32], returns: FFIType.i32 } });
  try {
    const pids = (spawnSync("/bin/ps", ["-xo", "pid=", "-U", String(process.getuid?.() ?? "")], { encoding: "utf8", maxBuffer: 16 << 20 }).stdout ?? "").split("\n").map(Number).filter((p) => p > 0 && p !== process.pid);
    const members = pids.filter((p) => libc.symbols.getsid(p) === sid);
    return members.includes(sid) ? [] : members;
  } finally {
    libc.close();
  }
}

/**
 * The bytes under the fake's dir, walked with lstat. A link anywhere in it is
 * an error: the fake has no reason to make one, and following it would have the
 * harness walk or read outside the sandbox.
 */
function dirBytes(dir: string): number {
  const { fakeDir } = ctx();
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    const st = fs.lstatSync(f);
    if (st.isSymbolicLink()) throw new Error(`the fake's dir holds a link: ${JSON.stringify(path.relative(fakeDir, f))}`);
    n += st.isDirectory() ? dirBytes(f) : st.size;
  }
  return n;
}

/**
 * The fake's answer to one call, from prompt-dry-run-fake.ts in the closed
 * world: in a session of its own under the run's tag, its output to files (a
 * child holding a pipe cannot stall the broker), killed at 30 s, its whole
 * session killed after, its answer and its dir capped in size;
 * fake-timings.log keeps what each call cost. Null when it does not model the
 * call.
 */
async function fakeCall(argv: string[], stdin: string): Promise<FakeAnswer | null> {
  const { fakeBin, fakeDir, fakeSeed, RUN_TAG, harnessDir } = ctx();
  if (!fakeBin || !fakeBox) return null;
  const [outFile, errFile] = [path.join(fakeDir, "call.out"), path.join(fakeDir, "call.err")];
  // Made fresh for each call, never opened through what the last call left: a link there would have the harness,
  // outside the sandbox, truncate the file it points at. O_EXCL refuses any path that exists again, a link included.
  const [outFd, errFd] = [outFile, errFile].map((f) => {
    fs.rmSync(f, { force: true });
    return fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  });
  const seed = fakeSeed ? path.join(fakeDir, "seed.json") : "";
  const child = spawn(fakeBox.prefix[0]!, [...fakeBox.prefix.slice(1), process.execPath, FAKE_RUNNER, fakeBin, path.join(fakeDir, "world.json"), path.join(fakeDir, "tree.json"), seed, ...argv], {
    cwd: fakeDir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG ?? "en_US.UTF-8", HOME: path.join(fakeDir, "home"), DRY_RUN_TAG: RUN_TAG, ...fakeBox.env },
    stdio: ["pipe", outFd, errFd], detached: true,
  });
  child.stdin!.end(stdin);
  const started = performance.now();
  const code = await new Promise<number>((resolve) => {
    const t = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, 30_000);
    child.on("exit", (c) => { clearTimeout(t); resolve(c ?? 1); });
  });
  for (const fd of [outFd, errFd]) fs.closeSync(fd);
  const ran = performance.now();
  // Its whole session: a child it spawned with no env and another cwd, which neither the tag nor the cwd finds, is still in it.
  // A grandchild that started a session of its own is the run's sweep's (sweepRun: the run's tag, or a cwd in fakeDir).
  try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
  for (const pid of sessionPids(child.pid!)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  // What each call cost: the fake's process, then killing its session (ms).
  fs.appendFileSync(path.join(harnessDir, "fake-timings.log"), `${Math.round(ran - started)}\t${Math.round(performance.now() - ran)}\t${code}\t${loggedArgv(argv)}\n`);
  // Before reading anything the fake wrote: no links, and within its size.
  const size = dirBytes(fakeDir);
  if (size > FAKE_DIR_CAP) throw new Error(`the fake's dir holds ${size} bytes, over its cap of ${FAKE_DIR_CAP}`);
  if (code === 125) return null;
  const said = readCapped(errFile, FAKE_OUTPUT_CAP).trim();
  if (code !== 0) throw new Error(said.split("\n").find((l) => /error/i.test(l)) ?? said.split("\n")[0] ?? `exit ${code}`);
  const a = JSON.parse(readCapped(outFile, FAKE_OUTPUT_CAP)) as FakeAnswer;
  if (typeof a?.out !== "string" || !Number.isInteger(a.exit)) throw new Error("the fake's answer is not { out, exit }");
  return { out: a.out, exit: a.exit, ...(a.cli === true ? { cli: true as const } : {}) };
}

/** The answering process: imports the --fake module and answers one call (prompt-dry-run-fake.ts). */
const FAKE_RUNNER = path.join(import.meta.dir, "prompt-dry-run-fake.ts");

/**
 * The fake's world, ready for its first call: the CLI's command tree (read by
 * the real CLI with no sign-in, in a directory the agent cannot write) and the
 * seed beside it, and the closed world it answers in, which reads the fake's
 * checkout and writes only fakeDir. The fake's code never runs in this
 * process.
 */
export async function loadFake(): Promise<void> {
  const { fakeBin, fakeSeed, fakeDir, harnessDir, brokerCwdDefault, guardDir } = ctx();
  if (!fakeBin) return;
  const cast = realCast();
  const state = path.join(harnessDir, "cast-state");
  fs.mkdirSync(state, { recursive: true });
  const r = cast ? spawnSync(cast, ["agent-context", "--json"], { cwd: brokerCwdDefault, env: { PATH: process.env.PATH ?? "", HOME: harnessDir, CODECAST_DIR: state, CODECAST_NO_AUTO_UPDATE: "1" }, encoding: "utf8", maxBuffer: 256 << 20 }) : null;
  let tree: unknown = null;
  try { tree = r && r.status === 0 ? JSON.parse(r.stdout) : null; } catch { /* not the tree */ }
  if (!tree) refuse(`--fake needs the CLI's command tree, and \`cast agent-context --json\` did not give one (${!r ? "no cast on PATH" : r.status !== 0 ? `exit ${r.status}` : "its output is not JSON"})`);
  fs.writeFileSync(path.join(harnessDir, "cli-tree.json"), r!.stdout);
  fs.mkdirSync(path.join(fakeDir, "home"), { recursive: true });
  fs.writeFileSync(path.join(fakeDir, "tree.json"), r!.stdout);
  if (fakeSeed) fs.copyFileSync(fakeSeed, path.join(fakeDir, "seed.json"));
  // The fake's code and what it imports: its checkout (git's top level), or its directory, and wherever the checkout's install really lives.
  const dir = path.dirname(fakeBin);
  const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim();
  const reads = [dir, import.meta.dir, ...(top ? [top, ...["node_modules"].map((n) => path.join(top, n)).filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p))] : [])];
  const gap = scratchIsolationGap(fakeDir, guardDir, fs.realpathSync(dir));
  if (gap) refuse(`--fake runs the fake in the closed world, and this machine cannot give it one (${gap})`);
  fakeBox = scratchSandbox(fakeDir, { guard: guardDir, read: reads, ports: [] });
}
