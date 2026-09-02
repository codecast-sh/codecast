// The installer: the section engine applied through an injected filesystem,
// to one file, to every target on a machine, and across a whole definition
// table at once.

import * as path from "path";
import { applySnippet, cutOwnedSections } from "./sections";
import type {
  SectionSpec,
  SnippetDefinition,
  SnippetFs,
  SnippetInstallResult,
  SnippetTarget,
} from "./types";

const dirOf = (target: SnippetTarget): string => target.dirPath ?? path.dirname(target.filePath);

/**
 * Write `spec`'s section into one file, creating its directory if needed.
 *
 * A file whose content already matches is left alone, not rewritten with the
 * same bytes. Reconcilers reinstall every enabled section at once on update
 * and on boot, so a machine that changed nothing would still rewrite many
 * sections across several files. Each write moves the mtime, which wakes every
 * watcher on it: editors, the agents reading CLAUDE.md, anything tailing the
 * file. `installed` still reports the section's state, so callers that print
 * "installed" or "updated" read the same as before.
 */
export function installSectionToFile(
  fsi: SnippetFs,
  target: SnippetTarget,
  spec: SectionSpec,
  snippet: string,
  update: boolean,
): SnippetInstallResult {
  const dirPath = dirOf(target);
  if (!fsi.exists(dirPath)) fsi.mkdir(dirPath);
  const existing = fsi.readFile(target.filePath);
  const result = applySnippet(existing ?? "", spec, snippet, update);
  // An absent file still gets created even when the text works out identical,
  // so "the section is installed" stays true on disk and not only in the value.
  const write = result.installed && (!result.unchanged || existing === null);
  if (write) fsi.writeFile(target.filePath, result.text);
  return { installed: result.installed, updated: result.updated, unchanged: !write };
}

/** Write `spec`'s section into every target. Unchanged only when NO target
 *  needed a write: one stale file out of three is still a change to this
 *  machine. */
export function installSectionToTargets(
  fsi: SnippetFs,
  targets: SnippetTarget[],
  spec: SectionSpec,
  snippet: string,
  update: boolean,
): SnippetInstallResult {
  let anyInstalled = false;
  let anyUpdated = false;
  let anyWritten = false;
  for (const target of targets) {
    const r = installSectionToFile(fsi, target, spec, snippet, update);
    if (r.installed) anyInstalled = true;
    if (r.updated) anyUpdated = true;
    if (!r.unchanged) anyWritten = true;
  }
  return { installed: anyInstalled, updated: anyUpdated, unchanged: !anyWritten };
}

/**
 * Take `spec`'s section back off every target. Removal is the other half of
 * disabling: flipping a config flag while leaving the text in CLAUDE.md means
 * the agent keeps reading a capability the user believes they switched off.
 * A file that does not exist is skipped; a file without the section is left
 * untouched. Returns whether anything was removed anywhere.
 */
export function removeSectionFromTargets(
  fsi: SnippetFs,
  targets: SnippetTarget[],
  spec: SectionSpec,
): boolean {
  let removedAnywhere = false;
  for (const target of targets) {
    const existing = fsi.readFile(target.filePath);
    if (existing === null) continue;
    const next = cutOwnedSections(existing, spec);
    if (next === existing) continue;
    fsi.writeFile(target.filePath, next.replace(/\n+$/, "") + "\n");
    removedAnywhere = true;
  }
  return removedAnywhere;
}

export interface InstallOptions {
  /** The instruction files to write into (see resolveTargets). */
  targets: SnippetTarget[];
  /** Whether a definition should be present. Enabled definitions are installed
   *  or refreshed; disabled ones are removed. */
  enabled: (def: SnippetDefinition) => boolean;
  /** The filesystem to write through: nodeFs, or memoryFs() in tests. */
  fs: SnippetFs;
  /** Refresh sections that are already present (the reconcile posture).
   *  Default true. Pass false for a first install that must not touch what is
   *  already there. */
  update?: boolean;
}

export interface InstallReport {
  /** Per slug, what happened. Definitions without a markdown section are
   *  skipped and do not appear. */
  results: Record<string, SnippetInstallResult & { removed?: boolean }>;
  /** True when no file changed anywhere. */
  unchanged: boolean;
}

/**
 * Reconcile a whole definition table against a machine: install or refresh
 * every enabled definition, remove every disabled one. One call is the whole
 * pass a CLI runs on install, on update and on boot.
 */
export function install(defs: SnippetDefinition[], opts: InstallOptions): InstallReport {
  const update = opts.update ?? true;
  const results: InstallReport["results"] = {};
  let anyChange = false;
  for (const def of defs) {
    if (!def.section) continue;
    if (opts.enabled(def)) {
      const r = installSectionToTargets(opts.fs, opts.targets, def.section.spec, def.section.body, update);
      results[def.slug] = r;
      if (!r.unchanged) anyChange = true;
    } else {
      const removed = removeSectionFromTargets(opts.fs, opts.targets, def.section.spec);
      results[def.slug] = { installed: false, updated: false, unchanged: !removed, removed };
      if (removed) anyChange = true;
    }
  }
  return { results, unchanged: !anyChange };
}
