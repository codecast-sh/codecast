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

import * as path from "node:path";
import { detectProject } from "./detect.js";
import { DEFAULT_BROWSER, parseManifest } from "./manifest.js";
import type { BrowserSpec, WorkspaceManifest } from "./types.js";

/** Conventional location of the workspace manifest within a repo. */
export const MANIFEST_REL_PATH = ".codecast/workspace.toml";

/**
 * Resolve the merged workspace manifest for a repo.
 * Reads detection + .codecast/workspace.toml; returns the merged result.
 */
export function resolveManifest(repoRoot: string): WorkspaceManifest {
  const detected = detectProject(repoRoot);
  const file = parseManifest(path.join(repoRoot, MANIFEST_REL_PATH));
  return mergeManifests(detected, file);
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
