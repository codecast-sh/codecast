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
import { loadLocalUsageProfiles, usagePressureLine } from "./usageCommand.js";

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
    const verifyNote =
      "This is a snapshot from session start — `cast feed` / `cast sessions` give the current picture. " +
      "Before attributing work to a session or messaging it about its work, check its evidence: `cast diff <id>` shows the files it changed, `cast read <id>` its recent turns. " +
      "A session's state says who is paying attention now, not who wrote what.";
    const instruction = opts.mode === "team"
      ? `This gives you bigger-picture visibility on what has been and is being worked on by the team.\n${verifyNote}`
      : `This gives you bigger-picture visibility on what you have been and are currently working on.\n${verifyNote}`;

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

/** Clients whose session-start hook mechanism we install into. Each consumes
 * the same feed block; only the stdout envelope differs:
 *  - claude:   raw text (SessionStart hook stdout becomes context)
 *  - codex:    {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}
 *  - cursor:   {"additional_context":…} (sessionStart hook, JSON stdout required)
 *  - opencode: raw text (our plugin pushes stdout into the system prompt) */
export type StableHookClient = "claude" | "codex" | "cursor" | "opencode";

export const STABLE_HOOK_CLIENTS: readonly StableHookClient[] = ["claude", "codex", "cursor", "opencode"];

export function parseStableHookClient(value: string | undefined): StableHookClient {
  return (STABLE_HOOK_CLIENTS as readonly string[]).includes(value ?? "")
    ? (value as StableHookClient)
    : "claude";
}

function wrapForClient(client: StableHookClient, text: string): string {
  switch (client) {
    case "codex":
      return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })}\n`;
    case "cursor":
      return `${JSON.stringify({ additional_context: text })}\n`;
    default:
      return `${text}\n`;
  }
}

/** Run the hidden session-start command without Commander or any of the CLI's
 * global lifecycle hooks. Stdout is reserved for the injected block because
 * the client consumes it as hook output. */
export async function runStableContextHook(
  config: StableContextConfig | null,
  client: StableHookClient = "claude",
): Promise<void> {
  // Hook payload on stdin: { session_id, cwd, source, ... }. Manual TTY runs
  // have no payload — fall back to process.cwd() and record by nothing.
  // Cursor's sessionStart payload has no cwd; it names workspace_roots instead.
  let payload: { session_id?: string; cwd?: string; workspace_roots?: string[]; cursor_version?: string } = {};
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

  // Cursor imports Claude user hooks and runs them with its own payload
  // (marked by cursor_version). Its native sessionStart hook already injects
  // the feed with the right envelope, so the Claude hook must stay silent
  // here — raw text would at best log a parse error in Cursor, at worst
  // double-inject if Cursor ever learns to read Claude hook stdout.
  if (client === "claude" && payload.cursor_version) return;

  // Env overrides (exported by the daemon from the new-session page's choice)
  // beat the machine config; no mode from either → nothing to inject.
  const launch = resolveStableLaunch(process.env, config ?? {});
  if (!launch.mode) return;

  const workspaceRoot = Array.isArray(payload.workspace_roots) ? payload.workspace_roots[0] : undefined;
  const built = await buildStableContext(config, {
    mode: launch.mode,
    global: launch.global,
    exclude: launch.exclude,
    cwd: payload.cwd || workspaceRoot || process.cwd(),
  });
  if (!built) return;

  // Claude sessions only (this is the Claude account's meter): a session that
  // starts on an already-pressured account learns it here, at the one moment
  // the active login is provably its account. Silent when there is headroom.
  let text = built.text;
  if (client === "claude") {
    try {
      const line = usagePressureLine(loadLocalUsageProfiles(), Date.now());
      if (line) text += `\n\n${line}`;
    } catch {}
  }
  process.stdout.write(wrapForClient(client, text));
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

/** One script template for every client: cheap disabled-case gate (no node
 * boot on machines without stable mode), then exec the real command. The
 * `--client` flag only selects the stdout envelope. Claude's script omits the
 * flag so hook files installed by older CLI versions keep matching it. */
function stableFeedHookScript(client: StableHookClient): string {
  const clientArg = client === "claude" ? "" : ` --client ${client}`;
  return `#!/bin/bash
# CodeCast Stable Mode - injects recent session history on session start (${client})
set -uo pipefail

CONFIG_FILE="$HOME/.codecast/config.json"

# Ensure codecast is on PATH (hooks run non-interactively)
export PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -z "\${CODECAST_STABLE_MODE:-}" ]; then
  [ -f "$CONFIG_FILE" ] || exit 0
  grep -q '"stable_mode"' "$CONFIG_FILE" 2>/dev/null || exit 0
fi

command -v codecast >/dev/null 2>&1 || exit 0
exec codecast stable-context${clientArg}
`;
}

export const STABLE_FEED_HOOK = stableFeedHookScript("claude");

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

// ─── Codex / Cursor / opencode hook install ──────────────────────────────────
// Same feed, three more delivery mechanisms. The wrapper scripts live under
// ~/.codecast/hooks/ (codecast-owned — client dot-dirs only get a config
// entry pointing at them). Every installer is a no-op when the client's
// dot-dir is absent, so enabling stable mode on a machine without a client
// touches nothing of that client's.

function codecastHooksDir(): string {
  return path.join(process.env.HOME || "", ".codecast", "hooks");
}

function writeStableHookScript(client: Exclude<StableHookClient, "claude">): string {
  const dir = codecastHooksDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `stable-feed-${client}.sh`);
  fs.writeFileSync(file, stableFeedHookScript(client), { mode: 0o755 });
  // writeFileSync's mode only applies when creating a file. A pre-existing
  // script may have lost its executable bit, so repair it on every refresh.
  fs.chmodSync(file, 0o755);
  return file;
}

/** Codex reads hooks.json only when the `hooks` feature flag is on (off by
 * default as of 0.146). Turn it on unless the user has set `hooks =` at all —
 * an explicit false is an opt-out we must respect. Line-level TOML surgery,
 * same spirit as the marked-snippet installers. */
function ensureCodexHooksFeature(codexDir: string): void {
  const configFile = path.join(codexDir, "config.toml");
  const existing = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf-8") : "";
  if (/^\s*hooks\s*=/m.test(existing)) return;
  const updated = /^\s*\[features\]\s*$/m.test(existing)
    ? existing.replace(/^(\s*\[features\]\s*)$/m, "$1\nhooks = true")
    : `${existing.trimEnd()}\n\n[features]\nhooks = true\n`.replace(/^\n+/, "");
  fs.writeFileSync(configFile, updated);
}

/** Codex: merge a SessionStart entry into ~/.codex/hooks.json. Codex's hook
 * schema mirrors Claude's settings.json (matcher groups with nested hooks).
 * additionalContextLimit 0 disables Codex's default 2,500-token spill-to-file
 * truncation — the feed must arrive whole or not at all. */
export function installStableHookCodex(): void {
  const home = process.env.HOME || "";
  const codexDir = path.join(home, ".codex");
  if (!fs.existsSync(codexDir)) return;

  try {
    ensureCodexHooksFeature(codexDir);
    const hookFile = writeStableHookScript("codex");
    const hooksFile = path.join(codexDir, "hooks.json");
    let config: any = {};
    if (fs.existsSync(hooksFile)) {
      config = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
    }
    if (!config.hooks) config.hooks = {};
    if (!config.hooks.SessionStart) config.hooks.SessionStart = [];

    const present = (config.hooks.SessionStart as any[]).some((matcher: any) =>
      (matcher.hooks || []).some((h: any) => h.command === hookFile),
    );
    if (!present) {
      config.hooks.SessionStart.push({
        hooks: [{ type: "command", command: hookFile, additionalContextLimit: 0, timeout: 30 }],
      });
      fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2));
    }
  } catch {
    // Hook install is an optional enhancement — never break the caller.
  }
}

export function removeStableHookCodex(): void {
  const home = process.env.HOME || "";
  const hookFile = path.join(codecastHooksDir(), "stable-feed-codex.sh");
  try { fs.unlinkSync(hookFile); } catch {}

  const hooksFile = path.join(home, ".codex", "hooks.json");
  if (!fs.existsSync(hooksFile)) return;
  try {
    const config = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
    if (!config.hooks?.SessionStart) return;
    for (const matcher of config.hooks.SessionStart) {
      if (matcher.hooks) {
        // Exact-path match so unrelated SessionStart hooks survive.
        matcher.hooks = matcher.hooks.filter((h: any) => h.command !== hookFile);
      }
    }
    config.hooks.SessionStart = config.hooks.SessionStart.filter((m: any) => m.hooks && m.hooks.length > 0);
    fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2));
  } catch {}
}

/** Cursor: merge a sessionStart entry into ~/.cursor/hooks.json. Flat entry
 * list per event (no matcher groups); the hook must print JSON with an
 * `additional_context` field, which `--client cursor` produces. */
export function installStableHookCursor(): void {
  const home = process.env.HOME || "";
  const cursorDir = path.join(home, ".cursor");
  if (!fs.existsSync(cursorDir)) return;

  try {
    const hookFile = writeStableHookScript("cursor");
    const hooksFile = path.join(cursorDir, "hooks.json");
    let config: any = {};
    if (fs.existsSync(hooksFile)) {
      config = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
    }
    if (config.version == null) config.version = 1;
    if (!config.hooks) config.hooks = {};
    if (!config.hooks.sessionStart) config.hooks.sessionStart = [];

    const present = (config.hooks.sessionStart as any[]).some((h: any) => h.command === hookFile);
    if (!present) {
      config.hooks.sessionStart.push({ command: hookFile, timeout: 30 });
      fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2));
    }
  } catch {
    // Optional enhancement.
  }
}

export function removeStableHookCursor(): void {
  const home = process.env.HOME || "";
  const hookFile = path.join(codecastHooksDir(), "stable-feed-cursor.sh");
  try { fs.unlinkSync(hookFile); } catch {}

  const hooksFile = path.join(home, ".cursor", "hooks.json");
  if (!fs.existsSync(hooksFile)) return;
  try {
    const config = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
    if (!config.hooks?.sessionStart) return;
    config.hooks.sessionStart = config.hooks.sessionStart.filter((h: any) => h.command !== hookFile);
    if (config.hooks.sessionStart.length === 0) delete config.hooks.sessionStart;
    fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2));
  } catch {}
}

/** opencode has no session-start hook yet (the upstream PR is unmerged), but
 * its plugin API exposes `experimental.chat.system.transform` — called on
 * every prompt build with the system-prompt array to extend. The plugin
 * fetches the feed once per session (cached promise) and pushes it into the
 * system prompt on every request, which keeps the feed present for the whole
 * session rather than only the first turn. */
function opencodeGlobalDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");
  return path.join(xdg, "opencode");
}

function opencodeStablePlugin(scriptPath: string): string {
  return `// CodeCast Stable Mode — injects recent session history into the system prompt.
// Installed by \`cast stable\`; \`cast stable off\` removes it. Do not edit —
// the codecast daemon rewrites this file when the CLI updates.
export const CodecastStable = async ({ $, directory }) => {
  const script = ${JSON.stringify(scriptPath)};
  const cache = new Map();
  return {
    "experimental.chat.system.transform": async (input, output) => {
      const key = input.sessionID || "global";
      if (!cache.has(key)) {
        cache.set(key, (async () => {
          try {
            const payload = JSON.stringify({ session_id: input.sessionID, cwd: directory });
            const res = await $\`echo \${payload} | bash \${script}\`.quiet().nothrow();
            return res.exitCode === 0 ? res.text().trim() : "";
          } catch {
            return "";
          }
        })());
      }
      const text = await cache.get(key);
      if (text) output.system.push(text);
    },
  };
};
`;
}

export function installStableHookOpencode(): void {
  const ocDir = opencodeGlobalDir();
  if (!fs.existsSync(ocDir)) return;
  try {
    const scriptPath = writeStableHookScript("opencode");
    const pluginDir = path.join(ocDir, "plugins");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "codecast-stable.js"), opencodeStablePlugin(scriptPath));
  } catch {
    // Optional enhancement.
  }
}

export function removeStableHookOpencode(): void {
  try { fs.unlinkSync(path.join(codecastHooksDir(), "stable-feed-opencode.sh")); } catch {}
  try { fs.unlinkSync(path.join(opencodeGlobalDir(), "plugins", "codecast-stable.js")); } catch {}
}

const HOOK_INSTALLERS: Record<StableHookClient, () => void> = {
  claude: installStableHook,
  codex: installStableHookCodex,
  cursor: installStableHookCursor,
  opencode: installStableHookOpencode,
};

/** Install the hook for every client present on this machine. Claude installs
 * unconditionally (its hook predates the per-client split); the others no-op
 * without their dot-dir. Used by `cast stable`, `cast install`, and the
 * daemon's boot refresh so script updates ship with the CLI. */
export function installAllStableHooks(): void {
  for (const client of STABLE_HOOK_CLIENTS) HOOK_INSTALLERS[client]();
}

export function removeAllStableHooks(): void {
  removeStableHook();
  removeStableHookCodex();
  removeStableHookCursor();
  removeStableHookOpencode();
}

/**
 * Ensure a launch that will actually inject stable context has this client's
 * session-start hook installed. This is intentionally evaluated per launch:
 * an explicit Team/Solo session can opt in on a machine whose configured
 * stable mode is off (and therefore had its hooks removed).
 */
export function ensureStableHookForLaunch(
  agentType: AgentClientId,
  configuredMode: StableMode | undefined,
  prefs: StableLaunchPrefs,
  installHook?: () => void,
): boolean {
  const effectiveMode = prefs.stable_mode ?? configuredMode;
  const installer = (HOOK_INSTALLERS as Partial<Record<AgentClientId, () => void>>)[agentType];
  if (!installer || (effectiveMode !== "team" && effectiveMode !== "solo")) {
    return false;
  }
  (installHook ?? installer)();
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
