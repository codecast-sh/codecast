// The shapes a snippet installer works with. No catalog content lives here:
// each consumer ships its own table of definitions and hands it to the
// installer. Codecast's SNIPPET_CATALOG satisfies SnippetDefinition
// structurally, so adoption there is an import swap, not a rewrite.

/**
 * How one installer-owned section is recognized inside a CLAUDE.md or
 * AGENTS.md.
 *
 * `headings[0]` is what the installer writes today; the rest are headings older
 * versions wrote, matched so an update replaces the old section instead of
 * stacking a second copy under it. `contentProbes` identifies bodies written
 * before end markers existed. Those files have a heading and no marker, and
 * the probes are the only reason a marker-less block may be removed at all.
 */
export interface SectionSpec {
  headings: string[];
  endMarker: string;
  contentProbes?: string[];
}

/** One snippet's installable half: the bytes, and the window rule that finds
 *  an installed copy again. The body is a template literal padded with one
 *  newline at each end. The append path writes it as is; the in-place path
 *  trims it. Keeping spec and body together is what stops them drifting. */
export interface SnippetSection {
  spec: SectionSpec;
  body: string;
}

/**
 * One installable snippet. The display fields (`name`, `desc`, `detail`,
 * `writesTo`, `shipped`) exist so a CLI, a daemon heartbeat and a settings page
 * can all render the same table. The two config keys are the installer's
 * bookkeeping: `enabledKey` is the flag that switches the snippet on, and
 * `versionKey` holds the version last installed. The content hash that decides
 * rewrites is stored under `hashKey`, which defaults to `versionKey` with its
 * `_version` suffix replaced by `_hash`.
 */
export interface SnippetDefinition {
  /** What the user types to install it. Stable, lowercase, no spaces. */
  slug: string;
  /** Alternate names accepted on a CLI. */
  aliases?: string[];
  /** Human label. */
  name: string;
  /** One line summary. */
  desc: string;
  /** The full explanation an install wizard prints. */
  detail: string;
  /** Where the snippet is written on disk, as a note for humans. */
  writesTo: string;
  /** ISO date (YYYY-MM-DD) the snippet first shipped. */
  shipped: string;
  /** Config flag this snippet toggles, for example "workflow_enabled". */
  enabledKey: string;
  /** Config field holding the installed version, for example "workflow_version". */
  versionKey: string;
  /** Config field holding the content hash last installed. Derived from
   *  `versionKey` when absent. */
  hashKey?: string;
  /** Former slug, kept while old clients are in the wild. */
  wireSlug?: string;
  /** The markdown this snippet installs. Absent for a snippet that is not
   *  markdown at all (one that installs skills, agents or hooks instead). */
  section?: SnippetSection;
}

/**
 * What one install run did.
 *
 * `installed`: this call put the section on disk. False when the section was
 * already there and the caller was not updating.
 *
 * `updated`: an existing block was refreshed in place rather than a new one
 * appended.
 *
 * `unchanged`: nothing moved. From `applySnippet` that means the text it
 * returns is byte-identical to the text it was given; from the file writers it
 * means they skipped the write, so the mtime did not move.
 */
export interface SnippetInstallResult {
  installed: boolean;
  updated: boolean;
  unchanged: boolean;
}

/** One instruction file the installer writes into. `dirPath` defaults to the
 *  file's parent; `label` is what a CLI prints (for example "~/.claude/CLAUDE.md"). */
export interface SnippetTarget {
  filePath: string;
  dirPath?: string;
  label?: string;
}

/**
 * The filesystem the installer writes through. Injected so tests and consumers
 * without Node can supply their own; `memoryFs()` and `nodeFs` ship here.
 *
 * `readFile` returns null for a missing file. `writeFile` must not leave a
 * torn file behind: the Node adapter publishes by rename.
 */
export interface SnippetFs {
  readFile(filePath: string): string | null;
  writeFile(filePath: string, text: string): void;
  exists(filePath: string): boolean;
  mkdir(dirPath: string): void;
}
