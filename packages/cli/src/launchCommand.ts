// Fresh-session launch command construction, pulled out of the daemon's start
// path so it is unit-testable per client. The binary itself is a registry lookup
// (AGENT_CLIENTS[agentType].binary); this module owns the ARG list and the one
// place the daemon reads a client's configured base args.
//
// buildLaunchArgs is pure: it takes the already-resolved flag strings (permission
// flags, default-param flags, model alias, effort) and returns the raw arg list
// plus whether the daemon should fire the one-time "codex is running in full-access
// mode" notification. The daemon keeps the impure pieces (getPermissionFlags,
// getDefaultParamFlags, the notification write, sanitizeBinaryArgs) around it.
import {
  AGENT_CLIENTS,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  type AgentClientId,
} from "@codecast/shared/contracts";
import { getAgentArgs, type Config } from "./config/types.js";

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
  }
  // cursor / gemini: no configured args or permission flags today.

  if (defaultFlags) args.push(...defaultFlags.split(/\s+/).filter(Boolean));

  // Per-session model/effort, appended AFTER config/default flags so the
  // per-session choice wins (both CLIs take the last occurrence).
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
  }

  return { binaryArgs: args, notifyCodexBypass };
}

/** The binary launched for a fresh session — a registry lookup. */
export function launchBinary(agentType: AgentClientId): string {
  return AGENT_CLIENTS[agentType].binary;
}
