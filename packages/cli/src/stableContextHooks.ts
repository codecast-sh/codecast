// Installing the session-start hook that injects the stable context, for each
// client, and the stdout envelope each client reads it from. The block it
// prints is built in stableContext.ts.

import { editHarnessJson, removeHarnessFile, writeHarnessFile } from "./harness.js";
import fs from "fs";
import path from "path";
import {
  STABLE_ENV_CONVERSATION_ID,
  STABLE_ENV_EXCLUDE,
  STABLE_ENV_GLOBAL,
  STABLE_ENV_MODE,
  type AgentClientId,
  type StableLaunchPrefs,
  type StableMode,
} from "@codecast/shared/contracts";
import { STABLE_FEED_HOOK_FILE } from "./codecastOwned.js";
import { defaultConfigDir, HOOK_STATE_DIR } from "./config/configDir.js";
import { STABLE_CONTEXT_SERVED_VERB } from "./fastPath.js";

/** Keys longer than this get no block (the script checks the same bound). */
export const DIR_BLOCK_KEY_MAX = 200;

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

/** A SessionStart block in the envelope `client` reads it from (also the
 *  task context after compaction, taskContextHook.ts). */
export function wrapForClient(client: StableHookClient, text: string): string {
  switch (client) {
    case "codex":
      return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })}\n`;
    case "cursor":
      return `${JSON.stringify({ additional_context: text })}\n`;
    default:
      return `${text}\n`;
  }
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

${HOOK_STATE_DIR}
CONFIG_FILE="$CC_DIR/config.json"

# Ensure codecast is on PATH (hooks run non-interactively)
export PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

${client === "claude" ? `# A session the daemon launched finds its block already rendered (prepareLaunchStableContext):
# printed with shell builtins, once (emptied as it is read).
case "\${${STABLE_ENV_CONVERSATION_ID}:-}" in
  ""|*[!a-z0-9]*) ;;
  *)
    RENDERED="$CC_DIR/stable-cache/rendered-\${${STABLE_ENV_CONVERSATION_ID}}.txt"
    if [ -s "$RENDERED" ]; then
      BODY=""
      IFS= read -r -d '' BODY < "$RENDERED" || true
      : > "$RENDERED"
      printf '%s' "$BODY"
      exit 0
    fi
    ;;
esac

# A terminal start (no launch overrides from the daemon) prints its folder's
# block, rendered by the last refresh, with shell builtins only: a process here
# costs the agent tens of milliseconds on a loaded machine. A detached
# \`codecast ${STABLE_CONTEXT_SERVED_VERB}\` records it and refreshes it. A resume, a
# payload this can't read, or a folder with no block takes the full path.
if [ -z "\${${STABLE_ENV_CONVERSATION_ID}:-}\${${STABLE_ENV_EXCLUDE}:-}\${${STABLE_ENV_MODE}:-}\${${STABLE_ENV_GLOBAL}:-}" ]; then
  INPUT=""; CFG=""; BODY=""
  IFS= read -r -d '' INPUT || true
  [ -f "$CONFIG_FILE" ] && { IFS= read -r -d '' CFG < "$CONFIG_FILE" || true; }
  MODE=""; GLOBAL=0; CWD=""; SOURCE=""; SID=""
  RE_MODE='"stable_mode"[[:space:]]*:[[:space:]]*"(team|solo)"'
  RE_GLOBAL='"stable_global"[[:space:]]*:[[:space:]]*true'
  RE_CWD='"cwd"[[:space:]]*:[[:space:]]*"([^"\\\\]+)"'
  RE_SOURCE='"source"[[:space:]]*:[[:space:]]*"([a-z]*)"'
  RE_SID='"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9-]+)"'
  [[ $CFG =~ $RE_MODE ]] && MODE=\${BASH_REMATCH[1]}
  [[ $CFG =~ $RE_GLOBAL ]] && GLOBAL=1
  [[ $INPUT =~ $RE_CWD ]] && CWD=\${BASH_REMATCH[1]}
  [[ $INPUT =~ $RE_SOURCE ]] && SOURCE=\${BASH_REMATCH[1]}
  [[ $INPUT =~ $RE_SID ]] && SID=\${BASH_REMATCH[1]}
  case "$INPUT" in *cursor_version*) MODE="" ;; esac
  [ -n "$MODE" ] || exit 0
  KEY="$MODE-$GLOBAL-\${CWD//[^A-Za-z0-9._-]/_}"
  BLOCK="$CC_DIR/stable-cache/rendered-dir-$KEY.txt"
  if [ -n "$CWD" ] && [ \${#KEY} -le ${DIR_BLOCK_KEY_MAX} ] && { [ "$SOURCE" = startup ] || [ -z "$SOURCE" ]; } && [ -f "$BLOCK" ]; then
    IFS= read -r -d '' BODY < "$BLOCK" || true
    if [ "\${BODY%%$'\n'*}" = "$MODE|$GLOBAL|$CWD" ]; then
      printf '%s' "\${BODY#*$'\n'}"
      if command -v codecast >/dev/null 2>&1; then
        nohup codecast ${STABLE_CONTEXT_SERVED_VERB} "$KEY" "\${SID:-none}" >/dev/null 2>&1 </dev/null &
      fi
      exit 0
    fi
  fi
  command -v codecast >/dev/null 2>&1 || exit 0
  printf '%s' "$INPUT" | codecast stable-context
  exit 0
fi

` : ""}if [ -z "\${CODECAST_STABLE_MODE:-}" ]; then
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
  const hookFile = path.join(home, ".claude", "hooks", STABLE_FEED_HOOK_FILE);
  const settingsFile = path.join(home, ".claude", "settings.json");

  try {
    writeHarnessFile(hookFile, STABLE_FEED_HOOK, "stable-context", { mode: 0o755, executable: true });
    editHarnessJson(settingsFile, "stable-context", (settings) => {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
      const hookArray = settings.hooks.SessionStart as any[];
      const alreadyPresent = hookArray.some((matcher: any) =>
        (matcher.hooks || []).some((h: any) => h.command?.includes(STABLE_FEED_HOOK_FILE))
      );
      if (alreadyPresent) return;
      const hookEntry = { type: "command", command: hookFile, timeout: 30 };
      if (hookArray.length > 0 && hookArray[0].matcher === "") {
        hookArray[0].hooks = hookArray[0].hooks || [];
        hookArray[0].hooks.push(hookEntry);
      } else {
        hookArray.unshift({ matcher: "", hooks: [hookEntry] });
      }
    });
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

export function codecastHooksDir(): string {
  return path.join(defaultConfigDir(), "hooks");
}

function writeStableHookScript(client: Exclude<StableHookClient, "claude">): string {
  const file = path.join(codecastHooksDir(), `stable-feed-${client}.sh`);
  writeHarnessFile(file, stableFeedHookScript(client), "stable-context", { mode: 0o755, executable: true });
  return file;
}

function readCodexConfig(codexDir: string): string {
  const configFile = path.join(codexDir, "config.toml");
  return fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf-8") : "";
}

/** Codex reads hooks.json only when the `hooks` feature flag is on (off by
 * default as of 0.146). Turn it on unless the user has set `hooks =` at all —
 * an explicit false is an opt-out we must respect. Line-level TOML surgery,
 * same spirit as the marked-snippet installers. `what` is the harness ledger's
 * cause. */
function ensureCodexHooksFeature(codexDir: string, what: string): void {
  const existing = readCodexConfig(codexDir);
  if (/^\s*hooks\s*=/m.test(existing)) return;
  const updated = /^\s*\[features\]\s*$/m.test(existing)
    ? existing.replace(/^(\s*\[features\]\s*)$/m, "$1\nhooks = true")
    : `${existing.trimEnd()}\n\n[features]\nhooks = true\n`.replace(/^\n+/, "");
  writeHarnessFile(path.join(codexDir, "config.toml"), updated, what);
}

/** Codex: merge a SessionStart entry into ~/.codex/hooks.json. Codex's hook
 * schema mirrors Claude's settings.json (matcher groups with nested hooks).
 * additionalContextLimit 0 disables Codex's default 2,500-token spill-to-file
 * truncation — the feed must arrive whole or not at all. */
export function installStableHookCodex(): void {
  installCodexSessionStartHook(() => writeStableHookScript("codex"), "stable-context", 30, { enableHooks: true });
}

export function removeStableHookCodex(): void {
  removeCodexSessionStartHook(path.join(codecastHooksDir(), "stable-feed-codex.sh"), "stable-context");
}

/** Register a SessionStart script in ~/.codex/hooks.json (written by
 *  `writeScript`, which returns its path). The hooks flag is global and
 *  wakes every hook in hooks.json, so only an explicit opt-in (stable mode)
 *  turns it on (`enableHooks`); any other caller installs only where Codex
 *  hooks are already on. A no-op without ~/.codex. Never throws: hooks are an
 *  optional enhancement. */
export function installCodexSessionStartHook(writeScript: () => string, what: string, timeout: number, opts: { enableHooks?: boolean } = {}): void {
  const codexDir = path.join(process.env.HOME || "", ".codex");
  if (!fs.existsSync(codexDir)) return;
  try {
    if (opts.enableHooks) ensureCodexHooksFeature(codexDir, what);
    else if (!/^\s*hooks\s*=\s*true\b/m.test(readCodexConfig(codexDir))) return;
    const hookFile = writeScript();
    editHarnessJson(path.join(codexDir, "hooks.json"), what, (config) => {
      if (!config.hooks) config.hooks = {};
      if (!config.hooks.SessionStart) config.hooks.SessionStart = [];
      const present = (config.hooks.SessionStart as any[]).some((matcher: any) =>
        (matcher.hooks || []).some((h: any) => h.command === hookFile),
      );
      if (present) return;
      config.hooks.SessionStart.push({
        hooks: [{ type: "command", command: hookFile, additionalContextLimit: 0, timeout }],
      });
    });
  } catch {}
}

/** Delete a SessionStart script and its ~/.codex/hooks.json entry. */
export function removeCodexSessionStartHook(hookFile: string, what: string): void {
  try { removeHarnessFile(hookFile, what); } catch {}
  try {
    editHarnessJson(path.join(process.env.HOME || "", ".codex", "hooks.json"), what, (config) => {
      if (!config.hooks?.SessionStart) return;
      for (const matcher of config.hooks.SessionStart) {
        if (matcher.hooks) {
          // Exact-path match so unrelated SessionStart hooks survive.
          matcher.hooks = matcher.hooks.filter((h: any) => h.command !== hookFile);
        }
      }
      config.hooks.SessionStart = config.hooks.SessionStart.filter((m: any) => m.hooks && m.hooks.length > 0);
    }, { createIfMissing: false });
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
    editHarnessJson(path.join(cursorDir, "hooks.json"), "stable-context", (config) => {
      if (config.version == null) config.version = 1;
      if (!config.hooks) config.hooks = {};
      if (!config.hooks.sessionStart) config.hooks.sessionStart = [];
      const present = (config.hooks.sessionStart as any[]).some((h: any) => h.command === hookFile);
      if (!present) config.hooks.sessionStart.push({ command: hookFile, timeout: 30 });
    });
  } catch {
    // Optional enhancement.
  }
}

export function removeStableHookCursor(): void {
  const home = process.env.HOME || "";
  const hookFile = path.join(codecastHooksDir(), "stable-feed-cursor.sh");
  try { removeHarnessFile(hookFile, "stable-context"); } catch {}

  try {
    editHarnessJson(path.join(home, ".cursor", "hooks.json"), "stable-context", (config) => {
      if (!config.hooks?.sessionStart) return;
      config.hooks.sessionStart = config.hooks.sessionStart.filter((h: any) => h.command !== hookFile);
      if (config.hooks.sessionStart.length === 0) delete config.hooks.sessionStart;
    }, { createIfMissing: false });
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
    writeHarnessFile(path.join(ocDir, "plugins", "codecast-stable.js"), opencodeStablePlugin(scriptPath), "stable-context");
  } catch {
    // Optional enhancement.
  }
}

export function removeStableHookOpencode(): void {
  try { removeHarnessFile(path.join(codecastHooksDir(), "stable-feed-opencode.sh"), "stable-context"); } catch {}
  try { removeHarnessFile(path.join(opencodeGlobalDir(), "plugins", "codecast-stable.js"), "stable-context"); } catch {}
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
  const hookFile = path.join(home, ".claude", "hooks", STABLE_FEED_HOOK_FILE);
  const settingsFile = path.join(home, ".claude", "settings.json");

  // The script contains no user data and is owned solely by Codecast. Removing
  // it as well as its settings entry makes `stable off` an actual uninstall.
  try { removeHarnessFile(hookFile, "stable-context"); } catch {}

  editHarnessJson(settingsFile, "stable-context", (settings) => {
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
  }, { createIfMissing: false });
}
