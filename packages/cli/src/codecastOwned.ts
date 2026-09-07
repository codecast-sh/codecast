/**
 * What codecast itself installs into a user's home, in one importable table.
 *
 * Three writers used to carry these names as private literals: the hook
 * installer in index.ts (`installHookScript("codecast-status.sh", …)`), the
 * orchestration installer (skill dir, three agent files, the
 * `/.codecast/orchestration/` marker its settings.json hooks are found by) and
 * stableContext.ts (`stable-feed.sh`). The cloud home mirror (cloud/mirror)
 * needs the same list to know what NOT to ship: a codecast-owned skill or
 * hook shipped as user content would be pruned the moment the laptop turned
 * the feature off, and re-created by the host a minute later. index.ts cannot
 * be imported for this (it calls program.parse on load), so the names live
 * here and index.ts / stableContext.ts import them.
 */

import * as path from "node:path";

/** The hook scripts codecast writes into ~/.claude/hooks/. */
export const CODECAST_HOOK_SCRIPTS = [
  "codecast-status.sh",
  "session-register.sh",
  "thread-state.sh",
  "task-pulse.sh",
  "stable-feed.sh",
] as const;

/** The stable-context SessionStart hook file (installed by stableContext.ts). */
export const STABLE_FEED_HOOK_FILE = "stable-feed.sh" satisfies (typeof CODECAST_HOOK_SCRIPTS)[number];

/** Orchestration hook commands live under this path; it is how their
 *  settings.json entries are recognised and replaced. */
export const ORCH_MARKER = "/.codecast/orchestration/";

/** Home-relative path of the orchestration skill directory. */
export const ORCH_SKILL_REL = ".claude/skills/codecast-orchestrate";

/** The agent definitions the orchestration snippet installs under ~/.claude/agents/. */
export const ORCH_AGENT_FILES = ["implementer.md", "reviewer.md", "critic.md"] as const;

/**
 * Every home-relative path codecast owns. A path equal to one of these, or
 * under one of the directories, is never mirrored and never pruned.
 */
export const CODECAST_OWNED_HOME_PATHS: readonly string[] = [
  ORCH_SKILL_REL,
  ...ORCH_AGENT_FILES.map((f) => `.claude/agents/${f}`),
  ...CODECAST_HOOK_SCRIPTS.map((f) => `.claude/hooks/${f}`),
  ".codecast",
];

/**
 * Is this hook command one codecast installed? True for the five hook
 * scripts (by basename, any home), for anything under a `.codecast/hooks/`
 * directory (the codex/cursor/opencode stable-feed wrappers) and for the
 * orchestration scripts (`/.codecast/orchestration/`). A user's own hook that
 * happens to sit in the same ~/.claude/hooks directory is not.
 */
export function isCodecastHookCommand(command: string | undefined | null, home?: string): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  if (command.includes(ORCH_MARKER)) return true;
  if (command.includes("/.codecast/hooks/")) return true;
  if (home && command.includes(path.posix.join(home, ".codecast", "hooks") + "/")) return true;
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = path.posix.basename(first);
  return (CODECAST_HOOK_SCRIPTS as readonly string[]).includes(base);
}

/** Is this home-relative path (posix) one codecast owns, or inside one? */
export function isCodecastOwnedHomePath(rel: string): boolean {
  const clean = rel.replace(/^\.\//, "").replace(/\/+$/, "");
  return CODECAST_OWNED_HOME_PATHS.some((owned) => clean === owned || clean.startsWith(`${owned}/`));
}
