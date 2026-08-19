import * as fs from "fs";
import * as path from "path";
import { findModelOption } from "@codecast/shared/contracts";

// Keeps the `model` key of ~/.claude/settings.json in step with the user's
// codecast default for claude (users.default_models.claude, delivered on every
// heartbeat). Claude Code's `/model <x>` one-shot — how a codecast session
// switches model mid-flight — also saves <x> as the global default in that
// file. Instead of guarding each switch, the daemon simply re-asserts the
// codecast default on the next beat: the switch stays with its session, and
// bare `claude` terminals keep launching on the model the user pinned in
// codecast. No codecast default = the file is the user's own business.

/** Pure planner: the new file text, or null when nothing needs writing. */
export function planClaudeSettingsModel(text: string | null, desiredAlias: string | undefined): string | null {
  if (!desiredAlias || text === null) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // an unreadable file is nothing trustworthy to rewrite
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.model === desiredAlias) return null;
  parsed.model = desiredAlias;
  return JSON.stringify(parsed, null, 2);
}

/** The settings.json alias for a codecast default key ("opus" → "opus"; unset,
 *  "default" or an unknown key → undefined = leave the file alone). */
export function claudeDefaultAlias(defaultModels: Record<string, string> | undefined): string | undefined {
  const key = defaultModels?.claude;
  return key ? findModelOption("claude_code", key)?.cliAlias : undefined;
}

/** Reconcile the file on disk. Returns true when it wrote. */
export function reconcileClaudeSettingsModel(
  defaultModels: Record<string, string> | undefined,
  home: string = process.env.HOME || "",
): boolean {
  const alias = claudeDefaultAlias(defaultModels);
  if (!alias) return false;
  const file = path.join(home, ".claude", "settings.json");
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return false; // no settings file = claude never configured here; the launch flag covers codecast sessions
  }
  const next = planClaudeSettingsModel(text, alias);
  if (next === null) return false;
  fs.writeFileSync(file, next);
  return true;
}
