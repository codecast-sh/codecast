#!/usr/bin/env bun
// THE harness for a prompt dry run: a headless `claude -p` that grades a prompt
// (the org analyzer, a role's standing text, a wake frame) and can never reach
// a person's inbox.
//
//   bun packages/cli/scripts/prompt-dry-run.ts --run <dir> --prompt <file> --model <id>
//        [--max-turns 80] [--tools Bash,Read,Write,Edit] [--guard <dir>] [--serve <dir>] [--then <file>]
//        [--account <profile>] [--max-output-tokens N] [--claude-md <file>]
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
// `--then <file>` is a later turn: once the previous result is in, the file's
// text is sent as the next message into the same session (claude --resume,
// same private config dir). Repeat it for more turns, in order; turn N writes
// outN.json, replyN.txt and saidN.json, and calls.log gets a `# turn N` line
// before its calls. It is how a conversational prompt is graded past its
// opening, since a dry run cannot hear a person, and how a standing session's
// later wakes are replayed after its opening. A turn that fails ends the run.
// The config dir is removed after the last turn.
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
import { ccKeychainReadArgs, ccKeychainReadItems } from "../src/ccKeychain.ts";
import { accountTokenFilePath, fleetStoreDir, fleetStoreEnabled } from "../src/ccAccounts.ts";

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

/** Every file under the shared temp dirs is off limits; the run dir and the
 *  directories the run reads from stay reachable even when they sit there.
 *  The credential dirs are unreadable, the guard cannot be rewritten, and no
 *  process outside the run can be driven from it (a tmux server's socket
 *  under /tmp, Apple events to Terminal). Paths arrive as -D parameters, so no
 *  path is ever quoted into the profile. */
function scratchProfile(hidden: number): string {
  return [
    "(version 1)",
    "(allow default)",
    '(deny file-read* file-write* (regex #"^/private/(var/)?tmp/"))',
    '(deny network-outbound (remote unix-socket (path-regex #"^/private/(var/)?tmp/")))',
    "(deny appleevent-send)",
    '(allow file-read* file-write* (subpath (param "RUN_DIR")))',
    '(allow file-read* (subpath (param "GUARD_DIR")) (subpath (param "SERVE_DIR")))',
    '(deny file-write* (subpath (param "GUARD_DIR")))',
    ...Array.from({ length: hidden }, (_, i) => `(deny file-read* file-write* (subpath (param "HIDDEN_${i}")))`),
  ].join("\n");
}

/** The argv prefix that runs a command with private scratch, and the env it needs. */
function scratchSandbox(run: string, readable: { guard: string; serve?: string }) {
  const scratch = path.join(run, "tmp");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : p);
  const hidden = credentialDirs().map(real);
  const prefix = [
    "sandbox-exec", "-D", `RUN_DIR=${real(run)}`, "-D", `GUARD_DIR=${real(readable.guard)}`, "-D", `SERVE_DIR=${real(readable.serve ?? run)}`,
    ...hidden.flatMap((dir, i) => ["-D", `HIDDEN_${i}=${dir}`]),
    "-p", scratchProfile(hidden.length),
  ];
  return { prefix, hidden, env: { TMPDIR: `${scratch}/`, TMP: scratch, TEMP: scratch, CLAUDE_CODE_TMPDIR: scratch } };
}

/** Whether the sandbox applies here and does what it claims: a write to /tmp
 *  is refused while one to the run's scratch lands. Null when it does, else why not. */
function scratchIsolationGap(run: string, guard: string): string | null {
  if (process.platform !== "darwin") return `no sandbox-exec on ${process.platform}`;
  const sb = scratchSandbox(run, { guard });
  const probe = `p=/tmp/.dry-run-probe-$$; if ( : > "$p" ) 2>/dev/null; then rm -f "$p"; exit 3; fi; : > "$TMPDIR/probe" || exit 4; rm -f "$TMPDIR/probe"; for d in "$@"; do [ -e "$d" ] && ls "$d" >/dev/null 2>&1 && exit 5; done; exit 0`;
  const r = spawnSync(sb.prefix[0], [...sb.prefix.slice(1), "/bin/sh", "-c", probe, "probe", ...sb.hidden], { env: { ...process.env, ...sb.env }, encoding: "utf8" });
  if (r.status === 0) return null;
  if (r.status === 3) return "sandbox-exec ran but /tmp stayed writable";
  if (r.status === 4) return "sandbox-exec refused the run's own scratch dir";
  if (r.status === 5) return "sandbox-exec ran but the sign-in directories stayed readable";
  return `sandbox-exec would not apply: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`;
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
  refuse("usage: prompt-dry-run.ts --run <dir> --prompt <file> --model <id> [--call [--system <file>]] [--max-output-tokens N] [--max-turns N] [--tools A,B] [--guard <dir>] [--serve <dir>] [--account <profile>] [--then <file>]... [--claude-md <file>]");
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
if (claudeMdFile && call) refuse("--claude-md does not apply to --call: a call carries no CLAUDE.md");
if (claudeMdFile && !fs.existsSync(claudeMdFile)) refuse(`--claude-md: no such file ${claudeMdFile}`);

/** A saved profile's setup token (`cast accounts token <name>`): a fixed sign-in
 *  in a 0600 env file, so a run can spend that account's window while the
 *  machine's login stays untouched. `--account <profile>` picks it; the token
 *  still reaches the child through its environment only. */
function profileToken(name: string): string {
  const file = accountTokenFilePath(name);
  if (!fs.existsSync(file)) throw new Error(`profile ${name} has no setup token; mint one with: cast accounts token ${name}`);
  const m = fs.readFileSync(file, "utf8").match(/CLAUDE_CODE_OAUTH_TOKEN=['"]?([^'"\s]+)/);
  if (!m) throw new Error(`no CLAUDE_CODE_OAUTH_TOKEN in ${file}`);
  return m[1];
}
/** The login a run spends: the fleet store's item, which the daemon rewrites
 *  on every account switch, then the machine item (or the scoped one when this
 *  shell runs under a config dir) for a machine without a fleet store. */
function loginToken(): string {
  const items = [...(fleetStoreEnabled() ? ccKeychainReadItems(fleetStoreDir()) : []), ...ccKeychainReadItems()];
  for (const item of items) {
    const r = spawnSync("security", ccKeychainReadArgs(item), { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout.trim()) continue;
    try {
      const tok = JSON.parse(r.stdout.trim())?.claudeAiOauth?.accessToken;
      if (tok) return tok;
    } catch { /* not this item */ }
  }
  throw new Error("no Claude Code login in the keychain or the fleet store; run `claude` once on this machine, or pass --account <profile>");
}

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
if (claudeMdFile) fs.copyFileSync(claudeMdFile, path.join(configDir, "CLAUDE.md"));

// A --call run has no tools, so nothing in it can write scratch or reach a
// sign-in. An agent run without its sandbox could read the codecast sign-in
// and write around the guard, so it does not start.
const isolationGap = call ? null : scratchIsolationGap(runDir, guardDir);
if (isolationGap) { fs.rmSync(pidFile, { force: true }); refuse(`an agent run needs its sandbox, and this machine cannot give it one (${isolationGap}): without it the agent could read the codecast sign-in and write around the guard`); }
const sandbox = call ? null : scratchSandbox(runDir, { guard: guardDir, serve: serveDir });
const isolation = call ? null : "sandbox-exec";

fs.writeFileSync(path.join(runDir, "args.json"), JSON.stringify({ model, call, maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null, tools, maxTurns: Number(maxTurns), serve: serveDir ?? null, guard: guardDir, isolation, claudeMd: claudeMdFile ?? null }, null, 1) + "\n");

// CLAUDE_CODE_MAX_OUTPUT_TOKENS reaches the child only from --max-output-tokens,
// never inherited, so args.json says every cap the run had.
const DROP = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODECAST_LAUNCH_TOKEN", "CODECAST_SESSION_ID", "TMUX", "TMUX_PANE", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"]);
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP.has(k)) env[k] = v;
env.CLAUDE_CONFIG_DIR = configDir;
env.CLAUDE_CODE_OAUTH_TOKEN = arg("account") ? profileToken(arg("account")!) : loginToken();
env.CODECAST_DIR = noCast;
env.RUN_DIR = runDir;
if (serveDir) env.DRY_RUN_SERVE_DIR = serveDir;
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
if (maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = maxOutputTokens;
if (sandbox) Object.assign(env, sandbox.env);

/**
 * Live reads, run outside the sandbox. The agent cannot read the sign-in, so
 * its guard hands each live read here (DRY_RUN_BROKER) and this runs the
 * guard again with the real state directory. That guard classifies the argv
 * itself, so only a read ever runs with the sign-in, whoever calls the broker.
 * The broker lives as long as this process: an agent that outlives its
 * harness reaches nothing live at all.
 */
function startBroker(): string {
  const brokerEnv = { ...env, DRY_RUN_LIVE_READ: "1", DRY_RUN_BROKER: "", DRY_RUN_REAL_CODECAST_DIR: process.env.CODECAST_DIR ?? "" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const argv = Buffer.from(await req.arrayBuffer()).toString("utf8").split("\0");
      if (argv[argv.length - 1] === "") argv.pop();
      const p = Bun.spawn(["bash", path.join(guardDir, "cast"), ...argv], { env: brokerEnv, cwd: runDir, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const said = await new Response(p.stderr).text();
      await p.exited;
      return new Response(said);
    },
  });
  return `http://127.0.0.1:${server.port}/read`;
}
if (!call) env.DRY_RUN_BROKER = startBroker();

/**
 * The guard answers before any agent starts. A guard that cannot reach the
 * real CLI (a here-string the sandbox refused, 2026-10-05) leaves an agent
 * with nothing that works but routes around it, so the run stops here: the
 * guard must answer a help call, in the agent's own sandbox and environment.
 */
function guardPreflight(): string | null {
  const dir = path.join(runDir, ".preflight");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const probe = 'cast task --help >/dev/null || exit 10; grep -q "^HELP task --help" "$RUN_DIR/calls.log" || exit 11';
  const r = spawnSync(sandbox!.prefix[0], [...sandbox!.prefix.slice(1), "bash", "-c", probe], { env: { ...env, RUN_DIR: dir }, encoding: "utf8", timeout: 120_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status === 0) return null;
  if (r.status === 11) return "a cast call did not reach the guard";
  return `the guard could not answer cast task --help: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 400)}`;
}
const guardGap = call ? null : guardPreflight();
if (guardGap) { fs.rmSync(pidFile, { force: true }); refuse(`the dry run's guard is not usable, so no agent starts: ${guardGap}`); }
// A prod call has no thinking, no CLAUDE.md and no memory. What claude still
// adds on a subscription login is fixed: an SDK identity line in the system
// prompt and three short reminders (environment, model, date) before the
// prompt, about 175 input tokens (measured 2026-10-01 on 2.1.286).
// CLAUDE_CODE_SIMPLE would drop them but refuses OAuth.
if (call) Object.assign(env, { CLAUDE_CODE_DISABLE_THINKING: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_ATTACHMENTS: "1" });

const started = Date.now();

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
    fs.rmSync(pidFile, { force: true });
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}
const WATCHDOG = 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; kill -TERM -"$2" 2>/dev/null; sleep 5; kill -KILL -"$2" 2>/dev/null';
function watchChild(pid: number | undefined) {
  if (!pid) return null;
  const w = spawn("/bin/sh", ["-c", WATCHDOG, "watchdog", String(process.pid), String(pid)], { detached: true, stdio: "ignore" });
  w.unref();
  return w;
}

/** The system prompt of a --call run with no --system file: prod calls without
 *  a system prompt send none, and claude always sends one, so it is one short
 *  neutral line rather than Claude Code's own. */
const NEUTRAL_SYSTEM = "Follow the user's instructions.";

/** Each model response of a --call run, folded from its partial-message
 *  stream events: the text, stop_reason and usage the API returned. */
function callReplies(events: any[]): { text: string; stop_reason: string | null; usage: Record<string, unknown> }[] {
  const replies: { text: string; stop_reason: string | null; usage: Record<string, unknown> }[] = [];
  for (const d of events) {
    const e = d.type === "stream_event" ? d.event : undefined;
    if (e?.type === "message_start") replies.push({ text: "", stop_reason: null, usage: { ...e.message?.usage } });
    const r = replies[replies.length - 1];
    if (!r) continue;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") r.text += e.delta.text;
    if (e?.type === "message_delta") { r.stop_reason = e.delta?.stop_reason ?? null; Object.assign(r.usage, e.usage); }
  }
  return replies;
}

/** One turn of the run: the opening (the prompt file on stdin as the whole
 *  user message, in --call mode as in an agent run), or a reply resumed into
 *  the same session (`promptText`). Writes <name>.json and <name>.txt;
 *  resolves with the exit code and the session id the result names. */
function runTurn(name: string, promptText?: string, resume?: string): Promise<{ code: number; sessionId?: string }> {
  return new Promise((resolve) => {
    const streamPath = path.join(runDir, name === "out" ? "stream.jsonl" : `${name.replace(/^out/, "stream")}.jsonl`);
    const out = fs.openSync(streamPath, "w");
    const err = fs.openSync(path.join(runDir, name === "out" ? "err.txt" : `${name}.err.txt`), "w");
    const stdin = promptText === undefined ? fs.openSync(promptFile, "r") : "ignore";
    const turn = call
      ? ["-p", "--tools", "", ...(systemFile ? ["--system-prompt-file", systemFile] : ["--system-prompt", NEUTRAL_SYSTEM]), "--strict-mcp-config", "--disable-slash-commands"]
      : [...(resume ? ["--resume", resume] : []), "-p", ...(promptText === undefined ? [] : [promptText]), "--allowedTools", ...tools, "--dangerously-skip-permissions"];
    const command = [...(sandbox?.prefix ?? []), "claude"];
    const child = spawn(command[0], [
      ...command.slice(1),
      "--setting-sources", claudeMdFile ? "user,project" : "project",
      ...turn,
      "--max-turns", maxTurns,
      "--model", model!,
      "--output-format", "stream-json", "--verbose",
      ...(call ? ["--include-partial-messages"] : []),
    ], { cwd: runDir, env, stdio: [stdin, out, err], detached: true });
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
      resolve({ code, sessionId });
    });
  });
}

const first = await runTurn("out");
let code = first.code;
let sessionId = first.sessionId;
for (const [i, file] of thenFiles.entries()) {
  const n = i + 2;
  if (code !== 0 || !sessionId) {
    fs.writeFileSync(path.join(runDir, `reply${n}.txt`), `(no turn ${n}: turn ${n - 1} exit ${code}, session ${sessionId ?? "unknown"})\n`);
    break;
  }
  fs.appendFileSync(path.join(runDir, "calls.log"), `# turn ${n}\n`);
  const next = await runTurn(`out${n}`, fs.readFileSync(file, "utf8").trim(), sessionId);
  code = next.code;
  sessionId = next.sessionId ?? sessionId;
}
fs.writeFileSync(path.join(runDir, "exit.txt"), `${code}\n`);
fs.writeFileSync(path.join(runDir, "took.txt"), `${Math.round((Date.now() - started) / 1000)}s\n`);
// The transcript and everything else claude wrote for this run go with the
// private config dir; nothing of it ever sat under ~/.claude/projects.
fs.rmSync(configDir, { recursive: true, force: true });
fs.rmSync(pidFile, { force: true });
console.log(`done ${path.basename(runDir)} (${Math.round((Date.now() - started) / 1000)}s, exit ${code})`);
process.exit(code);
