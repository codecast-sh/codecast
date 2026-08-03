// What `cast vault cat|grep|search|write|edit|rm|mv|links|open` actually does,
// with the terminal stripped out: pick a vault, turn what the user typed into a
// vault-relative path, and read or change the file it names.
//
// The point of this module is that an AGENT is the primary caller. It types the
// name it saw in a `[[wiki link]]`, not a path, and it needs a wrong guess to
// come back as a specific failure it can act on rather than a stack trace —
// hence VaultCliError carrying the process exit code, and hence resolution
// going through the SAME VaultIndex the browser resolves links with. If
// `[[Sleep]]` opens Areas/Health/Sleep.md in the app, `cast vault cat Sleep`
// must open that file too, ambiguity included.
//
// It talks to the disk through vaultScope (path rules, scanning) and vaultFs
// (writing, trashing) — the same two modules the daemon's loopback routes use,
// so a note written from a terminal is written exactly like one saved from a
// browser tab, and the daemon's watcher streams the change to open editors and
// the Convex mirror without knowing who wrote it.

import * as fsp from "fs/promises";
import * as nodePath from "path";
import type { VaultFileEntry, VaultInfo } from "@codecast/shared/contracts";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import {
  VaultIndex,
  applySpanEdits,
  fileMatchesQuery,
  parseVaultQuery,
  planLinkRewrites,
  type Backlink,
  type ResolvedLink,
  type VaultQuery,
} from "@codecast/shared/vault";
import { listVaults } from "./vaultRegistry.js";
import { moveToTrash, writeVaultFile } from "./vaultFs.js";
import {
  isVaultServablePath,
  normalizeVaultPath,
  resolveVaultPath,
  scanVault,
  vaultRelativePath,
} from "./vaultScope.js";

/**
 * Exit codes, so a script can branch without parsing prose. Documented in
 * `cast vault --help` and kept deliberately small.
 */
export const VAULT_EXIT = {
  ok: 0,
  /** No vault, no note, no match — the thing you named isn't there. */
  notFound: 1,
  /** The name fits more than one file, or more than one vault. Pick one. */
  ambiguous: 2,
  /** The vault's root directory is gone or unreadable (unmounted disk, moved
   *  folder). Registration survived; the files did not. */
  unreachable: 3,
} as const;

export class VaultCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = VAULT_EXIT.notFound,
    /** Alternatives worth printing, for the ambiguous case. */
    readonly candidates: string[] = [],
  ) {
    super(message);
    this.name = "VaultCliError";
  }
}

// ---------------------------------------------------------------------------
// Picking a vault
// ---------------------------------------------------------------------------

/**
 * The vault a command runs against, in order: `--vault <id|name|dir>`, then the
 * vault the current directory is inside, then the only registered vault.
 *
 * Defaulting matters more than it looks, and the cwd rule is why. Codecast
 * registers a vault per project, so an agent in a repo has a hundred vaults
 * visible and exactly one it means — the one it is standing in. Falling back to
 * "the only vault" still covers the person with a single notes folder. What is
 * never allowed is a silent pick between unrelated vaults: `cast vault write`
 * landing in the wrong one is somebody else's notes.
 */
export function selectVault(configDir: string, spec?: string, cwd = process.cwd()): VaultInfo {
  const vaults = listVaults(configDir);
  if (vaults.length === 0) {
    throw new VaultCliError("No vaults registered. Add one with: cast vault add ~/notes");
  }

  if (spec) {
    const wanted = spec.trim();
    const lower = wanted.toLowerCase();
    const byName = vaults.filter((v) => v.name.toLowerCase() === lower);
    // Id and path first — they are exact by construction; a name is the fuzzy
    // one and is only consulted when it is unique.
    const exact = vaults.find((v) => v.id === wanted) ?? matchByRoot(vaults, wanted);
    if (exact) return exact;
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new VaultCliError(
        `"${wanted}" names ${byName.length} vaults.`,
        VAULT_EXIT.ambiguous,
        byName.map((v) => `${v.id}  ${v.name}  ${v.root}`),
      );
    }
    throw new VaultCliError(
      `No vault matching "${wanted}". List them with: cast vault ls`,
      VAULT_EXIT.notFound,
    );
  }

  const here = vaultForCwd(vaults, cwd);
  if (here) return here;

  // Only DELIBERATELY registered vaults can be the implicit default. Project
  // vaults are discovered ambiently — there are hundreds on a working machine,
  // and letting them count would turn "the only vault" into "pick one of 112"
  // for someone who has exactly one real vault. They stay addressable by name,
  // by id, and by standing inside them (the cwd rule above, which runs first
  // precisely because it is the more specific answer).
  const registered = vaults.filter((v) => v.kind !== "project");
  if (registered.length === 1) return registered[0];
  if (registered.length === 0) {
    throw new VaultCliError(
      `No vaults registered, and this directory is not inside a project with notes.\n` +
        `Add one with: cast vault add <dir>   ·   or run this from inside a project.`,
      VAULT_EXIT.ambiguous,
    );
  }
  throw new VaultCliError(
    `${registered.length} vaults registered and this directory is not in one — name one with --vault.`,
    VAULT_EXIT.ambiguous,
    registered.map((v) => `${v.id}  ${v.name}  ${v.root}`),
  );
}

/**
 * The vault the given directory is inside, or null. Deepest root wins, so a
 * vault nested inside another resolves to the inner one — the more specific
 * answer. Exported because `cast vault ls` marks this row: with a hundred
 * project vaults on screen, "which one will `cast vault cat` use?" is the
 * question the listing has to answer, and it must answer it with the SAME rule
 * selectVault applies.
 */
export function vaultForCwd(vaults: VaultInfo[], cwd = process.cwd()): VaultInfo | null {
  const containing = vaults
    .filter((v) => vaultRelativePath(v.root, cwd) !== null)
    .sort((a, b) => b.root.length - a.root.length);
  return containing[0] ?? null;
}

function matchByRoot(vaults: VaultInfo[], spec: string): VaultInfo | undefined {
  // A path only counts as a path when it looks like one; otherwise "notes"
  // would resolve against the current directory and shadow a vault named
  // "notes".
  if (!/[/~]/.test(spec)) return undefined;
  const home = process.env.HOME || "";
  const expanded = spec.startsWith("~/") && home ? home + spec.slice(1) : spec;
  const resolved = nodePath.resolve(expanded);
  return vaults.find((v) => v.root === resolved);
}

// ---------------------------------------------------------------------------
// Loading a vault
// ---------------------------------------------------------------------------

/** A vault, its file listing, and a name index over it. */
export interface VaultCtx {
  vault: VaultInfo;
  files: VaultFileEntry[];
  index: VaultIndex;
  /** Note bodies were read, so aliases, tags, links and prose are indexed. */
  hasContent: boolean;
  /** Bodies by path, when hasContent — grep and search read from here rather
   *  than going back to disk. */
  contents: Map<string, string>;
}

/** Markdown notes read at once. High enough to finish a normal vault in a
 *  single wave, low enough not to exhaust file descriptors on a huge one. */
const READ_CONCURRENCY = 32;

/**
 * Scan a vault and index it.
 *
 * `content: false` reads NO files — it indexes paths alone, which is all that
 * exact-path and unique-name resolution need, so `cast vault cat Sleep` costs
 * one directory walk. `content: true` reads every markdown file, which is what
 * backlinks, tags, aliases and full-text search require: a backlink is by
 * definition a link in some OTHER note, and nothing short of reading them all
 * can know which. That read is bounded by scanVault's 20,000-entry cap and runs
 * 32 files at a time; a few thousand notes lands in tens of milliseconds.
 */
export async function openVault(
  configDir: string,
  spec: string | undefined,
  opts: { content?: boolean } = {},
): Promise<VaultCtx> {
  const vault = selectVault(configDir, spec);
  let files: VaultFileEntry[];
  try {
    files = await scanVault(vault.root);
  } catch (err) {
    throw new VaultCliError(
      `Cannot read vault "${vault.name}" at ${vault.root}: ${(err as Error).message}`,
      VAULT_EXIT.unreachable,
    );
  }
  // An empty listing where a root used to be is an unmounted disk far more
  // often than a vault someone emptied, and the two need different advice.
  if (files.length === 0) {
    try {
      await fsp.access(vault.root);
    } catch {
      throw new VaultCliError(
        `Vault "${vault.name}" is registered at ${vault.root}, which no longer exists.`,
        VAULT_EXIT.unreachable,
      );
    }
  }

  const ctx: VaultCtx = {
    vault,
    files,
    index: new VaultIndex(),
    hasContent: false,
    contents: new Map(),
  };
  await indexInto(ctx, !!opts.content);
  return ctx;
}

async function indexInto(ctx: VaultCtx, content: boolean): Promise<void> {
  const notes = ctx.files.filter((f) => !f.dir);
  ctx.index = new VaultIndex();
  ctx.contents.clear();

  if (!content) {
    for (const file of notes) ctx.index.upsert(file.path, "");
    ctx.hasContent = false;
    return;
  }

  for (let i = 0; i < notes.length; i += READ_CONCURRENCY) {
    await Promise.all(
      notes.slice(i, i + READ_CONCURRENCY).map(async (file) => {
        if (!isVaultMarkdownPath(file.path)) return;
        const abs = resolveVaultPath(ctx.vault.root, file.path);
        if (!abs) return;
        const text = await fsp.readFile(abs, "utf8").catch(() => null);
        if (text !== null) ctx.contents.set(file.path, text);
      }),
    );
  }
  for (const file of notes) ctx.index.upsert(file.path, ctx.contents.get(file.path) ?? "");
  ctx.hasContent = true;
}

/** Read the bodies in, if they aren't already. Used when a cheap path-only
 *  resolution came up empty and an alias is the remaining possibility. */
export async function withContent(ctx: VaultCtx): Promise<VaultCtx> {
  if (!ctx.hasContent) await indexInto(ctx, true);
  return ctx;
}

// ---------------------------------------------------------------------------
// Turning what the user typed into a path
// ---------------------------------------------------------------------------

/** A note that exists, addressed both ways the rest of the code needs it. */
export interface NoteRef {
  path: string;
  abs: string;
}

/**
 * Resolve an existing note from a vault-relative path OR a bare name, through
 * the same rules a `[[wiki link]]` follows: exact path (extension optional),
 * then shortest-unique trailing name, then a unique alias.
 *
 * There is no "from" note here — a command line has no folder to prefer — so a
 * name matching several files is an error listing them, never a silent pick.
 */
export async function resolveNote(ctx: VaultCtx, input: string): Promise<NoteRef> {
  const norm = normalizeVaultPath(input);
  if (norm === null || norm === "") {
    throw new VaultCliError(`"${input}" is not a path inside the vault.`);
  }

  let hit = ctx.index.resolveLinkInfo(norm, "");
  // A miss on the path-only index may still be an alias, which only the note's
  // frontmatter knows. Pay for reading the vault exactly then, and never on the
  // common path where the name matched a filename.
  if (!hit.path && !ctx.hasContent) {
    await withContent(ctx);
    hit = ctx.index.resolveLinkInfo(norm, "");
  }

  if (hit.isAmbiguous) {
    throw new VaultCliError(
      `"${input}" matches ${hit.candidates.length} notes.`,
      VAULT_EXIT.ambiguous,
      hit.candidates,
    );
  }
  if (!hit.path) {
    throw new VaultCliError(
      `No note matching "${input}" in vault "${ctx.vault.name}".`,
      VAULT_EXIT.notFound,
    );
  }
  const abs = resolveVaultPath(ctx.vault.root, hit.path);
  if (!abs) throw new VaultCliError(`"${hit.path}" is out of the vault's scope.`);
  return { path: hit.path, abs };
}

/**
 * The path a create or a move should land on. An input that names an existing
 * note resolves to it (so `cast vault write Sleep` overwrites the note the app
 * calls Sleep); anything else is taken literally, gaining a `.md` when it has
 * no extension the vault serves. That is Obsidian's "click the unresolved link
 * to create it" rule, which is the behaviour an agent already expects.
 */
export async function targetNote(ctx: VaultCtx, input: string): Promise<NoteRef & { exists: boolean }> {
  try {
    const found = await resolveNote(ctx, input);
    return { ...found, exists: true };
  } catch (err) {
    if (err instanceof VaultCliError && err.exitCode === VAULT_EXIT.ambiguous) throw err;
  }

  const norm = normalizeVaultPath(input);
  if (norm === null || norm === "") {
    throw new VaultCliError(`"${input}" is not a path inside the vault.`);
  }
  const rel = isVaultServablePath(norm) ? norm : `${norm}.md`;
  if (!isVaultServablePath(rel)) {
    throw new VaultCliError(`"${input}" is not a file type the vault holds.`);
  }
  const abs = resolveVaultPath(ctx.vault.root, rel);
  if (!abs) throw new VaultCliError(`"${input}" is out of the vault's scope.`);
  return { path: rel, abs, exists: false };
}

/** Read a note's text, refusing binaries so `cat` on an attachment says so
 *  instead of spraying bytes at the terminal. */
export async function readNote(ctx: VaultCtx, ref: NoteRef): Promise<string> {
  const cached = ctx.contents.get(ref.path);
  if (cached !== undefined) return cached;
  if (!isVaultMarkdownPath(ref.path)) {
    throw new VaultCliError(`${ref.path} is an attachment, not a text note.`);
  }
  try {
    return await fsp.readFile(ref.abs, "utf8");
  } catch {
    throw new VaultCliError(`Cannot read ${ref.path}.`, VAULT_EXIT.unreachable);
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Exact find and replace, with the same contract as `cast doc edit --old/--new`:
 * the old text must appear EXACTLY once. Absent is a not-found and several is
 * an ambiguity, because in both cases the edit an agent intended is unknowable
 * and a best guess would silently corrupt a note.
 */
export function applyEdit(content: string, oldText: string, newText: string): string {
  if (oldText === "") throw new VaultCliError("--old cannot be empty.");
  const first = content.indexOf(oldText);
  if (first < 0) {
    throw new VaultCliError("--old text is not in the note.", VAULT_EXIT.notFound);
  }
  if (content.indexOf(oldText, first + oldText.length) >= 0) {
    const count = content.split(oldText).length - 1;
    throw new VaultCliError(
      `--old text appears ${count} times; it must be unique. Include more surrounding text.`,
      VAULT_EXIT.ambiguous,
    );
  }
  return content.slice(0, first) + newText + content.slice(first + oldText.length);
}

/** Join a body onto a note: exactly one blank line at the seam and exactly one
 *  newline at the end, however sloppily either side was terminated. */
export function joinBody(existing: string, addition: string, where: "append" | "prepend"): string {
  const first = (where === "append" ? existing : addition).replace(/\s+$/, "");
  const second = (where === "append" ? addition : existing).replace(/^\s+|\s+$/g, "");
  if (!first) return second ? `${second}\n` : "";
  if (!second) return `${first}\n`;
  return `${first}\n\n${second}\n`;
}

export async function writeNote(ref: NoteRef, body: string): Promise<number> {
  const stat = await writeVaultFile(ref.abs, body);
  return stat.size;
}

export interface MoveResult {
  from: string;
  to: string;
  /** Files whose `[[links]]` were repointed at the new path. */
  rewritten: string[];
  /** Links left alone because the file on disk no longer matched what the
   *  index recorded — never rewritten blind. */
  skipped: number;
}

/**
 * Move a note and repoint the links that pointed at it, using the same plan the
 * browser's rename builds. Rewriting is the default because the alternative is
 * a move that silently breaks every inbound link — the one thing that makes
 * people stop trusting a rename.
 *
 * The plan is computed BEFORE the file moves and applied after, which is the
 * order the web store uses: the plan describes where each source file will be,
 * so a file that links at the moved note and is itself moving still lands right.
 */
export async function moveNote(
  ctx: VaultCtx,
  from: NoteRef,
  to: NoteRef & { exists: boolean },
  opts: { rewriteLinks?: boolean } = {},
): Promise<MoveResult> {
  if (to.exists && to.path !== from.path) {
    throw new VaultCliError(`${to.path} already exists.`, VAULT_EXIT.ambiguous);
  }
  const rewrite = opts.rewriteLinks !== false;
  // Planning needs every note's links, so this is the one place a move pays for
  // reading the vault. Skipped entirely when --no-rewrite-links asked for a
  // bare rename.
  const plan = rewrite
    ? planLinkRewrites((await withContent(ctx)).index, from.path, to.path)
    : [];

  await fsp.mkdir(nodePath.dirname(to.abs), { recursive: true });
  await fsp.rename(from.abs, to.abs);

  const rewritten: string[] = [];
  let skipped = 0;
  for (const file of plan) {
    const abs = resolveVaultPath(ctx.vault.root, file.source);
    if (!abs) continue;
    const text = await fsp.readFile(abs, "utf8").catch(() => null);
    if (text === null) continue;
    const result = applySpanEdits(text, file.edits);
    skipped += result.skipped;
    if (result.applied === 0) continue;
    await writeVaultFile(abs, result.content);
    rewritten.push(file.source);
  }
  return { from: from.path, to: to.path, rewritten, skipped };
}

/** Delete a note the way the browser does: to the trash, never unlinked. */
export function trashNote(ctx: VaultCtx, ref: NoteRef): string {
  try {
    return moveToTrash(ctx.vault.root, ref.abs);
  } catch {
    throw new VaultCliError(`Could not move ${ref.path} to the trash.`, VAULT_EXIT.unreachable);
  }
}

// ---------------------------------------------------------------------------
// Reads that need the whole vault
// ---------------------------------------------------------------------------

export interface NoteLinkReport {
  path: string;
  outgoing: ResolvedLink[];
  backlinks: Backlink[];
  /** This note's own links that answer to no file. */
  unresolved: string[];
  /** Codecast objects this note points at — tasks, sessions, plans, docs,
   *  people. They are ordinary markdown links to codecast URLs, so they read as
   *  links everywhere else; here they are named, because an agent asking what a
   *  note connects to wants the work items as much as the other notes. */
  objects: { key: string; type: string; id: string; text: string; line: number }[];
}

export function linkReport(ctx: VaultCtx, path: string): NoteLinkReport {
  const outgoing = ctx.index.outgoing(path);
  return {
    path,
    outgoing,
    backlinks: ctx.index.backlinks(path),
    unresolved: [...new Set(outgoing.filter((l) => !l.resolved).map((l) => l.link.target))].sort(),
    objects: ctx.index.entityRefs(path).map((r) => ({
      key: r.ref.key,
      type: r.ref.type,
      id: r.ref.id,
      text: r.text,
      line: r.line,
    })),
  };
}

export interface SearchHit {
  path: string;
  title: string;
  tags: string[];
  /** Higher is better: a title hit outranks a body hit. */
  score: number;
  /** First matching line, for context. */
  excerpt?: string;
}

/**
 * Metadata and prose search over the `tag:` / `path:` / `file:` grammar the web
 * search pane parses — the same parser, so a query that works in the app works
 * here. Ranking is deliberately simpler than the app's: minisearch is a browser
 * dependency and a CLI that scores title hits above body hits, then counts
 * matches, orders a result list well enough to pick from.
 */
export function searchNotes(ctx: VaultCtx, queryText: string, limit = 20): SearchHit[] {
  const q = parseVaultQuery(queryText);
  if (q.isEmpty) throw new VaultCliError("Nothing to search for.");

  const tagged = q.tags.length
    ? q.tags.map((t) => new Set(ctx.index.filesWithTag(t))).reduce((a, b) => intersect(a, b))
    : null;

  const terms = q.text.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];

  for (const path of ctx.index.paths()) {
    if (!isVaultMarkdownPath(path)) continue;
    if (tagged && !tagged.has(path)) continue;
    const note = ctx.index.note(path);
    if (!note) continue;
    const body = note.parsed?.plainText ?? "";
    if (!fileMatchesQuery(q, path, body)) continue;

    const score = scoreNote(note.title, body, terms, q);
    if (score === null) continue;
    // From the stripped prose, not the raw file: an excerpt quoting the
    // frontmatter back at you says nothing about the note. And an excerpt that
    // is just the title again is a wasted line — the title is already printed.
    const excerpt = firstMatchLine(body, terms, q.phrases);
    hits.push({
      path,
      title: note.title,
      tags: noteTags(note.parsed),
      score,
      excerpt: excerpt === note.title.trim() ? undefined : excerpt,
    });
  }

  hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return hits.slice(0, limit);
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a].filter((x) => b.has(x)));
}

function noteTags(parsed: { frontmatterTags: string[]; inlineTags: { tag: string }[] } | null): string[] {
  if (!parsed) return [];
  return [...new Set([...parsed.frontmatterTags, ...parsed.inlineTags.map((t) => t.tag)])].sort();
}

/** null means the note does not match at all. */
function scoreNote(title: string, body: string, terms: string[], q: VaultQuery): number | null {
  const lowerTitle = title.toLowerCase();
  const lowerBody = body.toLowerCase();
  for (const phrase of q.phrases) {
    if (!`${lowerTitle}\n${lowerBody}`.replace(/\s+/g, " ").includes(phrase.replace(/\s+/g, " "))) {
      return null;
    }
  }
  // A query that is only filters (`tag:x path:y`) matches every file the
  // filters left standing — there is nothing further to rank on.
  if (terms.length === 0) return 1;

  let score = 0;
  for (const term of terms) {
    if (lowerTitle.includes(term)) score += 10;
    const inBody = lowerBody.split(term).length - 1;
    if (inBody > 0) score += Math.min(inBody, 5);
    if (!lowerTitle.includes(term) && inBody === 0) return null;
  }
  return score;
}

function firstMatchLine(text: string, terms: string[], phrases: string[]): string | undefined {
  const needles = [...phrases, ...terms];
  if (!needles.length) return undefined;
  for (const line of text.split("\n")) {
    const lower = line.toLowerCase();
    if (needles.some((n) => lower.includes(n))) return line.trim().slice(0, 200);
  }
  return undefined;
}

/**
 * `--path` for grep: a glob over vault-relative paths. `*` and `?` stay inside
 * one segment, `**` crosses them, and a pattern with no slash is matched
 * against the basename — so `--path "*.md"` means what a shell user expects
 * rather than "only notes in the vault root".
 */
export function pathGlobMatcher(pattern: string): (path: string) => boolean {
  const source = pattern
    .split(/(\*\*|\*|\?)/)
    .map((part) =>
      part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : escapeRegex(part),
    )
    .join("");
  const re = new RegExp(`^${source}$`, "i");
  const basenameOnly = !pattern.includes("/");
  return (path: string) => re.test(path) || (basenameOnly && re.test(path.split("/").pop() ?? ""));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
