/**
 * Shared mapping between codecast object types, their identifiers, their
 * in-app routes, and the public URLs that address them. The single source of
 * truth for "how do I name and address this object" — used by the web entity
 * pills (to turn a bare id, an `@[Title id]` mention, or a pasted link into a
 * rich in-app pill), by navigation, and by the `cast link` CLI command.
 *
 * ADDING A NEW REFERENCEABLE OBJECT TYPE: add it to `EntityType`, give it a
 * `SHORT_ID_PREFIX` entry (or teach `entityTypeFromId` its id shape), add its
 * route to `ENTITY_ROUTE` and its url segment(s) to `SEGMENT_TYPE`. Every
 * mention surface derives its matching from those tables, so nothing else in
 * web/CLI needs a regex of its own. That is why triggers used to render as raw
 * 32-char ids: their table was simply never registered here.
 */

export type EntityType = "task" | "plan" | "session" | "doc" | "project" | "trigger";

/** The public web origin that serves codecast object pages. */
export const CODECAST_BASE_URL = "https://codecast.sh";

/**
 * True only for a full Convex document id: exactly 32 lowercase base32 chars.
 * Short ids (ct-…/pl-… and 7-char jx… sessions) and any malformed/garbage id
 * fail this. Callers use it before handing an id to a `db.get`-backed query —
 * a non-Convex string passed to `ctx.db.get` throws "Invalid ID length" and
 * crashes the page. Single source of truth, re-exported by the inbox store.
 */
export function isConvexId(id: string): boolean {
  return /^[a-z0-9]{32}$/.test(id);
}

/** In-app Next.js route prefix for each entity type. */
export const ENTITY_ROUTE: Record<EntityType, string> = {
  task: "/tasks",
  plan: "/plans",
  session: "/conversation",
  doc: "/docs",
  project: "/projects",
  trigger: "/triggers",
};

/**
 * Short-id prefix → entity type. A short id is the human-quotable handle for an
 * object (`ct-4102`, `pl-88`, `tr-17`); the registry is what makes one
 * recognizable everywhere at once, so a new prefixed type needs one line here
 * and nothing else. Sessions and docs are absent on purpose: a session's handle
 * is the 7-char `jx…` head of its Convex id, and a doc has no short id at all.
 */
export const SHORT_ID_PREFIX: Record<string, EntityType> = {
  ct: "task",
  pl: "plan",
  tr: "trigger",
};

/**
 * URL path segment → entity type. Several segments alias to one type
 * (e.g. /conversation and /sessions both address a session), which is why this
 * is a wider map than ENTITY_ROUTE's inverse.
 */
const SEGMENT_TYPE: Record<string, EntityType> = {
  tasks: "task",
  task: "task",
  plans: "plan",
  plan: "plan",
  conversation: "session",
  conversations: "session",
  sessions: "session",
  session: "session",
  docs: "doc",
  doc: "doc",
  projects: "project",
  project: "project",
  triggers: "trigger",
  trigger: "trigger",
  // Pre-rename alias, still live in old links.
  schedules: "trigger",
};

/**
 * Legacy query-param addressing, kept for PARSING old links only. Triggers
 * used to have no detail page — the list page opened one row via `?task=<id>`
 * — so those links are still live in old messages. New links always use the
 * path route (`/triggers/<id>`).
 */
const LEGACY_QUERY_PARAM: Partial<Record<EntityType, string>> = { trigger: "task" };

/** Normalize a canonical type or a url-segment alias to a canonical EntityType. */
export function normalizeEntityType(type: string): EntityType | null {
  return SEGMENT_TYPE[type] ?? (ENTITY_ROUTE[type as EntityType] ? (type as EntityType) : null);
}

/**
 * Build the in-app route for an entity, or null when the type isn't one we know.
 * Callers MUST treat null as "not navigable" rather than defaulting to /tasks/ —
 * a session id sent to /tasks/<id> renders the conversation as a fake task
 * (db.get is table-blind). `type` accepts both canonical types and url-segment
 * aliases (e.g. "conversation" -> session).
 */
export function entityRoute(type: string, id: string): string | null {
  const norm = normalizeEntityType(type);
  if (!norm) return null;
  return `${ENTITY_ROUTE[norm]}/${id}`;
}

/**
 * Build the public URL that addresses an entity (e.g. task ct-37187 →
 * https://codecast.sh/tasks/ct-37187), or null when the type is unknown. Short
 * ids (ct-…/pl-…/jx…) and full Convex ids both resolve on the web, so either is
 * a valid input. This is the inverse of `parseEntityUrl` for the non-anchored
 * case — message anchors (#msg-<id>) are session-only and added by the caller.
 */
export function buildEntityUrl(type: string, id: string, base: string = CODECAST_BASE_URL): string | null {
  const route = entityRoute(type, id);
  return route ? `${base.replace(/\/+$/, "")}${route}` : null;
}

/**
 * Infer an entity type from a bare short id by its prefix (`ct-…` → task,
 * `pl-…` → plan, `tr-…` → trigger). Returns null for everything else (full
 * Convex ids, 7-char `jx…` session ids, docs) — those have no distinguishing
 * prefix, so the caller must supply the type (or default to session, the
 * historical `cast link` behavior).
 */
export function inferEntityTypeFromShortId(id: string): EntityType | null {
  const prefix = (id || "").trim().toLowerCase().split("-")[0];
  return SHORT_ID_PREFIX[prefix] ?? null;
}

/**
 * Infer an entity type from any bare id: a prefixed short id, a `jx…` session
 * short id, or a `doc:<convexId>` reference. Returns null for a full 32-char
 * Convex id — those carry no type at all and must be resolved server-side
 * (`entities.resolveIdType`), which is what the web pill does.
 */
export function entityTypeFromId(id: string): EntityType | null {
  const s = (id || "").trim();
  if (/^doc:/i.test(s)) return "doc";
  if (isConvexId(s.toLowerCase())) return null;
  if (/^jx[a-z0-9]{5,}$/i.test(s)) return "session";
  return inferEntityTypeFromShortId(s);
}

// ---------------------------------------------------------------------------
// The mention vocabulary
//
// Every surface that turns agent prose into rich object references matches the
// same two shapes, so they are built here from one alternation instead of being
// retyped (and drifting) in each component:
//
//   • a bare id     — `ct-4102`, `pl-88`, `tr-17`, `jx7c6zk`, `doc:<32 chars>`,
//                     or a raw 32-char Convex id
//   • a named mention — `@[Some Title ct-4102]`, optionally trailed by a `(…)`
//
// Each accessor returns a FRESH RegExp: these are used with the `g` flag, whose
// `lastIndex` is mutable state, and a module-level shared instance silently
// skips matches when two callers interleave.
// ---------------------------------------------------------------------------

/** `ct|pl|tr` — the registered short-id prefixes, as a regex alternation. */
const PREFIX_ALT = Object.keys(SHORT_ID_PREFIX).join("|");

/**
 * Bare ids as they appear in prose, widest form first. Exported as a source
 * fragment (not a RegExp) for surfaces that must embed it inside a larger
 * alternation — mobile's markdown tokenizer scans every inline form in one
 * pass, so it needs the branch, not a standalone matcher.
 */
export const BARE_ID_SOURCE = `(?:${PREFIX_ALT})-[a-z0-9]+|jx[a-z0-9]{5,}|doc:[a-z0-9]{20,}|[a-z0-9]{32}`;

/** Ids as they appear inside an `@[Title id]` mention (a label is not an object). */
export const MENTION_ID_SOURCE = `(?:${PREFIX_ALT})-\\w+|jx\\w+|doc:\\w+|label:\\w+|date:\\d{4}-\\d{2}-\\d{2}|[a-z0-9]{32}`;

/** Scans prose for bare object ids. Word-bounded so it can't split a longer token. */
export function bareEntityIdRegex(): RegExp {
  return new RegExp(`\\b(?:${BARE_ID_SOURCE})\\b`, "gi");
}

/**
 * Matches `@[Title id]` mentions. Group 1 is the display title, group 2 the id
 * (absent for a bare `@[Name]` person mention). `requireId` is for the send-time
 * expander, which only enriches mentions that actually name an object.
 */
export function entityMentionRegex(opts: { requireId?: boolean } = {}): RegExp {
  const idGroup = opts.requireId
    ? `\\s+(${MENTION_ID_SOURCE})`
    : `(?:\\s+(${MENTION_ID_SOURCE}))?`;
  return new RegExp(`@\\[([^\\]]*?)${idGroup}\\](?:\\s*\\([^)]*\\))?`, "g");
}

/** True when a whole string is an object id (not a scan — an exact test). */
export function isEntityId(text: string): boolean {
  return new RegExp(`^(?:${BARE_ID_SOURCE})$`, "i").test((text || "").trim());
}

// ---------------------------------------------------------------------------
// What a reference is CALLED
//
// An id names nothing. "ct-38940" mid-sentence forces the reader to hover or
// click just to learn what is being discussed, so every reference surface —
// web pills, mobile pills — shows the object's title and keeps the id for the
// hover card. The rule lives here because both platforms need exactly it, and
// the last copy of it drifted.
// ---------------------------------------------------------------------------

/** Longest title a reference shows inline before it gets clipped. */
export const ENTITY_LABEL_MAX = 40;

/**
 * Clip a title to something that reads inline without swallowing the sentence
 * around it. Clips on a word boundary when there is a sensible one, and leaves
 * a title alone when clipping would save only a character or two.
 */
export function truncateEntityLabel(title: string, max: number = ENTITY_LABEL_MAX): string {
  const t = title.trim();
  if (t.length <= max + 3) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on a space if it leaves most of the budget used — otherwise a
  // long first word would collapse the label to almost nothing.
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return body.trimEnd() + "…";
}

/**
 * The text an inline object reference shows. The title, once the row resolves;
 * otherwise the short id, which at least says WHICH object and stays stable.
 * A 32-char Convex id is never readable, so it degrades to the type name.
 */
export function entityReferenceLabel(args: {
  title?: string | null;
  shortId?: string | null;
  rawId: string;
  typeLabel?: string | null;
}): string {
  const title = args.title?.trim();
  if (title) return truncateEntityLabel(title);
  if (args.shortId) return args.shortId;
  if (isConvexId(args.rawId) && args.typeLabel) return args.typeLabel;
  return args.rawId;
}

/**
 * True for hosts we treat as "ours" — production, the dev origins, and
 * localhost. Only links on these hosts (or path-only links) are eligible to
 * become pills; everything else stays an ordinary external link.
 */
export function isAppHost(host: string): boolean {
  if (/(^|\.)codecast\.sh$/i.test(host)) return true;
  if (host === "localhost" || host.startsWith("localhost:")) return true;
  if (host === "127.0.0.1" || host.startsWith("127.0.0.1:")) return true;
  return false;
}

/**
 * If `href` points at a codecast object, return its `{ type, id }`; otherwise
 * null. Accepts absolute app URLs (https://codecast.sh/tasks/<id>), dev/local
 * origins, and path-only hrefs (/tasks/<id>). The id may be a short id
 * (ct-…/pl-…/jx…) or a full Convex document id — downstream resolution handles
 * both. Non-entity app paths (/settings, /login, /share/…) return null and are
 * left as normal links.
 */
export function parseEntityUrl(
  href: string | undefined | null,
): { type: EntityType; id: string } | null {
  if (!href || typeof href !== "string") return null;
  let path = href.trim();
  let search = "";

  if (/^https?:\/\//i.test(path)) {
    let u: URL;
    try {
      u = new URL(path);
    } catch {
      return null;
    }
    if (!isAppHost(u.host)) return null;
    path = u.pathname;
    search = u.search;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    // Some other protocol (mailto:, entity://, mention://, codecast://, …).
    // Those are handled elsewhere or are genuinely external — not ours.
    return null;
  } else {
    // Path-only href: split the query string / hash off the path, but keep the
    // query — a trigger is addressed by it (/triggers?task=<id>).
    const qIdx = path.search(/[?#]/);
    if (qIdx !== -1) {
      search = path[qIdx] === "?" ? path.slice(qIdx).split("#")[0] : "";
      path = path.slice(0, qIdx);
    }
  }

  const segs = path.split("/").filter(Boolean);
  if (segs.length < 1) return null;
  const type = SEGMENT_TYPE[segs[0].toLowerCase()];
  if (!type) return null;

  // Legacy query-addressed links (old /triggers?task=<id>) still resolve; the
  // path segment wins when both are present.
  const param = LEGACY_QUERY_PARAM[type];
  if (param && segs.length < 2) {
    const qId = search ? new URLSearchParams(search).get(param)?.trim() : null;
    return qId ? { type, id: qId } : null;
  }

  if (segs.length < 2) return null;
  let id: string;
  try {
    id = decodeURIComponent(segs[1]).trim();
  } catch {
    id = segs[1].trim();
  }
  if (!id) return null;
  return { type, id };
}

/**
 * If `href` points at a published page (`cast publish` output), return its
 * slug; otherwise null. Accepts the canonical share URL
 * (https://codecast.sh/a/<slug>), the raw serving origin
 * (https://convex.codecast.sh/cli/a/<slug>), dev/local hosts, and path-only
 * hrefs. Slugs are alphanumeric secrets, so anything with other characters —
 * or a deeper path, which addresses an asset inside a directory bundle — is
 * not a page link.
 */
export function parsePublishedPageUrl(href: string | undefined | null): { slug: string } | null {
  const loc = appLocationOf(href);
  if (!loc) return null;
  const m = /^\/(?:cli\/)?a\/([A-Za-z0-9]{8,24})$/.exec(loc.path);
  return m ? { slug: m[1] } : null;
}

/**
 * The path and fragment of an href that addresses one of OUR pages: an
 * absolute URL on an app host, or a path-only href. Anything on another host
 * or another protocol (mailto:, entity://, …) is not ours and yields null.
 * Query strings are dropped; the fragment survives because message deep links
 * live in it (`/conversation/<id>#msg-<id>`).
 */
function appLocationOf(href: string | undefined | null): { path: string; hash: string } | null {
  if (!href || typeof href !== "string") return null;
  const raw = href.trim();
  if (/^https?:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (!isAppHost(u.host)) return null;
    return { path: u.pathname, hash: u.hash };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  const hashIdx = raw.indexOf("#");
  const beforeHash = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
  return { path: beforeHash.split("?")[0], hash: hashIdx === -1 ? "" : raw.slice(hashIdx) };
}

// ---------------------------------------------------------------------------
// Message references
//
// A conversation message is addressed two ways, and both circulate as links:
//
//   /share/message/<token>              a public excerpt (token minted by the
//                                       sharer; anyone holding it may read)
//   /conversation/<id>#msg-<message id> the message in place (readable by
//                                       whoever can read the conversation)
//
// Neither is an entity route (no `/messages/<id>` page exists), so the message
// is its own reference kind rather than an EntityType. A reference is carried
// through markdown as `msg:<token>` or `msg:<message id>` — the two never
// collide, a share token is a UUID and a message id a 32-char Convex id.
// ---------------------------------------------------------------------------

export const MESSAGE_REF_PREFIX = "msg:";

export type MessageRef = { kind: "share"; token: string } | { kind: "message"; id: string };

/** If `href` addresses a conversation message (either form above), its reference. */
export function parseMessageRefUrl(href: string | undefined | null): MessageRef | null {
  const loc = appLocationOf(href);
  if (!loc) return null;
  const share = parseSharePath(loc.path);
  if (share) return share.kind === "message" ? { kind: "share", token: share.token } : null;
  const entity = parseEntityUrl(loc.path);
  if (!entity || entity.type !== "session") return null;
  const m = /^#msg-([a-z0-9]{32})$/.exec(loc.hash);
  return m ? { kind: "message", id: m[1] } : null;
}

/** The markdown payload for a message reference (`msg:<token or id>`). */
export function messageRefPayload(ref: MessageRef): string {
  return `${MESSAGE_REF_PREFIX}${ref.kind === "share" ? ref.token : ref.id}`;
}

/** The inverse of messageRefPayload; null for any other payload. */
export function parseMessageRefPayload(payload: string | undefined | null): MessageRef | null {
  if (!payload || !payload.startsWith(MESSAGE_REF_PREFIX)) return null;
  const value = payload.slice(MESSAGE_REF_PREFIX.length).trim();
  if (isConvexId(value)) return { kind: "message", id: value };
  return /^[A-Za-z0-9_-]{6,80}$/.test(value) ? { kind: "share", token: value } : null;
}

/**
 * The /share URL family. A share link addresses an object through an opaque
 * token (a UUID minted when the owner shares it) rather than an id:
 *
 *   /share/<token>            → a whole conversation
 *   /share/message/<token>    → a message excerpt
 *   /share/doc/<token>        → a doc
 *   /share/plan/<token>       → a plan
 *
 * One grammar, three consumers: the web server (bot unfurls + SSR), the
 * mobile deep-link router, and the mobile /share resolver screen. The
 * sub-kind segment set is closed on purpose — an unknown segment is not a
 * token, it is a URL we do not own yet.
 */
export type ShareKind = "conversation" | "message" | "doc" | "plan";

export function parseSharePath(path: string): { kind: ShareKind; token: string } | null {
  const clean = (path || "").split(/[?#]/)[0];
  const m = /^\/share\/(?:(message|doc|plan)\/)?([A-Za-z0-9_-]{6,80})\/?$/.exec(clean);
  if (!m) return null;
  return { kind: (m[1] as ShareKind) ?? "conversation", token: m[2] };
}
