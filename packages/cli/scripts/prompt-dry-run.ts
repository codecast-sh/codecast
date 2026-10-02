#!/usr/bin/env bun
// THE harness for a prompt dry run: a headless `claude -p` that grades a prompt
// (the org analyzer, a role's standing text, a wake frame) and can never reach
// a person's inbox.
//
//   bun packages/cli/scripts/prompt-dry-run.ts --run <dir> --prompt <file> --model <id>
//        [--max-turns 80] [--tools Bash,Read,Write,Edit] [--guard <dir>] [--serve <dir>] [--then <file>]
//        [--account <profile>] [--max-output-tokens N]
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
//     finds is "Not authenticated" and cannot post, send or pin anything.
//  3. `cast` on PATH is the guard beside this script (prompt-dry-run-bin/cast,
//     or the directory given as --guard): reads pass through with the real
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
// `--then <file>` is a second turn: once the first result is in, the file's
// text is sent as the person's reply into the same session (claude --resume,
// same private config dir), and out2.json / reply2.txt hold that turn. It is
// how a conversational prompt is graded past its opening, since a dry run
// cannot hear a person. The config dir is removed after the last turn.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ccKeychainReadArgs, ccKeychainReadItems } from "../src/ccKeychain.ts";
import { accountTokenFilePath } from "../src/ccAccounts.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const runDir = path.resolve(arg("run") ?? "");
const promptFile = path.resolve(arg("prompt") ?? "");
function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}
if (!arg("run") || !arg("prompt") || !fs.existsSync(promptFile)) {
  refuse("usage: prompt-dry-run.ts --run <dir> --prompt <file> --model <id> [--call [--system <file>]] [--max-output-tokens N] [--max-turns N] [--tools A,B] [--guard <dir>] [--serve <dir>] [--account <profile>] [--then <reply file>]");
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
const thenFile = arg("then") ? path.resolve(arg("then")!) : undefined;
if (thenFile && !fs.existsSync(thenFile)) refuse(`--then: no such file ${thenFile}`);

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

fs.writeFileSync(path.join(runDir, "args.json"), JSON.stringify({ model, call, maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null, tools, maxTurns: Number(maxTurns), serve: serveDir ?? null, guard: guardDir }, null, 1) + "\n");

// CLAUDE_CODE_MAX_OUTPUT_TOKENS reaches the child only from --max-output-tokens,
// never inherited, so args.json says every cap the run had.
const DROP = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODECAST_LAUNCH_TOKEN", "CODECAST_SESSION_ID", "TMUX", "TMUX_PANE", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"]);
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP.has(k)) env[k] = v;
env.CLAUDE_CONFIG_DIR = configDir;
env.CLAUDE_CODE_OAUTH_TOKEN = arg("account") ? profileToken(arg("account")!) : loginToken();
env.CODECAST_DIR = noCast;
env.RUN_DIR = runDir;
env.DRY_RUN_REAL_CODECAST_DIR = process.env.CODECAST_DIR ?? "";
if (serveDir) env.DRY_RUN_SERVE_DIR = serveDir;
env.PATH = `${guardDir}:${env.PATH ?? ""}`;
if (maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = maxOutputTokens;
// A prod call has no thinking, no CLAUDE.md and no memory. What claude still
// adds on a subscription login is fixed: an SDK identity line in the system
// prompt and three short reminders (environment, model, date) before the
// prompt, about 175 input tokens (measured 2026-10-01 on 2.1.286).
// CLAUDE_CODE_SIMPLE would drop them but refuses OAuth.
if (call) Object.assign(env, { CLAUDE_CODE_DISABLE_THINKING: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_ATTACHMENTS: "1" });

const started = Date.now();

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
    const child = spawn("claude", [
      "--setting-sources", "project",
      ...turn,
      "--max-turns", maxTurns,
      "--model", model!,
      "--output-format", "stream-json", "--verbose",
      ...(call ? ["--include-partial-messages"] : []),
    ], { cwd: runDir, env, stdio: [stdin, out, err], detached: true });
    child.on("exit", (exitCode) => {
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
if (thenFile && first.code === 0 && first.sessionId) {
  const second = await runTurn("out2", fs.readFileSync(thenFile, "utf8").trim(), first.sessionId);
  code = second.code;
} else if (thenFile) {
  fs.writeFileSync(path.join(runDir, "reply2.txt"), `(no second turn: first turn exit ${first.code}, session ${first.sessionId ?? "unknown"})\n`);
}
fs.writeFileSync(path.join(runDir, "exit.txt"), `${code}\n`);
fs.writeFileSync(path.join(runDir, "took.txt"), `${Math.round((Date.now() - started) / 1000)}s\n`);
// The transcript and everything else claude wrote for this run go with the
// private config dir; nothing of it ever sat under ~/.claude/projects.
fs.rmSync(configDir, { recursive: true, force: true });
console.log(`done ${path.basename(runDir)} (${Math.round((Date.now() - started) / 1000)}s, exit ${code})`);
process.exit(code);
