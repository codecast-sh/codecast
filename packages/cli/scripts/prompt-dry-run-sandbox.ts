// The closed world every agent run of prompt-dry-run.ts gets (6b in its
// header): the sandbox-exec profile and argv, what it lets an agent read, and
// the check that it applies and holds on this machine.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

/** The directories that hold a sign-in a run must never use: the codecast
 *  state directory (its token, the daemon's loopback token) and the convex
 *  CLI's login. A run's agent cannot read them, so no route it finds around
 *  the guard (unsetting CODECAST_DIR, a direct `bun main.ts`, curl with a
 *  token) can write anywhere; its live reads go through the broker below. */
function credentialDirs(): string[] {
  const home = process.env.HOME || os.homedir();
  return [...new Set([process.env.CODECAST_DIR || path.join(home, ".codecast"), path.join(home, ".codecast"), path.join(home, ".convex")])];
}

/**
 * The sandbox every agent run gets (the closed world, ct-95483). A replayed
 * agent reads and writes nothing real and reaches nothing but the model:
 *  - writes land only in the run dir (and /dev and the per-user cache dir
 *    Claude Code and bun keep caches in);
 *  - nothing under the real home folder is readable except what the run
 *    needs: the run dir, the guard, the served record, the checkout this
 *    harness lives in (and a --fake's), the agent's --cwd, and the installs
 *    of the tools it runs (claude, bun, cast, ...). Every .env file and
 *    every `.claude/skills/secret` skill stays unreadable even there;
 *  - no listening socket, and no connection anywhere but the loopback ports
 *    this harness serves (the live-read broker and the egress proxy, which
 *    tunnels to Anthropic alone) and each --allow-port;
 *  - the shared temp dirs (/tmp, /var/tmp and the per-user temp), the
 *    credential dirs, Apple events and the keychain are off limits.
 * On 2026-11-16 a guidance replay with the old profile (only /tmp and the
 * credential dirs closed) listed a checkout's secrets through a project
 * skill, fetched an OAuth client into a catcher it wrote under the real
 * ~/.cache, and left it listening after the rep. Paths arrive as -D
 * parameters, so no path is ever quoted into the profile; ports are numbers
 * this process chose.
 */
function scratchProfile(o: { hidden: number; readable: number; files: number; closed: number; deny: number; ports: number[] }): string {
  return [
    "(version 1)",
    "(allow default)",
    // Writes: the run dir and /dev. The per-user cache dir is shared and outlives the run, so it is closed too.
    '(deny file-write* (subpath "/"))', '(allow file-write* (subpath "/dev"))',
    // The shared temp dirs: nothing in them can be read or listed or written. A path through them may still be
    // resolved (as under the home folder), so a tree allowed below one, a checkout git resolves by realpath, works.
    '(deny file-read-data file-write* (regex #"^/private/(var/)?tmp/" #"^/private/var/folders/[^/]+/[^/]+/T/"))',
    '(deny file-read-data (subpath (param "HOME_DIR")))',
    // Contents and listings only: a path through them must still resolve, since the run dir and its baked guard sit
    // inside the evals home (denying their metadata too left /usr/bin/env spinning on every #!/usr/bin/env script there).
    ...Array.from({ length: o.closed }, (_, i) => `(deny file-read-data (subpath (param "CLOSED_${i}")))`),
    // Each allowance names file-read-data too: a rule on the specific operation outranks a wildcard one, whatever their order.
    ...Array.from({ length: o.files }, (_, i) => `(allow file-read* file-read-data (literal (param "FILE_${i}")))`),
    ...Array.from({ length: o.readable }, (_, i) => `(allow file-read* file-read-data (subpath (param "READ_${i}")))`),
    // Paths inside an allowed tree that stay closed: the stash ref files. The stash's objects stay readable (gitStoresOf says why).
    ...Array.from({ length: o.deny }, (_, i) => `(deny file-read* file-read-data (subpath (param "DENY_${i}")))`),
    "(deny network-bind)", "(deny network-inbound)",
    "(deny network-outbound)",
    ...[...o.ports, ...allowedPorts()].map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
    "(deny appleevent-send)",
    // Another process's arguments and environment (sysctl KERN_PROCARGS2): every same-user process's tokens otherwise, the harness's own included.
    "(deny process-info* (target others))", '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
    // Signals to any process outside the sandbox: `kill -9 -1` otherwise takes down every process the user owns.
    "(deny signal (target others))",
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))',
    // A checkout's secrets, wherever a readable tree holds them: env files, keys and certificates, package and
    // network sign-ins, cloud and service-account credentials, and the secret skill that reads Fly and GitHub.
    // Before the run dir's allowance, so a file the launcher put there (a replay's read-only database URL) stays the run's.
    `(deny file-read* file-read-data file-write* ${SECRET_SHAPES.map((re) => `(regex #"${re}")`).join(" ")})`,
    '(allow file-read* file-read-data file-write* (subpath (param "RUN_DIR")))',
    '(allow file-read* file-read-data (subpath (param "GUARD_DIR")) (subpath (param "SERVE_DIR")))',
    '(deny file-write* (subpath (param "GUARD_DIR")))',
    // The denies below name file-read-data as well, so they outrank the allowances above that name it.
    ...Array.from({ length: o.hidden }, (_, i) => `(deny file-read* file-read-data file-write* (subpath (param "HIDDEN_${i}")))`),
    // DRY_RUN_HIDE_REGEX: one more path pattern the agent must not read. The launcher writes it, never the replayed work; no quote may appear in it.
    ...(process.env.DRY_RUN_HIDE_REGEX && !process.env.DRY_RUN_HIDE_REGEX.includes('"') ? [`(deny file-read* file-read-data file-write* (regex #"${process.env.DRY_RUN_HIDE_REGEX}"))`] : []),
  ].join("\n");
}

/** Path shapes that hold a secret in any tree the agent may read (sandbox regexes; no quote in any). */
const SECRET_SHAPES = [
  "/\\.env(\\.[^/]*)?$", "/\\.envrc$", "/\\.dev\\.vars$", "/\\.(npmrc|netrc|pypirc|git-credentials)$",
  "\\.(pem|p8|p12|pfx|key|keystore|jks)$", "/id_(rsa|dsa|ecdsa|ed25519)$",
  "/(credentials|service[-_]?account[^/]*|gcloud[^/]*key[^/]*)\\.json$", "/credentials$", "/\\.docker/config\\.json$", "/\\.kube/config$",
  "/\\.claude/skills/secret(/|$)",
];

/** The ports a run may also connect out on (`--allow-port <n>`, repeatable). */
function allowedPorts(): number[] {
  const ports: number[] = [];
  process.argv.forEach((a, i) => {
    if (a !== "--allow-port") return;
    const n = Number(process.argv[i + 1]);
    if (!Number.isInteger(n) || n <= 0 || n > 65535 || n === 443) refuse(`--allow-port takes a port other than 443, not ${process.argv[i + 1]}`);
    ports.push(n);
  });
  return ports;
}

const realHome = (): string => fs.realpathSync(process.env.HOME || os.homedir());
const realOf = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : p);

/** The tools an agent run may start, found on PATH; DRY_RUN_TOOLS (comma separated, launcher-written) names more. */
const AGENT_TOOLS = ["claude", "bun", "cast", "node", "git", "jq", "python3", "gh", "rg", "uv", ...(process.env.DRY_RUN_TOOLS ?? "").split(",").map((t) => t.trim()).filter(Boolean)];
/** An interpreter's own install, by its name: what python, node or ruby read their libraries from. */
const INTERPRETER_ROOT = /^(.*\/(?:cpython-[^/]+|pypy[^/]*|python@?[0-9][^/]*|node-v[^/]+|v\d+\.\d+\.\d+|ruby-[^/]+))\/bin\/[^/]+$/;

/**
 * What an agent must read under the home folder to start its tools, and
 * nothing more: for each tool it may run (AGENT_TOOLS), the file on PATH and
 * every link it resolves through, as single files, and for an interpreter
 * installed under the home folder (uv's or pyenv's python, nvm's node) its
 * own install by name. Never a directory a tool merely sits in, and never a
 * parent of one: ~/.local/bin/python3 opens that file, not ~/.local.
 */
function toolInstalls(): { files: string[]; dirs: string[] } {
  const home = realHome();
  const under = (p: string) => `${p}/`.startsWith(`${home}/`) && p !== home;
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const name of AGENT_TOOLS) {
    const entry = (process.env.PATH ?? "").split(":").map((d) => d && path.join(d, name)).find((p) => p && fs.existsSync(p));
    if (!entry) continue;
    // Every hop of the link chain, so a path through a link resolves.
    let at = path.resolve(entry);
    for (let hop = 0; hop < 16; hop++) {
      files.add(at);
      files.add(realOf(path.dirname(at)) === path.dirname(at) ? at : path.join(realOf(path.dirname(at)), path.basename(at)));
      let next: string;
      try { next = fs.readlinkSync(at); } catch { break; }
      at = path.resolve(path.dirname(at), next);
    }
    const target = realOf(entry);
    files.add(target);
    const root = INTERPRETER_ROOT.exec(target)?.[1];
    if (root && under(root)) dirs.add(root);
  }
  return { files: [...files].filter(under), dirs: [...dirs] };
}

/** The evals data home (packages/evals paths.ts evalsHome): labels, every freeze, other reps' runs. */
const evalsHome = (): string => process.env.CODECAST_EVALS_HOME || path.join(realHome(), ".local", "share", "codecast", "evals");

/**
 * Directories under the home folder that hold other runs' and other tools'
 * private data whatever is allowed above: the evals home (this run's own dir
 * and record are allowed again after), and the XDG data and state homes,
 * where tools keep tokens (amp's secrets.json, gh's state) and transcripts.
 */
const closedHomes = (): string[] => [evalsHome(), path.join(realHome(), ".local", "share"), path.join(realHome(), ".local", "state")].map(realOf);

/**
 * What git needs, read-only, of the repository a --cwd checkout belongs to,
 * and no more. A worktree's .git is a file pointing into the main checkout's
 * .git, which also holds other sessions' stashes and tools' data: of that
 * common dir only the object store, the refs, packed-refs, HEAD, config,
 * info/exclude and shallow, plus this worktree's own git dir. A clone made
 * with --shared borrows another store (its alternates): that store's objects.
 * The stash ref files (refs/stash and its log) are denied wherever they sit,
 * the cwd's own .git included, so `git stash list` finds nothing. That does
 * NOT close the stash: its commits are objects in the store the agent must
 * read for git to work, packed-refs can name them, and `git cat-file
 * --batch-all-objects` lists every object regardless. No path rule can hide
 * one object while the store is readable, so another session's stashed work
 * in this repository is readable by a replay that looks for it.
 */
export function gitStoresOf(cwd: string): { dirs: string[]; files: string[]; deny: string[] } {
  const git = (args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (common.status !== 0 || gitDir.status !== 0) return { dirs: [], files: [], deny: [] };
  const c = realOf(common.stdout.trim());
  const own = realOf(gitDir.stdout.trim());
  const dirs = new Set<string>();
  const files = new Set<string>();
  if (own !== c) {
    dirs.add(path.join(c, "objects")).add(path.join(c, "refs")).add(own);
    for (const f of ["packed-refs", "HEAD", "config", path.join("info", "exclude"), "shallow"]) files.add(path.join(c, f));
  }
  for (const store of [c, own]) {
    const alternates = path.join(store, "objects", "info", "alternates");
    if (fs.existsSync(alternates)) for (const line of fs.readFileSync(alternates, "utf8").split("\n")) if (line.trim() && !line.startsWith("#")) dirs.add(realOf(path.resolve(path.join(store, "objects"), line.trim())));
  }
  const deny = [path.join(c, "refs", "stash"), path.join(c, "logs", "refs", "stash")];
  return { dirs: [...dirs].filter((d) => fs.existsSync(d)), files: [...files].filter((f) => fs.existsSync(f)), deny };
}

/** The argv prefix that runs a command in the closed world, and the env it needs. */
export function scratchSandbox(run: string, o: { guard: string; serve?: string; read?: string[]; readFiles?: string[]; deny?: string[]; ports?: number[] }) {
  const scratch = path.join(run, "tmp");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  // DRY_RUN_HIDE: more paths (colon separated) the agent must not read, such as a
  // checkout's real .env or a cloud login, when the replayed work runs project code.
  const hidden = [...credentialDirs(), ...(process.env.DRY_RUN_HIDE ?? "").split(":").filter(Boolean)].map(realOf);
  const tools = toolInstalls();
  const files = [...new Set([...tools.files, ...(o.readFiles ?? []).map(realOf)])];
  const deny = (o.deny ?? []).map((d) => path.resolve(d));
  const readable = [...new Set([...tools.dirs, ...(o.read ?? [])].map(realOf))];
  const closed = closedHomes();
  const prefix = [
    "sandbox-exec", "-D", `RUN_DIR=${realOf(run)}`, "-D", `GUARD_DIR=${realOf(o.guard)}`, "-D", `SERVE_DIR=${realOf(o.serve ?? run)}`, "-D", `HOME_DIR=${realHome()}`,
    ...files.flatMap((file, i) => ["-D", `FILE_${i}=${file}`]),
    ...deny.flatMap((d, i) => ["-D", `DENY_${i}=${d}`]),
    ...readable.flatMap((dir, i) => ["-D", `READ_${i}=${dir}`]),
    ...closed.flatMap((dir, i) => ["-D", `CLOSED_${i}=${dir}`]),
    ...hidden.flatMap((dir, i) => ["-D", `HIDDEN_${i}=${dir}`]),
    "-p", scratchProfile({ hidden: hidden.length, readable: readable.length, files: files.length, closed: closed.length, deny: deny.length, ports: o.ports ?? [] }),
  ];
  // xcrun_db: Apple's /usr/bin/git and friends are xcrun shims that cache in the per-user temp dir, which is closed.
  // GIT_CEILING_DIRECTORIES: git looking for a repository stops at the run dir, so a run dir inside some other
  // repository (an evals home under a dotfiles checkout) never has git walk that repository's closed files.
  return { prefix, hidden, env: { TMPDIR: `${scratch}/`, TMP: scratch, TEMP: scratch, CLAUDE_CODE_TMPDIR: scratch, xcrun_db: path.join(scratch, "xcrun_db"), GIT_CEILING_DIRECTORIES: realOf(run) } };
}

/** Exits 0 when it can read the arguments and environment of the pid it is given (sysctl KERN_PROCARGS2). */
const ARGS_PROBE = `const { dlopen, FFIType, ptr } = require("bun:ffi");
const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } });
const mib = new Int32Array([1, 49, Number(process.argv[process.argv.length - 1])]);
const buf = new Uint8Array(1 << 16); const size = new BigUint64Array([BigInt(buf.length)]);
process.exit(symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(size), null, 0) === 0 ? 0 : 1);`;

/**
 * Whether the closed world applies here and holds: each way out an agent was
 * seen to take, tried inside it. Null when every one is refused and the run's
 * own scratch still works, else which one got through.
 */
export function scratchIsolationGap(run: string, guard: string, cwd?: string): string | null {
  if (process.platform !== "darwin") return `no sandbox-exec on ${process.platform}`;
  const sb = scratchSandbox(run, { guard, read: cwd ? [cwd] : [] });
  const home = realHome();
  const scratchCwd = !!cwd && `${cwd}${path.sep}`.startsWith(`${realOf(run)}${path.sep}`);
  const probe = [
    'p=/tmp/.dry-run-probe-$$; if ( : > "$p" ) 2>/dev/null; then rm -f "$p"; exit 3; fi',
    ': > "$TMPDIR/probe" || exit 4; rm -f "$TMPDIR/probe"',
    'for d in "$@"; do [ -e "$d" ] && ls "$d" >/dev/null 2>&1 && exit 5; done',
    ...(cwd && !scratchCwd ? ['q="$RO_DIR/.dry-run-probe-$$"; if ( : > "$q" ) 2>/dev/null; then rm -f "$q"; exit 6; fi'] : []),
    'c="$REAL_HOME/.cache/.dry-run-probe-$$"; if ( : > "$c" ) 2>/dev/null; then rm -f "$c"; exit 6; fi',
    'if ls "$REAL_HOME" >/dev/null 2>&1; then exit 8; fi',
    // Other runs' records and other tools' data: the evals home and the XDG data and state homes.
    'for d in "$EVALS_PROBE" "$REAL_HOME/.local/share" "$REAL_HOME/.local/state"; do [ -e "$d" ] && ls "$d" >/dev/null 2>&1 && exit 11; done',
    'if /usr/bin/nc -z -G 3 1.1.1.1 443 >/dev/null 2>&1; then exit 7; fi',
    // Another process's arguments and environment, read the way the agent did on 2026-11-16 (sysctl KERN_PROCARGS2), of this harness.
    'if "$PROBE_BUN" -e "$ARGS_PROBE" "$HARNESS_PID" 2>/dev/null; then exit 10; fi',
    // A signal to a process outside it, this harness: `kill -9 -1` from inside would otherwise end every process the user owns.
    'if kill -0 "$HARNESS_PID" 2>/dev/null; then exit 12; fi',
    `if /usr/bin/perl -MIO::Socket::INET -e 'exit(IO::Socket::INET->new(Listen => 1, LocalAddr => "127.0.0.1", LocalPort => 0) ? 0 : 1)' 2>/dev/null; then exit 9; fi`,
    "exit 0",
  ].join("; ");
  // In a session of its own, as an agent runs (spawn detached): the sandbox lets a process read the environment of its own session's processes, the harness's included.
  const r = spawnSync("/usr/bin/perl", ["-e", "use POSIX; POSIX::setsid(); exec @ARGV or exit 127", ...sb.prefix, "/bin/sh", "-c", probe, "probe", ...sb.hidden], { env: { ...process.env, ...sb.env, REAL_HOME: home, EVALS_PROBE: evalsHome(), PROBE_BUN: process.execPath, ARGS_PROBE, HARNESS_PID: String(process.pid), ...(cwd ? { RO_DIR: cwd } : {}) }, encoding: "utf8" });
  if (r.status === 0) return null;
  const said: Record<number, string> = {
    3: "/tmp stayed writable", 4: "it refused the run's own scratch dir", 5: "the sign-in directories stayed readable",
    6: "a write outside the run dir landed", 7: "a connection off the machine went through", 8: "the real home folder stayed readable", 9: "a process could listen on a port",
    10: "another process's environment stayed readable", 11: "the evals home or the XDG data and state homes stayed readable", 12: "a signal reached a process outside it",
  };
  return r.status !== null && said[r.status] ? `sandbox-exec ran but ${said[r.status]}` : `sandbox-exec would not apply: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`;
}
