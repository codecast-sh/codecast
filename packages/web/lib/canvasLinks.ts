import { parseEntityUrl, entityRoute } from "./entityLinks";

/**
 * In-app route for a canvas anchor that points at a codecast object
 * (https://codecast.sh/conversation/<id>#msg-…, /tasks/ct-…, …), else null.
 * Null means the link is genuinely external and keeps its new-tab default.
 * The fragment survives so message deep links (#msg-<id>) still land.
 */
export function canvasHrefToRoute(href: string | null | undefined): string | null {
  if (!href) return null;
  const ref = parseEntityUrl(href);
  if (!ref) return null;
  const route = entityRoute(ref.type, ref.id);
  if (!route) return null;
  const hashIdx = href.indexOf("#");
  return hashIdx === -1 ? route : route + href.slice(hashIdx);
}
