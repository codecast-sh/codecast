// The snippet INSTALLER: codecast's wiring around @platform/snippets.
//
// The engine — section recognition, the in-place hash-stamped rewrite, the fan
// out across instruction files, the atomic write — lives in @platform/snippets
// and is imported here. What stays codecast's: the catalog
// (@codecast/shared/contracts/snippets.ts, one table with the bodies, slugs and
// config keys, re-exported below for the CLI, the daemon and the tests), the
// candidate list getSnippetTargets reads off the agent client registry, the
// slug wrappers that throw on a typo, and ensureMessagingForMemory, which is
// product policy.
//
// The engine's content hash is byte identical to the one the catalog ships
// (both are FNV-1a over `{"scripts":[<body>]}`), so importing it changes no
// stored hash on any machine and triggers no rewrite pass across the fleet.
//
// This module lives apart from index.ts so the daemon can import it: index.ts
// runs `program.parse()` on import, so daemon.ts cannot import from it. The
// messaging snippet in particular has to be installable from the daemon's own
// startup, so memory-enabled daemons distribute it onto their machine's
// CLAUDE.md autonomously after a self-update — without a `cast` command running.

import * as os from "os";
import {
  type SectionSpec,
  BROWSER_SECTION,
  BROWSER_SNIPPET,
  CHAT_SECTION,
  CHAT_SNIPPET,
  MESSAGING_SECTION,
  MESSAGING_SNIPPET,
  PUBLISH_SECTION,
  PUBLISH_SNIPPET,
  REFERENCES_SECTION,
  REFERENCES_SNIPPET,
  snippetBySlug,
  snippetContentHash,
  AGENT_CLIENTS,
} from "@codecast/shared/contracts";
import {
  applySnippet,
  cutOwnedSections,
  findOwnedSections,
  installSectionToFile as installSectionToFileWith,
  installSectionToTargets as installSectionToTargetsWith,
  nodeFs,
  resolveTargets,
  snippetStale as snippetStaleFor,
  stampSnippet as stampSnippetFor,
  type ResolvedTarget,
  type SnippetInstallResult,
  type TargetCandidate,
} from "@platform/snippets";
import { getMessagingVersion } from "./update.js";

export {
  BROWSER_SECTION,
  BROWSER_SNIPPET,
  BROWSER_SNIPPET_END,
  CHAT_SECTION,
  CHAT_SNIPPET,
  CHAT_SNIPPET_END,
  MESSAGING_SECTION,
  MESSAGING_SNIPPET,
  MESSAGING_SNIPPET_END,
  PUBLISH_SECTION,
  PUBLISH_SNIPPET,
  PUBLISH_SNIPPET_END,
  REFERENCES_SECTION,
  REFERENCES_SNIPPET,
  REFERENCES_SNIPPET_END,
} from "@codecast/shared/contracts";
export type { SectionSpec };

// The pure string engine, unchanged: `findOwnedSections` reports every block a
// spec owns (a block is ours only when its end marker sits after its heading
// and before the next `## ` heading), `cutOwnedSections` removes them, and
// `applySnippet` refreshes the first one in place so an update never reorders
// the user's file.
export { applySnippet, cutOwnedSections, findOwnedSections };
export type { SnippetInstallResult };

/** One instruction file on this machine. */
export type SnippetTarget = ResolvedTarget;

export function getSnippetTargets(): SnippetTarget[] {
  // process.env.HOME first, matching the daemon: Bun's os.homedir() answers
  // from getpwuid and ignores $HOME, which breaks every fake-HOME test and any
  // user who genuinely redirects HOME.
  const home = process.env.HOME || os.homedir();
  const candidates: TargetCandidate[] = [];

  for (const descriptor of Object.values(AGENT_CLIENTS)) {
    // DECLARED is the gate, not "a dot directory exists": gemini and pi have
    // dot directories on plenty of machines and no verified instruction file,
    // and a directory-driven loop would start writing ~/.gemini files nothing
    // reads. Cursor drops out here too — its registry entry declares only a
    // project-level rules dir, because the user-level ~/.cursor/rules/*.mdc
    // this function used to emit was never loaded by Cursor (ecosystem
    // research); `cast uninstall` keeps its own legacy list to clean those up.
    const declared = descriptor.agentFileTargets?.instructionFile?.user;
    if (!declared) continue;

    // Presence gate: claude is the host CLI's own client and always gets its
    // file; resolveTargets includes any other client only when its config
    // directory already exists, which is the long-standing signal for
    // "installed here". Without it, every machine would grow an
    // ~/.codex/AGENTS.md it never asked for. Enumerating creates nothing on
    // disk — directory creation belongs to the writer.
    candidates.push({ path: declared, always: descriptor.id === "claude" });
  }

  return resolveTargets(candidates, { home, fs: nodeFs });
}

/**
 * Write `spec`'s section into one file, creating its directory if needed.
 *
 * A file whose content already matches is left alone — not rewritten with the
 * same bytes. `refreshEnabledSnippets` (index.ts) reinstalls every enabled
 * section at once, and it runs on `cast update`, on `cast restart`, and on
 * daemon boot after a self-update — so a machine that changed nothing would
 * still rewrite up to ten sections across up to three files. Each write moves
 * the mtime, which wakes every watcher on it: editors, the agents reading
 * CLAUDE.md, anything tailing the file. `installed` still reports the section's
 * state, so callers that print "installed"/"updated" read the same as before.
 *
 * The write itself is atomic and carries no mode, so a CLAUDE.md the user made
 * group-readable keeps its mode across every refresh: we own a section, not the
 * file.
 */
export function installSectionToFile(
  filePath: string,
  dirPath: string,
  spec: SectionSpec,
  snippet: string,
  update: boolean,
): SnippetInstallResult {
  return installSectionToFileWith(nodeFs, { filePath, dirPath }, spec, snippet, update);
}

/** Write `spec`'s section into every agent instruction file on this machine.
 *  Unchanged only when NO target needed a write: one stale file out of three is
 *  still a change to this machine. */
export function installSectionToTargets(
  spec: SectionSpec,
  snippet: string,
  update: boolean,
): SnippetInstallResult {
  return installSectionToTargetsWith(nodeFs, getSnippetTargets(), spec, snippet, update);
}

export function installBrowserSnippet(update = false): SnippetInstallResult {
  return installSectionToTargets(BROWSER_SECTION, BROWSER_SNIPPET, update);
}

export function installReferencesSnippet(update = false): SnippetInstallResult {
  return installSectionToTargets(REFERENCES_SECTION, REFERENCES_SNIPPET, update);
}

export function installPublishSnippet(update = false): SnippetInstallResult {
  return installSectionToTargets(PUBLISH_SECTION, PUBLISH_SNIPPET, update);
}

export function installChatSnippet(update = false): SnippetInstallResult {
  return installSectionToTargets(CHAT_SECTION, CHAT_SNIPPET, update);
}

export function installMessagingSnippet(update = false): SnippetInstallResult {
  return installSectionToTargets(MESSAGING_SECTION, MESSAGING_SNIPPET, update);
}

// -------------------------------------------------------------- the rewrite key

/** Resolve a slug that a refresh gate or stamp site passed as a literal. A
 *  miss is a typo in that caller, not a runtime condition — swallowing it
 *  would make the snippet silently never refresh (or never stamp, so it
 *  refreshes on every run) — so fail loudly and say where to look. */
function requireSnippet(slug: string, caller: string) {
  const desc = snippetBySlug(slug);
  if (!desc) {
    throw new Error(
      `${caller}: unknown snippet slug "${slug}" — fix the slug at the call site ` +
        `to match SNIPPET_CATALOG (@codecast/shared/contracts/snippets.ts)`,
    );
  }
  return desc;
}

/**
 * Does this machine's config say the installed section differs from the body
 * THIS binary ships? Keyed on a content hash of the body (memory_version →
 * memory_hash), not on the hand-bumped version constants in update.ts, which
 * were wrong in both directions: a body edit with no bump never reinstalled,
 * and a bump with identical bytes rewrote every instruction file on every
 * upgrade. The version constants remain as display values and as a downgrade
 * shadow (stampSnippet).
 *
 * A missing hash — any config written before hashes existed — reads as stale,
 * which costs one reinstall pass that the byte-compare in installSectionToFile
 * turns into zero writes when the text already matches.
 *
 * An unknown slug throws rather than returning false: every caller passes a
 * literal, so a slug the catalog does not know is a typo in a refresh gate —
 * and "false" would mean that snippet silently never refreshes again.
 * `snippetSection` throws for the same reason. False is reserved for a real
 * catalog entry that installs no markdown (orchestration).
 */
export function snippetStale(
  config: object | null | undefined,
  slug: string,
): boolean {
  return snippetStaleFor(config, requireSnippet(slug, "snippetStale"));
}

/**
 * Record what was just installed: the content hash (the actual rewrite key)
 * AND the version constant. The version is a compat shadow — an older CLI
 * compares its own constant against this key, so a downgrade that stopped
 * finding it would rewrite every file on every run. Returns whether the config
 * changed, so callers can skip a pointless write.
 *
 * Unknown slugs throw, like snippetStale: a typo here would silently never
 * stamp, so the paired staleness gate re-runs its install on every pass.
 */
export function stampSnippet(
  config: object,
  slug: string,
  version: string,
): boolean {
  return stampSnippetFor(config, requireSnippet(slug, "stampSnippet"), version);
}

// Messaging is on by default for anyone who has memory. Backfill/refresh it for
// memory installs (respecting an explicit opt-out), install the snippet onto
// disk, and return the config delta to persist — or null if nothing changed.
// Callers persist with their own config writer (index.ts and daemon.ts each
// have one). Idempotent: returns null once the installed CONTENT matches this
// binary's body (the hash is the rewrite key; the version rides along as the
// display/downgrade shadow).
export function ensureMessagingForMemory(
  config: { memory_enabled?: boolean; messaging_enabled?: boolean; messaging_version?: string; messaging_hash?: string } | null | undefined
): { messaging_enabled: true; messaging_version: string; messaging_hash: string } | null {
  if (!config?.memory_enabled) return null;        // only memory installs
  if (config.messaging_enabled === false) return null; // respect explicit opt-out

  const version = getMessagingVersion();
  const hash = snippetContentHash(MESSAGING_SNIPPET);
  if (config.messaging_enabled === true && config.messaging_hash === hash && config.messaging_version === version) {
    return null; // already enabled and current
  }

  installMessagingSnippet(true);
  return { messaging_enabled: true, messaging_version: version, messaging_hash: hash };
}
