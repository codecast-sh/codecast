#!/usr/bin/env bun
// THE harness for a prompt dry run: a headless `claude -p` that grades a prompt
// (the org analyzer, a role's standing text, a wake frame) and can never reach
// a person's inbox.
//
//   bun packages/cli/scripts/prompt-dry-run.ts --run <dir> --prompt <file>
//        [--max-turns 80] [--tools Bash,Read,Write,Edit] [--guard <dir>] [--serve <dir>]
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
//     finds is "Not authenticated" and cannot post, send or pin anything.
//  3. `cast` on PATH is the guard beside this script (prompt-dry-run-cast.sh,
//     or the one in --guard): reads pass through with the real state directory
//     restored, writes are refused and logged, and `--serve <dir>` answers
//     `cast org inputs` and `cast org health` from files there, so a run grades
//     the prompt against a record and never against a moving workspace.
//  4. No controlling terminal (start_new_session), no tmux variables, none of
//     the launching session's identity (CODECAST_SESSION_ID and friends).
//
// Output, in the run directory: out.json (the claude result), reply.txt (its
// final message and cost), exit.txt, took.txt, calls.log (every cast call the
// guard saw). The prompt file is read by the agent itself, so a prompt of any
// size works; the harness note (what to write instead of posting) belongs in
// that file, not here.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ccKeychainReadArgs, ccKeychainReadItems } from "../src/ccKeychain.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const runDir = path.resolve(arg("run") ?? "");
const promptFile = path.resolve(arg("prompt") ?? "");
if (!arg("run") || !arg("prompt") || !fs.existsSync(promptFile)) {
  console.error("usage: prompt-dry-run.ts --run <dir> --prompt <file> [--max-turns N] [--tools A,B] [--guard <dir>] [--serve <dir>]");
  process.exit(2);
}
const maxTurns = arg("max-turns", "80")!;
const tools = (arg("tools", "Bash,Read,Write,Edit") ?? "").split(",").filter(Boolean);
const guardDir = path.resolve(arg("guard") ?? path.join(import.meta.dir, "prompt-dry-run-bin"));
const serveDir = arg("serve") ? path.resolve(arg("serve")!) : undefined;

/** The machine login, best candidate first; the scoped item when this shell itself runs under a config dir. */
function loginToken(): string {
  for (const item of ccKeychainReadItems()) {
    const r = spawnSync("security", ccKeychainReadArgs(item), { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout.trim()) continue;
    try {
      const tok = JSON.parse(r.stdout.trim())?.claudeAiOauth?.accessToken;
      if (tok) return tok;
    } catch { /* not this item */ }
  }
  throw new Error("no Claude Code login in the keychain; run `claude` once on this machine");
}

fs.mkdirSync(runDir, { recursive: true });
const configDir = path.join(runDir, ".claude");
const noCast = path.join(runDir, ".nocast");
fs.rmSync(configDir, { recursive: true, force: true });
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(noCast, { recursive: true });

const DROP = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODECAST_LAUNCH_TOKEN", "CODECAST_SESSION_ID", "TMUX", "TMUX_PANE", "CLAUDE_CONFIG_DIR"]);
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP.has(k)) env[k] = v;
env.CLAUDE_CONFIG_DIR = configDir;
env.CLAUDE_CODE_OAUTH_TOKEN = loginToken();
env.CODECAST_DIR = noCast;
env.RUN_DIR = runDir;
env.DRY_RUN_REAL_CODECAST_DIR = process.env.CODECAST_DIR ?? "";
if (serveDir) env.DRY_RUN_SERVE_DIR = serveDir;
env.PATH = `${guardDir}:${env.PATH ?? ""}`;

const started = Date.now();
const out = fs.openSync(path.join(runDir, "out.json"), "w");
const err = fs.openSync(path.join(runDir, "err.txt"), "w");
const child = spawn("claude", [
  "--setting-sources", "project",
  "-p", `Your entire briefing is the file ${promptFile}. Read it in full first, then do what it says.`,
  "--allowedTools", ...tools,
  "--dangerously-skip-permissions",
  "--max-turns", maxTurns,
  "--output-format", "json",
], { cwd: runDir, env, stdio: ["ignore", out, err], detached: true });

child.on("exit", (code) => {
  fs.closeSync(out); fs.closeSync(err);
  fs.writeFileSync(path.join(runDir, "exit.txt"), `${code ?? 1}\n`);
  fs.writeFileSync(path.join(runDir, "took.txt"), `${Math.round((Date.now() - started) / 1000)}s\n`);
  let reply = "(no result)";
  try {
    const d = JSON.parse(fs.readFileSync(path.join(runDir, "out.json"), "utf8"));
    reply = `${d.result ?? ""}\n\n[cost_usd=${d.total_cost_usd} turns=${d.num_turns} is_error=${d.is_error}]`;
  } catch { /* claude wrote no json: err.txt says why */ }
  fs.writeFileSync(path.join(runDir, "reply.txt"), reply + "\n");
  // The transcript and everything else claude wrote for this run go with the
  // private config dir; nothing of it ever sat under ~/.claude/projects.
  fs.rmSync(configDir, { recursive: true, force: true });
  console.log(`done ${path.basename(runDir)} (${Math.round((Date.now() - started) / 1000)}s, exit ${code})`);
  process.exit(code ?? 1);
});
