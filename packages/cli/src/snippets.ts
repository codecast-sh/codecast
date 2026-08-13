// The snippet INSTALLER: everything that touches the filesystem.
//
// The snippet bodies and their section specs live in the shared catalog
// (@codecast/shared/contracts/snippets.ts) — one table with the slugs and
// config keys — and are re-exported below for the CLI, the daemon and the
// tests. This module lives apart from index.ts so the daemon can import it:
// index.ts runs `program.parse()` on import, so daemon.ts cannot import from
// it. The messaging snippet in particular has to be installable from the
// daemon's own startup, so memory-enabled daemons distribute it onto their
// machine's CLAUDE.md autonomously after a self-update — without a `cast`
// command running.

import * as fs from "fs";
import * as path from "path";
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
} from "@codecast/shared/contracts";
import { getMessagingVersion } from "./update.js";
import { atomicWriteFile } from "./atomicWrite.js";

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

export interface SnippetTarget {
  filePath: string;
  dirPath: string;
  label: string;
}

export function getSnippetTargets(): SnippetTarget[] {
  const home = os.homedir();
  const targets: SnippetTarget[] = [
    { filePath: path.join(home, ".claude", "CLAUDE.md"), dirPath: path.join(home, ".claude"), label: "~/.claude/CLAUDE.md" },
  ];

  const codexDir = path.join(home, ".codex");
  if (fs.existsSync(codexDir)) {
    targets.push({ filePath: path.join(codexDir, "AGENTS.md"), dirPath: codexDir, label: "~/.codex/AGENTS.md" });
  }

  const cursorDir = path.join(home, ".cursor");
  if (fs.existsSync(cursorDir)) {
    const rulesDir = path.join(cursorDir, "rules");
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }
    targets.push({ filePath: path.join(rulesDir, "codecast.mdc"), dirPath: rulesDir, label: "~/.cursor/rules/codecast.mdc" });
  }

  return targets;
}

/** A `## ` heading at the start of a line — the boundary between top-level
 *  sections. Snippet bodies only ever go as deep as `### `, so this never
 *  matches inside one of our own blocks. */
const NEXT_SECTION = /\n## /;

/**
 * Every codecast-owned block matching `spec`, as [start, end) offsets.
 *
 * The rule that makes this correct: a block is OURS only when its end marker
 * appears after its heading AND before the next `## ` heading. Detection and
 * removal therefore share one window, which is precisely what the previous
 * per-snippet copies got wrong — they tested `text.includes(endMarker)` across
 * the whole file but cut with `indexOf(endMarker, start)`, so a marker sitting
 * anywhere ABOVE the heading left the cut running to end of file and deleted
 * every later section, user content included.
 *
 * A heading whose block carries no marker is left alone unless a content probe
 * matches, so a user's own `## Tasks & Plans` survives while the real codecast
 * block further down is the one replaced.
 */
export function findOwnedSections(text: string, spec: SectionSpec): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];

  for (const heading of spec.headings) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(heading, from);
      if (start === -1) break;
      from = start + heading.length;

      // Must be a real heading: at file start or immediately after a newline.
      if (start !== 0 && text[start - 1] !== "\n") continue;

      const bodyFrom = start + heading.length;
      const rel = text.slice(bodyFrom).search(NEXT_SECTION);
      // Keep the newline with the block we cut, so the next heading lands
      // exactly where this block began.
      const nextSection = rel === -1 ? text.length : bodyFrom + rel + 1;

      const markerIdx = text.indexOf(spec.endMarker, bodyFrom);
      const owned = markerIdx !== -1 && markerIdx < nextSection;

      let end: number;
      if (owned) {
        end = markerIdx + spec.endMarker.length;
        // Take the blank lines that separated this block from what follows.
        // The separator is ours to re-emit: an update writes exactly one blank
        // line back when something follows the block, so a run over a file we
        // already wrote reproduces it byte for byte. Leaving the old separator
        // in place instead would stack a second blank line on every refresh —
        // the shipped CLI grew the file by one line per snippet per run.
        while (text[end] === "\n") end++;
      } else if (spec.contentProbes?.some((p) => text.slice(start, nextSection).includes(p))) {
        // Pre-marker-era block: bounded by the next heading, never by EOF.
        end = nextSection;
      } else {
        continue; // Someone else's section that happens to share our heading.
      }

      found.push({ start, end });
    }
  }

  // Outermost-first so callers can cut back to front without shifting offsets,
  // and drop any block nested inside another.
  found.sort((a, b) => a.start - b.start);
  return found.filter((b, i) => i === 0 || b.start >= found[i - 1].end);
}

/**
 * What one install run did.
 *
 * `installed` — this call put the section on disk. False when the section was
 * already there and we were not updating, which is why `cast install` then
 * prints "up to date" (index.ts:9601) rather than "installed".
 *
 * `updated` — an existing block was refreshed in place rather than a new one
 * appended.
 *
 * `unchanged` — nothing moved. From `applySnippet` that means the text it
 * returns is byte-identical to the text it was given; from the file writers it
 * means they skipped the write, so the mtime did not move.
 */
export interface SnippetInstallResult {
  installed: boolean;
  updated: boolean;
  unchanged: boolean;
}

/**
 * Rewrite the blocks we own in one pass: the first becomes `body`, the rest go
 * away. `body: null` removes them all — that is uninstall.
 *
 * Back to front, so the offsets `findOwnedSections` measured on the original
 * text still address the same bytes when we reach them.
 *
 * Collapsing to the FIRST block, rather than the last, is what makes an update
 * idempotent: our section lands where our section already was, so running the
 * writer again finds one block in that same place and reproduces the same file.
 */
function replaceOwnedBlocks(
  text: string,
  blocks: Array<{ start: number; end: number }>,
  body: string | null,
): string {
  let out = text;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const after = out.slice(blocks[i].end);
    // The block's end swallowed whatever blank lines separated it from the next
    // section, so re-emit exactly one — and none at end of file.
    const insert = body !== null && i === 0 ? (after === "" ? body : body + "\n") : "";
    let head = out.slice(0, blocks[i].start);
    // A block's window covers the blank lines BELOW it, never the one above.
    // Remove a block that ended the file and that blank line is orphaned: the
    // file ends "last line\n\n", and re-enabling the snippet then appends onto
    // two newlines instead of one, so a disable/enable cycle grows the file by a
    // line every time. Nothing follows it to separate, so end the file after its
    // last real line.
    if (insert === "" && after === "") head = head.replace(/\n+$/, "\n");
    out = head + insert + after;
  }
  return out;
}

/** Remove every block we own, leaving everything else byte-identical. */
export function cutOwnedSections(text: string, spec: SectionSpec): string {
  return replaceOwnedBlocks(text, findOwnedSections(text, spec), null);
}

/**
 * A snippet as a standalone block: no leading blank line (the text above the
 * block already ends in one, or the block starts the file) and exactly one
 * trailing newline. The constants below are template literals padded with a
 * newline at each end, which is what the append path wants and the in-place
 * path does not.
 */
function sectionBody(snippet: string): string {
  return snippet.replace(/^\n+/, "").replace(/\n+$/, "") + "\n";
}

/**
 * The single install algorithm behind every snippet: skip when present and not
 * updating, append when absent, otherwise refresh what we own IN PLACE.
 *
 * In place matters. Cutting the block and re-appending it at the end walked
 * codecast's sections downward past the user's own content a little further on
 * every update, quietly reordering a file they wrote. Duplicate blocks left by
 * an older writer collapse into the first one's position.
 *
 * `unchanged` reports that the result is byte-identical to `existing`, so a
 * caller can skip a pointless write. Pure — the filesystem lives in the
 * callers, so this is directly testable.
 */
export function applySnippet(
  existing: string,
  spec: SectionSpec,
  snippet: string,
  update: boolean,
): SnippetInstallResult & { text: string } {
  const blocks = findOwnedSections(existing, spec);
  const has = blocks.length > 0;
  if (has && !update) return { text: existing, installed: false, updated: false, unchanged: true };
  const text = has
    ? replaceOwnedBlocks(existing, blocks, sectionBody(snippet))
    : existing + snippet;
  return { text, installed: true, updated: has, unchanged: text === existing };
}

/**
 * Write `spec`'s section into one file, creating its directory if needed.
 *
 * A file whose content already matches is left alone — not rewritten with the
 * same bytes. `refreshEnabledSnippets` (index.ts) reinstalls every enabled
 * section at once, and it runs on `cast update`, on `cast restart`, and on
 * daemon boot after a self-update — so a machine that changed nothing still
 * rewrote up to ten sections across up to three files. Each write moves the
 * mtime, which wakes every watcher on it: editors, the agents reading
 * CLAUDE.md, anything tailing the file. `installed` still reports the section's
 * state, so callers that print "installed"/"updated" read the same as before.
 */
export function installSectionToFile(
  filePath: string,
  dirPath: string,
  spec: SectionSpec,
  snippet: string,
  update: boolean,
): SnippetInstallResult {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  const exists = fs.existsSync(filePath);
  const existing = exists ? fs.readFileSync(filePath, "utf-8") : "";
  const result = applySnippet(existing, spec, snippet, update);
  // An absent file still gets created even when the text works out identical,
  // so "the section is installed" stays true on disk and not only in the value.
  const write = result.installed && (!result.unchanged || !exists);
  // Atomic because this file is the user's CLAUDE.md: a crash or a full disk
  // partway through a plain write truncates it, and the whole point of the
  // section machinery above is that we never destroy content we do not own.
  if (write) atomicWriteFile(filePath, result.text, { mode: 0o600 });
  return { installed: result.installed, updated: result.updated, unchanged: !write };
}

/** Write `spec`'s section into every agent instruction file on this machine. */
export function installSectionToTargets(
  spec: SectionSpec,
  snippet: string,
  update: boolean,
): SnippetInstallResult {
  let anyInstalled = false;
  let anyUpdated = false;
  let anyWritten = false;
  for (const target of getSnippetTargets()) {
    const r = installSectionToFile(target.filePath, target.dirPath, spec, snippet, update);
    if (r.installed) anyInstalled = true;
    if (r.updated) anyUpdated = true;
    if (!r.unchanged) anyWritten = true;
  }
  // Unchanged only when NO target needed a write: one stale file out of three
  // is still a change to this machine.
  return { installed: anyInstalled, updated: anyUpdated, unchanged: !anyWritten };
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

/** memory_version → memory_hash: the config key recording the content hash of
 *  the body last installed for a snippet. Every catalog entry's versionKey ends
 *  in `_version` (asserted in snippets.sections.test.ts) — one that did not
 *  would collide this key with the version key itself. */
function snippetHashKey(versionKey: string): string {
  return versionKey.replace(/_version$/, "_hash");
}

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
 * THIS binary ships? Keyed on a content hash of the body, not on the
 * hand-bumped version constants in update.ts, which were wrong in both
 * directions: a body edit with no bump never reinstalled, and a bump with
 * identical bytes rewrote every instruction file on every upgrade. The version
 * constants remain as display values and as a downgrade shadow (stampSnippet).
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
  const desc = requireSnippet(slug, "snippetStale");
  const body = desc.section?.body;
  if (!body) return false;
  // `object` rather than an indexed type so the CLI's and the daemon's Config
  // interfaces (no index signature) pass without casts at every call site.
  const bag = (config ?? {}) as Record<string, unknown>;
  return bag[snippetHashKey(desc.versionKey)] !== snippetContentHash(body);
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
  const desc = requireSnippet(slug, "stampSnippet");
  const bag = config as Record<string, unknown>;
  let changed = false;
  if (bag[desc.versionKey] !== version) {
    bag[desc.versionKey] = version;
    changed = true;
  }
  const body = desc.section?.body;
  if (body) {
    const key = snippetHashKey(desc.versionKey);
    const hash = snippetContentHash(body);
    if (bag[key] !== hash) {
      bag[key] = hash;
      changed = true;
    }
  }
  return changed;
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
