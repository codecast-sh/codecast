// Local files and directories mentioned in prose — "edited lib/pageLayout.tsx:38",
// "/Users/ashot/src/codecast", "~/vault-fixture/Daily/" — become links into the
// Files surface. This module is the pure half: what counts as a path mention,
// and how one resolves to an absolute path given the session it was written in.
//
// The grammar is deliberately strict. Prose is full of slashes that are not
// paths ("and/or", "km/h", "application/json", dates, URLs, app routes like
// /tasks/:id), and a wrong link is worse than a missed one. So a bare relative
// mention must look like a file (an extension on the last segment) or be deep
// enough to be unambiguous (three segments or more), an absolute one must start
// at a directory real machines have, and anything glued to a URL or a dotted
// host is skipped by the boundary rule.

import { createContext } from "react";
import { resolveCustomPath } from "./utils";
import { filesHref } from "./vault/vaultHref";

// One path segment: the usual file-name characters, plus Next.js-style
// `[id]` and `(group)` directories, which this codebase is full of.
const SEG = String.raw`(?:\([\w.@+-]+\)|[\w.@+\-\[\]]+)`;

// Top-level directories an absolute path may start in. Not "any slash-led
// token": app routes (/inbox, /tasks/:id, /files?f=) are everywhere in prose.
const ABS_ROOTS = "Users|home|tmp|private|var|etc|opt|root|mnt|Volumes|Applications|srv|usr|Library|workspace";

const ABS = String.raw`/(?:${ABS_ROOTS})(?:/${SEG})*/?`;
const HOME = String.raw`~(?:/${SEG})+/?`;
const REL = String.raw`(?:\.{1,2}/)?${SEG}(?:/${SEG})+/?`;
// A trailing `:12` or `:12:4` / `:12-20` — the editor convention for "this line".
const LINE = String.raw`(?::(\d+)(?:[-:]\d+)?)?`;
// A GitHub / Antigravity `#L12` or `#L12-L20` line fragment on a file link.
const HASH_LINE = String.raw`(?:#L(\d+)(?:-L?\d+)?)?`;

// Not mid-word, not the tail of a URL or dotted host (preceded by `/` or `.`),
// not the continuation of another path.
const BEFORE = String.raw`(?<![\w/:.@~\-\[\]])`;
const AFTER = String.raw`(?![\w/])`;

const TOKEN = String.raw`(${ABS}|${HOME}|${REL})${LINE}`;

/** Global scanner for text nodes (mdast-util-find-and-replace wants a /g regex). */
export const FILE_PATH_SCAN_RE = new RegExp(`${BEFORE}${TOKEN}${AFTER}`, "g");
const WHOLE_RE = new RegExp(`^${TOKEN}$`);
const ABS_HREF_RE = new RegExp(String.raw`^(/(?:${ABS_ROOTS})(?:/[^?#\r\n]*?)?)${LINE}${HASH_LINE}$`);
const FILE_URI_RE = new RegExp(String.raw`^file://(?:localhost)?(/(?:${ABS_ROOTS})(?:/[^?#\r\n]*?)?)${LINE}${HASH_LINE}$`, "i");

const TRAILING_PUNCT = /[.,;:!?]+$/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

export interface FilePathMention {
  /** The path exactly as written, punctuation trimmed, without the line suffix. */
  path: string;
  /** The text that should stay linked: path plus the `:line` suffix it carried. */
  text: string;
  /** Characters the scanner swallowed that are not part of the path ("." at a
   *  sentence end) — the caller puts them back as plain text. */
  rest: string;
  line?: number;
}

function looksLikePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("~")) return true;
  const explicit = path.startsWith("./") || path.startsWith("../");
  const segs = path.replace(/\/$/, "").split("/");
  const first = segs[0];
  // Scoped packages (@codecast/shared/render) and dotted hosts (github.com/x/y)
  // read like paths and are not. A leading dot (.claude/settings.json) is fine.
  if (first.startsWith("@")) return false;
  if (!first.startsWith(".") && first.includes(".")) return false;
  // Dates: 08/20/2026.
  if (segs.every((s) => /^\d+$/.test(s))) return false;
  // A git ref (origin/codecast/agentwatch-ct-57467) names a branch, not a file.
  if (!explicit && GIT_REF_ROOTS.has(first)) return false;
  if (explicit || path.endsWith("/")) return true;
  if (EXTENSION.test(segs[segs.length - 1])) return true;
  // Without an extension, depth is the evidence. Three bare words are as often a list
  // ("booked/unbooked/missed", "read/write/admin") as a directory, so three plain-word
  // segments are not enough; a fourth, or a segment no word looks like, is.
  return segs.length >= 4 || (segs.length === 3 && segs.some((s) => !/^[A-Za-z]+$/.test(s)));
}
const GIT_REF_ROOTS = new Set(["origin", "upstream", "refs", "remotes"]);

/** Interpret one regex match (from FILE_PATH_SCAN_RE or the whole-string form). */
export function mentionFromMatch(full: string, rawPath: string, line?: string): FilePathMention | null {
  const trimmed = rawPath.replace(TRAILING_PUNCT, "");
  if (!trimmed || !looksLikePath(trimmed)) return null;
  // The line suffix only counts when nothing was trimmed between it and the path.
  const cut = rawPath.length - trimmed.length;
  const suffixed = cut === 0 && line != null;
  const text = suffixed ? full : trimmed;
  return {
    path: trimmed,
    text,
    rest: full.slice(text.length),
    ...(suffixed ? { line: parseInt(line, 10) } : {}),
  };
}

/** The whole string is one path mention (inline code spans), or null. */
export function filePathMention(text: string): FilePathMention | null {
  const m = WHOLE_RE.exec(text.trim());
  if (!m) return null;
  const mention = mentionFromMatch(m[0], m[1], m[2]);
  return mention && !mention.rest ? mention : null;
}

export interface FilePathContextValue {
  /** The directory relative mentions resolve against — the session's working
   *  directory. Without it, relative paths go to the Files page as written and
   *  resolve against whichever vault is open there. */
  base?: string;
  /** Home directory for `~/…`, inferred from the session's own paths. */
  home?: string;
  /** The GitHub repository the session works in (`owner/name`), which is what
   *  a bare `#3263` or `PR 3263` in its prose refers to. Absent, those stay
   *  the text they were written as. */
  repository?: string | null;
  /** The pull requests this conversation knows as repo object ids (linked to
   *  the session, made by its shell calls, or named outright in it). A lone
   *  `#N` is a pull request only when it is one of these. */
  pullRequestIds?: ReadonlySet<string>;
  /** The session's checkout root, which turns an absolute path into the
   *  repo-relative one a `file:` search is written with. */
  gitRoot?: string | null;
  /** Absolute paths the session's own tool calls named. Agents often write a
   *  path relative to somewhere other than their working directory (a sibling
   *  repo, the parent of the checkout); these say where it really is. */
  knownPaths?: readonly string[];
  /** The conversation this link sits in, and whether it belongs to another
   *  person or guest view (`foreign`), so a file the session itself wrote or
   *  edited opens from the session's own diff instead of failing on a local
   *  checkout this machine does not have. */
  conversationId?: string | null;
  foreign?: boolean;
  /** Absolute paths of the files the session changed (the diff panel's
   *  files). A reply that names one by its bare file name ("the edited
   *  constitution.md") links to it. */
  editedPaths?: readonly string[];
}

/** A bare file name in prose: no directory, an extension on the end
 *  ("constitution.md"). Far too common to link on its own; it links only
 *  when it names a file the session changed (editedFileNamed). */
const BARE_FILE_NAME = String.raw`[\w@+\-]+(?:\.[\w@+\-]+)*\.[A-Za-z][A-Za-z0-9]{0,9}`;
export const BARE_FILE_NAME_SCAN_RE = new RegExp(String.raw`${BEFORE}(${BARE_FILE_NAME})${AFTER}`, "g");
const BARE_FILE_NAME_RE = new RegExp(`^${BARE_FILE_NAME}$`);

/** True when `text` is one bare file name and nothing else (`constitution.md`
 *  written as inline code). */
export function isBareFileName(text: string): boolean {
  return BARE_FILE_NAME_RE.test(text);
}

/** The one changed file whose name is `name`, or undefined when none is, or
 *  two in different directories are (a guess there would be a wrong link). */
export function editedFileNamed(name: string, ctx: FilePathContextValue | null | undefined): string | undefined {
  let found: string | undefined;
  for (const p of ctx?.editedPaths ?? []) {
    if (p.slice(p.lastIndexOf("/") + 1) !== name) continue;
    if (found !== undefined && found !== p) return undefined;
    found = p;
  }
  return found;
}

/** The absolute and `~/` paths named anywhere in these tool call inputs
 *  (JSON strings), `~` expanded against `home`, sorted and unique. */
export function namedAbsolutePaths(inputs: Iterable<string>, home: string | undefined): string[] {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.slice(0, 20_000).matchAll(FILE_PATH_SCAN_RE)) {
        const raw = m[1].replace(TRAILING_PUNCT, "");
        if (!raw.startsWith("/") && !raw.startsWith("~")) continue;
        const abs = resolveCustomPath(raw, home);
        if (abs) out.add(abs);
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  for (const input of inputs) {
    try {
      visit(JSON.parse(input));
    } catch {
      visit(input);
    }
  }
  return [...out].sort();
}

/**
 * The absolute path a mention names. A bare relative mention resolves against
 * the working directory, unless the paths the session touched place it
 * somewhere else: a touched path that holds the mention's first two or more
 * segments (`ls ~/src/repo/a/b` places `repo/a/b/c.ts`). When the touched
 * paths disagree, or one agrees with the working directory, it stays there.
 */
export function resolveMentionPath(path: string, ctx: FilePathContextValue | null | undefined): string | undefined {
  if (!ctx) return undefined;
  const direct = resolveCustomPath(path, ctx.home, ctx.base);
  const rel = path.trim().replace(/\/$/, "");
  const known = ctx.knownPaths;
  if (!known?.length || /^[~/.]/.test(rel)) return direct;
  const segs = rel.split("/");
  const candidates = new Set<string>();
  for (const k of known) {
    for (let j = segs.length; j >= 2; j--) {
      const head = segs.slice(0, j).join("/");
      const at = `${k}/`.indexOf(`/${head}/`);
      if (at < 0) continue;
      candidates.add([k.slice(0, at + 1 + head.length), ...segs.slice(j)].join("/"));
      break;
    }
  }
  if (candidates.size !== 1 || (direct && candidates.has(direct))) return direct;
  return [...candidates][0];
}

/** Provided once per conversation (ConversationView) with the session's
 *  working directory and home. Null outside a conversation — absolute and
 *  `~/` mentions still link; relative ones ride to the page as written. */
export const FilePathContext = createContext<FilePathContextValue | null>(null);

/**
 * The Files-surface link for a mention. With context, the path is made absolute
 * here so the link names the file regardless of which vault is open; without it,
 * the raw path rides along and the page does its best.
 */
export function filePathHref(path: string, line: number | undefined, ctx?: FilePathContextValue | null): string {
  const abs = resolveMentionPath(path, ctx);
  return filesHref({ localPath: abs ?? path, line });
}

/** Reads a mention back out of a link the plugin minted, so a component can
 *  re-resolve it with context it has and the parser did not. */
export function parseFilePathHref(href: string | undefined): { path: string; line?: number } | null {
  if (!href) return null;
  const absolute = ABS_HREF_RE.exec(href) ?? FILE_URI_RE.exec(href);
  if (absolute) {
    const encoded = absolute[1].replace(/\+/g, "%2B").replace(/&/g, "%26");
    const path = new URLSearchParams(`path=${encoded}`).get("path")!;
    const line = Number(absolute[2] ?? absolute[3]);
    return { path, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) };
  }
  if (!href.startsWith("/files?") && !href.startsWith("/vault?")) return null;
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  const path = params.get("path");
  if (!path) return null;
  const l = params.get("l");
  const line = l ? parseInt(l, 10) : undefined;
  return { path, ...(line ? { line } : {}) };
}

/**
 * Match a linked path against the files this session wrote or edited. A shared
 * session's artifacts (`~/.gemini/antigravity-cli/brain/…/perf-scorecard.md`)
 * and isolated worktrees live only on the author's machine, while their text
 * is already materialized in the session's own changes.
 */
export function matchSessionChangedFile(
  rawPath: string,
  changes: ReadonlyArray<{ filePath: string; changeType?: string }>,
  ctx?: FilePathContextValue | null,
): { kind: "file"; filePath: string } | { kind: "dir" } | null {
  const fileChanges = changes.filter((c) => c.changeType !== "commit" && !!c.filePath);
  if (fileChanges.length === 0) return null;
  const resolved = (resolveMentionPath(rawPath, ctx) ?? rawPath).replace(/\/+$/, "");
  if (!resolved) return null;
  const exact = fileChanges.find((c) => c.filePath === resolved);
  if (exact) return { kind: "file", filePath: exact.filePath };
  if (!rawPath.startsWith("/") && !rawPath.startsWith("~")) {
    const cleanRel = rawPath.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (cleanRel) {
      const hits = [...new Set(fileChanges.filter((c) => c.filePath.endsWith(`/${cleanRel}`)).map((c) => c.filePath))];
      if (hits.length === 1) return { kind: "file", filePath: hits[0] };
    }
  }
  const dirPrefix = `${resolved}/`;
  if (fileChanges.some((c) => c.filePath.startsWith(dirPrefix))) {
    return { kind: "dir" };
  }
  return null;
}
