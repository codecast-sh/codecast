/**
 * Manifest resolver: merges detection defaults with the user's
 * .codecast/workspace.toml override (if any).
 *
 * Merge semantics (lowest → highest precedence):
 *   1. Detection defaults
 *   2. .codecast/workspace.toml file
 *
 * Per-field rules:
 *   - setup.{copy,share,install,generate,migrate}: file replaces detection per field
 *     if present, else detection is kept. (Replace, not append — explicit lists
 *     mean "this is the full set"; otherwise users couldn't remove a
 *     misdetected step.)
 *   - ports / services / env: per-key merge. File's keys override detection's
 *     keys with the same name; detection's other keys are preserved.
 *   - teardown.run: file replaces detection if present.
 *   - detected: detection's value is preserved unless the file explicitly
 *     overrides it (rare; mostly a diagnostic label).
 *
 * Env-var overrides (e.g., CODECAST_WORKSPACE_*) are intentionally out of
 * scope for v1 — see plan.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_CONTEXT_ROOTS, collectProjectContext } from "../cloud/mirror/discovery.js";
import { readLocalConfig } from "../config/readLocalConfig.js";
import { spawnSync } from "../proc.js";
import { detectProject } from "./detect.js";
import { DEFAULT_BROWSER, MANIFEST_REL_PATH, parseManifest } from "./manifest.js";
import type { BrowserSpec, WorkspaceManifest } from "./types.js";

export { MANIFEST_REL_PATH };

/**
 * Resolve the merged workspace manifest for a repo.
 * Reads detection + .codecast/workspace.toml; returns the merged result,
 * with the project's untracked agent-config files (CLAUDE.local.md, an
 * untracked skill, .claude/settings.local.json, …) appended to setup.copy at
 * file granularity so a worktree — local or cloud — starts with them.
 */
export function resolveManifest(repoRoot: string, inputRoot = repoRoot): WorkspaceManifest {
  const detected = detectProject(repoRoot);
  if (inputRoot !== repoRoot) {
    // The input root is the checkout files are taken from, so its copy and
    // share lists are the ones that describe real paths on this machine.
    const fromInput = detectProject(inputRoot);
    detected.setup.copy = fromInput.setup.copy;
    detected.setup.share = fromInput.setup.share;
  }
  const file = parseManifest(path.join(inputRoot, MANIFEST_REL_PATH));
  return withAgentConfigCopies(mergeManifests(detected, file), inputRoot ?? repoRoot, { isInputRoot: inputRoot !== repoRoot });
}

export const AGENT_CONFIG_COPY_CANDIDATES: readonly string[] = [
  ...AGENT_CONTEXT_ROOTS, "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", "GEMINI.md", ".mcp.json",
];

export function withAgentConfigCopies(
  manifest: WorkspaceManifest,
  root: string,
  opts: { isInputRoot: boolean; warn?: (m: string) => void },
): WorkspaceManifest {
  // Agent context and what it requires only: any other untracked doc or
  // script in the source checkout is someone's work in progress, and a copy of
  // it in the worktree blocks the checkout of the commit that later tracks it
  // (a rebase onto main refused).
  const context = collectProjectContext({ root, includeTracked: opts.isInputRoot, agentContextOnly: true, includeAncestors: false, tolerateMissing: true, config: readLocalConfig() });
  for (const skipped of context.skipped) opts.warn?.(`agent config ${skipped.path} skipped: ${skipped.reason}`);
  const existing = manifest.setup.copy;
  const configs = context.files.filter((f) => f.scope === "project");
  const additions = [...configs.map((f) => f.relativePath), ...hookScripts(root, configs)]
    .filter((rel, i, all) => all.indexOf(rel) === i)
    .filter((rel) => !existing.some((entry) => entry === rel || rel.startsWith(`${entry.replace(/\/+$/, "")}/`)));
  return additions.length ? { ...manifest, setup: { ...manifest.setup, copy: [...existing, ...additions] } } : manifest;
}

/**
 * The untracked project files Claude settings run as commands (a Stop hook's
 * `bash scripts/hook.sh`, `$CLAUDE_PROJECT_DIR/.../x.sh`, a statusline). The
 * settings travel to the worktree, so a script they run must travel too or
 * the hook breaks there; a tracked one is already in the worktree.
 */
function hookScripts(root: string, configs: ReadonlyArray<{ relativePath: string; bytes: Buffer }>): string[] {
  const commands: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "command" && typeof item === "string") commands.push(item);
        else collect(item);
      }
    }
  };
  for (const file of configs) {
    if (!/^\.claude\/settings(?:\.local)?\.json$/.test(file.relativePath)) continue;
    try { collect(JSON.parse(file.bytes.toString("utf8"))); } catch { /* not ours to judge */ }
  }
  const found = new Set<string>();
  for (const command of commands) {
    for (const raw of command.split(/[\s;&|()]+/)) {
      const token = raw.replace(/["']/g, "").replace(/^(?:\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})\//, "");
      if (!token || token.startsWith("-") || token.startsWith("~") || token.includes("$") || !token.includes("/")) continue;
      const abs = path.resolve(root, token);
      const rel = path.relative(root, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      if (spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", rel], { stdio: "ignore" }).status === 0) continue;
      found.add(rel);
    }
  }
  return [...found];
}

/** Pure merge of two manifests (used by resolveManifest and by tests). */
export function mergeManifests(
  base: WorkspaceManifest,
  override: WorkspaceManifest | null,
): WorkspaceManifest {
  if (!override) return base;

  // Per-field: if the override declared the field non-empty, it replaces.
  // We treat "field present and non-empty in override" as "user intends this".
  // Empty arrays in override are interpreted as "user has no commands here",
  // which still wins (i.e., they wanted to silence detection).
  //
  // To distinguish "absent" from "explicitly empty", parser uses arity:
  //   - absent in TOML → default to [] in parseManifest
  //   - present but [] in TOML → also [] in parseManifest
  //
  // For v1 we accept this ambiguity: an empty array in the manifest means
  // "use detection's value" (i.e., treat empty as "not set"). Users who want
  // to explicitly silence a step should set it via a no-op like ["true"].
  // This is documented in resolver.test.ts.
  const replaceArrayIfNonEmpty = <T>(o: T[], b: T[]): T[] =>
    o.length > 0 ? o : b;

  const host = override.host ?? base.host;
  const ship = override.ship ?? base.ship;
  return {
    ...(host ? { host } : {}),
    ...(ship ? { ship } : {}),
    // Detection never maps secrets, so the file's [vault] is the whole map.
    ...(override.vault ? { vault: override.vault } : {}),
    setup: {
      copy: replaceArrayIfNonEmpty(override.setup.copy, base.setup.copy),
      share: replaceArrayIfNonEmpty(override.setup.share, base.setup.share),
      install: replaceArrayIfNonEmpty(override.setup.install, base.setup.install),
      generate: replaceArrayIfNonEmpty(override.setup.generate, base.setup.generate),
      migrate: replaceArrayIfNonEmpty(override.setup.migrate, base.setup.migrate),
    },
    ports: { ...base.ports, ...override.ports },
    services: { ...base.services, ...override.services },
    env: { ...base.env, ...override.env },
    teardown: {
      run: replaceArrayIfNonEmpty(override.teardown.run, base.teardown.run),
    },
    ...(override.verify?.command ? { verify: override.verify } : base.verify ? { verify: base.verify } : {}),
    browser: mergeBrowser(base.browser, override.browser),
    backend: override.backend !== "local" ? override.backend : base.backend,
    detected: override.detected ?? base.detected,
  };
}

/**
 * Browser merge rule: file beats detection field-by-field, but only for fields
 * the file actually changed from the default. Otherwise detection wins.
 */
function mergeBrowser(base: BrowserSpec, override: BrowserSpec): BrowserSpec {
  // If override matches the default (means user didn't write [browser]), keep base.
  if (
    override.enabled === DEFAULT_BROWSER.enabled &&
    override.headless === DEFAULT_BROWSER.headless &&
    override.cdpPort.base === DEFAULT_BROWSER.cdpPort.base &&
    override.cdpPort.range === DEFAULT_BROWSER.cdpPort.range
  ) {
    return base;
  }
  // Otherwise the file wins outright — its values are an explicit user choice.
  return override;
}
