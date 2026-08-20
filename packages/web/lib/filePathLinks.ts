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

// Not mid-word, not the tail of a URL or dotted host (preceded by `/` or `.`),
// not the continuation of another path.
const BEFORE = String.raw`(?<![\w/:.@~\-\[\]])`;
const AFTER = String.raw`(?![\w/])`;

const TOKEN = String.raw`(${ABS}|${HOME}|${REL})${LINE}`;

/** Global scanner for text nodes (mdast-util-find-and-replace wants a /g regex). */
export const FILE_PATH_SCAN_RE = new RegExp(`${BEFORE}${TOKEN}${AFTER}`, "g");
const WHOLE_RE = new RegExp(`^${TOKEN}$`);

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
  if (explicit || path.endsWith("/")) return true;
  if (EXTENSION.test(segs[segs.length - 1])) return true;
  return segs.length >= 3;
}

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
  const abs = ctx ? resolveCustomPath(path, ctx.home, ctx.base) : undefined;
  return filesHref({ localPath: abs ?? path, line });
}

/** Reads a mention back out of a link the plugin minted, so a component can
 *  re-resolve it with context it has and the parser did not. */
export function parseFilePathHref(href: string | undefined): { path: string; line?: number } | null {
  if (!href || !href.startsWith("/files?") && !href.startsWith("/vault?")) return null;
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  const path = params.get("path");
  if (!path) return null;
  const l = params.get("l");
  const line = l ? parseInt(l, 10) : undefined;
  return { path, ...(line ? { line } : {}) };
}
