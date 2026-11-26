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
//        [--system <file>] [--json-schema <file>] [--max-output-tokens N]
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
// `--fake <module>` gives the guard a fake service to ask before it refuses a
// write (a module exporting openFake, packages/evals/src/fakes/cast): a call
// the fake models is answered as prod would answer it, from a world kept
// beside the run, so the turn goes on past its first write and later calls
// see what it did. calls.log marks such a call FAKED. The fake runs once per
// call in a process of its own inside the closed world (prompt-dry-run-fake.ts),
// writing only its world, so whatever its code does it can only answer
// wrongly; a call it does not model is refused as before.
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
import { spawn } from "node:child_process";
import { NEUTRAL_SYSTEM, callArgs, callEnv, callReplies, isolatedEnv, loginToken, profileToken } from "../src/subscriptionCall.ts";
// The harness's parts, each beside this file: the closed world, the broker and
// its record, the fake's call path, the proxies, and the sweep.
import { startBroker } from "./prompt-dry-run-broker.ts";
import { setContext } from "./prompt-dry-run-context.ts";
import { runExec } from "./prompt-dry-run-exec.ts";
import { loadFake } from "./prompt-dry-run-fakecall.ts";
import { PLACEHOLDER_TOKEN, startEgressProxy, startModelProxy } from "./prompt-dry-run-model.ts";
import { mergeAnswered, reconcileRecord, setTurn, startRecording } from "./prompt-dry-run-record.ts";
import { gitStoresOf, refuse, scratchIsolationGap, scratchSandbox } from "./prompt-dry-run-sandbox.ts";
import { WATCHDOG, sweepRun } from "./prompt-dry-run-sweep.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (process.argv.includes("--isolation-check")) {
  const probeRun = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "dry-run-isolation-"));
  const gap = scratchIsolationGap(probeRun, path.resolve(arg("guard") ?? path.join(import.meta.dir, "prompt-dry-run-bin")));
  fs.rmSync(probeRun, { recursive: true, force: true });
  console.log(gap ? `not isolated: ${gap}` : "isolated");
  process.exit(gap ? 3 : 0);
}

// `--exec`: one command in the closed world (prompt-dry-run-exec.ts); it exits with the command.
if (process.argv.includes("--exec")) await runExec();

const runDir = path.resolve(arg("run") ?? "");
const promptFile = path.resolve(arg("prompt") ?? "");

if (!arg("run") || !arg("prompt") || !fs.existsSync(promptFile)) {
  refuse("usage: prompt-dry-run.ts --run <dir> --prompt <file> --model <id> [--call [--system <file>] [--json-schema <file>]] [--max-output-tokens N] [--max-turns N] [--tools A,B] [--guard <dir>] [--serve <dir>] [--account <profile>] [--then <file>]... [--claude-md <file>] [--seed <jsonl>]");
}
const model = arg("model");
if (!model || model.startsWith("--")) refuse("--model is required: an unpinned run takes the account default and cannot be compared");
const call = process.argv.includes("--call");
if (call) {
  for (const f of ["then", "tools", "max-turns"]) if (process.argv.includes(`--${f}`)) refuse(`--${f} does not apply to --call: a call is one turn with no tools`);
} else if (process.argv.includes("--system")) refuse("--system applies only to --call");
const systemFile = arg("system") ? path.resolve(arg("system")!) : undefined;
if (systemFile && !fs.existsSync(systemFile)) refuse(`--system: no such file ${systemFile}`);
const jsonSchemaFile = arg("json-schema") ? path.resolve(arg("json-schema")!) : undefined;
if (jsonSchemaFile && !call) refuse("--json-schema applies only to --call");
if (jsonSchemaFile && !fs.existsSync(jsonSchemaFile)) refuse(`--json-schema: no such file ${jsonSchemaFile}`);
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
// The agent runs a copy of the guard with this run's broker baked in (bakeGuard); the original stays the broker's.
const agentGuardDir = call ? guardDir : path.join(`${runDir}.harness`, "guard");
env.PATH = `${agentGuardDir}:${env.PATH ?? ""}`;
// The Bash tool runs each command over a snapshot of the user's shell, and a
// snapshot cut short under load carries no PATH line, so the command sources
// the profile and its `~/.local/bin` puts the real cast first (7 of 8 parallel
// runs at load 650, 2026-10-02). Claude Code sources CLAUDE_ENV_FILE before
// every command, after the profile, so the guard is first on every call.
const envFile = path.join(configDir, "dry-run-env.sh");
fs.writeFileSync(envFile, `export PATH='${agentGuardDir.replace(/'/g, `'\\''`)}':"$PATH"\n`);
env.CLAUDE_ENV_FILE = envFile;
// A `cast` reached around the guard anyway, by an absolute path or a login
// shell, finds the empty state directory and hands the call to the guard
// (src/main.ts), so no call leaves the served world whatever PATH it took.
env.DRY_RUN_GUARD = path.join(agentGuardDir, "cast");
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

const fakeDir = path.join(harnessDir, "fake");
setContext({ runDir, harnessDir, brokerCwdDefault, guardDir, agentGuardDir, serveDir, agentCwd, fakeBin, fakeSeed, fakeDir, env, realEnvHome, RUN_TAG });

if (!call) env.DRY_RUN_BROKER = startBroker();
if (!call) await loadFake();

/**
 * The guard the agent runs: a copy of this run's guard directory with the
 * broker's address, the served record and the fake's flag written into it,
 * beside the run where the agent cannot edit it (the sandbox lets it read and
 * run the copy, never write it). Its environment no longer decides where a
 * call is recorded, so a write run through a script, eval or a subprocess
 * with DRY_RUN_BROKER blanked is recorded all the same.
 */
function bakeGuard(): void {
  const quote = (v: string) => {
    if (/['\n]/.test(v)) refuse(`a path the guard is baked with holds a quote or a line break: ${v}`);
    return `'${v}'`;
  };
  fs.mkdirSync(agentGuardDir, { recursive: true });
  for (const f of fs.readdirSync(guardDir)) {
    const from = path.join(guardDir, f);
    if (!fs.statSync(from).isFile()) continue;
    let text = fs.readFileSync(from, "utf8");
    if (f === "cast") {
      const line = 'BAKED_BROKER=""; BAKED_SERVE=""; BAKED_FAKE=""';
      // A launcher's own guard (--guard) without the line runs as it is: it never reaches the broker.
      text = text.replace(line, `BAKED_BROKER=${quote(env.DRY_RUN_BROKER!)}; BAKED_SERVE=${quote(serveDir ?? "")}; BAKED_FAKE=${quote(fakeBin ? "1" : "")}`);
    }
    fs.writeFileSync(path.join(agentGuardDir, f), text, { mode: 0o755 });
  }
}
if (!call) bakeGuard();
const portOf = (url: string | undefined) => (url ? Number(new URL(url).port) : 0);

let proxyUrl: string | undefined;
if (!call) {
  const proxy = (proxyUrl = await startEgressProxy());
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"]) env[k] = proxy;
  // The broker is on the loopback, and nothing else is reachable there anyway.
  env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost";
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
const sandbox = call ? null : scratchSandbox(runDir, { guard: agentGuardDir, serve: serveDir, ...((): { read: string[]; readFiles: string[]; deny: string[] } => {
  const g = agentCwd ? gitStoresOf(agentCwd) : { dirs: [], files: [], deny: [] };
  return { read: [...(agentCwd ? [agentCwd] : []), ...g.dirs, ...extraReads], readFiles: g.files, deny: g.deny };
})(), ports: [portOf(env.DRY_RUN_BROKER), portOf(proxyUrl), portOf(modelUrl)] });
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
startRecording();

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
      ? callArgs({ model: model!, ...(systemFile ? { systemFile } : { systemText: NEUTRAL_SYSTEM }), ...(jsonSchemaFile ? { jsonSchema: fs.readFileSync(jsonSchemaFile, "utf8") } : {}) })
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
  setTurn(n);
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
