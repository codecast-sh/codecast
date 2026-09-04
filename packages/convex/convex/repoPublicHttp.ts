// Reading a PUBLIC repository over HTTP, with no viewer at all.
//
// Everything else in repos.ts answers a signed-in person: the installation must
// cover the repository AND the reader must belong to the team that owns it.
// This route drops the second half, so it has to be strict about the first.
// Two rules hold it together.
//
// One: a repository is readable here only when GitHub itself says it is public.
// Visibility comes from the meta cache row, refreshed through whichever
// installation covers the repository, and a repository no installation covers
// is not readable at all.
//
// Two: a refusal says nothing. A private repository and a repository that does
// not exist get the identical response — same status, same body, same headers —
// so the route cannot be used to ask whether some private repository is real.
// publicGate is the single place that decision is made, and a test asserts the
// two answers are byte for byte the same.
//
// The payloads are the cache rows as written, never the enriched ones. Every
// viewer-facing query in repos.ts joins codecast's own rows onto its answer —
// the session that wrote a commit, the tasks it names, the pull request being
// shepherded — and none of that may leave through a route that never asked who
// is reading. publicRead is the read with no joins for exactly that reason.

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { ipRateLimited, keyRateLimited } from "./lib/httpRateLimit";
import { cacheKeyFor } from "./repos";

/** Both prefixes reach this handler; see the registration in http.ts. */
export const PUBLIC_REPO_PREFIXES = ["/api/public/repo/", "/cli/public/repo/"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** The kinds this route will answer, and which query params each one reads. */
export const PUBLIC_KINDS = [
  "meta",
  "branches",
  "branchdetails",
  "tags",
  "tree",
  "blob",
  "readme",
  "log",
  "blame",
  "compare",
  "lastcommits",
  "pulls",
  "search",
] as const;

export type PublicKind = (typeof PUBLIC_KINDS)[number];

export function json(body: unknown, status: number, cache: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache, ...CORS },
  });
}

/**
 * The one refusal. Every path that declines to answer returns this exact
 * response, so nothing about the repository leaks through the difference.
 */
export function notFound(): Response {
  return json({ error: "not_found" }, 404, "no-store");
}

/**
 * Whether a repository may be read here. Null means yes.
 *
 * Not installed and private are the same answer on purpose: the caller learns
 * only that this route has nothing for them.
 */
export function publicGate(visibility: { installed: boolean; private: boolean }): Response | null {
  if (!visibility.installed) return notFound();
  if (visibility.private) return notFound();
  return null;
}

/** `<prefix><owner>/<name>/<kind>` and nothing else. */
export function parsePublicRepoPath(
  pathname: string,
): { repository: string; kind: PublicKind } | null {
  const prefix = PUBLIC_REPO_PREFIXES.find((candidate) => pathname.startsWith(candidate));
  if (!prefix) return null;

  const parts = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (parts.length !== 3) return null;

  const [owner, name, kind] = parts;
  if (!PUBLIC_KINDS.includes(kind as PublicKind)) return null;
  // Anything that could never be a repository is rejected before it becomes a
  // rate-limit key, so garbage cannot mint untracked counter rows. GitHub
  // owners are letters, digits and hyphens; repository names also allow dots,
  // which is why "." and ".." have to be named separately.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") return null;

  return { repository: `${owner}/${name}`, kind: kind as PublicKind };
}

/** Query params for one kind. Reads only the fields that kind uses. */
export function paramsForKind(kind: PublicKind, q: URLSearchParams): Record<string, unknown> {
  const ref = q.get("ref") || undefined;
  const path = q.get("path") || undefined;
  const page = q.get("page") ? Number(q.get("page")) : undefined;

  switch (kind) {
    case "tree":
      return { ref, recursive: q.get("recursive") === "1" };
    case "blob":
    case "blame":
      return { ref, path };
    case "readme":
      return { ref };
    case "lastcommits":
      return { ref, path: path ?? "" };
    case "log":
      return { ref, path, page, author: q.get("author") || undefined };
    case "compare":
      return { base: q.get("base") || undefined, head: q.get("head") || undefined };
    case "search":
      return { q: q.get("q") || "", page };
    case "pulls":
      return { state: q.get("state") || "open", page };
    default:
      return {};
  }
}

/**
 * Does this kind have what it needs to be answered?
 *
 * A blob with no path, a compare with no head and a search with no query all
 * reach GitHub as a malformed request and come back as a confusing upstream
 * failure. They are bad requests, and saying so here keeps them from spending a
 * GitHub call and from being reported as our outage.
 */
export function paramsComplete(kind: PublicKind, params: Record<string, unknown>): boolean {
  if (params.page !== undefined && (!Number.isInteger(params.page) || Number(params.page) < 1 || Number(params.page) > 1000)) return false;
  if (kind === "pulls" && params.state !== undefined && !["open", "closed", "all"].includes(String(params.state))) return false;
  const filled = (key: string) => typeof params[key] === "string" && params[key] !== "";
  switch (kind) {
    case "blob":
    case "blame":
      return filled("ref") && filled("path");
    case "tree":
    case "readme":
    case "log":
      return filled("ref");
    case "lastcommits":
      return filled("ref");
    case "compare":
      return filled("base") && filled("head");
    case "search":
      return filled("q");
    default:
      return true;
  }
}

export function cacheHeaderFor(_params: Record<string, unknown>): string {
  return "no-store";
}

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS }));

export const serve = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const target = parsePublicRepoPath(url.pathname);
  if (!target) return notFound();
  const { repository, kind } = target;

  // Three limits. The first bounds one caller across every repository; the
  // second bounds one repository across every caller and fails CLOSED, because
  // contention on a single counter row is what a flood at one repository looks
  // like; the third is code search, which is the expensive one at GitHub.
  const perCaller = await ipRateLimited(ctx, request, "public-repo", 240, 60_000);
  if (perCaller) return perCaller;
  if (kind === "search") {
    const searchLimit = await ipRateLimited(ctx, request, "public-repo-search", 20, 60_000);
    if (searchLimit) return searchLimit;
  }
  const perRepo = await keyRateLimited(ctx, `public-repo:${repository}`, 600, 60_000, true);
  if (perRepo) return perRepo;

  // --- Visibility, before anything is read ---
  let visibility = await ctx.runQuery(internal.repos.repoVisibility, { repository });
  let installed = true;
  if (!visibility.known || visibility.stale) {
    try {
      const refreshed = await ctx.runAction(internal.repos.ensureCachedPublic, {
        repository,
        kind: "meta",
      });
      installed = refreshed.installed;
      if (installed) {
        visibility = await ctx.runQuery(internal.repos.repoVisibility, { repository });
      }
    } catch {
      // GitHub refusing the repository through the installation that supposedly
      // covers it is indistinguishable from not covering it, and both mean the
      // same thing here.
      installed = false;
    }
  }
  const refused = publicGate({ installed, private: visibility.private });
  if (refused) return refused;

  // --- Only now is anything else fetched ---
  const params = paramsForKind(kind, url.searchParams);
  if (!paramsComplete(kind, params)) {
    return json({ error: "bad_request" }, 400, "no-store");
  }
  if (kind !== "meta") {
    try {
      const filled = await ctx.runAction(internal.repos.ensureCachedPublic, {
        repository,
        kind,
        ...params,
      });
      if (!filled.installed) return notFound();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A ref or path that does not exist is a 404 from GitHub and a 404 here.
      // Anything else is our problem, and says so rather than pretending the
      // repository is missing.
      if (message.includes("404")) return notFound();
      return json({ error: "upstream_unavailable" }, 502, "no-store");
    }
  }

  const { ref, path } = cacheKeyFor(kind, params);
  const data = await ctx.runQuery(internal.repos.publicRead, { repository, kind, ref, path });
  if (data === null) return notFound();

  return json(data, 200, cacheHeaderFor(params));
});
