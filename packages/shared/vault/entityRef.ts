// Codecast object references inside vault notes.
//
// A note lives on the user's disk, in their git repo, and they may also open it
// in Obsidian, read it on GitHub, or edit it in vim. So the reference to a task
// or a session has to be MEANINGFUL THERE, not only inside codecast. That rules
// out a bespoke token: `[[task:ct-40561]]` is a broken link in Obsidian and
// literal noise on GitHub.
//
// The form is therefore an ordinary markdown link to the public URL that already
// addresses the object:
//
//   [Fix the sync clog](https://codecast.sh/tasks/ct-40561)
//   [jx7dnj1](https://codecast.sh/conversation/jx7dnj1)
//   [@ashot](https://codecast.sh/team/ashot)
//
// Every reader in the world renders that as a working link. Codecast alone
// recognizes the host and draws its own pill instead — the same pill a task id
// gets in a conversation. Nothing is lost when the file leaves the app.
//
// The address vocabulary is NOT redefined here: `parseEntityUrl` (shared/
// entities) already maps a codecast URL to `{ type, id }`, and `buildEntityUrl`
// builds one. This module adds three things on top:
//
//   * people, who address by github username at /team/<name> and have no
//     EntityType of their own,
//   * ID-SHAPE VALIDATION, so `https://codecast.sh/tasks/somethingelse` stays a
//     plain link instead of becoming a pill for an object that cannot exist,
//   * a scan over raw markdown, so the vault index can record which notes
//     reference which objects without a server call.
//
// PURE isomorphic data — no DOM, no Node. The web reading view, the live-preview
// editor and the index worker all read their answers from here, which is what
// keeps them from drifting into three dialects of one file.

import {
  buildEntityUrl,
  entityRoute,
  isAppHost,
  isConvexId,
  parseEntityUrl,
  type EntityType,
} from "../entities";

/** Object types a note may reference. People are not an `EntityType` (they have
 *  no id-addressed page), so the union widens by exactly one member. */
export type EntityRefType = EntityType | "person";

export interface VaultEntityRef {
  type: EntityRefType;
  /** The handle as written. Convex ids are case sensitive, so it is preserved. */
  id: string;
  /** Grouping key — one object, one key, whatever the URL spelled. */
  key: string;
}

export interface VaultEntityOccurrence {
  ref: VaultEntityRef;
  /** The link's display text as written (the URL itself for a bare link). */
  text: string;
  /** 1-based, matching `NoteLink`. */
  line: number;
  /** 0-based, matching `NoteLink`. */
  col: number;
  /** The source slice this occurrence covers. */
  raw: string;
}

/** URL segments that address a person. `/team/<name>` is what the mention route
 *  map builds; `/u/<name>` is the public profile page for the same person. */
const PERSON_SEGMENTS = new Set(["team", "u"]);

/** `/team/activity` is a page, not a person. It is the only collision. */
const PERSON_RESERVED = new Set(["activity"]);

/** A github username: what `/team/<name>` resolves. Deliberately narrow — a
 *  string that cannot be a username must not become a person pill. */
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * The handle shapes each type accepts, beside a full Convex id (which every
 * type but a person may also be addressed by).
 *
 * This is the guard that makes "unresolved" honest: a URL whose id could never
 * name an object of that type is not an entity reference at all, so it renders
 * as the plain link it is rather than as a pill for nothing.
 */
const HANDLE_SHAPE: Record<EntityRefType, RegExp | null> = {
  task: /^ct-[a-z0-9]+$/i,
  plan: /^pl-[a-z0-9]+$/i,
  trigger: /^tr-[a-z0-9]+$/i,
  session: /^jx[a-z0-9]{5,}$/i,
  // Docs and projects have no short id; only a Convex id addresses them.
  doc: null,
  project: null,
  person: USERNAME,
};

export function entityRefKey(type: EntityRefType, id: string): string {
  return `${type}:${id.trim().toLowerCase()}`;
}

/** True when `id` can name an object of this type. */
export function isValidEntityHandle(type: EntityRefType, id: string): boolean {
  const trimmed = (id || "").trim();
  if (!trimmed) return false;
  if (type !== "person" && isConvexId(trimmed.toLowerCase())) return true;
  const shape = HANDLE_SHAPE[type];
  return shape ? shape.test(trimmed) : false;
}

/** A reference, or null when `id` cannot name an object of that type. The only
 *  way to build one — so an unusable handle can never reach a pill. */
export function makeEntityRef(type: EntityRefType, id: string): VaultEntityRef | null {
  const trimmed = (id || "").trim();
  if (!isValidEntityHandle(type, trimmed)) return null;
  return { type, id: trimmed, key: entityRefKey(type, trimmed) };
}

/** The path of an href we are willing to read, or null when it belongs to
 *  somebody else's site (or isn't an address at all). */
function appPath(href: string): string | null {
  const raw = (href || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return isAppHost(u.host) ? u.pathname : null;
    } catch {
      return null;
    }
  }
  // Any other scheme (mailto:, wiki://, entity://) is handled elsewhere.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  if (!raw.startsWith("/")) return null;
  return raw.split(/[?#]/)[0];
}

/** A person reference, or null. Split out because people are the one type
 *  `parseEntityUrl` cannot answer for. */
function parsePersonHref(href: string): VaultEntityRef | null {
  const path = appPath(href);
  if (!path) return null;
  const segs = path.split("/").filter(Boolean);
  if (segs.length !== 2 || !PERSON_SEGMENTS.has(segs[0].toLowerCase())) return null;
  let name: string;
  try {
    name = decodeURIComponent(segs[1]);
  } catch {
    name = segs[1];
  }
  name = name.replace(/^@/, "");
  if (PERSON_RESERVED.has(name.toLowerCase())) return null;
  return makeEntityRef("person", name);
}

/**
 * What object this href addresses, or null when it addresses none. Accepts
 * absolute codecast URLs, the dev/local origins, and path-only hrefs.
 *
 * THE shared answer: the reading view, the live-preview editor and the index
 * all ask this one question, so a link can never be a pill in one view and
 * plain text in another.
 */
export function parseEntityRefHref(href: string | null | undefined): VaultEntityRef | null {
  if (!href || typeof href !== "string") return null;
  const entity = parseEntityUrl(href);
  if (entity) return makeEntityRef(entity.type, entity.id);
  return parsePersonHref(href);
}

/** The in-app route that opens a reference. */
export function entityRefRoute(ref: VaultEntityRef): string | null {
  if (ref.type === "person") return `/team/${encodeURIComponent(ref.id)}`;
  return entityRoute(ref.type, ref.id);
}

/** The public URL that addresses a reference — the inverse of the parse. */
export function entityRefUrl(ref: VaultEntityRef, base?: string): string | null {
  if (ref.type === "person") {
    const origin = (base ?? "https://codecast.sh").replace(/\/+$/, "");
    return `${origin}/team/${encodeURIComponent(ref.id)}`;
  }
  return base ? buildEntityUrl(ref.type, ref.id, base) : buildEntityUrl(ref.type, ref.id);
}

/**
 * The markdown a reference is written as. Link text carries the human-readable
 * name so the note still reads well in Obsidian, on GitHub, and in a plain
 * editor, where the URL is all codecast leaves behind.
 */
export function entityRefMarkdown(
  ref: VaultEntityRef,
  text: string,
  base?: string,
): string | null {
  const url = entityRefUrl(ref, base);
  if (!url) return null;
  return `[${sanitizeLinkText(text) || ref.id}](${url})`;
}

/** Link text may not carry brackets or line breaks; a title that does gets them
 *  flattened rather than escaped, which reads the same and parses everywhere. */
export function sanitizeLinkText(text: string): string {
  return (text || "")
    .replace(/[\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Scanning raw markdown
// ---------------------------------------------------------------------------

// `[text](url)` with an optional angle-bracketed url and an optional title.
const INLINE_LINK = /\[([^\]\n]*)\]\(\s*<?([^\s)<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
// A bare URL, which remark-gfm's autolink literals turn into a link too.
const BARE_URL = /https?:\/\/[^\s<>()\[\]]+/g;
// Inline code is literal: an example URL in backticks is not a reference.
const INLINE_CODE = /`[^`\n]*`/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Blank out a span while keeping every column where it was, so positions
 *  measured against the masked line are positions in the real line. */
function mask(line: string, re: RegExp): string {
  return line.replace(re, (m) => " ".repeat(m.length));
}

/**
 * Every codecast object reference in a note body, in document order.
 *
 * Cheap by construction: two regex passes per line, fenced code and inline code
 * skipped, no parse tree. The index calls it once per file change, which is why
 * "which notes reference task ct-X" needs no server round trip.
 */
export function scanEntityRefs(content: string): VaultEntityOccurrence[] {
  const out: VaultEntityOccurrence[] = [];
  const lines = content.split(/\r\n|\r|\n/);
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (fence) {
      if (raw.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    const open = FENCE.exec(raw);
    if (open) {
      fence = open[1];
      continue;
    }
    // Cheap reject for the overwhelming majority of lines. Both forms are
    // covered: an inline link always carries `](`, a bare one always `http`.
    if (!raw.includes("](") && !raw.includes("http")) continue;

    const line = mask(raw, INLINE_CODE);
    const claimed: { from: number; to: number }[] = [];

    INLINE_LINK.lastIndex = 0;
    for (let m = INLINE_LINK.exec(line); m; m = INLINE_LINK.exec(line)) {
      claimed.push({ from: m.index, to: m.index + m[0].length });
      const ref = parseEntityRefHref(m[2]);
      if (!ref) continue;
      out.push({ ref, text: m[1], line: i + 1, col: m.index, raw: m[0] });
    }

    BARE_URL.lastIndex = 0;
    for (let m = BARE_URL.exec(line); m; m = BARE_URL.exec(line)) {
      const from = m.index;
      if (claimed.some((c) => c.from <= from && c.to > from)) continue;
      const ref = parseEntityRefHref(m[0]);
      if (!ref) continue;
      out.push({ ref, text: m[0], line: i + 1, col: from, raw: m[0] });
    }
  }

  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

/**
 * The accent each type is drawn in, as a `--sol-*` token name. The reading view
 * gets these colors from EntityIdPill; live preview has no React component to
 * reuse, so it reads the same table rather than inventing a second palette.
 */
export const ENTITY_REF_ACCENT: Record<EntityRefType, string> = {
  session: "--sol-blue",
  plan: "--sol-cyan",
  task: "--sol-yellow",
  doc: "--sol-green",
  project: "--sol-violet",
  trigger: "--sol-orange",
  person: "--sol-blue",
};
