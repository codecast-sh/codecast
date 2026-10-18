// One model call on a Claude Code subscription login instead of the metered
// API (docs/architecture/learning-loop.md LL10): the same system prompt, the
// same user message, the same model, no tools, one turn, and the reply read
// the way the server reads an API reply (runModelCall), so a judge's answer
// parses through the one parser whichever side made it.
//
// The isolation is the dry-run harness's (scripts/prompt-dry-run.ts --call,
// which builds on the pieces here): the codecast daemon syncs every transcript
// under ~/.claude/projects as a session, so a call runs under a private
// CLAUDE_CONFIG_DIR that holds no settings, hooks or memory and is removed
// after; the login reaches the child as CLAUDE_CODE_OAUTH_TOKEN in its
// environment alone; and every model key the shell carries is stripped, since
// claude bills an ANTHROPIC_API_KEY ahead of the login (and this machine's
// shell holds a customer's OPENROUTER_API_KEY).
//
// What claude still adds that the API call lacks: an SDK identity line in the
// system prompt and three short reminders (environment, model, date) before
// the prompt, about 175 input tokens (measured 2026-10-01 on 2.1.286).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "./proc.js";
import { ccKeychainReadArgs, ccKeychainReadItems } from "./ccKeychain.js";
import { accountTokenFilePath, fleetStoreDir, fleetStoreEnabled } from "./ccAccounts.js";
import { stableClaudeBinary, resolveClaudeInstall } from "./stableClaudeBinary.js";
import { modelCallProblem, parseJsonBlock, type ModelCallResult, type ModelCallSpec } from "@codecast/shared/contracts/modelCall";
import { sendsThinkingOff } from "@codecast/shared/contracts/modelOptions";

/** A saved profile's setup token (`cast accounts token <name>`): a fixed sign-in in a 0600 env file. */
export function profileToken(name: string): string {
  const file = accountTokenFilePath(name);
  if (!fs.existsSync(file)) throw new Error(`profile ${name} has no setup token; mint one with: cast accounts token ${name}`);
  const m = fs.readFileSync(file, "utf8").match(/CLAUDE_CODE_OAUTH_TOKEN=['"]?([^'"\s]+)/);
  if (!m) throw new Error(`no CLAUDE_CODE_OAUTH_TOKEN in ${file}`);
  return m[1]!;
}

/** The login a call spends: the fleet store's item, which the daemon rewrites
 *  on every account switch, then the machine item (or the scoped one when this
 *  shell runs under a config dir) for a machine without a fleet store. */
export function loginToken(): string {
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

/** What a child never inherits: the launching session's identity, its config dir and output cap. */
const DROP = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODECAST_LAUNCH_TOKEN", "CODECAST_SESSION_ID", "TMUX", "TMUX_PANE", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"]);
/** Every way the shell could route a call off the subscription: a model key (claude bills ANTHROPIC_API_KEY ahead of the login), a gateway, a cloud provider. */
const MODEL_ROUTE = /^(?:[A-Z0-9_]*_API_KEY|ANTHROPIC_[A-Z_]+|CLAUDE_CODE_USE_[A-Z]+|AWS_[A-Z_]+|GOOGLE_APPLICATION_CREDENTIALS|OPENROUTER_[A-Z_]+)$/;

/** The child env of an isolated claude: the parent's minus DROP, minus every model route when `stripModelKeys`. */
export function isolatedEnv(opts: { configDir: string; token: string; stripModelKeys: boolean; maxOutputTokens?: number }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || DROP.has(k) || (opts.stripModelKeys && MODEL_ROUTE.test(k))) continue;
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = opts.configDir;
  env.CLAUDE_CODE_OAUTH_TOKEN = opts.token;
  if (opts.maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(opts.maxOutputTokens);
  return env;
}

/** The env that makes one claude turn a bare call: no CLAUDE.md, no memory, no attachments, and thinking only where the API call has it. */
export function callEnv(thinking: boolean): Record<string, string> {
  return { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_ATTACHMENTS: "1", ...(thinking ? {} : { CLAUDE_CODE_DISABLE_THINKING: "1" }) };
}

/** The claude flags of a bare call: one turn, no tools, no MCP, no slash commands, settings from nowhere, and the given system prompt in place of Claude Code's. */
export function callArgs(o: { model: string; systemFile?: string; systemText?: string; effort?: string }): string[] {
  return [
    "--setting-sources", "project",
    "-p", "--tools", "",
    ...(o.systemFile ? ["--system-prompt-file", o.systemFile] : ["--system-prompt", o.systemText ?? NEUTRAL_SYSTEM]),
    "--strict-mcp-config", "--disable-slash-commands",
    "--max-turns", "1",
    "--model", o.model,
    ...(o.effort ? ["--effort", o.effort] : []),
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  ];
}

/** The system prompt of a call that has none: claude always sends one, so it is one short neutral line rather than Claude Code's own. */
export const NEUTRAL_SYSTEM = "Follow the user's instructions.";

export type CallReply = { text: string; stop_reason: string | null; usage: Record<string, unknown> };

/** Each model response of a call, folded from its partial-message stream events: the text, stop_reason and usage the API returned. */
export function callReplies(events: any[]): CallReply[] {
  const replies: CallReply[] = [];
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

/** The first reply of a call's stream, which is what the API call gets: a reply cut at max_tokens makes claude resume the turn, and the API never does. */
export function firstReply(stream: string): { reply: CallReply | null; result: any; thought: boolean } {
  const events: any[] = [];
  let result: any = null;
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      events.push(d);
      if (d.type === "result") result = d;
    } catch { /* a partial line */ }
  }
  const thought = events.some((d) => d.type === "stream_event" && d.event?.type === "content_block_start" && d.event.content_block?.type === "thinking");
  return { reply: callReplies(events)[0] ?? null, result, thought };
}

function claudeBinary(): string {
  return stableClaudeBinary() ?? resolveClaudeInstall() ?? "claude";
}

/**
 * The effort a thinking model's call runs at. The API call sends none and
 * gets the API's default; Claude Code's own default thinks less. Measured on
 * 41 trial judge requests, 3 runs each (2026-10-16): replies averaged 842
 * output tokens on the API, 535 under Claude Code's default and 853 at high.
 */
export const THINKING_EFFORT = "high";

export type SubscriptionCallOptions = {
  /** A saved profile's setup token instead of the machine's login. */
  account?: string;
  timeoutMs?: number;
  /** Claude Code's --effort; default high for a model that thinks (THINKING_EFFORT). */
  effort?: string;
  /** Where the call's private config dir goes (default: a fresh dir under the OS temp dir); removed after. */
  runDir?: string;
};

export type SubscriptionCallResult = ModelCallResult & { backend: "subscription"; thought?: boolean; notional_usd?: number };

/**
 * One call on the subscription, answered as runModelCall answers: ok with the
 * text (and the parsed JSON for a json call), or failed with why. Nothing is
 * charged to a budget, so cost_usd is 0; notional_usd is what claude reports
 * the call would have cost on the API.
 */
export async function subscriptionModelCall(spec: ModelCallSpec, opts: SubscriptionCallOptions = {}): Promise<SubscriptionCallResult> {
  const fail = (error: string): SubscriptionCallResult => ({ ok: false, reason: "failed", error, cost_usd: 0, model: spec.model, backend: "subscription" });
  const problem = modelCallProblem(spec);
  if (problem) return fail(problem);
  let token: string;
  try {
    token = opts.account ? profileToken(opts.account) : loginToken();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const run = opts.runDir ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cast-sub-call-"));
  const configDir = path.join(run, ".claude");
  fs.mkdirSync(configDir, { recursive: true });
  const systemFile = path.join(run, "system.txt");
  if (spec.system) fs.writeFileSync(systemFile, spec.system);
  const thinking = !sendsThinkingOff(spec.model);
  const env = { ...isolatedEnv({ configDir, token, stripModelKeys: true, maxOutputTokens: spec.max_tokens }), ...callEnv(thinking) };
  try {
    const { code, stdout, stderr, timedOut } = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn(claudeBinary(), callArgs({ model: spec.model, ...(spec.system ? { systemFile } : {}), ...(thinking ? { effort: opts.effort ?? THINKING_EFFORT } : {}) }), { cwd: run, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, opts.timeoutMs ?? 300_000);
      child.stdout!.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-4000); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: e.message, timedOut }); });
      child.on("close", (c) => { clearTimeout(timer); resolve({ code: c, stdout, stderr, timedOut }); });
      child.stdin!.end(spec.prompt);
    });
    if (timedOut) return fail(`the subscription call ran past ${Math.round((opts.timeoutMs ?? 300_000) / 1000)}s`);
    const { reply, result, thought } = firstReply(stdout);
    const notional = typeof result?.total_cost_usd === "number" ? { notional_usd: result.total_cost_usd } : {};
    if (!reply || (!reply.text.trim() && result?.is_error)) {
      return { ...fail(String(result?.result ?? stderr.trim() ?? `claude exited ${code}`).slice(0, 400) || `claude exited ${code}`), thought, ...notional };
    }
    const usage = { input_tokens: Number(reply.usage.input_tokens ?? 0) + Number(reply.usage.cache_read_input_tokens ?? 0) + Number(reply.usage.cache_creation_input_tokens ?? 0), output_tokens: Number(reply.usage.output_tokens ?? 0) };
    const base = { text: reply.text, usage, cost_usd: 0, model: spec.model, stop_reason: reply.stop_reason, backend: "subscription" as const, thought, ...notional };
    if (spec.output === "json") {
      const json = parseJsonBlock(reply.text);
      if (json === null) return { ...fail(reply.stop_reason === "max_tokens" ? "the answer ran past max_tokens before its JSON closed" : "the answer held no JSON"), thought, ...notional };
      return { ok: true, json, ...base };
    }
    return { ok: true, ...base };
  } finally {
    // The transcript and everything else claude wrote go with the private config dir.
    if (opts.runDir) fs.rmSync(configDir, { recursive: true, force: true });
    else fs.rmSync(run, { recursive: true, force: true });
  }
}
