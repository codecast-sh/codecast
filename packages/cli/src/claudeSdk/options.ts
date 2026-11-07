// SDK query options for one Claude SDK session, derived from the same launch
// argv the tmux path types into a pane (launchCommand.ts buildLaunchArgs), so
// the two backends cannot drift on model, effort, permission mode, tool policy
// or session id. Pure: the host process calls it with its own environment.
//
// Claude Code's own behavior is kept whole: no settingSources override (user,
// project and local settings, CLAUDE.md, hooks, skills and MCP servers all
// load as in the terminal), the claude_code system prompt preset, the built-in
// tools, and the user's installed binary rather than the SDK's bundled copy.

import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_LAUNCH_UNSET_ENV, AGENT_SCRUBBED_ENV_VARS, EFFORT_OVERRIDE_ENV, FORCE_PERSISTENCE_VAR, SDK_BACKEND_ENV } from "../agentEnv.js";

export { SDK_BACKEND_ENV };


export interface SdkLaunchSpec {
  /** The conversation this session belongs to, for the daemon's bookkeeping. */
  conversationId: string | null;
  /** The Claude session id: a fresh id to create, or the saved session to resume. */
  sessionId: string;
  resume: boolean;
  cwd: string;
  /** The user's installed claude, the binary the tmux path would launch. */
  executable: string;
  /** The claude argv the tmux path would use (buildLaunchArgs), without the binary. */
  args: string[];
  /** Variables the tmux launch line sets (launch token, stable context, worktree ports). */
  env: Record<string, string>;
  appendSystemPrompt?: string;
  /** argv prefix for the claude process (the TCC disclaim wrapper), empty for none. */
  spawnPrefix?: string[];
}

export interface ParsedClaudeArgs {
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  sessionId?: string;
  resume?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  appendSystemPrompt?: string;
  systemPrompt?: string;
  /** Every other flag, passed through to claude unchanged. */
  extraArgs: Record<string, string | null>;
}

const VARIADIC = new Set(["--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--add-dir"]);
/** Flags that take no value, whatever follows them. */
const BOOLEAN = new Set([
  "--allow-dangerously-skip-permissions", "--dangerously-skip-permissions", "--verbose", "--debug",
  "--continue", "-c", "--ide", "--strict-mcp-config", "--fork-session",
]);

/** Read a claude launch argv into SDK options. Unknown flags ride `extraArgs`. */
export function parseClaudeArgs(args: string[]): ParsedClaudeArgs {
  const out: ParsedClaudeArgs = { extraArgs: {} };
  const list = (key: "allowedTools" | "disallowedTools" | "additionalDirectories", values: string[]) => {
    const items = values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
    out[key] = [...(out[key] ?? []), ...items];
  };
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (raw === "--") break;
    if (!raw.startsWith("-")) continue;
    const eq = raw.indexOf("=");
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    if (VARIADIC.has(flag)) {
      const values: string[] = inline !== undefined ? [inline] : [];
      while (inline === undefined && i + 1 < args.length && !args[i + 1].startsWith("-")) values.push(args[++i]);
      if (flag === "--add-dir") list("additionalDirectories", values);
      else list(flag.startsWith("--allowed") ? "allowedTools" : "disallowedTools", values);
      continue;
    }
    if (BOOLEAN.has(flag)) {
      if (flag === "--allow-dangerously-skip-permissions") out.allowDangerouslySkipPermissions = true;
      else if (flag === "--dangerously-skip-permissions") {
        out.permissionMode = "bypassPermissions";
        out.allowDangerouslySkipPermissions = true;
      } else out.extraArgs[flag.replace(/^-+/, "")] = null;
      continue;
    }
    const value = inline ?? (i + 1 < args.length && !args[i + 1].startsWith("-") ? args[++i] : undefined);
    switch (flag) {
      case "--model": out.model = value; break;
      case "--effort": out.effort = value; break;
      case "--permission-mode": out.permissionMode = value as PermissionMode; break;
      case "--session-id": out.sessionId = value; break;
      case "--resume": case "-r": out.resume = value; break;
      case "--append-system-prompt": out.appendSystemPrompt = value; break;
      case "--system-prompt": out.systemPrompt = value; break;
      default: out.extraArgs[flag.replace(/^-+/, "")] = value ?? null;
    }
  }
  if (out.permissionMode === "bypassPermissions") out.allowDangerouslySkipPermissions = true;
  return out;
}

/**
 * The environment Claude runs with: the host's own (which already carries the
 * account the tmux path would source), minus the markers that silence or
 * confuse a nested Claude, plus the launch line's variables.
 */
export function sdkSessionEnv(base: Record<string, string | undefined>, spec: Pick<SdkLaunchSpec, "env">, opts: { effortSet: boolean }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, ...spec.env };
  for (const v of AGENT_SCRUBBED_ENV_VARS) delete env[v];
  for (const v of AGENT_LAUNCH_UNSET_ENV) delete env[v];
  if (opts.effortSet) delete env[EFFORT_OVERRIDE_ENV];
  env[FORCE_PERSISTENCE_VAR] = "1";
  env[SDK_BACKEND_ENV] = "sdk";
  // The host's own launchd label is not Claude's.
  delete env.CAST_LAUNCHD_LABEL;
  return env;
}

/** The SDK options for a spec. canUseTool is attached by the session. */
export function sdkQueryOptions(spec: SdkLaunchSpec, base: Record<string, string | undefined>): Options & { sessionId?: string; resume?: string } {
  const parsed = parseClaudeArgs(spec.args);
  const effort = parsed.effort as Options["effort"] | undefined;
  const append = [parsed.appendSystemPrompt, spec.appendSystemPrompt].filter(Boolean).join("\n\n") || undefined;
  const options: Options & { sessionId?: string; resume?: string } = {
    pathToClaudeCodeExecutable: spec.executable,
    cwd: spec.cwd,
    env: sdkSessionEnv(base, spec, { effortSet: !!effort }),
    systemPrompt: parsed.systemPrompt ?? { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
    persistSession: true,
    extraArgs: parsed.extraArgs,
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(effort ? { effort } : {}),
    ...(parsed.permissionMode ? { permissionMode: parsed.permissionMode } : {}),
    ...(parsed.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    ...(parsed.allowedTools?.length ? { allowedTools: parsed.allowedTools } : {}),
    ...(parsed.disallowedTools?.length ? { disallowedTools: parsed.disallowedTools } : {}),
    ...(parsed.additionalDirectories?.length ? { additionalDirectories: parsed.additionalDirectories } : {}),
  };
  if (spec.resume) options.resume = spec.sessionId;
  else options.sessionId = spec.sessionId;
  return options;
}
