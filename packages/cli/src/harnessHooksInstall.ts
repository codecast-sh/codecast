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
import { HARNESS_HOOKS } from "@codecast/shared/contracts";
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

/** Hooks are on unless the user turned them off. */
export function hooksEnabled(config: { hooks_enabled?: boolean } | null | undefined): boolean {
  return config?.hooks_enabled !== false;
}

/** Bring this machine's hooks in line with the switch: install when on,
 *  remove when off. Never throws: hooks are never a reason to fail setup. */
export function syncHarnessHooks(config: { hooks_enabled?: boolean } | null | undefined): void {
  try {
    if (hooksEnabled(config)) installHarnessHooks();
    else removeHarnessHooks();
  } catch {
    // Every write that did land is in the change history.
  }
}

export function installHarnessHooks(): void {
  const dir = hooksDir();
  const settings = settingsPath();
  for (const hook of HARNESS_HOOKS) {
    const file = path.join(dir, hook.file);
    writeHarnessFile(file, SCRIPTS[hook.file], "hooks", { mode: 0o755, executable: true });
    if (hook.kind === "statusLine") {
      installOwnedStatusLine(file, { settingsPath: settings });
    } else if (hook.events.length > 0) {
      installOwnedHook(hook.events, file, { timeout: HOOK_TIMEOUT_S, settingsPath: settings });
    }
  }
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
    const file = path.join(dir, hook.file);
    if (hook.kind === "statusLine") removeOwnedStatusLine({ settingsPath: settings });
    else removeOwnedHook(file, { settingsPath: settings });
    removeHarnessFile(file, "hooks");
  }
  const retired = path.join(dir, RETIRED_SHELL_CHANGES);
  removeOwnedHook(retired, { settingsPath: settings });
  removeHarnessFile(retired, "hooks");
}
