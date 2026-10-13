// Product views (docs/architecture/external-data.md X8, views): a connected
// app's own screens, framed inside codecast. `mint` turns a reference
// (`union:conversation/<id>@<iso>`, contracts/productView.ts) into a frame
// url by calling the app's `views.token` action through the stored
// credential. It goes through appCall like any other action, so the grant
// gate and the app_calls audit apply unchanged, and the token is never
// stored: the url goes back to the browser that asked, which frames it.
//
// Which source answers is found from the reference's app name, among the
// sources of ONE workspace: the one the caller names (`workspace`, the
// workspace of the content the reference sits in), which must be one of
// theirs. The app connector of that name answers, or the one a source of that
// name reports for (viewSourceFor). A mint never reaches into another of the
// caller's workspaces: a same-named connection there holds another
// credential and its audit belongs to another workspace. A caller that names
// no workspace, or one that is not theirs, gets null, as does an app with no
// `views` (or none of that name), and the page shows its own rendering instead.
import { v } from "convex/values";
import { action, internalQuery } from "../functions";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { getAuthenticatedUserId } from "../pendingMessages";
import { workspaceKey } from "../lib/accessKeys";
import { sourceFilingScope } from "../lib/ingestScope";
import { appCall, cachedManifest, grantUrlFor, withManifest } from "./app";
import { framesOwnSite, parseProductViewRef, siteOf, type ProductViewDef, type ProductViewRef } from "@codecast/shared/contracts/productView";
import { siteUrl } from "../lib/siteUrl";

export { siteOf };
import type { AppManifest } from "@codecast/shared/contracts/appConnector";
import type { FetchLike } from "../tokenConnectors";

export const VIEW_TOKEN_ACTION = "views.token";

/** What the browser gets: a url to frame, or why there is none. Null means the app declares no such view. */
export type ProductViewMint =
  | { ok: true; url: string; origin: string; expires_at: string; app: string; view: string; title: string }
  | { ok: false; app: string; view: string; title: string; error: string; grant_url?: string };

/** A name as a reference's app part (the web writes moment refs with the same rule, web lib/productViewRefs.ts). */
export const appSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

/** One of the caller's sources as the resolver reads it: an app connector carries its manifest. */
export type ViewSourceRow = {
  name: string;
  status: Doc<"event_sources">["status"];
  provider: string;
  workspace: string;
  fingerprint_prefix?: string | null;
  manifest: AppManifest | null;
};

/**
 * The app connector among `rows` that answers for `app` and declares `view`.
 * An app named so (its manifest name or source name) answers first. A
 * reference written from another source's records (a moment's source,
 * `union-moments`) reaches the app that source reports for: the app its
 * fingerprint prefix names, else the one app in its workspace declaring the
 * view. Two such apps are ambiguous and answer nothing.
 */
export function viewSourceFor(rows: ReadonlyArray<ViewSourceRow>, app: string, view: string): { index: number; def: ProductViewDef; appTitle: string } | null {
  const want = appSlug(app);
  const declares = (i: number) => {
    const r = rows[i];
    if (r.provider !== "app" || r.status === "paused" || !r.manifest) return null;
    const def = r.manifest.views.find((d) => d.name === view);
    return def ? { index: i, def, appTitle: r.manifest.name } : null;
  };
  const apps = rows.map((_, i) => i).filter((i) => rows[i].provider === "app");
  const isNamed = (i: number, name: string) => (!!rows[i].manifest && appSlug(rows[i].manifest!.name) === name) || appSlug(rows[i].name) === name;
  for (const i of apps) if (isNamed(i, want)) { const hit = declares(i); if (hit) return hit; }
  for (const other of rows) {
    if (other.provider === "app" || appSlug(other.name) !== want) continue;
    // The app it reports for lives in its own workspace: a same-named app elsewhere never answers for its records.
    const prefix = other.fingerprint_prefix ? appSlug(other.fingerprint_prefix) : null;
    const pool = apps.filter((i) => rows[i].workspace === other.workspace && (!prefix || isNamed(i, prefix)));
    const hits = pool.map(declares).filter((h): h is NonNullable<typeof h> => !!h);
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/**
 * The app's answer read as a frame url: JSON with an http(s) `url` whose path
 * is the one the manifest declares for the view, on the same site as the
 * connection's base url (`base`), so a token answer cannot steer the frame to
 * a screen the app never listed or to a host that is not the app's. `self` is
 * codecast's own url: a frame on its site would run same-origin with the page
 * around it (the frame is sandboxed with scripts and its own origin), so it
 * could drop its sandbox and read the parent. No connection, whatever base url
 * a person typed, may frame codecast into codecast.
 */
export function readViewToken(text: string | undefined, def: Pick<ProductViewDef, "path">, base?: string, self?: string): { url: string; origin: string; expires_at: string } | { error: string } {
  let raw: any;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    return { error: "the app's answer is not JSON" };
  }
  if (!raw || typeof raw.url !== "string") return { error: "the app's answer has no url" };
  let u: URL;
  try {
    u = new URL(raw.url);
  } catch {
    return { error: "the app's url does not parse" };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return { error: "the app's url is not https" };
  if (u.pathname.replace(/\/+$/, "") !== def.path.replace(/\/+$/, "")) return { error: `the app's url is not the declared ${def.path}` };
  if (self !== undefined && framesOwnSite(u.toString(), self)) return { error: "the app's url is on codecast's own site, which is never framed here" };
  if (base !== undefined) {
    let b: URL;
    try {
      b = new URL(base);
    } catch {
      return { error: "the connection's base url does not parse" };
    }
    const site = siteOf(b.hostname);
    if (siteOf(u.hostname) !== site) return { error: `the app's url is not on ${site}` };
  }
  const expires = typeof raw.expires_at === "string" && Number.isFinite(Date.parse(raw.expires_at)) ? raw.expires_at : new Date(Date.now() + 5 * 60_000).toISOString();
  return { url: u.toString(), origin: u.origin, expires_at: expires };
}

/** The sources of one of the caller's workspaces (`workspace`, a stored access key); an app connector carries its
 *  cached manifest. Null when the caller names no workspace or one that is not theirs. */
export const viewSources = internalQuery({
  args: { api_token: v.optional(v.string()), workspace: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId || !args.workspace) return null;
    const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q) => q.eq("user_id", userId)).take(50);
    const mine = [workspaceKey({ type: "personal", userId }), ...memberships.map((m) => workspaceKey({ type: "team", teamId: m.team_id }))];
    if (!mine.includes(args.workspace)) return null;
    const keys = [args.workspace];
    const out: Array<Omit<ViewSourceRow, "manifest"> & { short_id: string; scope: ReturnType<typeof sourceFilingScope>; manifest_json: string | null }> = [];
    for (const key of keys) {
      const rows = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", key)).take(100);
      for (const row of rows) {
        const manifest = row.provider === "app" ? cachedManifest(await withManifest(ctx, row)) : null;
        out.push({
          short_id: row.short_id,
          name: row.name,
          status: row.status,
          provider: row.provider,
          workspace: row.workspace,
          fingerprint_prefix: row.fingerprint_prefix ?? null,
          scope: sourceFilingScope(row),
          manifest_json: manifest ? JSON.stringify(manifest) : null,
        });
      }
    }
    return { user_id: userId as Id<"users">, sources: out };
  },
});

/** `mint`, with the fetch it calls the app through (a test passes its own). */
export async function mintProductView(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  args: { ref: string; workspace?: string; api_token?: string },
  fetchImpl: FetchLike,
): Promise<ProductViewMint | null> {
  const ref: ProductViewRef | null = parseProductViewRef(args.ref);
  if (!ref) return null;
  const found = await ctx.runQuery(internal.sources.appViews.viewSources, { api_token: args.api_token, workspace: args.workspace });
  if (!found) return null;
  const rows: ViewSourceRow[] = found.sources.map((s: any) => ({ ...s, manifest: s.manifest_json ? (JSON.parse(s.manifest_json) as AppManifest) : null }));
  const hit = viewSourceFor(rows, ref.app, ref.view);
  if (!hit) return null;
  const source = found.sources[hit.index];
  const base = { app: hit.appTitle, view: ref.view, title: hit.def.title };
  const input = { view: ref.view, id: ref.id, ...(ref.at ? { at: ref.at } : {}) };
  const res = await appCall(
    ctx,
    "do",
    { ...source.scope, ...(args.api_token ? { api_token: args.api_token } : {}), source: source.short_id, name: VIEW_TOKEN_ACTION, args_json: JSON.stringify(input) },
    fetchImpl,
  );
  if (!res.ok) return { ok: false, ...base, error: res.error ?? `the app answered ${res.status ?? "an error"}`, ...(res.denied ? { grant_url: grantUrlFor(source) } : {}) };
  // The frame must be on the app's own site: the connection's base url names it, whatever the manifest says.
  if (!res.base_url) return { ok: false, ...base, error: "the connection named no base url" };
  const token = readViewToken(res.text, hit.def, res.base_url, siteUrl());
  if ("error" in token) return { ok: false, ...base, error: token.error };
  return { ok: true, ...base, ...token };
}

/** Mint a frame url for one product view reference through the sources of `workspace` (the caller's active workspace,
 *  or the workspace of the row the reference sits in); null when no connected app there declares that view. */
export const mint = action({
  args: { ref: v.string(), workspace: v.optional(v.string()), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ProductViewMint | null> => mintProductView(ctx, args, fetch),
});
