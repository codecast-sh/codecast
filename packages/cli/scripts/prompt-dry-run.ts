#!/usr/bin/env bun
// THE harness for a prompt dry run: a headless `claude -p` that grades a prompt
// (the org analyzer, a role's standing text, a wake frame) and can never reach
// a person's inbox.
//
//   bun packages/cli/scripts/prompt-dry-run.ts --run <dir> --prompt <file> --model <id>
//        [--max-turns 80] [--tools Bash,Read,Write,Edit] [--guard <dir>] [--serve <dir>] [--then <file>]
//        [--account <profile>] [--max-output-tokens N] [--claude-md <file>] [--seed <jsonl>] [--cwd <dir>] [--read-only [--allow-port N]...]
//        [--fake <bin> [--fake-seed <json>]]
//   bun packages/cli/scripts/prompt-dry-run.ts --run <dir> --prompt <file> --model <id> --call
//        [--system <file>] [--max-output-tokens N]
//
// `--model` is required: an unpinned run takes the account default, and two
// runs on different accounts are not comparable.
//
// `--call` grades a single model call rather than an agent: the prompt file's
// text IS the user message (on stdin), the system prompt is the --system file
// or one neutral line, there are no tools and one turn. It keeps every piece
// of isolation below, so an eval of a prod prompt carries no Claude Code
// context the prod call lacks. `--max-output-tokens N` sets
// CLAUDE_CODE_MAX_OUTPUT_TOKENS for the child only, the closest a run gets to
// prod's max_tokens. args.json in the run dir records the knobs the run used.
//
// Why a harness at all. The codecast daemon syncs EVERY transcript under
// ~/.claude/projects as a session, whether or not the SessionStart hook ran
// (syncScope.ts refuses paths by shape only), so a bare `claude -p` with hooks
// off, detached from the terminal and its transcript deleted afterwards still
// shows in the founder's feed for as long as it runs. Four sessions leaked
// dry runs that way on four days before the cause was found (2026-09-19).
//
// What this does instead, in order of what it protects against:
//  1. A private CLAUDE_CONFIG_DIR under the run directory. The transcript lands
//     there, outside the watched tree, and the directory holds no settings and
//     no hooks; `--setting-sources project` loads none from the machine either.
//     The keychain item is scoped to the config dir, so the login is read from
//     the machine's item (ccKeychain.ts, the reader the CLI already has) and
//     handed to the child as CLAUDE_CODE_OAUTH_TOKEN in its environment only:
//     no file ever carries it. The directory is removed when the run ends.
//  2. CODECAST_DIR points at an empty directory, so a real `cast` the agent
//     finds cannot post, send or pin anything: one built from this tree hands
//     the call to the guard (3), any other answers "Not authenticated", and
//     the eval reads such a run as one that left its world (evals dryRun.ts).
//  3. `cast` on PATH is the guard beside this script (prompt-dry-run-bin/cast,
//     or the directory given as --guard), put first on PATH again before
//     every Bash command through CLAUDE_ENV_FILE, since the user's profile
//     would otherwise shadow it, and the target of a `cast` the agent reaches
//     some other way (src/main.ts sends it there): reads pass through with the real
//     state directory restored, writes are refused and logged, and
//     `--serve <dir>` answers reads from files there (the legacy org files,
//     and any argv captured under reads/ by its key), refusing a read that
//     `frozen` lists and that was not captured, so a run grades the prompt
//     against a record and never against a moving workspace (a `*` line
//     freezes every read). A `--help` prints the CLI's help under a state
//     directory of its own. calls.log marks each call SERVED, UNSERVED, LIVE,
//     HELP or REFUSED.
//  4. No controlling terminal (start_new_session), no tmux variables, none of
//     the launching session's identity (CODECAST_SESSION_ID and friends).
//  5. An agent run's scratch is its own (ct-56832). The model picks fixed
//     paths like /tmp/org_inputs.json, so two runs in flight read each other's
//     files. On macOS the agent's whole process tree runs under sandbox-exec
//     with every file under /tmp and /var/tmp unreadable and unwritable, the
//     run dir excepted, while TMPDIR and CLAUDE_CODE_TMPDIR (Claude Code's
//     own scratch, which ignores TMPDIR and defaults to /tmp) point at
//     <run>/tmp. A write to /tmp fails with "Operation not permitted" and the
//     agent moves to $TMPDIR or its cwd.
//  6. The same sandbox hides every sign-in a run could write with: the
//     codecast state directory (its token, the daemon's loopback token) and
//     the convex CLI's login are unreadable, the guard cannot be rewritten,
//     and nothing outside the run can be driven from it (a tmux socket, Apple
//     events). So a route around the guard (unsetting CODECAST_DIR, `bun
//     main.ts`, curl) finds nothing to sign in with. Live reads go to a
//     broker in this process (DRY_RUN_BROKER), which runs the guard outside
//     the sandbox; it classifies the argv again and runs only reads. On
//     2026-10-05 two agents left running after their harness was killed read
//     the guard's source, went around it with the real state directory, and
//     wrote proposals to prod; every layer here answers one step of that.
//  6b. The sandbox is a closed world (scratchProfile, ct-95483): an agent
//     writes only in its run dir, reads nothing under the real home folder
//     but the run, the guard, the record, this checkout, its --cwd and its
//     tools' installs (never a .env or a secret skill, even there), listens
//     on nothing, and connects only to this process's broker and an egress
//     proxy that tunnels to Anthropic alone. It gets a home folder of its
//     own and none of the shell's credentials, and every process it starts
//     carries a tag: when the run ends, whatever is still running with the
//     tag or inside the run dir is killed, however it detached. `cast vault`
//     is refused outright. On 2026-11-16 a guidance replay under the old
//     sandbox read a checkout's secrets through its secret skill, wrote an
//     OAuth catcher under the real ~/.cache and left it listening; the
//     guard test "reads, writes and reaches nothing real" tries each step.
//     The review of that fix (2026-11-16) found four more ways out, each now
//     closed and tested: the agent read other processes' environments
//     (sysctl KERN_PROCARGS2; now denied, and the agent runs in a session of
//     its own, the only boundary that denial keeps), so the login never
//     enters the sandbox either: Claude Code holds a placeholder and reaches
//     the model through a proxy here that swaps in the real token and serves
//     the model's endpoints alone. The broker ran the guard in a directory the
//     agent chose, where a bunfig.toml preload ran its code outside the
//     sandbox, and wrote live-read copies through links it had planted; it now
//     runs in a directory the agent cannot write and answers in its reply.
//     And what the eval trusts (the fake's world, the calls it answered) now
//     lives in <run>.harness, beside the run dir, never in it.
//     Its second review closed the rest: the agent reads only the files its
//     tools run from (never a directory a tool sits in), with the evals home
//     and the XDG data and state homes shut; its environment is an allowlist;
//     calls.log is rebuilt from the harness's own record of every call, so no
//     line in it is the agent's; the model proxy refuses server tools,
//     mcp_servers and container and pins anthropic-beta; and the real CLI
//     runs only outside the sandbox, with no sign-in, for help and the
//     command tree.
//     Linux has no sandbox-exec, so an agent run there does not start (7).
//  7. Before the agent starts, the guard must answer a help call in the
//     agent's own sandbox and env, or the run does not start. An agent run
//     where sandbox-exec cannot apply (another OS, an already sandboxed
//     parent) does not start either; `--isolation-check` answers that alone
//     (exit 0 isolated, 3 not). A run dir holds one live run (harness.pid),
//     and the agent's process group dies with the harness: on a signal, and
//     through a watchdog when the harness is killed outright.
//
// Output, in the run directory: out.json (the claude result), reply.txt (its
// final message and cost), said.txt and said.json (every assistant message of
// the turn, in order, as text with a rule between them and as a JSON array: a
// run that keeps working after the message it meant to send ends on a
// correction, and the result alone loses the message; two samples did on
// 2026-09-24), stream.jsonl (the raw stream), exit.txt, took.txt, calls.log
// (every cast call the guard saw), and live-reads/ (each read that went to the
// live workspace, under its served-read key). The prompt file goes to claude
// on stdin and is the opening user message itself, as prod delivers a frame,
// so a prompt of any size works; the harness note (what to write instead of
// posting) belongs in that file, not here.
//
// `--fake <bin>` gives the guard a fake service to ask before it refuses a
// write (packages/evals/src/fakes/bin.ts): a call the fake models is answered
// as prod would answer it, from a world kept in the run dir, so the turn goes
// on past its first write and later calls see what it did. calls.log marks
// such a call FAKED. Nothing about isolation changes: the fake runs inside the
// sandbox with no sign-in, and a call it does not model is refused as before.
// `--fake-seed <json>` is the world it starts from (who is calling, the
// workspace's roles). args.json records both.
//
// `--then <file>` is a later turn: once the previous result is in, the file's
// text is sent as the next message into the same session (claude --resume,
// same private config dir). Repeat it for more turns, in order; turn N writes
// outN.json, replyN.txt and saidN.json, and calls.log gets a `# turn N` line
// before its calls. It is how a conversational prompt is graded past its
// opening, since a dry run cannot hear a person, and how a standing session's
// later wakes are replayed after its opening. A turn that fails ends the run.
// The config dir is removed after the last turn.
//
// `--seed <jsonl>` opens the run inside an existing conversation: a Claude
// Code transcript (cut at the moment under test) is copied into the private
// config dir and the prompt file is sent as its next message (claude
// --resume). It is how a moment deep in a real session is replayed with the
// whole history the agent had, which a prompt file alone cannot carry.
//
// `--cwd <dir>` runs the agent in that directory (default: the run dir), so a
// replayed station reads the checkout it would have read. Every agent run is
// closed (6b): no file write outside the run dir, and no connection but the
// model's, reached through an egress proxy here that opens tunnels to
// Anthropic alone, so a station holding a gh or git sign-in still cannot open
// a pull request or push. `--read-only` is accepted and changes nothing now. A replay in a real checkout
// leaves it, and everything it could reach, exactly as it was: the line
// workspace's Try runs that way (line-workspace.md LW4, cli lineTry.ts). A
// `--cwd` inside the run dir is the run's own scratch and stays writable, so
// a replay can work in a clone of a branch (cli lineReplay.ts) and leave the
// repository it came from untouched. `--allow-port <n>` opens one more way
// out, to any host on that port: for a database whose only
// sign-in the run can read is a read-only one (the launcher hides the rest
// with DRY_RUN_HIDE_REGEX). 443 is never opened that way.
//
// `--claude-md <file>` installs the file as the run's user-level CLAUDE.md
// (in the private config dir, where ~/.claude/CLAUDE.md would be) and lets
// the agent load user-scope sources, so an agent run carries the global
// instructions under test the way a person's session does. The config dir
// holds nothing else, so no other user setting reaches the run.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as net from "node:net";
import { NEUTRAL_SYSTEM, callArgs, callEnv, callReplies, isolatedEnv, loginToken, profileToken } from "../src/subscriptionCall.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
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
function scratchProfile(o: { hidden: number; readable: number; files: number; closed: number; ports: number[] }): string {
  return [
    "(version 1)",
    "(allow default)",
    // Writes: the run dir and /dev. The per-user cache dir is shared and outlives the run, so it is closed too.
    '(deny file-write* (subpath "/"))', '(allow file-write* (subpath "/dev"))',
    // The shared temp dirs: nothing in them can be read or listed or written. A path through them may still be
    // resolved (as under the home folder), so a tree allowed below one, a checkout git resolves by realpath, works.
    '(deny file-read-data file-write* (regex #"^/private/(var/)?tmp/" #"^/private/var/folders/[^/]+/[^/]+/T/"))',
    '(deny file-read-data (subpath (param "HOME_DIR")))',
    ...Array.from({ length: o.closed }, (_, i) => `(deny file-read* file-read-data (subpath (param "CLOSED_${i}")))`),
    // Each allowance names file-read-data too: a rule on the specific operation outranks a wildcard one, whatever their order.
    ...Array.from({ length: o.files }, (_, i) => `(allow file-read* file-read-data (literal (param "FILE_${i}")))`),
    ...Array.from({ length: o.readable }, (_, i) => `(allow file-read* file-read-data (subpath (param "READ_${i}")))`),
    "(deny network-bind)", "(deny network-inbound)",
    "(deny network-outbound)",
    ...[...o.ports, ...allowedPorts()].map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
    "(deny appleevent-send)",
    // Another process's arguments and environment (sysctl KERN_PROCARGS2): every same-user process's tokens otherwise, the harness's own included.
    "(deny process-info* (target others))", '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
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
 * Where git keeps a checkout's objects when they are not inside it, read-only:
 * a worktree's common dir (its .git file points into the main checkout's
 * .git), and every alternates target (a `git clone --shared` borrows the
 * source repository's objects). Without them git log and show fail in the
 * closed world.
 */
function gitStoresOf(cwd: string): string[] {
  const git = (args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (common.status !== 0) return [];
  const dirs = new Set<string>([common.stdout.trim(), gitDir.stdout.trim()].filter(Boolean));
  for (const d of [...dirs]) {
    const alternates = path.join(d, "objects", "info", "alternates");
    if (fs.existsSync(alternates)) for (const line of fs.readFileSync(alternates, "utf8").split("\n")) if (line.trim() && !line.startsWith("#")) dirs.add(path.resolve(path.join(d, "objects"), line.trim()));
  }
  return [...dirs].filter((d) => fs.existsSync(d)).map(realOf);
}

/** The argv prefix that runs a command in the closed world, and the env it needs. */
function scratchSandbox(run: string, o: { guard: string; serve?: string; read?: string[]; ports?: number[] }) {
  const scratch = path.join(run, "tmp");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  // DRY_RUN_HIDE: more paths (colon separated) the agent must not read, such as a
  // checkout's real .env or a cloud login, when the replayed work runs project code.
  const hidden = [...credentialDirs(), ...(process.env.DRY_RUN_HIDE ?? "").split(":").filter(Boolean)].map(realOf);
  const tools = toolInstalls();
  const readable = [...new Set([...tools.dirs, ...(o.read ?? [])].map(realOf))];
  const closed = closedHomes();
  const prefix = [
    "sandbox-exec", "-D", `RUN_DIR=${realOf(run)}`, "-D", `GUARD_DIR=${realOf(o.guard)}`, "-D", `SERVE_DIR=${realOf(o.serve ?? run)}`, "-D", `HOME_DIR=${realHome()}`,
    ...tools.files.flatMap((file, i) => ["-D", `FILE_${i}=${file}`]),
    ...readable.flatMap((dir, i) => ["-D", `READ_${i}=${dir}`]),
    ...closed.flatMap((dir, i) => ["-D", `CLOSED_${i}=${dir}`]),
    ...hidden.flatMap((dir, i) => ["-D", `HIDDEN_${i}=${dir}`]),
    "-p", scratchProfile({ hidden: hidden.length, readable: readable.length, files: tools.files.length, closed: closed.length, ports: o.ports ?? [] }),
  ];
  // xcrun_db: Apple's /usr/bin/git and friends are xcrun shims that cache in the per-user temp dir, which is closed.
  return { prefix, hidden, env: { TMPDIR: `${scratch}/`, TMP: scratch, TEMP: scratch, CLAUDE_CODE_TMPDIR: scratch, xcrun_db: path.join(scratch, "xcrun_db") } };
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
function scratchIsolationGap(run: string, guard: string, cwd?: string): string | null {
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
    `if /usr/bin/perl -MIO::Socket::INET -e 'exit(IO::Socket::INET->new(Listen => 1, LocalAddr => "127.0.0.1", LocalPort => 0) ? 0 : 1)' 2>/dev/null; then exit 9; fi`,
    "exit 0",
  ].join("; ");
  // In a session of its own, as an agent runs (spawn detached): the sandbox lets a process read the environment of its own session's processes, the harness's included.
  const r = spawnSync("/usr/bin/perl", ["-e", "use POSIX; POSIX::setsid(); exec @ARGV or exit 127", ...sb.prefix, "/bin/sh", "-c", probe, "probe", ...sb.hidden], { env: { ...process.env, ...sb.env, REAL_HOME: home, EVALS_PROBE: evalsHome(), PROBE_BUN: process.execPath, ARGS_PROBE, HARNESS_PID: String(process.pid), ...(cwd ? { RO_DIR: cwd } : {}) }, encoding: "utf8" });
  if (r.status === 0) return null;
  const said: Record<number, string> = {
    3: "/tmp stayed writable", 4: "it refused the run's own scratch dir", 5: "the sign-in directories stayed readable",
    6: "a write outside the run dir landed", 7: "a connection off the machine went through", 8: "the real home folder stayed readable", 9: "a process could listen on a port",
    10: "another process's environment stayed readable", 11: "the evals home or the XDG data and state homes stayed readable",
  };
  return r.status !== null && said[r.status] ? `sandbox-exec ran but ${said[r.status]}` : `sandbox-exec would not apply: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`;
}

if (process.argv.includes("--isolation-check")) {
  const probeRun = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "dry-run-isolation-"));
  const gap = scratchIsolationGap(probeRun, path.resolve(arg("guard") ?? path.join(import.meta.dir, "prompt-dry-run-bin")));
  fs.rmSync(probeRun, { recursive: true, force: true });
  console.log(gap ? `not isolated: ${gap}` : "isolated");
  process.exit(gap ? 3 : 0);
}

const runDir = path.resolve(arg("run") ?? "");
const promptFile = path.resolve(arg("prompt") ?? "");
function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}
if (!arg("run") || !arg("prompt") || !fs.existsSync(promptFile)) {
  refuse("usage: prompt-dry-run.ts --run <dir> --prompt <file> --model <id> [--call [--system <file>]] [--max-output-tokens N] [--max-turns N] [--tools A,B] [--guard <dir>] [--serve <dir>] [--account <profile>] [--then <file>]... [--claude-md <file>] [--seed <jsonl>]");
}
const model = arg("model");
if (!model || model.startsWith("--")) refuse("--model is required: an unpinned run takes the account default and cannot be compared");
const call = process.argv.includes("--call");
if (call) {
  for (const f of ["then", "tools", "max-turns"]) if (process.argv.includes(`--${f}`)) refuse(`--${f} does not apply to --call: a call is one turn with no tools`);
} else if (process.argv.includes("--system")) refuse("--system applies only to --call");
const systemFile = arg("system") ? path.resolve(arg("system")!) : undefined;
if (systemFile && !fs.existsSync(systemFile)) refuse(`--system: no such file ${systemFile}`);
const maxOutputTokens = arg("max-output-tokens");
if (maxOutputTokens !== undefined && !/^[1-9]\d*$/.test(maxOutputTokens)) refuse(`--max-output-tokens wants a positive integer (got ${maxOutputTokens})`);
const maxTurns = call ? "1" : arg("max-turns", "80")!;
const tools = call ? [] : (arg("tools", "Bash,Read,Write,Edit") ?? "").split(",").filter(Boolean);
const guardDir = path.resolve(arg("guard") ?? path.join(import.meta.dir, "prompt-dry-run-bin"));
const serveDir = arg("serve") ? path.resolve(arg("serve")!) : undefined;
const thenFiles = process.argv.flatMap((a, i) => (a === "--then" && process.argv[i + 1] ? [path.resolve(process.argv[i + 1])] : []));
for (const f of thenFiles) if (!fs.existsSync(f)) refuse(`--then: no such file ${f}`);
const claudeMdFile = arg("claude-md") ? path.resolve(arg("claude-md")!) : undefined;
const readOnly = process.argv.includes("--read-only");
const seedFile = arg("seed") ? path.resolve(arg("seed")!) : undefined;
if (seedFile && call) refuse("--seed does not apply to --call: a call is one model call with no history");
if (seedFile && !fs.existsSync(seedFile)) refuse(`--seed: no such file ${seedFile}`);
const agentCwd = arg("cwd") ? path.resolve(arg("cwd")!) : undefined;
/** More trees the agent may read, never write (`--read <dir>`, repeatable): what a replayed clone links to, its dependencies. */
const extraReads = process.argv.flatMap((a, i) => (a === "--read" && process.argv[i + 1] ? [path.resolve(process.argv[i + 1]!)] : []));
for (const r of extraReads) if (!fs.existsSync(r)) refuse(`--read: no such path ${r}`);
const fakeBin = arg("fake") ? path.resolve(arg("fake")!) : undefined;
const fakeSeed = arg("fake-seed") ? path.resolve(arg("fake-seed")!) : undefined;
if (fakeBin && call) refuse("--fake does not apply to --call: a call has no tools to reach it with");
if (fakeBin && !fs.existsSync(fakeBin)) refuse(`--fake: no such file ${fakeBin}`);
if (fakeSeed && !fakeBin) refuse("--fake-seed goes with --fake");
if (fakeSeed && !fs.existsSync(fakeSeed)) refuse(`--fake-seed: no such file ${fakeSeed}`);
if (agentCwd && !fs.existsSync(agentCwd)) refuse(`--cwd: no such directory ${agentCwd}`);
if (readOnly && call) refuse("--read-only does not apply to --call: a call has no tools to write with");
if (claudeMdFile && call) refuse("--claude-md does not apply to --call: a call carries no CLAUDE.md");
if (claudeMdFile && !fs.existsSync(claudeMdFile)) refuse(`--claude-md: no such file ${claudeMdFile}`);

fs.mkdirSync(runDir, { recursive: true });
// One run per run dir. A run started over a live one deletes the live one's
// config dir and env file, and that agent goes on with no guard first on its
// PATH (2026-10-05: two such agents wrote proposals to prod).
const pidFile = path.join(runDir, "harness.pid");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === "EPERM"; } };
const holder = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8").trim()) : 0;
if (holder && holder !== process.pid && alive(holder)) refuse(`${runDir} belongs to a run still alive (harness pid ${holder}); stop it or pick another --run`);
fs.writeFileSync(pidFile, `${process.pid}\n`);
const configDir = path.join(runDir, ".claude");
const noCast = path.join(runDir, ".nocast");
fs.rmSync(configDir, { recursive: true, force: true });
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(noCast, { recursive: true });
// The guard's help state directory (prompt-dry-run-bin/cast help_state): made
// here, because a mkdir inside the run's sandbox can be refused under /tmp.
fs.mkdirSync(path.join(runDir, ".cast-help"), { recursive: true });
if (claudeMdFile) fs.copyFileSync(claudeMdFile, path.join(configDir, "CLAUDE.md"));

/** Install the --seed transcript as a session claude can resume from the
 *  agent's cwd: under the project dir claude derives from that cwd, with a
 *  fresh session id so nothing points back at the original. */
function installSeed(file: string): string {
  const id = crypto.randomUUID();
  const cwd = fs.realpathSync(agentCwd ?? runDir);
  const dir = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    const row = JSON.parse(l);
    if (row.sessionId) row.sessionId = id;
    if (row.cwd) row.cwd = cwd;
    return JSON.stringify(row);
  });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  return id;
}
const seedSession = seedFile ? installSeed(seedFile) : undefined;

// A --call run has no tools, so nothing in it can write scratch or reach a
// sign-in. An agent run without its sandbox could read the codecast sign-in
// and write around the guard, so it does not start.
const isolationGap = call ? null : scratchIsolationGap(runDir, guardDir, agentCwd ? fs.realpathSync(agentCwd) : undefined);
if (isolationGap) { fs.rmSync(pidFile, { force: true }); refuse(`an agent run needs its sandbox, and this machine cannot give it one (${isolationGap}): without it the agent could read and write the real machine and reach the network`); }
const isolation = call ? null : "sandbox-exec";

fs.writeFileSync(path.join(runDir, "args.json"), JSON.stringify({ model, call, maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null, tools, maxTurns: Number(maxTurns), serve: serveDir ?? null, guard: guardDir, isolation, claudeMd: claudeMdFile ?? null, seed: seedFile ?? null, cwd: agentCwd ?? null, readOnly: !call, fake: fakeBin ?? null, fakeSeed: fakeSeed ?? null }, null, 1) + "\n");

// The child env (src/subscriptionCall.ts isolatedEnv): none of the launching
// session's identity, the login as CLAUDE_CODE_OAUTH_TOKEN alone, and
// CLAUDE_CODE_MAX_OUTPUT_TOKENS only from --max-output-tokens, never
// inherited, so args.json says every cap the run had. A call carries no model
// key either: claude bills an ANTHROPIC_API_KEY ahead of the login. An agent
// run keeps the shell's keys, since what it replays may need them.
const env = isolatedEnv({ configDir, token: arg("account") ? profileToken(arg("account")!) : loginToken(), stripModelKeys: call, ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}) });
env.CODECAST_DIR = noCast;
env.RUN_DIR = runDir;
if (serveDir) env.DRY_RUN_SERVE_DIR = serveDir;
// The fake answers from this process (the broker's /fake), never from a file the agent's guard would run.
if (fakeBin) env.DRY_RUN_FAKE_VIA_BROKER = "1";
env.PATH = `${guardDir}:${env.PATH ?? ""}`;
// The Bash tool runs each command over a snapshot of the user's shell, and a
// snapshot cut short under load carries no PATH line, so the command sources
// the profile and its `~/.local/bin` puts the real cast first (7 of 8 parallel
// runs at load 650, 2026-10-02). Claude Code sources CLAUDE_ENV_FILE before
// every command, after the profile, so the guard is first on every call.
const envFile = path.join(configDir, "dry-run-env.sh");
fs.writeFileSync(envFile, `export PATH='${guardDir.replace(/'/g, `'\\''`)}':"$PATH"\n`);
env.CLAUDE_ENV_FILE = envFile;
// A `cast` reached around the guard anyway, by an absolute path or a login
// shell, finds the empty state directory and hands the call to the guard
// (src/main.ts), so no call leaves the served world whatever PATH it took.
env.DRY_RUN_GUARD = path.join(guardDir, "cast");
env.DRY_RUN_EMPTY_CODECAST_DIR = noCast;

/**
 * What an agent run carries that the real machine gave it: a home folder of
 * its own inside the run (the sandbox makes the real one unreadable anyway,
 * and every tool's dotfiles and caches land here), none of the shell's
 * credentials (a token, a key, an agent socket), and a tag every process it
 * starts inherits, so the harness can find and kill each one when the run
 * ends, however it detached.
 */
const RUN_TAG = `dry-run-${crypto.randomUUID()}`;
/**
 * What an agent run's environment keeps of the shell it was launched from:
 * an allowlist, never a denylist, since a credential's name says nothing
 * certain about it. The harness's own settings, the locale and terminal, and
 * any name the launcher passes in DRY_RUN_PASS_ENV (comma separated: a test
 * world's stub, a station's read-only database address).
 */
const AGENT_ENV = new Set(["PATH", "LANG", "TERM", "SHELL", "USER", "LOGNAME", "TZ", "COLORTERM", "NO_COLOR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CODECAST_DIR", "RUN_DIR", "CLAUDE_ENV_FILE"]);
const keepEnv = (k: string) => AGENT_ENV.has(k) || /^(LC_|DRY_RUN_)/.test(k) || (process.env.DRY_RUN_PASS_ENV ?? "").split(",").map((n) => n.trim()).includes(k);
const realEnvHome = process.env.HOME || os.homedir();
if (!call) {
  for (const k of Object.keys(env)) if (!keepEnv(k)) delete env[k];
  const home = path.join(runDir, "home");
  fs.mkdirSync(home, { recursive: true });
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local", "share"), DRY_RUN_TAG: RUN_TAG });
}

/**
 * Every process the rep left running, the harness's own excepted, found two
 * ways because each misses what the other sees: the run's tag in its
 * environment (macOS hides the environment of its own system binaries, so a
 * detached /bin/sleep or perl shows no tag), and a working directory inside
 * the run dir (lsof), which any binary keeps unless it moves. A system binary
 * that detaches and leaves the run dir outlives the sweep, still inside the
 * sandbox: it cannot listen, write outside the run dir or reach anything, and
 * the harness's loopback ports close when the harness exits.
 */
function runPids(): number[] {
  // -x: a process that left its session (setsid) has no controlling terminal, and ps lists none of those without it.
  const tagged = (spawnSync("/bin/ps", ["-xEwwo", "pid=,command="], { encoding: "utf8", maxBuffer: 256 << 20 }).stdout ?? "").split("\n").filter((l) => l.includes(`DRY_RUN_TAG=${RUN_TAG}`)).map((l) => Number(l.trim().split(/\s+/, 1)[0]));
  const run = fs.realpathSync(runDir);
  const inRun: number[] = [];
  let pid = 0;
  for (const l of (spawnSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-u", String(process.getuid?.() ?? ""), "-Fpn"], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout ?? "").split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && (l.slice(1) === run || l.slice(1).startsWith(`${run}/`))) inRun.push(pid);
  }
  return [...new Set([...tagged, ...inRun])].filter((p) => p && p !== process.pid);
}
/** Kills everything the run started, a process that left the agent's group (setsid, nohup, a tmux server) included. */
function sweepRun(): number {
  const pids = runPids();
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  return pids.length;
}

/**
 * Live reads, run outside the sandbox. The agent cannot read the sign-in, so
 * its guard hands each live read here (DRY_RUN_BROKER) and this runs the
 * guard again with the real state directory. That guard classifies the argv
 * itself, so only a read ever runs with the sign-in, whoever calls the broker.
 * The broker lives as long as this process: an agent that outlives its
 * harness reaches nothing live at all.
 */
/**
 * What the agent must not be able to write, kept beside the run dir rather
 * than in it: the fake's world and command tree, the calls the fake answered,
 * the broker's live-read copies, and an empty directory the broker reads from.
 */
const harnessDir = `${runDir}.harness`;
const brokerCwdDefault = path.join(harnessDir, "cwd");
if (!call) {
  fs.rmSync(harnessDir, { recursive: true, force: true });
  fs.mkdirSync(brokerCwdDefault, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(runDir, "live-reads"), { recursive: true });
}

/** The calls the fake answered, each with its turn, as calls.log lines: the harness's record, merged into calls.log once the agent is gone. */
const answered: Array<{ turn: number; line: string }> = [];
let turnNo = 1;

/** An argv as the guard logs it (prompt-dry-run-bin/cast logged_argv): a word that is not plain is single-quoted. */
function loggedArgv(argv: string[]): string {
  // A line break is written as \\n (\\r): an argument can never start a line of its own in calls.log.
  return argv.map((raw) => {
    const a = raw.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    return /^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
  }).join(" ");
}

/**
 * The record of what the agent's `cast` calls did, which calls.log is
 * rebuilt from. A call opens with /begin (the guard posts its argv and gets
 * an id), and gets exactly one mark: this process writes the marks it
 * produces itself (LIVE, HELP, FAKED, FAKEERR, CLI), and accepts one the
 * guard posts (SERVED, UNSERVED, REFUSED, UNKNOWN) only when it is true of
 * that argv (verifyMark). The agent can post here too, so it can add a call,
 * which is the same as making it, but never a mark its argv does not earn,
 * and nothing before its first turn (the guard's preflight) is recorded.
 */
const calls = new Map<string, { argv: string[]; marked: boolean }>();
let recording = false;
let callSeq = 0;

function beginCall(argv: string[]): string {
  const id = `c${++callSeq}-${crypto.randomUUID().slice(0, 8)}`;
  calls.set(id, { argv, marked: false });
  if (recording) answered.push({ turn: turnNo, line: loggedArgv(argv) });
  return id;
}

/** One mark for a call: by id when the guard named one, else a call of its own (the agent posted to the broker directly). */
function markCall(id: string | null, argv: string[], mark: string): void {
  const call = id ? calls.get(id) : undefined;
  if (call?.marked) return;
  if (call) call.marked = true;
  else beginCall(argv);
  if (recording) answered.push({ turn: turnNo, line: `${mark} ${loggedArgv(call?.argv ?? argv)}` });
}

const POSTED_MARKS = ["SERVED", "UNSERVED", "REFUSED", "UNKNOWN"];

/** What the guard (with DRY_RUN_CLASSIFY) takes an argv for: read or write. */
async function classify(argv: string[]): Promise<string> {
  const p = Bun.spawn(["bash", path.join(guardDir, "cast"), ...argv], { env: { PATH: process.env.PATH ?? "", DRY_RUN_CLASSIFY: "1" }, cwd: brokerCwdDefault, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return (await new Response(p.stdout).text()).trim();
}

/** Whether the served record answers an argv, as the guard serves it (prompt-dry-run-bin/cast): its key, a prefix marker, the org files, or the proposals listing. */
function served(argv: string[]): boolean {
  if (!serveDir) return false;
  const two = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  if (/^org (inputs|health|ls|list)/.test(two) && ["org-inputs.json", "org-health.json", "org-ls.json"].some((f) => fs.existsSync(path.join(serveDir, f)))) return true;
  if (two === "org proposals" && !argv.some((a) => a.startsWith("--withdraw"))) return true;
  const reads = path.join(serveDir, "reads");
  if (fs.existsSync(path.join(reads, `${readKey(argv)}.out`))) return true;
  const joined = argv.map((a) => `${a}\x1f`).join("");
  return fs.existsSync(reads) && fs.readdirSync(reads).some((f) => f.endsWith(".prefix") && (() => { const pre = fs.readFileSync(path.join(reads, f), "utf8"); return pre.length < joined.length && joined.startsWith(pre); })());
}

/** Whether the served dir freezes an argv's verb (prompt-dry-run-bin/cast frozen). */
function frozen(argv: string[]): boolean {
  const f = serveDir ? path.join(serveDir, "frozen") : "";
  if (!f || !fs.existsSync(f)) return false;
  const lines = fs.readFileSync(f, "utf8").split("\n");
  return lines.includes("*") || lines.includes(argv[0] ?? "") || lines.includes(`${argv[0] ?? ""} ${argv[1] ?? ""}`);
}

/** Whether a mark the guard posted is true of its argv. */
async function verifyMark(argv: string[], mark: string): Promise<boolean> {
  if (mark === "UNKNOWN") return true;
  if (mark === "SERVED") return served(argv);
  const kind = await classify(argv);
  if (mark === "REFUSED") return kind === "write";
  if (mark === "UNSERVED") return kind === "read" && frozen(argv) && !served(argv);
  return false;
}

/** /begin: a call's argv, \0 separated; answers its id. */
function recordBegin(body: Buffer): Response {
  const argv = body.toString("utf8").split("\0");
  if (argv[argv.length - 1] === "") argv.pop();
  return new Response(`${beginCall(argv)}\n`);
}

/** /mark: `<id>\0<MARK>`, a mark the guard reached for the call it opened. */
async function recordMark(body: Buffer): Promise<Response> {
  const [id = "", mark = ""] = body.toString("utf8").split("\0");
  const call = calls.get(id);
  if (!call || call.marked || !POSTED_MARKS.includes(mark) || !(await verifyMark(call.argv, mark))) return new Response("refused\n", { status: 400 });
  markCall(id, call.argv, mark);
  return new Response("ok\n");
}

/** The served-read key of an argv (packages/evals/src/served.ts servedReadKey). */
const readKey = (argv: string[]) => new Bun.CryptoHasher("sha256").update(argv.map((a) => `${a}\x1f`).join("")).digest("hex");

/**
 * Where the broker's guard runs: a directory the agent cannot write and that
 * holds no bunfig.toml or env file. bun (and a compiled cast) runs a
 * bunfig.toml preload from its cwd, and a compiled cast loads .env from it,
 * so a cwd the agent could write would run its code outside the sandbox with
 * the real home folder. The agent's --cwd counts only when it sits outside
 * the run dir (a real checkout, read-only to the agent) and is clean; the
 * agent never chooses.
 */
function brokerCwd(): string {
  if (!agentCwd) return brokerCwdDefault;
  const cwd = fs.realpathSync(agentCwd);
  const run = fs.realpathSync(runDir);
  const agentWritable = cwd === run || cwd.startsWith(`${run}${path.sep}`);
  const loads = ["bunfig.toml", ".env", ".env.local", ".envrc"].some((f) => fs.existsSync(path.join(cwd, f)));
  return agentWritable || loads ? brokerCwdDefault : cwd;
}

/** The fake (--fake), held in this process: null without one. */
let fakeAnswer: ((argv: string[], stdin: string) => { out: string; exit: number; cli?: true } | null) | null = null;

/**
 * Live reads and fake answers, outside the sandbox. The agent cannot read the
 * sign-in, so its guard hands each live read here (DRY_RUN_BROKER) and this
 * runs the guard again with the real state directory; that guard classifies
 * the argv itself, so only a read ever runs with the sign-in, whoever calls
 * the broker. It runs in brokerCwd, with RUN_DIR pointed at the harness
 * directory and none of the fake's or the record's settings, and answers in
 * its reply: the exit code, the length of stderr, stderr, stdout. The broker
 * lives as long as this process: an agent that outlives its harness reaches
 * nothing live at all.
 */
function startBroker(): string {
  const brokerEnv: Record<string, string> = { ...env, HOME: realEnvHome, RUN_DIR: harnessDir, DRY_RUN_LIVE_READ: "1", DRY_RUN_BROKER: "", DRY_RUN_REAL_CODECAST_DIR: process.env.CODECAST_DIR ?? "" };
  // The real CLI reads its config where the shell keeps it, not in the agent's home.
  for (const k of ["DRY_RUN_FAKE", "DRY_RUN_FAKE_SEED", "DRY_RUN_FAKE_VIA_BROKER", "DRY_RUN_SERVE_DIR", "DRY_RUN_TAG", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete brokerEnv[k];
  for (const k of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) if (process.env[k]) brokerEnv[k] = process.env[k]!;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = Buffer.from(await req.arrayBuffer());
      const route = new URL(req.url).pathname;
      if (route === "/fake") return answerFake(body, Number(req.headers.get("x-dry-run-stdin-bytes") ?? 0), req.headers.get("x-dry-run-call"));
      const callId = req.headers.get("x-dry-run-call");
      if (route === "/begin") return recordBegin(body);
      if (route === "/mark") return recordMark(body);
      if (route === "/help") {
        const words = body.toString("utf8").split("\0").filter(Boolean);
        markCall(callId, [...words, "--help"], "HELP");
        return cliHelp(words);
      }
      if (route === "/tree") return cliNoSignIn(["agent-context", "--json"]);
      const argv = body.toString("utf8").split("\0");
      if (argv[argv.length - 1] === "") argv.pop();
      const p = Bun.spawn(["bash", path.join(guardDir, "cast"), ...argv], { env: brokerEnv, cwd: brokerCwd(), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const said = await new Response(p.stderr).text();
      await p.exited;
      // The broker's guard reads only what it takes for a read; what it refused (the agent posting a write here) is that.
      const log = path.join(harnessDir, "calls.log");
      const logged = loggedArgv(argv);
      const refusedHere = fs.existsSync(log) && fs.readFileSync(log, "utf8").split("\n").some((line) => line === `REFUSED ${logged}`);
      fs.rmSync(log, { force: true });
      markCall(callId, argv, refusedHere ? "REFUSED" : "LIVE");
      const copy = path.join(harnessDir, "live-reads", readKey(argv));
      const code = fs.existsSync(`${copy}.exit`) ? fs.readFileSync(`${copy}.exit`, "utf8").trim() || "1" : "1";
      const out = fs.existsSync(`${copy}.out`) ? fs.readFileSync(`${copy}.out`) : Buffer.alloc(0);
      const err = Buffer.from(said);
      return new Response(Buffer.concat([Buffer.from(`${code}\n${err.length}\n`), err, out]));
    },
  });
  return `http://127.0.0.1:${server.port}/read`;
}

/** One call to the fake: the first `stdinBytes` of the body are its stdin, the rest its argv, \0 separated. */
function answerFake(body: Buffer, stdinBytes: number, callId: string | null): Response {
  const stdin = body.subarray(0, stdinBytes).toString("utf8");
  const argv = body.subarray(stdinBytes).toString("utf8").split("\0");
  if (argv[argv.length - 1] === "") argv.pop();
  let a: ReturnType<NonNullable<typeof fakeAnswer>> = null;
  try {
    a = fakeAnswer ? fakeAnswer(argv, stdin) : null;
  } catch (e) {
    fs.appendFileSync(path.join(harnessDir, "fake-errors.log"), `${loggedArgv(argv)}: ${(e as Error).message}\n`);
  }
  if (!a) return new Response("125\n");
  markCall(callId, argv, a.cli ? "CLI" : a.exit === 0 ? "FAKED" : "FAKEERR");
  return new Response(`${a.exit}\n${a.out}`);
}

/**
 * The real CLI with no sign-in, outside the sandbox for the two things the
 * guard asks of it that never run a command: a command's --help and the
 * command tree. A dev checkout's cast is `bun main.ts`, which the closed
 * world cannot open, and a compiled one would run a bunfig.toml preload from
 * the agent's directory, so it runs here, in a directory the agent cannot
 * write, with an empty state directory and this process's own home.
 */
async function cliNoSignIn(args: string[]): Promise<Response> {
  const cast = realCast();
  if (!cast) return new Response("1\ndry run: no real cast on PATH\n");
  const state = path.join(harnessDir, "help-state");
  fs.mkdirSync(state, { recursive: true });
  const p = Bun.spawn([cast, ...args], { cwd: brokerCwdDefault, env: { PATH: process.env.PATH ?? "", HOME: harnessDir, CODECAST_DIR: state, CODECAST_NO_AUTO_UPDATE: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [out, err, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return new Response(`${status}\n${out}${err}`);
}

/** A command's help: its words alone, each a plain command word, then --help, so nothing else the agent typed reaches the CLI. */
async function cliHelp(words: string[]): Promise<Response> {
  if (words.length > 8 || !words.every((w) => /^[a-z][a-z0-9-]*$/.test(w))) return new Response("1\ndry run: help takes command words only\n");
  return cliNoSignIn([...words, "--help"]);
}

/** The first `cast` on PATH that is not the guard: the real CLI. */
function realCast(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, "cast");
    if (dir && path.resolve(dir) !== guardDir && fs.existsSync(p)) return p;
  }
  return null;
}

/** The fake, loaded into this process with the CLI's command tree, read by the real CLI with no sign-in in a directory the agent cannot write. */
async function loadFake(): Promise<void> {
  if (!fakeBin) return;
  const cast = realCast();
  const state = path.join(harnessDir, "cast-state");
  fs.mkdirSync(state, { recursive: true });
  const r = cast ? spawnSync(cast, ["agent-context", "--json"], { cwd: brokerCwdDefault, env: { PATH: process.env.PATH ?? "", HOME: harnessDir, CODECAST_DIR: state, CODECAST_NO_AUTO_UPDATE: "1" }, encoding: "utf8", maxBuffer: 256 << 20 }) : null;
  let tree: unknown = null;
  try { tree = r && r.status === 0 ? JSON.parse(r.stdout) : null; } catch { /* not the tree */ }
  if (!tree) refuse(`--fake needs the CLI's command tree, and \`cast agent-context --json\` did not give one (${!r ? "no cast on PATH" : r.status !== 0 ? `exit ${r.status}` : "its output is not JSON"})`);
  fs.writeFileSync(path.join(harnessDir, "cli-tree.json"), r!.stdout);
  const mod = await import(fakeBin);
  fakeAnswer = mod.openFake({ worldPath: path.join(harnessDir, "fake-world.json"), seed: fakeSeed ? JSON.parse(fs.readFileSync(fakeSeed, "utf8")) : undefined, tree });
}

/**
 * Every `cast` call the agent's Bash commands made, from the turn's stream
 * (kept where the agent cannot edit it), set against the record: a call the
 * record lacks went around the broker (a stripped DRY_RUN_BROKER, a copy of
 * the guard), so it joins the record with the mark it earns. A write is
 * REFUSED and a frozen read the record does not hold UNSERVED, which is what
 * the gates count; a command whose words the shell would expand is read by
 * its leading command words alone.
 */
async function reconcileRecord(): Promise<void> {
  const { splitShellCommand } = await import("../../shared/contracts/permissionRules.ts");
  for (let turn = 1; turn <= turnNo; turn++) {
    const file = path.join(harnessDir, turn === 1 ? "stream.jsonl" : `stream${turn}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const have = new Set(answered.filter((a) => a.turn === turn).map((a) => a.line));
    const missing: string[][] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"tool_use"')) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      for (const c of e?.message?.content ?? []) {
        if (c?.type !== "tool_use" || c.name !== "Bash" || typeof c.input?.command !== "string") continue;
        const cmd: string = c.input.command;
        const split = splitShellCommand(cmd);
        const argvs = split
          ? split.flatMap((words: string[]) => { const at = words.findIndex((w) => w === "cast" || w.endsWith("/cast")); return at < 0 ? [] : [words.slice(at + 1)]; })
          : [...cmd.matchAll(/(?:^|[\s;&|(])(?:\S*\/)?cast\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g)].map((m) => [m[1]!, ...(m[2] ? [m[2]] : [])]);
        for (const argv of argvs) {
          const logged = loggedArgv(argv);
          const known = split ? have.has(logged) : [...have].some((l) => l === logged || l.startsWith(`${logged} `));
          if (!known) missing.push(argv);
        }
      }
    }
    for (const argv of missing) {
      const kind = await classify(argv);
      const mark = kind === "write" ? "REFUSED" : frozen(argv) && !served(argv) ? "UNSERVED" : null;
      if (!mark) continue;
      answered.push({ turn, line: loggedArgv(argv) }, { turn, line: `${mark} ${loggedArgv(argv)}` });
      have.add(loggedArgv(argv));
    }
  }
}

/**
 * calls.log as the run leaves it, rebuilt from this process's record alone:
 * every argv and mark the guard reported (/mark), the fake's answers, and the
 * broker's own refusals, each in its turn. The calls.log the guard wrote in
 * the run dir is the agent's to edit, so nothing in it counts. Runs once the
 * agent and everything it started are gone.
 */
function mergeAnswered(): void {
  const file = path.join(runDir, "calls.log");
  const turns = new Map<number, string[]>([[1, []]]);
  for (let t = 2; t <= turnNo; t++) turns.set(t, []);
  for (const a of answered) (turns.get(a.turn) ?? turns.set(a.turn, []).get(a.turn)!).push(a.line);
  const out = [...turns.keys()].sort((a, b) => a - b).flatMap((t) => [...(t > 1 ? [`# turn ${t}`] : []), ...turns.get(t)!]);
  fs.writeFileSync(file, out.length ? `${out.join("\n")}\n` : "");
  fs.writeFileSync(path.join(harnessDir, "answered.log"), answered.map((a) => `${a.turn} ${a.line}`).join("\n") + (answered.length ? "\n" : ""));
}

if (!call) env.DRY_RUN_BROKER = startBroker();
if (!call) await loadFake();
const portOf = (url: string | undefined) => (url ? Number(new URL(url).port) : 0);

/** The hosts an agent may open a tunnel to: the model's API and Claude Code's own sign-in. */
const EGRESS_ALLOWED = /^(?:[a-z0-9-]+\.)*(?:anthropic\.com|claude\.ai)$/i;

/**
 * The one way off the machine an agent has: an HTTP CONNECT proxy
 * on the loopback that opens tunnels to Anthropic on 443 and answers anything
 * else 403. The sandbox refuses every other connection, so gh, a git remote
 * or curl reach nothing whatever sign-in they hold; tools that read the proxy
 * env are told no, the rest are refused by the kernel. Lives as long as this
 * process, like the broker.
 */
async function startEgressProxy(): Promise<string> {
  const server = net.createServer((client) => {
    client.once("data", (head) => {
      const line = head.toString("latin1").split("\r\n", 1)[0];
      const m = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(line);
      if (!m || m[2] !== "443" || !EGRESS_ALLOWED.test(m[1])) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = net.connect(443, m[1], () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    client.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}
let proxyUrl: string | undefined;
if (!call) {
  const proxy = (proxyUrl = await startEgressProxy());
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"]) env[k] = proxy;
  // The broker is on the loopback, and nothing else is reachable there anyway.
  env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost";
}

/** What an agent's Claude Code holds in place of the login: a token that opens nothing. */
const PLACEHOLDER_TOKEN = "sk-ant-oat01-dry-run-placeholder";
/** The model endpoints the agent's Claude Code calls; the model proxy forwards these and nothing else. */
const MODEL_PATHS = /^(?:HEAD \/api\/hello|POST \/v1\/messages(?:\/count_tokens)?|GET \/v1\/models(?:\/[^/]+)?)$/;

/**
 * The anthropic-beta values Claude Code sends on a turn (captured from real
 * haiku, sonnet and opus turns, 2.1.326, 2026-11-16); any other is dropped
 * before the request leaves, so a beta that would enable a feature reaching
 * past the model is never asked for. 1M-context models add context-1m-*.
 */
const MODEL_BETAS = new Set(["oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "claude-code-20250219", "per-turn-control-2026-07-01", "mid-conversation-tool-changes-2026-07-01", "thinking-token-count-2026-05-13", "advanced-tool-use-2025-11-20", "effort-2025-11-24", "extended-cache-ttl-2025-04-11"]);

/**
 * Why a model request is refused, or null: anything that has Anthropic act
 * beyond the model on the agent's behalf. A tool with a `type` is a server
 * tool (web fetch and search, code execution, a computer); mcp_servers and
 * container reach other hosts. Claude Code's own turns declare client tools
 * only, so none of these is ever its.
 */
/**
 * A URL inside a message or the system prompt, outside the arguments of a
 * tool call the agent already made: an image, a document or a file Anthropic
 * would fetch from any host (`source: {type: "url"}`), which reaches past the
 * model with no tool and no beta at all. Null when there is none.
 */
function urlInContent(node: unknown, at = ""): string | null {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) {
      const hit = urlInContent(v, `${at}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    // What a tool was called with is the agent's own record, never fetched.
    if (k === "input" && o.type === "tool_use") continue;
    if (/url$/i.test(k) && typeof v === "string") return `${at}.${k}`;
    if (k === "source" && v && typeof v === "object" && (v as Record<string, unknown>).type === "url") return `${at}.source`;
    const hit = urlInContent(v, `${at}.${k}`);
    if (hit) return hit;
  }
  return null;
}

function modelRequestRefusal(req: any): string | null {
  if (!req || typeof req !== "object" || Array.isArray(req)) return "a model request must be a JSON object";
  const url = urlInContent(req.messages, "messages") ?? urlInContent(req.system, "system");
  if (url) return `content Anthropic would fetch from a URL is not available here (${url})`;
  if ("mcp_servers" in req) return "mcp_servers would reach other hosts";
  if ("container" in req) return "a container runs code off the machine";
  const server = (Array.isArray(req.tools) ? req.tools : []).filter((t: any) => t && typeof t === "object" && "type" in t && t.type !== "custom");
  return server.length ? `server tools are not available here (${server.map((t: any) => t.type).join(", ")})` : null;
}

/**
 * The model, reached without the login ever entering the sandbox. Claude
 * Code inside reads its own process environment, and so can every process
 * in its session (sysctl KERN_PROCARGS2), the agent's Bash included, so the
 * real token cannot sit there. Claude Code gets a placeholder and this
 * address as ANTHROPIC_BASE_URL; each call to a model endpoint goes on to
 * Anthropic over TLS with the placeholder swapped for the real login, and
 * any other path is refused, so the agent cannot spend the login on the
 * account's own endpoints either.
 */
function startModelProxy(token: string): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (!MODEL_PATHS.test(`${req.method} ${u.pathname}`)) return new Response("dry run: only the model's endpoints are reachable\n", { status: 403 });
      let body: string | undefined;
      if (req.method === "POST") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await req.text());
        } catch {
          return new Response("dry run: a model request must be JSON\n", { status: 403 });
        }
        const refused = modelRequestRefusal(parsed);
        if (refused) return new Response(`dry run: ${refused}\n`, { status: 403 });
        // What was checked is what is sent: re-serialized, so no second parser can read the raw text another way (a duplicate key).
        body = JSON.stringify(parsed);
      }
      const headers = new Headers(req.headers);
      for (const h of ["host", "content-length", "content-encoding", "transfer-encoding"]) headers.delete(h);
      if (headers.get("authorization")?.includes(PLACEHOLDER_TOKEN)) headers.set("authorization", `Bearer ${token}`);
      const betas = (headers.get("anthropic-beta") ?? "").split(",").map((b) => b.trim()).filter((b) => b && (MODEL_BETAS.has(b) || /^context-1m-/.test(b)));
      if (betas.length) headers.set("anthropic-beta", betas.join(","));
      else headers.delete("anthropic-beta");
      const r = await fetch(`https://api.anthropic.com${u.pathname}${u.search}`, { method: req.method, headers, body } as RequestInit);
      const out = new Headers(r.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(r.body, { status: r.status, headers: out });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}
let modelUrl: string | undefined;
if (!call) {
  modelUrl = startModelProxy(env.CLAUDE_CODE_OAUTH_TOKEN!);
  env.CLAUDE_CODE_OAUTH_TOKEN = PLACEHOLDER_TOKEN;
  env.ANTHROPIC_BASE_URL = modelUrl;
  // The proxy env sends everything else to the egress proxy; the model's own address is on the loopback.
  env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost";
}

// The closed world, built once the harness knows the loopback ports it serves the run on.
const sandbox = call ? null : scratchSandbox(runDir, { guard: guardDir, serve: serveDir, read: [...(agentCwd ? [agentCwd, ...gitStoresOf(agentCwd)] : []), ...extraReads], ports: [portOf(env.DRY_RUN_BROKER), portOf(proxyUrl), portOf(modelUrl)] });
if (sandbox) Object.assign(env, sandbox.env);

/**
 * The guard answers before any agent starts. A guard that cannot reach the
 * real CLI (a here-string the sandbox refused, 2026-10-05) leaves an agent
 * with nothing that works but routes around it, so the run stops here: the
 * guard must answer a help call, in the agent's own sandbox and environment.
 */
// Not spawnSync: the guard's help call goes to the broker, which lives in this process.
async function guardPreflight(): Promise<string | null> {
  const dir = path.join(runDir, ".preflight");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, ".cast-help"), { recursive: true });
  const probe = 'cast task --help >/dev/null || exit 10; grep -q "^HELP task --help" "$RUN_DIR/calls.log" || exit 11';
  const p = Bun.spawn([sandbox!.prefix[0], ...sandbox!.prefix.slice(1), "bash", "-c", probe], { cwd: runDir, env: { ...env, RUN_DIR: dir, PWD: fs.realpathSync(runDir) }, stdout: "ignore", stderr: "pipe", timeout: 120_000 });
  const [stderr, status] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  fs.rmSync(dir, { recursive: true, force: true });
  if (status === 0) return null;
  if (status === 11) return "a cast call did not reach the guard";
  return `the guard could not answer cast task --help: ${(stderr || `exit ${status}`).trim().slice(0, 400)}`;
}
const guardGap = call ? null : await guardPreflight();
if (guardGap) { fs.rmSync(pidFile, { force: true }); refuse(`the dry run's guard is not usable, so no agent starts: ${guardGap}`); }
// A prod call has no thinking, no CLAUDE.md and no memory. What claude still
// adds on a subscription login is fixed: an SDK identity line in the system
// prompt and three short reminders (environment, model, date) before the
// prompt, about 175 input tokens (measured 2026-10-01 on 2.1.286).
// CLAUDE_CODE_SIMPLE would drop them but refuses OAuth.
if (call) Object.assign(env, callEnv(false));

const started = Date.now();
// The record starts with the agent: nothing the guard's preflight did is the turn's.
recording = true;

// The agent runs in a process group of its own (detached), so stopping this
// harness never stops it by itself: killing the harness's bun on 2026-10-05
// left two agents running, and both wrote to prod. A signal to the harness
// takes the agent's group down with it, and a watchdog outside the harness
// does the same when the harness dies by SIGKILL.
let liveChild: number | null = null;
const killGroup = (pid: number, sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch { /* gone */ } };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    if (liveChild) killGroup(liveChild, "SIGTERM");
    sweepRun();
    fs.rmSync(pidFile, { force: true });
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}
// After the group, every process carrying the run's tag ($3) or standing in the run dir ($4): what left the group (setsid, nohup) dies too (runPids).
const WATCHDOG = 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; kill -TERM -"$2" 2>/dev/null; sleep 5; kill -KILL -"$2" 2>/dev/null; { /bin/ps -xEwwo pid=,command= | awk -v t="DRY_RUN_TAG=$3" \'index($0, t) { print $1 }\'; /usr/sbin/lsof -a -d cwd -u "$(id -u)" -Fpn | awk -v r="$4" \'/^p/ { p = substr($0, 2) } /^n/ { n = substr($0, 2); if (n == r || index(n, r "/") == 1) print p }\'; } | grep -vx "$$" | xargs kill -KILL 2>/dev/null';
function watchChild(pid: number | undefined) {
  if (!pid) return null;
  const w = spawn("/bin/sh", ["-c", WATCHDOG, "watchdog", String(process.pid), String(pid), RUN_TAG, fs.realpathSync(runDir)], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  w.unref();
  return w;
}

/** One turn of the run: the opening (the prompt file on stdin as the whole
 *  user message, in --call mode as in an agent run), or a reply resumed into
 *  the same session (`promptText`). Writes <name>.json and <name>.txt;
 *  resolves with the exit code and the session id the result names. */
function runTurn(name: string, promptText?: string, resume?: string): Promise<{ code: number; sessionId?: string }> {
  return new Promise((resolve) => {
    // An agent's stream is written where the agent cannot edit it (the harness dir) and copied into the run dir
    // after the turn: it is the record of every command the turn ran (reconcileRecord).
    const streamName = name === "out" ? "stream.jsonl" : `${name.replace(/^out/, "stream")}.jsonl`;
    const streamPath = path.join(call ? runDir : harnessDir, streamName);
    const out = fs.openSync(streamPath, "w");
    const err = fs.openSync(path.join(runDir, name === "out" ? "err.txt" : `${name}.err.txt`), "w");
    const stdin = promptText === undefined ? fs.openSync(promptFile, "r") : "ignore";
    // A call's flags are the subscription call's own (src/subscriptionCall.ts callArgs).
    // --strict-mcp-config in an agent run too: a .mcp.json in any parent of the run dir
    // (the home folder's, say) otherwise starts its servers inside every rep.
    const turn = call
      ? callArgs({ model: model!, ...(systemFile ? { systemFile } : { systemText: NEUTRAL_SYSTEM }) })
      : [
          "--setting-sources", claudeMdFile ? "user,project" : "project",
          ...(resume ? ["--resume", resume] : []), "-p", ...(promptText === undefined ? [] : [promptText]), "--allowedTools", ...tools, "--dangerously-skip-permissions", "--strict-mcp-config",
          "--max-turns", maxTurns,
          "--model", model!,
          "--output-format", "stream-json", "--verbose",
        ];
    const command = [...(sandbox?.prefix ?? []), "claude"];
    // PWD names the real cwd: a shell whose PWD disagrees walks the parent directories to find it, and the sandbox hides those.
    const cwd = fs.realpathSync(agentCwd ?? runDir);
    const child = spawn(command[0], [...command.slice(1), ...turn], { cwd, env: { ...env, PWD: cwd }, stdio: [stdin, out, err], detached: true });
    const watchdog = watchChild(child.pid);
    liveChild = child.pid ?? null;
    child.on("exit", (exitCode) => {
      liveChild = null;
      try { watchdog?.kill(); } catch { /* already gone */ }
      fs.closeSync(out); fs.closeSync(err);
      if (typeof stdin === "number") fs.closeSync(stdin);
      let code = exitCode ?? 1;
      let reply = "(no result)";
      let sessionId: string | undefined;
      let said: string[] = [];
      try {
        // The stream is one JSON object per line: assistant messages as they
        // are produced, then the result. out.json keeps the result alone, the
        // shape every reader of these runs already parses.
        let result: any = null;
        const events: any[] = [];
        for (const line of fs.readFileSync(streamPath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          let d: any; try { d = JSON.parse(line); } catch { continue; }
          events.push(d);
          if (d.type === "result") result = d;
          else if (d.type === "assistant") for (const c of d.message?.content ?? []) if (c.type === "text" && c.text?.trim()) said.push(c.text.trim());
        }
        // A reply cut at max_tokens makes claude resume the turn ("Output token
        // limit hit", up to three times) and then end on an error. Prod gets the
        // first reply only, so that is what out.json reports: its text,
        // stop_reason and usage. Cost and modelUsage stay the run's real spend.
        const replies = call ? callReplies(events) : [];
        if (result && replies.length > 1 && replies[0].stop_reason === "max_tokens") {
          const first = replies[0];
          result = { ...result, result: first.text, stop_reason: first.stop_reason, usage: first.usage, is_error: false, num_turns: 1, resumed_past_cap: replies.length - 1 };
          said = [first.text.trim()];
          code = 0;
        }
        if (result) {
          fs.writeFileSync(path.join(runDir, `${name}.json`), JSON.stringify(result, null, 1));
          reply = `${result.result ?? ""}\n\n[cost_usd=${result.total_cost_usd} turns=${result.num_turns} is_error=${result.is_error}]`;
          sessionId = result.session_id;
        }
      } catch { /* claude wrote no stream: the err file says why */ }
      fs.writeFileSync(path.join(runDir, name === "out" ? "reply.txt" : name.replace(/^out/, "reply") + ".txt"), reply + "\n");
      const saidBase = path.join(runDir, name === "out" ? "said" : name.replace(/^out/, "said"));
      fs.writeFileSync(`${saidBase}.txt`, said.join("\n\n────────\n\n") + "\n");
      fs.writeFileSync(`${saidBase}.json`, JSON.stringify(said));
      if (!call && fs.existsSync(streamPath)) fs.copyFileSync(streamPath, path.join(runDir, streamName));
      resolve({ code, sessionId });
    });
  });
}

const first = await runTurn("out", undefined, seedSession);
let code = first.code;
let sessionId = first.sessionId;
for (const [i, file] of thenFiles.entries()) {
  const n = i + 2;
  if (code !== 0 || !sessionId) {
    fs.writeFileSync(path.join(runDir, `reply${n}.txt`), `(no turn ${n}: turn ${n - 1} exit ${code}, session ${sessionId ?? "unknown"})\n`);
    break;
  }
  fs.appendFileSync(path.join(runDir, "calls.log"), `# turn ${n}\n`);
  turnNo = n;
  const next = await runTurn(`out${n}`, fs.readFileSync(file, "utf8").trim(), sessionId);
  code = next.code;
  sessionId = next.sessionId ?? sessionId;
}
// Whatever the rep left running dies with it: swept.txt says how many, so a rep that tried to linger shows it.
if (!call) fs.writeFileSync(path.join(runDir, "swept.txt"), `${sweepRun()}\n`);
if (!call) await reconcileRecord();
if (!call) mergeAnswered();
fs.writeFileSync(path.join(runDir, "exit.txt"), `${code}\n`);
fs.writeFileSync(path.join(runDir, "took.txt"), `${Math.round((Date.now() - started) / 1000)}s\n`);
// The transcript and everything else claude wrote for this run go with the
// private config dir; nothing of it ever sat under ~/.claude/projects.
fs.rmSync(configDir, { recursive: true, force: true });
fs.rmSync(pidFile, { force: true });
console.log(`done ${path.basename(runDir)} (${Math.round((Date.now() - started) / 1000)}s, exit ${code})`);
process.exit(code);
