// `cast exec` — print mode for every agent harness.
//
// The scripting analog of `claude -p`: run a prompt, print the result, exit.
// Unified flags (agent, model, effort, permission, output format, resume) map
// onto each client's native headless form via buildPrintArgs. This is NOT
// `cast spawn` (inbox, fire-and-forget), NOT `cast ask` (history search), and
// NOT `cast claude` (raw pass-through to one binary).
//
// Three shapes on one launcher:
//   cast exec "prompt"                       one run, streamed to the terminal
//   cast exec -j 4 "a" "b" "c"               each prompt its own run, 4 at a time
//   cast exec --chain implement "task"       a chain: each step's output feeds the next
// `--as <definition>` runs any of them as a named agent definition (client,
// model, effort, tools, system prompt); explicit flags override the definition.
//
// A single run streams and needs no codecast auth. Parallel and chain runs
// capture each child's stdout so results can be collected and handed on;
// progress goes to stderr and the results to stdout. `--as` and `--chain`
// read the workspace's definitions, so they need `cast auth`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import {
  AGENT_CLIENTS,
  AGENT_MODEL_CONFIG,
  parseExecutionAgentClientId,
  renderChainStepPrompt,
  resolveAgentLaunch,
  type AgentChainSpec,
  type AgentClientId,
  type AgentDefinitionSpec,
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
import { definitionLaunchFlags, describeDropped } from "./agentLaunch.js";
import { spawn, whichBin } from "./proc.js";
import { commandGroup, type GroupDeps } from "./commandGroups.js";
import { defaultConfigDir } from "./config/configDir.js";
import { apiPost } from "./castApi.js";
import { countingSemaphore } from "./semaphore.js";

const CONFIG_DIR = defaultConfigDir();
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

/** Parallel mode: every positional is its own prompt (`-` sections included). */
export function resolveExecPrompts(parts: string[], deps: ResolveExecPromptDeps): string[] {
  const hasDash = parts.some((p) => p === "-");
  const expanded = expandStdinArgs(parts, hasDash ? deps.readStdin : () => "");
  const prompts = expanded.map((p) => p.trim()).filter(Boolean);
  if (prompts.length === 0 && !deps.stdinIsTTY) {
    const body = stripOneTrailingNewline(deps.readStdin());
    return body.split(/\r?\n---\r?\n/).map((p) => p.trim()).filter(Boolean);
  }
  return prompts;
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

export interface ChildResult {
  code: number;
  /** Captured stdout; empty when the child inherited the terminal. */
  output: string;
}

function runChild(
  binary: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; inheritStdin: boolean; capture?: boolean; onChunk?: (text: string) => void },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      stdio: [opts.inheritStdin ? "inherit" : "ignore", opts.capture ? "pipe" : "inherit", opts.capture ? "pipe" : "inherit"],
    });
    const chunks: string[] = [];
    if (opts.capture) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => {
        chunks.push(d);
        opts.onChunk?.(d);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => opts.onChunk?.(d));
    }
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
      const output = chunks.join("");
      if (timedOut) {
        process.stderr.write(`cast exec: timed out after ${opts.timeoutMs}ms\n`);
        resolve({ code: 124, output });
        return;
      }
      if (signal) resolve({ code: 1, output });
      else resolve({ code: code ?? 1, output });
    });
  });
}

// ─── One launch, fully resolved ─────────────────────────────────────────────

export interface ExecFlags {
  agent?: AgentClientId;
  model?: string;
  effort?: string;
  outputFormat?: PrintOutputFormat;
  permissionMode?: string;
  resumeId?: string;
  continueLast?: boolean;
  maxTurns?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  jsonSchema?: string;
  bare?: boolean;
  isolated?: boolean;
}

interface ResolvedLaunch {
  agent: AgentClientId;
  binary: string;
  binaryArgs: string[];
  warnings: string[];
}

/** Flags + an optional definition -> the binary and argv. Explicit flags win
 *  over the definition; the definition wins over the surface default. */
function resolveLaunch(prompt: string, flags: ExecFlags, definition: AgentDefinitionSpec | undefined, fallbackAgent: AgentClientId): ResolvedLaunch {
  const resolved = resolveAgentLaunch(definition, { agent: flags.agent, model: flags.model, effort: flags.effort }, fallbackAgent);
  const agent = resolved.agent;
  const warnings: string[] = [];
  const efforts = (AGENT_MODEL_CONFIG[agent]?.efforts ?? []) as readonly string[];
  const effort = resolved.effort;
  if (effort && efforts.length > 0 && !efforts.includes(effort)) {
    throw new Error(`Unknown --effort "${effort}" for ${agent}. Use: ${efforts.join(", ")}`);
  }
  if (effort && efforts.length === 0) warnings.push(`${agent} has no effort flag; ignoring --effort`);

  const defFlags = definition ? definitionLaunchFlags(resolved, agent) : undefined;
  if (definition) {
    const dropped = describeDropped(definition.name, defFlags!.dropped);
    if (dropped) warnings.push(dropped);
  }

  const config = readSharedConfig(CONFIG_DIR);
  const configuredArgs = getConfiguredAgentArgs(agent, config);
  const permFlags = flags.permissionMode
    ? permissionFlagsForMode(agent, flags.permissionMode, configuredArgs)
    : getPermissionFlags(agent, config);

  const appendParts = [defFlags?.appendSystemPrompt, flags.appendSystemPrompt].filter(Boolean) as string[];
  const { binaryArgs, ignored } = buildPrintArgs({
    agentType: agent,
    prompt,
    configuredArgs,
    permFlags,
    defaultFlags: getDefaultParamFlags(agent, config),
    modelAlias: resolvePrintModelAlias(agent, resolved.model),
    requestedEffort: effort && efforts.length > 0 ? effort : undefined,
    outputFormat: flags.outputFormat,
    resumeId: flags.resumeId,
    continueLast: flags.continueLast,
    maxTurns: flags.maxTurns,
    systemPrompt: flags.systemPrompt ?? defFlags?.systemPrompt,
    appendSystemPrompt: appendParts.length ? appendParts.join("\n\n") : undefined,
    jsonSchema: flags.jsonSchema,
    bare: flags.bare,
    worktree: flags.isolated || resolved.isolated ? true : undefined,
    autoApprove: flags.permissionMode !== "default",
    extraArgs: defFlags?.args,
  });
  for (const flag of ignored) warnings.push(`${agent} does not support ${flag}; ignoring`);
  return { agent, binary: launchBinary(agent), binaryArgs, warnings };
}

// ─── Definitions and chains from the workspace ──────────────────────────────

async function loadDefinition(deps: GroupDeps, name: string): Promise<AgentDefinitionSpec> {
  const def = await apiPost(deps, "/cli/agents/resolve", { name }, { read: true });
  if (!def) {
    console.error(`No agent definition named "${name}". See: cast agent ls`);
    process.exit(1);
  }
  return def as AgentDefinitionSpec;
}

async function loadChain(deps: GroupDeps, name: string): Promise<{ chain: AgentChainSpec; definitions: Record<string, AgentDefinitionSpec> }> {
  const res = await apiPost(deps, "/cli/chains/resolve", { name }, { read: true });
  if (!res?.chain) {
    console.error(`No chain named "${name}". See: cast agent chains`);
    process.exit(1);
  }
  if (res.missing?.length) {
    console.error(`Chain "${name}" names definitions that do not exist: ${res.missing.join(", ")}`);
    process.exit(1);
  }
  return res;
}

// ─── Command ────────────────────────────────────────────────────────────────

function tail(text: string, lines: number): string {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

export interface ChainRunOptions {
  flags: ExecFlags;
  dir: string;
  timeoutMs?: number;
  quiet?: boolean;
  dryRun?: boolean;
}

/** Run a chain: each step's captured output feeds the next step's template.
 *  Progress goes to stderr, the last step's output (or the JSON envelope when
 *  the output format is json) to stdout. Returns the exit code. Shared by
 *  `cast exec --chain` and `cast agent run`. */
export async function runChain(deps: GroupDeps, chainName: string, task: string, opts: ChainRunOptions): Promise<number> {
  const { chain, definitions } = await loadChain(deps, chainName);
  if (!task) {
    console.error(`Give the chain a task: cast exec --chain ${chain.name} "…"`);
    return 1;
  }
  const say = (line: string) => { if (!opts.quiet) process.stderr.write(line + "\n"); };
  const json = opts.flags.outputFormat === "json";
  const steps: Array<{ agent: string; prompt: string; code: number; output: string; ms: number }> = [];
  let previous: string | undefined;
  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    const def = definitions[step.agent];
    const prompt = renderChainStepPrompt(step.prompt, { task, previous });
    let launch: ResolvedLaunch;
    try {
      // The child always answers in text: `{previous}` is prose for the next
      // step, and the output format flag shapes only this command's envelope.
      launch = resolveLaunch(prompt, { ...opts.flags, outputFormat: undefined }, def, "claude");
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
    for (const w of launch.warnings) process.stderr.write(`cast exec: ${w}\n`);
    if (opts.dryRun) {
      console.log(`# step ${i + 1}/${chain.steps.length} ${step.agent}\n${formatPrintCommand(launch.binary, launch.binaryArgs)}`);
      continue;
    }
    if (!path.isAbsolute(launch.binary) && !whichBin(launch.binary)) {
      console.error(`${launch.binary} not found on PATH. Install the ${AGENT_CLIENTS[launch.agent].displayName} CLI.`);
      return 1;
    }
    say(`▸ step ${i + 1}/${chain.steps.length} ${step.agent} (${launch.agent})`);
    const started = Date.now();
    const result = await runChild(launch.binary, launch.binaryArgs, { cwd: opts.dir, timeoutMs: opts.timeoutMs, inheritStdin: false, capture: true });
    const ms = Date.now() - started;
    steps.push({ agent: step.agent, prompt, code: result.code, output: result.output, ms });
    if (result.code !== 0) {
      say(`✗ ${step.agent} failed (exit ${result.code}) after ${Math.round(ms / 1000)}s`);
      if (!opts.quiet && result.output.trim()) process.stderr.write(tail(result.output, 12) + "\n");
      if (json) console.log(JSON.stringify({ chain: chain.name, task, steps, ok: false }, null, 2));
      else process.stdout.write(result.output);
      return result.code;
    }
    say(`✓ ${step.agent} done in ${Math.round(ms / 1000)}s (${result.output.length} chars)`);
    previous = result.output.trim();
  }
  if (opts.dryRun) return 0;
  if (json) console.log(JSON.stringify({ chain: chain.name, task, steps, ok: true }, null, 2));
  else process.stdout.write((previous ?? "") + "\n");
  return 0;
}

export function registerExecCommand(program: Command, deps: GroupDeps): void {
  program
    .command("exec")
    .description(commandGroup("exec").description)
    .argument("[prompt...]", "Prompt; omit or pass '-' to read stdin")
    .option("--agent <type>", `Agent: ${AGENT_NAMES} (default: claude, or the definition's)`)
    .option("-m, --model <model>", "Model (picker key or raw id, e.g. opus, grok-4.6)")
    .option("--effort <level>", "Reasoning effort (claude: low|medium|high|max; varies by agent)")
    .option("--as <definition>", "Run as a named agent definition (cast agent ls); explicit flags override it")
    .option("--chain <name>", "Run a chain: the prompt is the task, each step's output feeds the next")
    .option("-j, --jobs <n>", "Parallel: each prompt is its own run, at most n at once")
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
    .option("--isolated", "Start in a git worktree (grok, cursor, gemini native --worktree)")
    .option("--timeout <duration>", "Kill the run after this long (30s, 2m, 10m)")
    .option("--quiet", "Parallel and chain runs: no progress on stderr")
    .option("--dry-run", "Print the resolved command and exit without running it")
    .action(async (rawParts: string[], options: Record<string, unknown>) => {
      let explicitAgent: AgentClientId | undefined;
      if (options.agent) {
        try {
          explicitAgent = parseExecutionAgentClientId(String(options.agent));
        } catch {
          console.error(`Unknown agent "${options.agent}". Use: ${AGENT_NAMES}`);
          process.exit(1);
        }
      }

      const outputFormat = parseOutputFormat(options.outputFormat as string | undefined);
      if (options.outputFormat && !outputFormat) {
        console.error(`Unknown --output-format "${options.outputFormat}". Use: text, json, stream-json`);
        process.exit(1);
      }
      const timeoutMs = options.timeout ? parseExecTimeout(String(options.timeout)) : undefined;
      if (options.timeout && timeoutMs == null) {
        console.error(`Unknown --timeout "${options.timeout}". Use 30s, 2m, 10m, or a number of seconds.`);
        process.exit(1);
      }
      const maxTurns = options.maxTurns != null ? parseInt(String(options.maxTurns), 10) : undefined;
      if (options.maxTurns != null && (!Number.isFinite(maxTurns) || (maxTurns as number) < 1)) {
        console.error(`--max-turns must be a positive integer (got "${options.maxTurns}")`);
        process.exit(1);
      }
      const jobs = options.jobs != null ? parseInt(String(options.jobs), 10) : undefined;
      if (options.jobs != null && (!Number.isFinite(jobs) || (jobs as number) < 1)) {
        console.error(`--jobs must be a positive integer (got "${options.jobs}")`);
        process.exit(1);
      }
      if (jobs && options.chain) {
        console.error("--jobs and --chain do not combine: a chain is sequential by definition.");
        process.exit(1);
      }

      const dir = options.dir
        ? path.resolve(String(options.dir).replace(/^~/, os.homedir()))
        : (process.env.CODECAST_CWD || process.cwd());
      if (!fs.existsSync(dir)) {
        console.error(`Directory not found: ${dir}`);
        process.exit(1);
      }

      const flags: ExecFlags = {
        agent: explicitAgent,
        model: options.model ? String(options.model) : undefined,
        effort: options.effort ? String(options.effort) : undefined,
        outputFormat,
        permissionMode: options.permissionMode ? String(options.permissionMode) : undefined,
        resumeId: options.resume ? String(options.resume) : undefined,
        continueLast: !!options.continue,
        maxTurns,
        systemPrompt: options.systemPrompt ? String(options.systemPrompt) : undefined,
        appendSystemPrompt: options.appendSystemPrompt ? String(options.appendSystemPrompt) : undefined,
        jsonSchema: options.jsonSchema ? String(options.jsonSchema) : undefined,
        bare: !!options.bare,
        isolated: !!options.isolated,
      };
      const quiet = !!options.quiet;
      const say = (line: string) => { if (!quiet) process.stderr.write(line + "\n"); };
      const stdinDeps = { stdinIsTTY: !!process.stdin.isTTY, readStdin: readStdinBody };

      const definition = options.as ? await loadDefinition(deps, String(options.as)) : undefined;

      const launchOrExit = (prompt: string, def: AgentDefinitionSpec | undefined, override: Partial<ExecFlags> = {}): ResolvedLaunch => {
        try {
          const launch = resolveLaunch(prompt, { ...flags, ...override }, def, "claude");
          for (const w of launch.warnings) process.stderr.write(`cast exec: ${w}\n`);
          if (!path.isAbsolute(launch.binary) && !whichBin(launch.binary)) {
            console.error(`${launch.binary} not found on PATH. Install the ${AGENT_CLIENTS[launch.agent].displayName} CLI, or pick another --agent.`);
            process.exit(1);
          }
          return launch;
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
      };

      // ── Chain ──────────────────────────────────────────────────────────
      if (options.chain) {
        let task: string;
        try {
          task = resolveExecPrompt(rawParts ?? [], stdinDeps).prompt;
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
        const code = await runChain(deps, String(options.chain), task, { flags, dir, timeoutMs, quiet, dryRun: !!options.dryRun });
        process.exit(code);
      }

      // ── Parallel ───────────────────────────────────────────────────────
      if (jobs) {
        let prompts: string[];
        try {
          prompts = resolveExecPrompts(rawParts ?? [], stdinDeps);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
        if (prompts.length === 0) {
          console.error('Give one or more prompts: cast exec -j 4 "a" "b"   or   cast exec -j 4 - - <<\'EOF\' … --- … EOF');
          process.exit(1);
        }
        if (options.dryRun) {
          prompts.forEach((p, i) => {
            const launch = launchOrExit(p, definition);
            console.log(`# task ${i + 1}/${prompts.length}\n${formatPrintCommand(launch.binary, launch.binaryArgs)}`);
          });
          return;
        }
        const sem = countingSemaphore(jobs);
        const results = await Promise.all(
          prompts.map((prompt, i) =>
            sem.run(async () => {
              const launch = launchOrExit(prompt, definition, { outputFormat: undefined });
              say(`▸ task ${i + 1}/${prompts.length} started (${launch.agent})`);
              const started = Date.now();
              const result = await runChild(launch.binary, launch.binaryArgs, { cwd: dir, timeoutMs, inheritStdin: false, capture: true });
              const ms = Date.now() - started;
              say(`${result.code === 0 ? "✓" : "✗"} task ${i + 1}/${prompts.length} ${result.code === 0 ? "done" : `failed (exit ${result.code})`} in ${Math.round(ms / 1000)}s`);
              return { index: i, prompt, code: result.code, output: result.output, ms };
            }),
          ),
        );
        if (outputFormat === "json") {
          console.log(JSON.stringify({ tasks: results, ok: results.every((r) => r.code === 0) }, null, 2));
        } else {
          for (const r of results) {
            console.log(`### task ${r.index + 1}: ${r.prompt.split("\n")[0].slice(0, 80)}${r.code === 0 ? "" : ` (exit ${r.code})`}\n`);
            console.log(r.output.trimEnd() + "\n");
          }
        }
        process.exit(results.every((r) => r.code === 0) ? 0 : 1);
      }

      // ── Single ─────────────────────────────────────────────────────────
      let prompt: string;
      let inheritStdin: boolean;
      try {
        const resolved = resolveExecPrompt(rawParts ?? [], stdinDeps);
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
      const launch = launchOrExit(prompt, definition);
      if (options.dryRun) {
        console.log(formatPrintCommand(launch.binary, launch.binaryArgs));
        return;
      }
      try {
        const result = await runChild(launch.binary, launch.binaryArgs, { cwd: dir, timeoutMs, inheritStdin });
        process.exit(result.code);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`cast exec failed: ${msg}`);
        process.exit(1);
      }
    });
}
