/**
 * Shared mapping between codecast object types, their in-app routes, and the
 * public URLs that address them. The single source of truth for "what URL
 * addresses this object" — used by the web entity pills (to turn a pasted link
 * into a rich, in-app pill), by navigation, and by the `cast link` CLI command
 * (to mint those links). Keep route knowledge here, not scattered across
 * components or duplicated in the CLI.
 */

export type EntityType = "task" | "plan" | "session" | "doc" | "project";

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
};

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
  return norm ? `${ENTITY_ROUTE[norm]}/${id}` : null;
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
 * Infer an entity type from a bare short id by its prefix: `ct-…` → task,
 * `pl-…` → plan. Returns null for everything else (full Convex ids, 7-char `jx…`
 * session ids, docs) — those have no distinguishing prefix, so the caller must
 * supply the type (or default to session, the historical `cast link` behavior).
 */
export function inferEntityTypeFromShortId(id: string): EntityType | null {
  const s = (id || "").trim();
  if (/^ct-/.test(s)) return "task";
  if (/^pl-/.test(s)) return "plan";
  return null;
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

  if (/^https?:\/\//i.test(path)) {
    let u: URL;
    try {
      u = new URL(path);
    } catch {
      return null;
    }
    if (!isAppHost(u.host)) return null;
    path = u.pathname;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    // Some other protocol (mailto:, entity://, mention://, codecast://, …).
    // Those are handled elsewhere or are genuinely external — not ours.
    return null;
  } else {
    // Path-only href: drop any query string / hash.
    path = path.split(/[?#]/)[0];
  }

  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const type = SEGMENT_TYPE[segs[0].toLowerCase()];
  if (!type) return null;
  let id: string;
  try {
    id = decodeURIComponent(segs[1]).trim();
  } catch {
    id = segs[1].trim();
  }
  if (!id) return null;
  return { type, id };
}
