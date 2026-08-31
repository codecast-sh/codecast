// `cast exec` — print mode for every agent harness.
//
// The scripting analog of `claude -p`: run a prompt, print the result, exit.
// Unified flags (agent, model, effort, permission, output format, resume) map
// onto each client's native headless form via buildPrintArgs. This is NOT
// `cast spawn` (inbox, fire-and-forget), NOT `cast ask` (history search), and
// NOT `cast claude` (raw pass-through to one binary).
//
// Does not require codecast auth: it launches the local agent CLI. The daemon
// will still pick up the transcript if it is watching this project.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import {
  AGENT_CLIENTS,
  AGENT_MODEL_CONFIG,
  parseExecutionAgentClientId,
  type AgentClientId,
} from "@codecast/shared/contracts";
import { readSharedConfig } from "./config/sharedConfig.js";
import { expandStdinArgs, readStdinBody } from "./sendBody.js";
import {
  buildPrintArgs,
  formatPrintCommand,
  getConfiguredAgentArgs,
  getDefaultParamFlags,
  getPermissionFlags,
  launchBinary,
  permissionFlagsForMode,
  resolvePrintModelAlias,
  type PrintOutputFormat,
} from "./launchCommand.js";
import { spawn, whichBin } from "./proc.js";
import { c, fmt } from "./colors.js";

const CONFIG_DIR = path.join(os.homedir(), ".codecast");
const AGENT_NAMES = Object.keys(AGENT_CLIENTS).join(", ");

export interface ResolveExecPromptDeps {
  stdinIsTTY: boolean;
  readStdin: () => string;
}

/**
 * Prompt from args, `-` (stdin body), or a piped stdin when no arg was given.
 * When a prompt arg is present AND stdin is piped, the child inherits stdin so
 * `cat file | cast exec "summarize"` works the way `claude -p` does.
 */
export function resolveExecPrompt(
  parts: string[],
  deps: ResolveExecPromptDeps,
): { prompt: string; inheritStdin: boolean } {
  const hasDash = parts.some((p) => p === "-");
  const expanded = expandStdinArgs(parts, hasDash ? deps.readStdin : () => "");
  const joined = expanded.map((p) => p.trim()).filter((p) => p && p !== "-").join(" ").trim();
  if (hasDash) return { prompt: joined, inheritStdin: false };
  if (joined) return { prompt: joined, inheritStdin: !deps.stdinIsTTY };
  if (!deps.stdinIsTTY) {
    return { prompt: stripOneTrailingNewline(deps.readStdin()), inheritStdin: false };
  }
  return { prompt: "", inheritStdin: false };
}

function stripOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** `30s` / `2m` / `10m` / a bare number of seconds. */
export function parseExecTimeout(input: string): number | undefined {
  const trimmed = input.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 1000;
  const match = trimmed.match(/^(\d+)\s*(s|sec|m|min|h|hr|hour)s?$/);
  if (!match) return undefined;
  const num = parseInt(match[1], 10);
  const unit = match[2][0];
  if (unit === "s") return num * 1000;
  if (unit === "m") return num * 60 * 1000;
  if (unit === "h") return num * 60 * 60 * 1000;
  return undefined;
}

export function parseOutputFormat(raw: string | undefined): PrintOutputFormat | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "text" || v === "json" || v === "stream-json") return v;
  return undefined;
}

function runChild(
  binary: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; inheritStdin: boolean },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      stdio: [opts.inheritStdin ? "inherit" : "ignore", "inherit", "inherit"],
    });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        process.stderr.write(`cast exec: timed out after ${opts.timeoutMs}ms\n`);
        resolve(124);
        return;
      }
      if (signal) resolve(1);
      else resolve(code ?? 1);
    });
  });
}

export function registerExecCommand(program: Command): void {
  program
    .command("exec")
    .description(
      "Run a prompt on any agent harness, print the result, and exit\n\n" +
      "Print mode for every harness we launch — the scripting analog of `claude -p`.\n" +
      "Unified flags (agent, model, effort, permission, output format, resume) map\n" +
      "onto that client's native headless form. The process is the session: stdout\n" +
      "is the result, the exit code is the agent's, and there is no inbox card.\n\n" +
      "Not `cast spawn` (starts a session in your inbox and returns immediately).\n" +
      "Not `cast ask` (searches conversation history).\n" +
      "Not `cast claude` (raw pass-through to the Claude binary).\n\n" +
      "Examples:\n" +
      "  cast exec \"summarize this repo\"\n" +
      "  cast exec --agent grok --model grok-4.6 --effort high \"review the diff\"\n" +
      "  git diff | cast exec --agent claude --model sonnet \"write a commit message\"\n" +
      "  cast exec --output-format json --max-turns 4 \"list the public API\"\n" +
      "  cast exec --resume abc123 \"continue from there\"\n" +
      "  cast exec --dry-run --agent codex \"what would run\"\n" +
      "  cast exec - <<'EOF'\n" +
      "  Multi-line prompt, exact newlines preserved.\n" +
      "  EOF"
    )
    .argument("[prompt...]", "Prompt; omit or pass '-' to read stdin")
    .option("--agent <type>", `Agent: ${AGENT_NAMES}`, "claude")
    .option("-m, --model <model>", "Model (picker key or raw id, e.g. opus, grok-4.6)")
    .option("--effort <level>", "Reasoning effort (per-agent: claude low|medium|high|max, …)")
    .option("-C, --dir <path>", "Working directory (default: current directory)")
    .option("--output-format <fmt>", "text (default), json, or stream-json")
    .option("--permission-mode <mode>", "bypass (default), default, acceptEdits, full_auto, or a native mode")
    .option("-r, --resume <id>", "Resume a previous session by id")
    .option("-c, --continue", "Continue the most recent session in this directory")
    .option("--max-turns <n>", "Cap agentic turns (claude, grok)")
    .option("--system-prompt <text>", "Replace the default system prompt (claude, grok, pi)")
    .option("--append-system-prompt <text>", "Append to the default system prompt (claude, grok, pi)")
    .option("--json-schema <schema>", "Constrain the final answer to a JSON schema (claude, grok)")
    .option("--bare", "Minimal start: skip hooks/plugins/CLAUDE.md discovery (claude; opencode --pure)")
    .option("--worktree [name]", "Start in a git worktree (grok, cursor, gemini)")
    .option("--timeout <duration>", "Kill the run after this long (30s, 2m, 10m)")
    .option("--dry-run", "Print the resolved command and exit without running it")
    .action(async (rawParts: string[], options: Record<string, unknown>, command: Command) => {
      let agent: AgentClientId;
      try {
        agent = parseExecutionAgentClientId(String(options.agent || "claude"));
      } catch {
        console.error(`Unknown agent "${options.agent}". Use: ${AGENT_NAMES}`);
        process.exit(1);
      }

      let prompt: string;
      let inheritStdin: boolean;
      try {
        const resolved = resolveExecPrompt(rawParts ?? [], {
          stdinIsTTY: !!process.stdin.isTTY,
          readStdin: readStdinBody,
        });
        prompt = resolved.prompt;
        inheritStdin = resolved.inheritStdin;
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }

      if (!prompt) {
        console.error('Give a prompt: cast exec "…"   or   cast exec - <<\'EOF\' … EOF');
        process.exit(1);
      }

      const outputFormat = parseOutputFormat(options.outputFormat as string | undefined);
      if (options.outputFormat && !outputFormat) {
        console.error(`Unknown --output-format "${options.outputFormat}". Use: text, json, stream-json`);
        process.exit(1);
      }

      const timeoutMs = options.timeout
        ? parseExecTimeout(String(options.timeout))
        : undefined;
      if (options.timeout && timeoutMs == null) {
        console.error(`Unknown --timeout "${options.timeout}". Use 30s, 2m, 10m, or a number of seconds.`);
        process.exit(1);
      }

      const maxTurns = options.maxTurns != null ? parseInt(String(options.maxTurns), 10) : undefined;
      if (options.maxTurns != null && (!Number.isFinite(maxTurns) || (maxTurns as number) < 1)) {
        console.error(`--max-turns must be a positive integer (got "${options.maxTurns}")`);
        process.exit(1);
      }

      const effort = options.effort ? String(options.effort) : undefined;
      const efforts = AGENT_MODEL_CONFIG[agent]?.efforts ?? [];
      if (effort && efforts.length > 0 && !(efforts as readonly string[]).includes(effort)) {
        console.error(`Unknown --effort "${effort}" for ${agent}. Use: ${(efforts as readonly string[]).join(", ")}`);
        process.exit(1);
      }
      if (effort && efforts.length === 0) {
        process.stderr.write(`cast exec: ${agent} has no effort flag; ignoring --effort\n`);
      }

      const config = readSharedConfig(CONFIG_DIR);
      const configuredArgs = getConfiguredAgentArgs(agent, config);
      const permissionMode = options.permissionMode ? String(options.permissionMode) : undefined;
      const permFlags = permissionMode
        ? permissionFlagsForMode(agent, permissionMode, configuredArgs)
        : getPermissionFlags(agent, config);
      const autoApprove = permissionMode !== "default";

      const extraArgs = typeof command.args === "object" && command.args
        ? [] // positional prompt already consumed; extra unknown flags are rejected by commander
        : [];
      void extraArgs;

      const dir = options.dir
        ? path.resolve(String(options.dir).replace(/^~/, os.homedir()))
        : (process.env.CODECAST_CWD || process.cwd());

      const worktreeOpt = options.worktree;
      const worktree =
        worktreeOpt === true || worktreeOpt === false
          ? !!worktreeOpt
          : typeof worktreeOpt === "string"
            ? worktreeOpt
            : undefined;

      const { binaryArgs, ignored } = buildPrintArgs({
        agentType: agent,
        prompt,
        configuredArgs,
        permFlags,
        defaultFlags: getDefaultParamFlags(agent, config),
        modelAlias: resolvePrintModelAlias(agent, options.model ? String(options.model) : undefined),
        requestedEffort: effort && efforts.length > 0 ? effort : undefined,
        outputFormat,
        resumeId: options.resume ? String(options.resume) : undefined,
        continueLast: !!options.continue,
        maxTurns,
        systemPrompt: options.systemPrompt ? String(options.systemPrompt) : undefined,
        appendSystemPrompt: options.appendSystemPrompt ? String(options.appendSystemPrompt) : undefined,
        jsonSchema: options.jsonSchema ? String(options.jsonSchema) : undefined,
        bare: !!options.bare,
        worktree,
        autoApprove,
      });

      for (const flag of ignored) {
        process.stderr.write(`cast exec: ${agent} does not support ${flag}; ignoring\n`);
      }

      const binary = launchBinary(agent);
      if (!path.isAbsolute(binary) && !whichBin(binary)) {
        console.error(`${binary} not found on PATH. Install the ${AGENT_CLIENTS[agent].displayName} CLI, or pick another --agent.`);
        process.exit(1);
      }

      if (options.dryRun) {
        console.log(formatPrintCommand(binary, binaryArgs));
        return;
      }

      if (!fs.existsSync(dir)) {
        console.error(`Directory not found: ${dir}`);
        process.exit(1);
      }

      try {
        const code = await runChild(binary, binaryArgs, {
          cwd: dir,
          timeoutMs,
          inheritStdin,
        });
        process.exit(code);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`cast exec failed: ${msg}`);
        process.exit(1);
      }
    });
}

export const EXEC_AGENT_NAMES = AGENT_NAMES;
export { fmt, c };
