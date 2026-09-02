// Fresh-session launch command construction, pulled out of the daemon's start
// path so it is unit-testable per client. The binary itself is a registry lookup
// (AGENT_CLIENTS[agentType].binary); this module owns the ARG list and the one
// place the daemon reads a client's configured base args.
//
// buildLaunchArgs is pure: it takes the already-resolved flag strings (permission
// flags, default-param flags, model alias, effort) and returns the raw arg list
// plus whether the daemon should fire the one-time "codex is running in full-access
// mode" notification. getPermissionFlags / getDefaultParamFlags live here so the
// TUI launch path and `cast exec` (print mode) share one mapping.
import {
  AGENT_CLIENTS,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  GROK_EFFORT_LEVELS,
  PI_EFFORT_LEVELS,
  findModelOption,
  type AgentClientId,
} from "@codecast/shared/contracts";
import { getAgentArgs, type Config } from "./config/types.js";
import { stableClaudeBinary } from "./stableClaudeBinary.js";

/**
 * The single seam for reading a client's user-configured base launch args.
 * Delegates to the agent_args map accessor (ct-39076), which falls back to the
 * legacy claude_args/codex_args fields; an explicit "" in the map wins. Clients
 * with no configured args get "".
 * NOTE: parameter order is (agentType, config) here but (config, clientId) on
 * getAgentArgs — keep the delegation as the only crossing point.
 */
export function getConfiguredAgentArgs(agentType: AgentClientId, config: Config | null | undefined): string {
  return getAgentArgs(config, agentType) ?? "";
}

/** The claude permission flags that must not be doubled up when the user already
 *  pinned one in their configured args. */
function claudeArgsPinPermission(configuredArgs: string): boolean {
  return configuredArgs.includes("--dangerously-skip-permissions")
    || configuredArgs.includes("--permission-mode")
    || configuredArgs.includes("--allow-dangerously-skip-permissions");
}

function splitFlags(flags: string | null | undefined): string[] {
  return flags ? flags.split(/\s+/).filter(Boolean) : [];
}

/**
 * Permission flags the daemon (and `cast exec`) pass at launch. Default is
 * bypass so a session started from the web or a script doesn't sit on a TUI
 * prompt nobody can answer. Returns null when the user's configured args
 * already pin a mode, so we never double up.
 */
export function getPermissionFlags(agentType: AgentClientId, config?: Config | null): string | null {
  const modes = config?.agent_permission_modes;

  if (agentType === "claude") {
    if (modes?.claude === "bypass") return "--permission-mode bypassPermissions";
    if (modes?.claude === "default") return "--allow-dangerously-skip-permissions";
    return "--permission-mode bypassPermissions";
  } else if (agentType === "codex") {
    const existing = getAgentArgs(config, "codex") || "";
    if (existing.includes("--full-auto") || existing.includes("--ask-for-approval") || existing.includes("--dangerously-bypass")) return null;
    if (modes?.codex === "full_auto") return "--full-auto";
    if (modes?.codex === "default") return null;
    return "--dangerously-bypass-approvals-and-sandbox";
  } else if (agentType === "grok") {
    const existing = getAgentArgs(config, "grok") || "";
    if (existing.includes("--permission-mode") || existing.includes("--always-approve")) return null;
    return "--permission-mode bypassPermissions";
  } else if (agentType === "gemini") {
    // gemini flags TBD for TUI launch; print mode adds --yolo separately.
  }

  return null;
}

/** Extra `--flag value` pairs from config.agent_default_params. */
export function getDefaultParamFlags(agentType: AgentClientId, config?: Config | null): string | null {
  const params = config?.agent_default_params?.[agentType];
  if (!params || Object.keys(params).length === 0) return null;
  return Object.entries(params).map(([k, v]) => `--${k} ${v}`).join(" ");
}

/**
 * Explicit `--permission-mode` from `cast exec`, overriding config. Unknown
 * values pass through as claude/grok's native `--permission-mode <value>`
 * for those two clients and are ignored elsewhere.
 */
export function permissionFlagsForMode(
  agentType: AgentClientId,
  mode: string,
  configuredArgs: string,
): string | null {
  const m = mode.trim();
  if (!m) return null;
  if (agentType === "claude") {
    if (claudeArgsPinPermission(configuredArgs)) return null;
    if (m === "bypass") return "--permission-mode bypassPermissions";
    if (m === "default") return "--allow-dangerously-skip-permissions";
    return `--permission-mode ${m}`;
  }
  if (agentType === "codex") {
    if (configuredArgs.includes("--full-auto") || configuredArgs.includes("--ask-for-approval") || configuredArgs.includes("--dangerously-bypass")) return null;
    if (m === "bypass") return "--dangerously-bypass-approvals-and-sandbox";
    if (m === "full_auto") return "--full-auto";
    if (m === "default") return null;
    return null;
  }
  if (agentType === "grok") {
    if (configuredArgs.includes("--permission-mode") || configuredArgs.includes("--always-approve")) return null;
    if (m === "bypass") return "--permission-mode bypassPermissions";
    if (m === "default") return null;
    return `--permission-mode ${m}`;
  }
  return null;
}

/** Picker key (`opus`) or raw id → the launch-flag value. `default` omits the flag. */
export function resolvePrintModelAlias(agentType: AgentClientId, model: string | undefined): string | undefined {
  if (!model || model === "default") return undefined;
  const opt = findModelOption(agentType, model);
  if (opt) return opt.cliAlias;
  return model;
}

export interface LaunchArgsInput {
  agentType: AgentClientId;
  /** From getConfiguredAgentArgs — the client's configured base args. */
  configuredArgs: string;
  /** From getPermissionFlags(agentType, config). */
  permFlags: string | null;
  /** From getDefaultParamFlags(agentType, config). */
  defaultFlags: string | null;
  /** requestedModelOpt?.cliAlias for the per-session model choice. */
  modelAlias?: string;
  /** The per-session effort choice, unvalidated (validated here per client). */
  requestedEffort?: string;
  /** The pre-assigned claude session id (claude only), if any. */
  assignedClaudeSessionId?: string | null;
  /** config.agent_permission_modes?.codex is set — suppresses the bypass notice. */
  hasCodexPermissionMode?: boolean;
}

export interface LaunchArgsResult {
  binaryArgs: string[];
  /** True when codex is defaulting to full-access with no explicit config — the
   *  daemon fires the one-time notification. */
  notifyCodexBypass: boolean;
}

/**
 * Build the raw binary args for a fresh launch, per client. Byte-identical to the
 * old inline if/else chain: codex and claude fold in configured args + permission
 * flags (claude also `--session-id`); default-param flags apply to all; model /
 * effort append last so the per-session choice wins. cursor/gemini contribute no
 * args today. The daemon sanitizes the result (sanitizeBinaryArgs) afterward.
 */
export function buildLaunchArgs(input: LaunchArgsInput): LaunchArgsResult {
  const { agentType, configuredArgs, permFlags, defaultFlags } = input;
  const args: string[] = [];
  let notifyCodexBypass = false;

  if (agentType === "codex") {
    if (configuredArgs) args.push(...configuredArgs.split(/\s+/).filter(Boolean));
    if (permFlags) {
      args.push(...permFlags.split(/\s+/).filter(Boolean));
      if (!configuredArgs && !input.hasCodexPermissionMode) notifyCodexBypass = true;
    }
  } else if (agentType === "claude") {
    if (configuredArgs) args.push(...configuredArgs.split(/\s+/).filter(Boolean));
    if (permFlags && !claudeArgsPinPermission(configuredArgs)) {
      args.push(...permFlags.split(/\s+/).filter(Boolean));
    }
    if (input.assignedClaudeSessionId && !configuredArgs.includes("--session-id")) {
      args.push("--session-id", input.assignedClaudeSessionId);
    }
  } else if (agentType === "opencode") {
    if (configuredArgs) args.push(...configuredArgs.split(/\s+/).filter(Boolean));
    // A managed opencode session is driven from the web and can't answer the TUI's
    // permission prompts (the daemon does no pane prompt monitoring for opencode),
    // so it launches auto-approved — its full-access default, matching how codex
    // (--full-auto) and claude (--dangerously-skip-permissions) launch here. Skip if
    // the user already pinned --auto in their configured args.
    if (!configuredArgs.includes("--auto")) args.push("--auto");
  } else if (agentType === "pi") {
    // pi passes through the user's configured args (agent_args.pi) and takes no
    // permission flags; its model/thinking flags are per-session and appended in
    // the model/effort block below. Without this branch the configured args are
    // dropped.
    if (configuredArgs) args.push(...configuredArgs.split(/\s+/).filter(Boolean));
  } else if (agentType === "grok") {
    // grok folds in configured args + the daemon's permission flags
    // (`--permission-mode bypassPermissions` — grok uses claude's exact flag
    // spelling). getPermissionFlags already returns null when agent_args.grok
    // pins a permission mode, so concatenating can't double up (codex shape).
    if (configuredArgs) args.push(...configuredArgs.split(/\s+/).filter(Boolean));
    if (permFlags) args.push(...permFlags.split(/\s+/).filter(Boolean));
  }
  // cursor / gemini: no configured args or permission flags today.

  if (defaultFlags) args.push(...defaultFlags.split(/\s+/).filter(Boolean));

  appendModelEffortFlags(args, input);

  return { binaryArgs: args, notifyCodexBypass };
}

/** Per-session model/effort, appended AFTER config/default flags so the
 *  per-session choice wins (both CLIs take the last occurrence). Shared by
 *  TUI launch and print mode. */
export function appendModelEffortFlags(
  args: string[],
  input: { agentType: AgentClientId; modelAlias?: string; requestedEffort?: string },
): void {
  const { agentType } = input;
  if (agentType === "claude") {
    if (input.modelAlias) args.push("--model", input.modelAlias);
    if (input.requestedEffort && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(input.requestedEffort)) {
      args.push("--effort", input.requestedEffort);
    }
  } else if (agentType === "codex") {
    if (input.modelAlias) args.push("-m", input.modelAlias);
    if (input.requestedEffort && (CODEX_EFFORT_LEVELS as readonly string[]).includes(input.requestedEffort)) {
      args.push("-c", `model_reasoning_effort=${input.requestedEffort}`);
    }
  } else if (agentType === "opencode") {
    // opencode selects a model with `-m provider/model` (the picker's cliAlias);
    // it has no reasoning-effort launch flag.
    if (input.modelAlias) args.push("-m", input.modelAlias);
  } else if (agentType === "pi") {
    // pi selects a model with `--model provider/model`; its `--thinking` levels
    // ride the effort slot (launch-time only, like codex).
    if (input.modelAlias) args.push("--model", input.modelAlias);
    if (input.requestedEffort && (PI_EFFORT_LEVELS as readonly string[]).includes(input.requestedEffort)) {
      args.push("--thinking", input.requestedEffort);
    }
  } else if (agentType === "grok") {
    // grok selects a model with `-m <model-id>` (bare id, e.g. grok-4.6) and
    // takes reasoning effort as a launch flag (`--reasoning-effort`; the TUI's
    // effort menu is interactive-only, like codex's).
    if (input.modelAlias) args.push("-m", input.modelAlias);
    if (input.requestedEffort && (GROK_EFFORT_LEVELS as readonly string[]).includes(input.requestedEffort)) {
      args.push("--reasoning-effort", input.requestedEffort);
    }
  }
}

export interface LaunchBinaryDeps {
  warn?: (message: string) => void;
  /** Test seam for the macOS fixed-path claude copy. */
  stable?: (opts: { warn?: (message: string) => void }) => string | null;
}

/**
 * The binary a session launches or resumes with — a registry lookup, except
 * claude on macOS, which runs from its fixed-path copy (stableClaudeBinary) so
 * the user's folder grants survive Claude Code updates.
 */
export function launchBinary(agentType: AgentClientId, deps: LaunchBinaryDeps = {}): string {
  if (agentType === "claude") {
    const stable = (deps.stable ?? stableClaudeBinary)({ warn: deps.warn });
    if (stable) return stable;
  }
  return AGENT_CLIENTS[agentType].binary;
}

export type PrintOutputFormat = "text" | "json" | "stream-json";

export interface PrintArgsInput {
  agentType: AgentClientId;
  prompt: string;
  configuredArgs: string;
  permFlags: string | null;
  defaultFlags: string | null;
  modelAlias?: string;
  requestedEffort?: string;
  outputFormat?: PrintOutputFormat;
  resumeId?: string;
  continueLast?: boolean;
  maxTurns?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  jsonSchema?: string;
  bare?: boolean;
  worktree?: boolean | string;
  extraArgs?: string[];
  /** Print-mode auto-approve for clients whose TUI launch has no perm flags
   *  (cursor --force, gemini --yolo). Default true; `--permission-mode default`
   *  turns it off. */
  autoApprove?: boolean;
}

export interface PrintArgsResult {
  binaryArgs: string[];
  /** Unified flags this client cannot honor; the CLI warns on these. */
  ignored: string[];
}

/**
 * Args for a client's native print / exec / run mode. Shares configured args,
 * permission flags, and model/effort mapping with TUI launch, then wraps them
 * in the client's print-mode token from the registry.
 */
export function buildPrintArgs(input: PrintArgsInput): PrintArgsResult {
  const { agentType, prompt } = input;
  const print = AGENT_CLIENTS[agentType].printMode;
  const ignored: string[] = [];
  const args: string[] = [];

  if (print.kind === "subcommand") args.push(print.token);

  if (input.resumeId && input.continueLast) {
    // Resume names a session; continue is redundant.
  }
  if (agentType === "codex") {
    if (input.resumeId) args.push("resume", input.resumeId);
    else if (input.continueLast) args.push("resume", "--last");
  } else if (agentType === "opencode") {
    if (input.resumeId) args.push("-s", input.resumeId);
    else if (input.continueLast) args.push("--continue");
  } else if (agentType === "pi") {
    if (input.resumeId) args.push("--session", input.resumeId);
    else if (input.continueLast) args.push("--continue");
  } else if (agentType === "gemini") {
    if (input.resumeId) args.push("-r", input.resumeId);
    else if (input.continueLast) args.push("-r", "latest");
  } else {
    if (input.resumeId) args.push("--resume", input.resumeId);
    else if (input.continueLast) args.push("--continue");
  }

  if (input.configuredArgs) args.push(...splitFlags(input.configuredArgs));

  if (agentType === "opencode" && !input.configuredArgs.includes("--auto")) {
    args.push("--auto");
  }

  const perm = splitFlags(input.permFlags);
  if (perm.length) {
    if (agentType === "claude" && claudeArgsPinPermission(input.configuredArgs)) {
      // configured args already pin a mode
    } else {
      args.push(...perm);
    }
  } else if (input.autoApprove !== false && !input.configuredArgs) {
    // TUI launch has no permission flags for cursor/gemini; print mode
    // still auto-approves so a script does not hang on a prompt.
    if (agentType === "cursor") args.push("--force", "--trust");
    else if (agentType === "gemini") args.push("--yolo");
  }

  if (input.defaultFlags) args.push(...splitFlags(input.defaultFlags));

  appendModelEffortFlags(args, input);
  if ((agentType === "cursor" || agentType === "gemini") && input.modelAlias) {
    args.push("--model", input.modelAlias);
  }

  pushOutputFormat(args, agentType, input.outputFormat, ignored);

  if (input.maxTurns != null) {
    if (agentType === "claude" || agentType === "grok") {
      args.push("--max-turns", String(input.maxTurns));
    } else {
      ignored.push("--max-turns");
    }
  }

  if (input.systemPrompt) {
    if (agentType === "claude" || agentType === "pi") args.push("--system-prompt", input.systemPrompt);
    else if (agentType === "grok") args.push("--system-prompt-override", input.systemPrompt);
    else ignored.push("--system-prompt");
  }
  if (input.appendSystemPrompt) {
    if (agentType === "claude" || agentType === "pi") args.push("--append-system-prompt", input.appendSystemPrompt);
    else if (agentType === "grok") args.push("--rules", input.appendSystemPrompt);
    else ignored.push("--append-system-prompt");
  }
  if (input.jsonSchema) {
    if (agentType === "claude" || agentType === "grok") args.push("--json-schema", input.jsonSchema);
    else ignored.push("--json-schema");
  }
  if (input.bare) {
    if (agentType === "claude") args.push("--bare");
    else if (agentType === "opencode") args.push("--pure");
    else ignored.push("--bare");
  }
  if (input.worktree) {
    const name = typeof input.worktree === "string" ? input.worktree : undefined;
    if (agentType === "grok" || agentType === "cursor" || agentType === "gemini") {
      if (name) args.push("--worktree", name);
      else args.push("--worktree");
    } else {
      ignored.push("--worktree");
    }
  }

  if (print.kind === "flag") {
    if (print.promptAsValue) args.push(print.token, prompt);
    else {
      args.push(print.token);
      if (prompt) args.push(prompt);
    }
  } else if (prompt) {
    args.push(prompt);
  }

  if (input.extraArgs?.length) args.push(...input.extraArgs);

  return { binaryArgs: args, ignored };
}

function pushOutputFormat(
  args: string[],
  agentType: AgentClientId,
  format: PrintOutputFormat | undefined,
  ignored: string[],
): void {
  if (!format || format === "text") return;
  if (agentType === "claude" || agentType === "cursor" || agentType === "gemini") {
    args.push("--output-format", format);
    return;
  }
  if (agentType === "grok") {
    args.push("--output-format", format === "stream-json" ? "streaming-json" : "json");
    return;
  }
  if (agentType === "codex") {
    args.push("--json");
    return;
  }
  if (agentType === "opencode") {
    args.push("--format", "json");
    return;
  }
  if (agentType === "pi") {
    args.push("--mode", "json");
    return;
  }
  ignored.push("--output-format");
}

/** Shell-quote a binary + args for `--dry-run` display. */
export function formatPrintCommand(binary: string, args: string[]): string {
  return [binary, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
