// The vault index: every derived view (backlinks, tags, quick switcher, graph,
// rename rewriting, unlinked mentions) is a query against this.
//
// Pure and isomorphic — no DOM, no window, no node. It runs in the index
// worker, in tests, and on the main thread when a worker is unavailable.
//
// THE HARD PART is not parsing, it's RESOLUTION, and specifically the fact
// that resolution is GLOBAL. `[[Note]]` in file X resolves through the whole
// vault's name space, so creating `B/Note.md` when `A/Note.md` already exists
// silently changes what a link in a third, untouched file points at. Every
// mutation therefore recomputes the resolutions of exactly the files whose
// links depend on the names that changed, and bumps `resolutionVersion` when a
// cross-file flip actually happened, so views know to re-render.
//
// The incremental maps are contractually identical to a from-scratch rebuild;
// __tests__/vaultIndex.test.ts asserts that against random operation streams.

import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import {
  basenameOf,
  parseNote,
  stripKnownExtension,
  type NoteLink,
  type ParsedNote,
} from "./parseNote";

/** Bump when the snapshot shape changes; persisted indexes rebuild on mismatch. */
export const VAULT_INDEX_VERSION = 1;

export interface IndexedNote {
  path: string;
  /** Filename without its extension — the name `[[Wiki Links]]` use. */
  basename: string;
  /** Frontmatter title > first H1 > basename. Never empty. */
  title: string;
  /** Only markdown files carry a parse; assets are indexed for embeds alone. */
  parsed: ParsedNote | null;
}

export interface ResolvedLink {
  link: NoteLink;
  /** Vault-relative path of the note/asset the link points at, or null. */
  resolved: string | null;
  /** More than one file answered to this name — the UI should say so. */
  isAmbiguous: boolean;
}

export interface Backlink {
  source: string;
  link: NoteLink;
}

export interface TagTreeNode {
  /** Full tag path, e.g. "status/draft". */
  tag: string;
  /** Last segment, e.g. "draft". */
  name: string;
  /** Files carrying exactly this tag. */
  count: number;
  /** Files carrying this tag or any descendant (deduped). */
  total: number;
  children: TagTreeNode[];
}

export interface VaultIndexSnapshot {
  version: number;
  notes: IndexedNote[];
  resolutionVersion: number;
}

// ---------------------------------------------------------------------------

const lc = (s: string): string => s.toLowerCase();
const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
};

/** Normalize a link target as written: `./A/B`, `A\B`, ` A/B ` all mean `A/B`. */
function normalizeTarget(target: string): string {
  return target.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Every name this file answers to, by path: each trailing path segment run,
 * both with and without the extension. `Areas/Health/Sleep.md` answers to
 * "areas/health/sleep", "health/sleep", "sleep" (and the .md forms), which is
 * exactly the set `[[...]]` targets may spell.
 */
function pathKeys(path: string): string[] {
  const keys = new Set<string>();
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const suffix = segments.slice(i).join("/");
    keys.add(lc(suffix));
    keys.add(lc(stripKnownExtension(suffix)));
  }
  return [...keys];
}

/** The name keys a link target's resolution depends on — the mirror of
 *  pathKeys, so a file appearing or vanishing dirties exactly the links that
 *  could have matched it. */
function targetKeys(target: string): string[] {
  const norm = lc(normalizeTarget(target));
  const noExt = lc(stripKnownExtension(norm));
  return norm === noExt ? [norm] : [norm, noExt];
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

function removeFrom<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

const sortedPaths = (set: Set<string> | undefined): string[] =>
  set ? [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : [];

// ---------------------------------------------------------------------------

export class VaultIndex {
  private notes = new Map<string, IndexedNote>();

  /** name key → files answering to it (path suffixes, with and without ext). */
  private nameIndex = new Map<string, Set<string>>();
  /** lowercased alias → files declaring it. Consulted only after path names. */
  private aliasIndex = new Map<string, Set<string>>();
  /** name key → source files whose links depend on it. The dirty-tracking spine. */
  private linkDeps = new Map<string, Set<string>>();

  /** source path → its links, in document order, with resolutions. */
  private outgoingMap = new Map<string, ResolvedLink[]>();
  /** resolved target path → who links at it. */
  private backlinkMap = new Map<string, Backlink[]>();
  /** normalized unresolved target → source paths. */
  private unresolved = new Map<string, Set<string>>();
  /** lowercased tag → files carrying it exactly. */
  private tagIndex = new Map<string, Set<string>>();

  /** Bumps on any mutation. */
  version = 0;
  /** Bumps only when a link in an UNTOUCHED file changed where it points. */
  resolutionVersion = 0;

  // -- mutation ------------------------------------------------------------

  /** Parse and index a file. Non-markdown paths are indexed as attachments so
   *  `![[diagram.png]]` resolves; they carry no parse. */
  upsert(path: string, content: string): void {
    const parsed = isVaultMarkdownPath(path) ? parseNote(content) : null;
    const basename = stripKnownExtension(basenameOf(path));
    const note: IndexedNote = {
      path,
      basename,
      title: parsed?.title?.trim() || basename,
      parsed,
    };
    const before = this.notes.get(path);
    // Both sets matter: an edit that DROPS an alias must re-resolve the links
    // that were riding on it just as much as one that adds a name.
    const touched = before ? this.detach(before) : new Set<string>();
    this.notes.set(path, note);
    for (const key of this.attach(note)) touched.add(key);
    this.reresolve(path);
    this.propagate(touched, path);
    this.version++;
  }

  remove(path: string): void {
    const note = this.notes.get(path);
    if (!note) return;
    const touched = this.detach(note);
    this.notes.delete(path);
    this.dropOutgoing(path);
    this.propagate(touched, path);
    this.version++;
  }

  /** A move: the file's content is unchanged but its name space entry moves.
   *  (Rewriting the links that POINT at it is a separate, explicit act — this
   *  reports the new resolutions so a caller can offer that rewrite.) */
  rename(oldPath: string, newPath: string): void {
    const note = this.notes.get(oldPath);
    if (!note || oldPath === newPath) return;
    const touched = new Set([...this.detach(note)]);
    this.notes.delete(oldPath);
    const outgoing = this.outgoingMap.get(oldPath);
    this.dropOutgoing(oldPath);

    const basename = stripKnownExtension(basenameOf(newPath));
    const moved: IndexedNote = {
      ...note,
      path: newPath,
      basename,
      title: note.parsed?.title?.trim() || basename,
    };
    this.notes.set(newPath, moved);
    for (const key of this.attach(moved)) touched.add(key);
    // The moved file's own links are re-resolved from its new folder: the
    // ambiguity tie-break prefers same-folder candidates, so moving a file can
    // change where ITS links point too.
    if (outgoing) this.reresolve(newPath);
    this.propagate(touched, newPath);
    this.version++;
  }

  // -- reads ---------------------------------------------------------------

  note(path: string): IndexedNote | undefined {
    return this.notes.get(path);
  }

  paths(): string[] {
    return [...this.notes.keys()].sort();
  }

  size(): number {
    return this.notes.size;
  }

  /**
   * Obsidian's resolution order, and the whole reason this module exists:
   *   1. exact vault-relative path (with or without extension)
   *   2. shortest-unique name match — a trailing run of path segments,
   *      case-insensitive; ties break to fromPath's own folder, then
   *      alphabetically (and the link is reported ambiguous)
   *   3. a unique alias, case-insensitive
   *   4. unresolved
   * A target of "" means fromPath itself (`[[#Heading]]`).
   */
  resolveLink(target: string, fromPath: string): string | null {
    return this.resolveLinkInfo(target, fromPath).path;
  }

  resolveLinkInfo(
    target: string,
    fromPath: string,
  ): { path: string | null; isAmbiguous: boolean; candidates: string[] } {
    const norm = normalizeTarget(target);
    if (!norm) {
      return { path: this.notes.has(fromPath) ? fromPath : null, isAmbiguous: false, candidates: [] };
    }
    const key = lc(norm);

    // 1. Exact vault-relative path, extension optional, case-insensitive
    //    (macOS and Windows vaults are case-preserving but case-insensitive,
    //    so `[[projects/note]]` must find `Projects/Note.md`).
    if (this.notes.has(norm)) return { path: norm, isAmbiguous: false, candidates: [norm] };
    for (const candidate of [key, `${key}.md`, `${key}.markdown`]) {
      const hit = sortedPaths(this.nameIndex.get(candidate)).find((p) => lc(p) === candidate);
      if (hit) return { path: hit, isAmbiguous: false, candidates: [hit] };
    }

    // 2. Shortest-unique name match, with and without extension.
    const byKey = sortedPaths(this.nameIndex.get(key));
    const candidates = byKey.length ? byKey : sortedPaths(this.nameIndex.get(lc(stripKnownExtension(norm))));
    if (candidates.length === 1) return { path: candidates[0], isAmbiguous: false, candidates };
    if (candidates.length > 1) {
      const folder = dirOf(fromPath);
      const sameFolder = candidates.find((p) => dirOf(p) === folder);
      return { path: sameFolder ?? candidates[0], isAmbiguous: true, candidates };
    }

    // 3. Aliases.
    const aliased = sortedPaths(this.aliasIndex.get(key));
    if (aliased.length === 1) return { path: aliased[0], isAmbiguous: false, candidates: aliased };
    if (aliased.length > 1) {
      const folder = dirOf(fromPath);
      const sameFolder = aliased.find((p) => dirOf(p) === folder);
      return { path: sameFolder ?? aliased[0], isAmbiguous: true, candidates: aliased };
    }

    return { path: null, isAmbiguous: false, candidates: [] };
  }

  outgoing(path: string): ResolvedLink[] {
    return this.outgoingMap.get(path) ?? [];
  }

  /** Sorted by source path then position, so the pane's order never depends on
   *  the order files happened to be indexed or re-resolved in. */
  backlinks(path: string): Backlink[] {
    const list = this.backlinkMap.get(path);
    if (!list) return [];
    return [...list].sort(
      (a, b) =>
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
        a.link.line - b.link.line ||
        a.link.col - b.link.col,
    );
  }

  /** Targets nothing answers to → the files that mention them. Powers the
   *  faded "click to create" links and the unresolved-links pane. */
  unresolvedTargets(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [target, sources] of this.unresolved) out.set(target, sortedPaths(sources));
    return out;
  }

  /** Files carrying `tag` or any tag nested under it. */
  filesWithTag(tag: string): string[] {
    const key = lc(tag.replace(/^#/, ""));
    const out = new Set<string>();
    for (const [indexed, files] of this.tagIndex) {
      if (indexed === key || indexed.startsWith(`${key}/`)) for (const f of files) out.add(f);
    }
    return [...out].sort();
  }

  tags(): string[] {
    return [...this.tagIndex.keys()].sort();
  }

  tagTree(): TagTreeNode[] {
    const roots: TagTreeNode[] = [];
    const byTag = new Map<string, TagTreeNode>();
    const filesFor = new Map<string, Set<string>>();

    for (const tag of [...this.tagIndex.keys()].sort()) {
      const segments = tag.split("/");
      let parent: TagTreeNode | null = null;
      for (let i = 0; i < segments.length; i++) {
        const full = segments.slice(0, i + 1).join("/");
        let node = byTag.get(full);
        if (!node) {
          node = { tag: full, name: segments[i], count: 0, total: 0, children: [] };
          byTag.set(full, node);
          filesFor.set(full, new Set());
          (parent ? parent.children : roots).push(node);
        }
        parent = node;
      }
    }
    // `total` counts FILES, not tag occurrences, so a file tagged both
    // status/draft and status/done counts once under "status".
    for (const [tag, files] of this.tagIndex) {
      const node = byTag.get(tag);
      if (node) node.count = files.size;
      const segments = tag.split("/");
      for (let i = 0; i < segments.length; i++) {
        const bucket = filesFor.get(segments.slice(0, i + 1).join("/"));
        if (bucket) for (const f of files) bucket.add(f);
      }
    }
    for (const [tag, files] of filesFor) {
      const node = byTag.get(tag);
      if (node) node.total = files.size;
    }
    return roots;
  }

  // -- persistence ---------------------------------------------------------

  /** Structured-clone-safe (plain objects and arrays only): crosses the worker
   *  boundary and lands in IndexedDB. Derived maps rebuild on load — they are
   *  pure functions of the notes, and serializing them would double the size. */
  snapshot(): VaultIndexSnapshot {
    return {
      version: VAULT_INDEX_VERSION,
      notes: [...this.notes.values()],
      resolutionVersion: this.resolutionVersion,
    };
  }

  static fromSnapshot(snapshot: VaultIndexSnapshot): VaultIndex | null {
    if (snapshot.version !== VAULT_INDEX_VERSION) return null;
    const index = new VaultIndex();
    for (const note of snapshot.notes) {
      index.notes.set(note.path, note);
      index.attach(note);
    }
    for (const path of index.notes.keys()) index.reresolve(path);
    index.resolutionVersion = snapshot.resolutionVersion;
    return index;
  }

  static build(files: Iterable<[string, string]>): VaultIndex {
    const index = new VaultIndex();
    for (const [path, content] of files) index.upsert(path, content);
    return index;
  }

  // -- internals -----------------------------------------------------------

  /** Register a file's names and tags. Returns the name keys whose candidate
   *  set changed, i.e. the keys whose dependent links must be re-resolved. */
  private attach(note: IndexedNote): Set<string> {
    const touched = new Set<string>();
    for (const key of pathKeys(note.path)) {
      addTo(this.nameIndex, key, note.path);
      touched.add(key);
    }
    for (const alias of note.parsed?.aliases ?? []) {
      const key = lc(alias.trim());
      if (!key) continue;
      addTo(this.aliasIndex, key, note.path);
      touched.add(key);
    }
    for (const tag of this.tagsOf(note)) addTo(this.tagIndex, tag, note.path);
    return touched;
  }

  private detach(note: IndexedNote): Set<string> {
    const touched = new Set<string>();
    for (const key of pathKeys(note.path)) {
      removeFrom(this.nameIndex, key, note.path);
      touched.add(key);
    }
    for (const alias of note.parsed?.aliases ?? []) {
      const key = lc(alias.trim());
      if (!key) continue;
      removeFrom(this.aliasIndex, key, note.path);
      touched.add(key);
    }
    for (const tag of this.tagsOf(note)) removeFrom(this.tagIndex, tag, note.path);
    return touched;
  }

  private tagsOf(note: IndexedNote): string[] {
    const parsed = note.parsed;
    if (!parsed) return [];
    const out = new Set<string>();
    for (const tag of parsed.frontmatterTags) out.add(lc(tag));
    for (const { tag } of parsed.inlineTags) out.add(lc(tag));
    return [...out];
  }

  /** Retire a file's outgoing links from every reverse map. */
  private dropOutgoing(path: string): void {
    const previous = this.outgoingMap.get(path);
    if (!previous) return;
    for (const entry of previous) {
      if (entry.resolved) {
        const list = this.backlinkMap.get(entry.resolved);
        if (list) {
          const kept = list.filter((b) => b.source !== path);
          if (kept.length) this.backlinkMap.set(entry.resolved, kept);
          else this.backlinkMap.delete(entry.resolved);
        }
      } else {
        removeFrom(this.unresolved, lc(normalizeTarget(entry.link.target)), path);
      }
      for (const key of targetKeys(entry.link.target)) removeFrom(this.linkDeps, key, path);
    }
    this.outgoingMap.delete(path);
  }

  /** Recompute one file's link resolutions and patch the reverse maps.
   *  Returns true if any resolution actually changed. */
  private reresolve(path: string): boolean {
    const note = this.notes.get(path);
    if (!note) {
      const had = this.outgoingMap.has(path);
      this.dropOutgoing(path);
      return had;
    }
    const links = note.parsed?.links ?? [];
    const previous = this.outgoingMap.get(path);
    const next: ResolvedLink[] = links.map((link) => {
      const { path: resolved, isAmbiguous } = this.resolveLinkInfo(link.target, path);
      return { link, resolved, isAmbiguous };
    });

    const changed =
      !previous ||
      previous.length !== next.length ||
      next.some((entry, i) => previous[i].resolved !== entry.resolved || previous[i].isAmbiguous !== entry.isAmbiguous);
    if (!changed) return false;

    this.dropOutgoing(path);
    this.outgoingMap.set(path, next);
    for (const entry of next) {
      if (entry.resolved) {
        const list = this.backlinkMap.get(entry.resolved);
        if (list) list.push({ source: path, link: entry.link });
        else this.backlinkMap.set(entry.resolved, [{ source: path, link: entry.link }]);
      } else {
        addTo(this.unresolved, lc(normalizeTarget(entry.link.target)), path);
      }
      for (const key of targetKeys(entry.link.target)) addTo(this.linkDeps, key, path);
    }
    return true;
  }

  /**
   * THE TRAP THIS EXISTS FOR: adding `B/Note.md` next to an existing
   * `A/Note.md` flips every `[[Note]]` in the vault from a unique hit to an
   * ambiguous one, changing where links in files nobody touched now point.
   * Re-resolve exactly the files that depend on the changed names.
   */
  private propagate(touchedKeys: Set<string>, exclude: string): void {
    const dirty = new Set<string>();
    for (const key of touchedKeys) {
      for (const source of this.linkDeps.get(key) ?? []) {
        if (source !== exclude) dirty.add(source);
      }
    }
    let flipped = false;
    for (const source of dirty) if (this.reresolve(source)) flipped = true;
    if (flipped) this.resolutionVersion++;
  }
}
