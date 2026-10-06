// The runtime's URL space on the deployment's .convex.site origin:
//
//   /run/sdk.js                  the SDK every app imports as "playground"
//   /run/<slug>/live             redirects to the live version's folder
//   /run/<slug>/v/<n>/           version n's index.html
//   /run/<slug>/v/<n>/<path>     one file of version n (transpiled if JSX/TS)
//
// A version folder ends in "/" because apps load their files by relative
// path. The shell builds iframe URLs with these helpers, and the HTTP router
// parses requests with runRoute, so the two cannot disagree.
import { ENTRY_PATH, normalizeFilePath } from "./files";
import { isSlug } from "./slugs";
import { SDK_PATH } from "./runtime";

export const RUN_PREFIX = "/run/";

export function versionPath(slug: string, number: number, file = ""): string {
  return `${RUN_PREFIX}${slug}/v/${number}/${file}`;
}

export function livePath(slug: string): string {
  return `${RUN_PREFIX}${slug}/live`;
}

export type RunRoute =
  | { kind: "sdk" }
  | { kind: "live"; slug: string }
  /** A version folder asked for without its trailing slash. */
  | { kind: "folder"; location: string }
  | { kind: "file"; slug: string; number: number; path: string };

const VERSION_NUMBER = /^[1-9]\d{0,5}$/;

/** What a /run/ pathname asks for, or null for anything the runtime does not
 *  serve (bad slug, bad version, a path no version could hold). */
export function runRoute(pathname: string): RunRoute | null {
  if (pathname === SDK_PATH) return { kind: "sdk" };
  if (!pathname.startsWith(RUN_PREFIX)) return null;
  const [slug, segment, number, ...rest] = pathname.slice(RUN_PREFIX.length).split("/");
  if (!isSlug(slug)) return null;
  if (segment === "live") return (number ?? "") === "" && rest.length === 0 ? { kind: "live", slug } : null;
  if (segment !== "v" || !number || !VERSION_NUMBER.test(number)) return null;
  const n = Number(number);
  if (rest.length === 0) return { kind: "folder", location: versionPath(slug, n) };
  const raw = safeDecode(rest.join("/"));
  if (raw === "") return { kind: "file", slug, number: n, path: ENTRY_PATH };
  return raw !== null && normalizeFilePath(raw) === raw ? { kind: "file", slug, number: n, path: raw } : null;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
