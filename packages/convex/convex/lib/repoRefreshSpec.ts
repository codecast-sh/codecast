// Every repository read kind as one table entry: where it is cached (ref,
// path) and how it is fetched from GitHub (internal.githubApi actions).
// repos.ts walks it to refresh, and the public repo route derives its cache
// key from it, so the two can never drift. It lives apart from repos.ts so the
// public route (repoPublicHttp, mounted by http.ts) does not load repos.ts,
// which reaches the big import cycle (ct-92432).
import { internal } from "../_generated/api";

export type Refresh = {
  kind: string;
  ref: string;
  path: string;
  fetch: (token: string) => Promise<{ payload: any; sha?: string; size?: number; truncated?: boolean }>;
};

/** Everything any kind might need. Each case reads only its own fields. */
export type SpecParams = {
  ref?: string;
  path?: string;
  page?: number;
  per_page?: number;
  author?: string;
  recursive?: boolean;
  base?: string;
  head?: string;
  q?: string;
  state?: string;
  paths?: string[];
  tree_ref?: string;
};

/**
 * The entry names in one directory, for the last-commit column.
 *
 * The walk the source page does has already cached the tree it is looking at,
 * so the names are usually free. A caller that has no cached tree (the public
 * route, which is handed a ref and a path and nothing else) leaves them unset
 * and GitHub resolves the directory instead.
 */
async function directoryEntryNames(
  ctx: any,
  repository: string,
  params: SpecParams,
): Promise<string[] | undefined> {
  if (params.paths) return params.paths;

  // A cached tree row is keyed by the tree's OWN sha. The commit-ish alone
  // therefore reaches the root tree and nothing below it: reading the root row
  // for a subdirectory would name the root's entries and prefix them with the
  // subdirectory, which is a list of paths that do not exist. A caller that has
  // already walked down passes the sha it arrived at as tree_ref; one that has
  // not leaves the names unresolved and GitHub lists the directory instead.
  const dir = params.path ?? "";
  const treeRef = params.tree_ref ?? (dir === "" ? params.ref : undefined);
  if (!treeRef) return undefined;

  const row = await ctx.runQuery(internal.repos.getCacheRow, {
    repository,
    kind: "tree",
    ref: treeRef,
    path: "",
  });
  if (!row) return undefined;

  const entries = JSON.parse(row.content)?.entries ?? [];
  return entries.map((entry: any) => (dir ? `${dir}/${entry.path}` : entry.path));
}

export function refreshSpec(ctx: any, repository: string, kind: string, params: SpecParams): Refresh {
  const ref = params.ref ?? "-";
  const path = params.path ?? "";
  const page = params.page ?? 1;
  const call = (name: string, extra: Record<string, unknown>) => async (token: string) => ({
    payload: await ctx.runAction((internal.githubApi as any)[name], {
      repository,
      github_access_token: token,
      ...extra,
    }),
  });

  switch (kind) {
    case "branches":
      return { kind, ref: "-", path: "", fetch: call("listBranches", {}) };

    case "branchdetails":
      return { kind, ref: "-", path: "", fetch: call("listBranchDetails", {}) };

    case "meta":
      return { kind, ref: "-", path: "", fetch: call("getRepoMeta", {}) };

    case "tags":
      return { kind, ref: "-", path: "", fetch: call("listTags", {}) };

    case "readme":
      return {
        kind,
        ref,
        path: "",
        // A repository with no README is an ordinary answer, and the cache
        // stores objects, so "there isn't one" is a field rather than a null
        // row that a reader cannot tell from a cache miss.
        fetch: async (token) => {
          const data = await ctx.runAction(internal.githubApi.getReadme, {
            repository,
            ref,
            github_access_token: token,
          });
          return { payload: data ? { found: true, ...data } : { found: false }, sha: data?.sha };
        },
      };

    case "tree":
      return {
        kind,
        ref,
        path: params.recursive ? "**" : "",
        fetch: async (token) => {
          const data = await ctx.runAction(internal.githubApi.getTree, {
            repository,
            ref,
            recursive: params.recursive,
            github_access_token: token,
          });
          return { payload: data, sha: data.sha, truncated: data.truncated };
        },
      };

    case "blob":
      return {
        kind,
        ref,
        path,
        fetch: async (token) => {
          const data = await ctx.runAction(internal.githubApi.getBlob, {
            repository,
            ref,
            path,
            github_access_token: token,
          });
          return { payload: data, sha: data.sha, size: data.size, truncated: data.truncated };
        },
      };

    case "log":
      return {
        kind,
        ref,
        path: `${path}#${page}#${params.author ?? ""}`,
        fetch: call("listCommits", {
          sha: ref,
          path: path || undefined,
          per_page: 30,
          page,
          author: params.author,
        }),
      };

    case "blame":
      return { kind, ref, path, fetch: call("getBlame", { ref, path }) };

    case "lastcommits":
      return {
        kind,
        ref,
        path,
        fetch: async (token) => ({
          payload: await ctx.runAction(internal.githubApi.lastCommitsForPaths, {
            repository,
            ref,
            dir: path,
            paths: await directoryEntryNames(ctx, repository, params),
            github_access_token: token,
          }),
        }),
      };

    case "compare":
      return {
        kind,
        ref: params.base ?? "-",
        path: params.head ?? "",
        fetch: call("compare", { base: params.base, head: params.head }),
      };

    case "search":
      return {
        kind,
        ref: "-",
        path: `scoped-v2:${params.q ?? ""}#${page}`,
        fetch: call("searchCode", { q: params.q, page }),
      };

    case "pulls":
      return {
        kind,
        ref: params.state ?? "open",
        path: `#${page}`,
        fetch: call("listPulls", { state: params.state ?? "open", page }),
      };

    default:
      throw new Error(`Unknown repository read: ${kind}`);
  }
}

/**
 * Where a kind lands in the cache, for a caller that holds only params.
 *
 * The public route has to read the same row the refresh just wrote, and the
 * key rules are per kind and fiddly (a log page carries its page and author in
 * the path, a compare carries the head there). Deriving the key from the one
 * table means the route can never drift from the writer. The fetch closure is
 * built and discarded unused, so the context it would have needed is not.
 */
export function cacheKeyFor(kind: string, params: SpecParams): { ref: string; path: string } {
  if (kind === "commit") return { ref: params.ref ?? "-", path: "" };
  const spec = refreshSpec(null as any, "", kind, params);
  return { ref: spec.ref, path: spec.path };
}
