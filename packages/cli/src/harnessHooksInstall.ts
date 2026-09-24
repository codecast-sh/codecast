// Install and remove the codecast hooks listed in HARNESS_HOOKS
// (@codecast/shared/contracts). This is the only place that registers them, so
// the one switch that governs them (`hooks_enabled`) is checked in one place:
// setup, `cast update`, the automatic update, and the daemon's refresh after
// a self update all come through `syncHarnessHooks`.
//
// Loaded lazily by index.ts (bench/bootGraph.guard.test.ts): the hook scripts
// and the ownership ledger are needed only by an install, an update or an
// uninstall, never by an ordinary command.

import * as path from "path";
import { HARNESS_HOOKS, harnessHookWanted, snippetBySlug, type HarnessHook } from "@codecast/shared/contracts";
import { installOwnedHook, removeOwnedHook, installOwnedStatusLine, removeOwnedStatusLine } from "./capabilities/hooks.js";
import { removeHarnessFile, writeHarnessFile } from "./harness.js";
import { CODECAST_STATUS_HOOK } from "./statusHook.js";
import { SESSION_REGISTER_HOOK } from "./sessionRegisterHook.js";
import { THREAD_STATE_HOOK } from "./threadStateHook.js";
import { TASK_PULSE_HOOK } from "./taskPulseHook.js";
import { USER_PROMPT_HOOK, USER_PROMPT_HOOK_FILE } from "./userPromptHook.js";
import { CODECAST_STATUSLINE_HOOK, STATUSLINE_HOOK_FILE } from "./statuslineHook.js";

const SCRIPTS: Record<string, string> = {
  "codecast-status.sh": CODECAST_STATUS_HOOK,
  "session-register.sh": SESSION_REGISTER_HOOK,
  "thread-state.sh": THREAD_STATE_HOOK,
  "task-pulse.sh": TASK_PULSE_HOOK,
  [USER_PROMPT_HOOK_FILE]: USER_PROMPT_HOOK,
  [STATUSLINE_HOOK_FILE]: CODECAST_STATUSLINE_HOOK,
};

// Retired: its Bash edit capture moved into the daemon. The entries come out
// of settings.json; the script stays as a no-op so an entry some other copy of
// settings.json still holds finds a file instead of failing the tool call.
const RETIRED_SHELL_CHANGES = "codecast-shell-changes.sh";
const RETIRED_SHELL_CHANGES_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

// 10s, not 5: these scripts normally finish well under a second, but a loaded
// machine (dozens of live sessions spawning processes) can stretch interpreter
// startup past 5s. A timed out UserPromptSubmit or Stop hook loses the status
// transition behind it, and the session then reads as idle for minutes.
const HOOK_TIMEOUT_S = 10;

function hooksDir(): string {
  return path.join(process.env.HOME || "", ".claude", "hooks");
}

function settingsPath(): string {
  return path.join(process.env.HOME || "", ".claude", "settings.json");
}

// Any config.json shape: the switch and the feature flags are read by key.
type HookConfig = object | null | undefined;

/** Hooks are on unless the user turned them off. */
export function hooksEnabled(config: HookConfig): boolean {
  return (config as Record<string, unknown> | null | undefined)?.hooks_enabled !== false;
}

/** Is an Agent Features entry on in this config? */
function featureOn(config: HookConfig, feature: string): boolean {
  const c = config as Record<string, unknown> | null | undefined;
  if (feature === "stable") return !!c?.stable_mode && c.stable_mode !== "off";
  const desc = snippetBySlug(feature);
  return !!desc && c?.[desc.enabledKey] === true;
}

function wanted(hook: HarnessHook, config: HookConfig): boolean {
  return harnessHookWanted(hook, hooksEnabled(config), (f) => featureOn(config, f));
}

/** Bring this machine's hooks in line with its config: the hooks switch, and
 *  for a hook that belongs to an Agent Features entry, that entry too. Run
 *  after any change to either, so a feature and its hook move together. Never
 *  throws: hooks are never a reason to fail setup. */
export function syncHarnessHooks(config: HookConfig): void {
  try {
    if (hooksEnabled(config)) installHarnessHooks(config);
    else removeHarnessHooks();
  } catch {
    // Every write that did land is in the change history.
  }
}

/**
 * After an Agent Features toggle: bring only the hooks that belong to a
 * feature in line. The functional hooks are left exactly as they are, so
 * installing one feature never installs anything else.
 */
export function syncFeatureHooks(config: HookConfig): void {
  try {
    installHarnessHooks(config, { featuresOnly: true });
  } catch {
    // Every write that did land is in the change history.
  }
}

export function installHarnessHooks(config: HookConfig = {}, opts: { featuresOnly?: boolean } = {}): void {
  const dir = hooksDir();
  const settings = settingsPath();
  for (const hook of HARNESS_HOOKS) {
    if (hook.installedElsewhere) continue;
    if (opts.featuresOnly && !hook.feature) continue;
    const file = path.join(dir, hook.file);
    if (!wanted(hook, config)) {
      removeHook(hook, dir, settings);
      continue;
    }
    writeHarnessFile(file, SCRIPTS[hook.file], "hooks", { mode: 0o755, executable: true });
    if (hook.kind === "statusLine") {
      installOwnedStatusLine(file, { settingsPath: settings });
    } else if (hook.events.length > 0) {
      installOwnedHook(hook.events, file, { timeout: HOOK_TIMEOUT_S, settingsPath: settings });
    }
  }
  if (opts.featuresOnly) return;
  // The prompt hook runs the other jobs itself; an older install registered
  // each of them on UserPromptSubmit too, which ran every job twice.
  for (const hook of HARNESS_HOOKS) {
    if (hook.file === USER_PROMPT_HOOK_FILE || hook.kind !== "hook") continue;
    removeOwnedHook(path.join(dir, hook.file), { settingsPath: settings, events: ["UserPromptSubmit"] });
  }
  const retired = path.join(dir, RETIRED_SHELL_CHANGES);
  writeHarnessFile(retired, "#!/bin/sh\nexit 0\n", "hooks", { mode: 0o755, executable: true });
  removeOwnedHook(retired, { settingsPath: settings, events: RETIRED_SHELL_CHANGES_EVENTS });
}

/** Take every codecast hook out of settings.json and delete the scripts.
 *  Hooks the user wrote are untouched. */
export function removeHarnessHooks(): void {
  const dir = hooksDir();
  const settings = settingsPath();
  for (const hook of HARNESS_HOOKS) {
    if (!hook.installedElsewhere) removeHook(hook, dir, settings);
  }
  const retired = path.join(dir, RETIRED_SHELL_CHANGES);
  removeOwnedHook(retired, { settingsPath: settings });
  removeHarnessFile(retired, "hooks");
}

function removeHook(hook: HarnessHook, dir: string, settings: string): void {
  const file = path.join(dir, hook.file);
  if (hook.kind === "statusLine") removeOwnedStatusLine({ settingsPath: settings });
  else removeOwnedHook(file, { settingsPath: settings });
  removeHarnessFile(file, "hooks");
}
