/**
 * Shared mapping between codecast object types, their in-app routes, and the
 * public URLs that address them. This is the single source of truth used by
 * the entity pills (to turn a pasted link into a rich, in-app pill) and by
 * navigation. Keep route knowledge here, not scattered across components.
 */

export type EntityType = "task" | "plan" | "session" | "doc" | "project";

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

/**
 * Build the in-app route for an entity, or null when the type isn't one we know.
 * Callers MUST treat null as "not navigable" rather than defaulting to /tasks/ —
 * a session id sent to /tasks/<id> renders the conversation as a fake task
 * (db.get is table-blind). `type` accepts both canonical types and url-segment
 * aliases (e.g. "conversation" -> session).
 */
export function entityRoute(type: string, id: string): string | null {
  const norm = SEGMENT_TYPE[type] ?? (type as EntityType);
  const prefix = ENTITY_ROUTE[norm];
  return prefix ? `${prefix}/${id}` : null;
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
