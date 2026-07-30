// Stable-context building + recording, shared by the two injection paths:
//   - `cast stable-context` (the SessionStart hook for Claude Code) — resolves
//     env overrides, prints the block to stdout, records what it injected.
//   - the daemon's Codex threadStart (developerInstructions) — same builder,
//     records directly against the conversation it is spawning.
// One builder means the feed params, exclusion filtering, and the recorded
// item shape can never drift between agents.

import fs from "fs";
import path from "path";
import {
  isExcludedStableItem,
  resolveStableLaunch,
  type AgentClientId,
  type StableContextData,
  type StableContextItem,
  type StableFeedMode,
  type StableLaunchPrefs,
  type StableMode,
} from "@codecast/shared/contracts";
import { formatFeedResults } from "./formatter.js";

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export interface StableContextConfig {
  auth_token?: string;
  convex_url?: string;
  stable_mode?: StableMode;
  stable_global?: boolean;
}

export interface BuildStableContextOptions {
  mode: StableFeedMode;
  global: boolean;
  exclude?: string[];
  cwd?: string;
}

export interface BuiltStableContext {
  text: string;
  data: StableContextData;
}

/** Fetch the feed and render the <stable-context> block. Returns undefined on
 * any failure — injection is an optional enhancement, never a boot blocker. */
export async function buildStableContext(
  config: StableContextConfig | null,
  opts: BuildStableContextOptions,
): Promise<BuiltStableContext | undefined> {
  if (!config?.auth_token || !config?.convex_url) return undefined;

  const projectPath = opts.global ? undefined : opts.cwd;
  const lookbackDays = opts.mode === "team" ? 14 : 7;
  const limit = opts.mode === "team" ? 15 : 10;
  const exclude = opts.exclude ?? [];
  const siteUrl = config.convex_url.replace(".cloud", ".site");

  try {
    const response = await fetch(`${siteUrl}/cli/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        // Over-fetch by the exclusion count so excluding cards doesn't shrink
        // the injected feed below its normal size.
        limit: Math.min(limit + exclude.length, 30),
        offset: 0,
        start_time: Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
        project_path: projectPath,
      }),
      // Stable context is optional and must never hold up agent startup
      // indefinitely when the network or backend is unhealthy.
      signal: AbortSignal.timeout(15_000),
    });

    const result = (await response.json()) as any;
    if (!response.ok || result?.error) return undefined;

    const conversations = ((result.conversations ?? []) as any[])
      .filter((conv) => !isExcludedStableItem(String(conv.id ?? ""), exclude))
      .slice(0, limit);

    const feed = stripAnsi(formatFeedResults({ ...result, conversations }, { projectPath }));
    const instruction = opts.mode === "team"
      ? "This gives you bigger-picture visibility on what has been and is being worked on by the team."
      : "This gives you bigger-picture visibility on what you have been and are currently working on.";

    const items: StableContextItem[] = conversations.map((conv) => ({
      id: String(conv.id),
      title: String(conv.title ?? "Untitled"),
      project_path: conv.project_path ?? null,
      updated_at: conv.updated_at,
      message_count: conv.message_count,
      work_state: conv.work_state,
      is_live: conv.is_live,
      user_name: conv.user?.name ?? conv.user?.email ?? null,
      owner_name: conv.owner?.name ?? conv.owner?.email ?? null,
      owned_by_me: conv.owned_by_me,
    }));

    return {
      text: `<stable-context mode="${opts.mode}">
${instruction}

${feed}
</stable-context>`,
      data: { mode: opts.mode, global: opts.global, injected_at: Date.now(), items },
    };
  } catch {
    return undefined;
  }
}

/** Report what was injected so the web can render it as cards at the top of
 * the conversation. Keyed by conversation_id when the daemon exported it
 * (web-started sessions), else by the agent session id — the server spools
 * records that arrive before the conversation row exists. Fire-and-forget
 * with a short cap so a slow network never delays session start. */
export async function recordStableContext(
  config: StableContextConfig | null,
  payload: { session_id?: string; conversation_id?: string; data: StableContextData },
): Promise<void> {
  if (!config?.auth_token || !config?.convex_url) return;
  if (!payload.session_id && !payload.conversation_id) return;
  const siteUrl = config.convex_url.replace(".cloud", ".site");
  try {
    await fetch(`${siteUrl}/cli/stable-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        session_id: payload.session_id,
        conversation_id: payload.conversation_id,
        data: JSON.stringify(payload.data),
      }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // Optional enhancement — never surface.
  }
}

/** Run the hidden SessionStart command without Commander or any of the CLI's
 * global lifecycle hooks. Stdout is reserved for the injected block because
 * Claude consumes it as hook output. */
export async function runStableContextHook(
  config: StableContextConfig | null,
): Promise<void> {
  // Hook payload on stdin: { session_id, cwd, source, ... }. Manual TTY runs
  // have no payload — fall back to process.cwd() and record by nothing.
  let payload: { session_id?: string; cwd?: string } = {};
  if (!process.stdin.isTTY) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw) payload = JSON.parse(raw);
    } catch {
      // Malformed payload — still inject from defaults.
    }
  }

  // Env overrides (exported by the daemon from the new-session page's choice)
  // beat the machine config; no mode from either → nothing to inject.
  const launch = resolveStableLaunch(process.env, config ?? {});
  if (!launch.mode) return;

  const built = await buildStableContext(config, {
    mode: launch.mode,
    global: launch.global,
    exclude: launch.exclude,
    cwd: payload.cwd || process.cwd(),
  });
  if (!built) return;

  process.stdout.write(`${built.text}\n`);
  // Record what was injected so the web renders it as cards at the top of
  // the conversation. Prefer the daemon-exported conversation id (no lookup
  // race); terminal-started sessions fall back to the agent session id,
  // which the server spools until the conversation registers.
  await recordStableContext(config, {
    conversation_id: launch.conversationId,
    session_id: payload.session_id,
    data: built.data,
  });
}

// ─── SessionStart hook install ────────────────────────────────────────────────
// The mode/scope resolution, feed build, exclusion filtering, and the record of
// what was injected all live in `codecast stable-context` — the script only
// gates the disabled case cheaply so a machine without stable mode never pays a
// node boot per session start. CODECAST_STABLE_MODE is the daemon's per-session
// override (may enable injection on a machine whose config has no stable_mode,
// or force it off). Installed by `cast stable` / the install flow, and
// refreshed by the daemon on boot so script updates ship with the CLI.

export const STABLE_FEED_HOOK = `#!/bin/bash
# CodeCast Stable Mode - injects recent session history on SessionStart
set -uo pipefail

CONFIG_FILE="$HOME/.codecast/config.json"

# Ensure codecast is on PATH (hooks run non-interactively)
export PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -z "\${CODECAST_STABLE_MODE:-}" ]; then
  [ -f "$CONFIG_FILE" ] || exit 0
  grep -q '"stable_mode"' "$CONFIG_FILE" 2>/dev/null || exit 0
fi

command -v codecast >/dev/null 2>&1 || exit 0
exec codecast stable-context
`;

export function installStableHook(): void {
  const home = process.env.HOME || "";
  const hooksDir = path.join(home, ".claude", "hooks");
  const hookFile = path.join(hooksDir, "stable-feed.sh");
  const settingsFile = path.join(home, ".claude", "settings.json");

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookFile, STABLE_FEED_HOOK, { mode: 0o755 });
    // writeFileSync's mode only applies when creating a file. A pre-existing
    // hook may have lost its executable bit, so repair it on every refresh.
    fs.chmodSync(hookFile, 0o755);

    let settings: any = {};
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    }
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];

    const hookArray = settings.hooks.SessionStart as any[];
    const alreadyPresent = hookArray.some((matcher: any) =>
      (matcher.hooks || []).some((h: any) => h.command?.includes("stable-feed.sh"))
    );

    if (!alreadyPresent) {
      const hookEntry = { type: "command", command: hookFile, timeout: 30 };
      if (hookArray.length > 0 && hookArray[0].matcher === "") {
        hookArray[0].hooks = hookArray[0].hooks || [];
        hookArray[0].hooks.push(hookEntry);
      } else {
        hookArray.unshift({ matcher: "", hooks: [hookEntry] });
      }
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4));
  } catch {
    // Ignore errors - hook is optional enhancement
  }
}

/**
 * Ensure a Claude launch that will actually inject stable context has the
 * SessionStart hook installed. This is intentionally evaluated per launch:
 * an explicit Team/Solo session can opt in on a machine whose configured
 * stable mode is off (and therefore had its hook removed).
 */
export function ensureStableHookForLaunch(
  agentType: AgentClientId,
  configuredMode: StableMode | undefined,
  prefs: StableLaunchPrefs,
  installHook: () => void = installStableHook,
): boolean {
  const effectiveMode = prefs.stable_mode ?? configuredMode;
  if (agentType !== "claude" || (effectiveMode !== "team" && effectiveMode !== "solo")) {
    return false;
  }
  installHook();
  return true;
}

export function removeStableHook(): void {
  const home = process.env.HOME || "";
  const hookFile = path.join(home, ".claude", "hooks", "stable-feed.sh");
  const settingsFile = path.join(home, ".claude", "settings.json");

  // The script contains no user data and is owned solely by Codecast. Removing
  // it as well as its settings entry makes `stable off` an actual uninstall.
  try {
    fs.unlinkSync(hookFile);
  } catch {}

  if (!fs.existsSync(settingsFile)) return;

  let settings: any;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  } catch {
    return;
  }
  if (!settings.hooks?.SessionStart) return;

  for (const matcher of settings.hooks.SessionStart) {
    if (matcher.hooks) {
      // installStableHook writes this exact absolute path. Match it exactly so
      // an unrelated SessionStart integration with a similar filename survives.
      matcher.hooks = matcher.hooks.filter((h: any) => h.command !== hookFile);
    }
  }
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
    (m: any) => m.hooks && m.hooks.length > 0
  );

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4));
}
