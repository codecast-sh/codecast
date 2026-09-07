/**
 * Manifest resolver: merges detection defaults with the user's
 * .codecast/workspace.toml override (if any).
 *
 * Merge semantics (lowest → highest precedence):
 *   1. Detection defaults
 *   2. .codecast/workspace.toml file
 *
 * Per-field rules:
 *   - setup.{copy,install,generate,migrate}: file replaces detection per field
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

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectProject } from "./detect.js";
import { DEFAULT_BROWSER, parseManifest } from "./manifest.js";
import type { BrowserSpec, WorkspaceManifest } from "./types.js";

/** Conventional location of the workspace manifest within a repo. */
export const MANIFEST_REL_PATH = ".codecast/workspace.toml";

/**
 * Resolve the merged workspace manifest for a repo.
 * Reads detection + .codecast/workspace.toml; returns the merged result,
 * with the project's untracked agent-config files (CLAUDE.local.md, an
 * untracked skill, .claude/settings.local.json, …) appended to setup.copy at
 * file granularity so a worktree — local or cloud — starts with them.
 */
export function resolveManifest(repoRoot: string, inputRoot = repoRoot): WorkspaceManifest {
  const detected = detectProject(repoRoot);
  if (inputRoot !== repoRoot) detected.setup.copy = detectProject(inputRoot).setup.copy;
  const file = parseManifest(path.join(inputRoot, MANIFEST_REL_PATH));
  return withAgentConfigCopies(mergeManifests(detected, file), inputRoot ?? repoRoot, { isInputRoot: inputRoot !== repoRoot });
}

/**
 * Project-level files agents read that are commonly untracked (personal
 * instructions, local settings, a skill in progress). `.mcp.json` is
 * deliberately absent: MCP definitions never travel.
 */
export const AGENT_CONFIG_COPY_CANDIDATES: readonly string[] = [
  "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md",
  ".claude/settings.json", ".claude/settings.local.json",
  ".claude/agents", ".claude/skills", ".claude/commands",
  ".codex/config.toml", ".agents/skills", ".grok",
];

/** A directory candidate bigger than this is skipped with a warning. */
export const AGENT_CONFIG_DIR_MAX_FILES = 200;
export const AGENT_CONFIG_DIR_MAX_BYTES = 8 * 1024 * 1024;

const COPY_NOISE = /(^|\/)(node_modules|\.git|__pycache__)(\/|$)|(^|\/)\.DS_Store$|\.log$/;

/** Every path component from root to rel, none of them a symlink; null when one is. */
function statNoSymlinks(root: string, rel: string): fs.Stats | null {
  let current = root;
  let stat: fs.Stats | null = null;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    stat = fs.lstatSync(current, { throwIfNoEntry: false }) ?? null;
    if (!stat || stat.isSymbolicLink()) return null;
  }
  return stat;
}

function walkFiles(root: string, rel: string, out: string[]): void {
  const stat = statNoSymlinks(root, rel);
  if (!stat) return;
  if (stat.isFile()) { out.push(rel); return; }
  if (!stat.isDirectory()) return;
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) walkFiles(root, `${rel}/${name}`, out);
}

/** `git ls-files -o` (untracked) plus `-o -i` (ignored) for the candidates; null when root is not a work tree. */
function gitUntracked(root: string, candidates: string[]): string[] | null {
  const run = (extra: string[]) => spawnSync("git", ["-C", root, "ls-files", "-o", ...extra, "--exclude-standard", "-z", "--", ...candidates], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
  });
  const plain = run([]);
  if (plain.error || plain.status !== 0) return null;
  const ignored = run(["-i"]);
  const out = new Set<string>();
  for (const r of [plain, ignored]) {
    if (r.error || r.status !== 0) continue;
    for (const p of r.stdout.split("\0")) if (p) out.add(p);
  }
  return [...out].sort();
}

/**
 * Append the project's untracked agent-config files to setup.copy, one file
 * per entry (copy.ts skips an existing destination wholesale, so a directory
 * entry would lose an untracked skill beside a tracked one).
 *
 * For a repo root the list is `git ls-files -o` (+ `-i` for gitignored ones
 * like CLAUDE.local.md), scoped to the candidates; a root that is not a work
 * tree, and an input root (the host's staged inputs dir), list every present
 * candidate file. A file with a symlinked path component is skipped with a
 * warning; a directory candidate over 200 files or 8 MiB too.
 */
export function withAgentConfigCopies(
  manifest: WorkspaceManifest,
  root: string,
  opts: { isInputRoot: boolean; warn?: (m: string) => void },
): WorkspaceManifest {
  const warn = opts.warn ?? (() => {});
  const present = AGENT_CONFIG_COPY_CANDIDATES.filter((c) => fs.lstatSync(path.join(root, c), { throwIfNoEntry: false }));
  if (!present.length) return manifest;
  const listed = opts.isInputRoot ? null : gitUntracked(root, present);
  let files: string[];
  if (listed) files = listed;
  else {
    files = [];
    for (const c of present) walkFiles(root, c, files);
    files.sort();
  }
  const perDir = new Map<string, { count: number; bytes: number }>();
  const accepted: string[] = [];
  for (const rel of files) {
    if (rel === ".mcp.json" || rel.endsWith("/.mcp.json") || COPY_NOISE.test(rel)) continue;
    const stat = statNoSymlinks(root, rel);
    if (!stat) { warn(`agent config ${rel} skipped: a symlink in its path`); continue; }
    if (!stat.isFile()) continue;
    const dirCandidate = present.find((c) => rel.startsWith(`${c}/`));
    if (dirCandidate) {
      const acc = perDir.get(dirCandidate) ?? { count: 0, bytes: 0 };
      acc.count++;
      acc.bytes += stat.size;
      perDir.set(dirCandidate, acc);
    }
    accepted.push(rel);
  }
  const tooBig = new Set([...perDir.entries()].filter(([, a]) => a.count > AGENT_CONFIG_DIR_MAX_FILES || a.bytes > AGENT_CONFIG_DIR_MAX_BYTES).map(([d]) => d));
  for (const d of tooBig) warn(`agent config directory ${d} skipped: over ${AGENT_CONFIG_DIR_MAX_FILES} files or ${AGENT_CONFIG_DIR_MAX_BYTES / 1048576} MiB`);
  const existing = manifest.setup.copy;
  const covered = (rel: string) => existing.some((e) => e === rel || rel.startsWith(`${e.replace(/\/+$/, "")}/`));
  const additions = accepted.filter((rel) => !tooBig.has(present.find((c) => rel.startsWith(`${c}/`)) ?? "") && !covered(rel));
  if (!additions.length) return manifest;
  return { ...manifest, setup: { ...manifest.setup, copy: [...existing, ...additions] } };
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

  return {
    setup: {
      copy: replaceArrayIfNonEmpty(override.setup.copy, base.setup.copy),
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
