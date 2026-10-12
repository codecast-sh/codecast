// Product views (docs/architecture/external-data.md X8, views): a connected
// app's own screens, framed inside codecast. `mint` turns a reference
// (`union:conversation/<id>@<iso>`, contracts/productView.ts) into a frame
// url by calling the app's `views.token` action through the stored
// credential. It goes through appCall like any other action, so the grant
// gate and the app_calls audit apply unchanged, and the token is never
// stored: the url goes back to the browser that asked, which frames it.
//
// Which source answers is found from the reference's app name: an app
// connector in one of the caller's workspaces (personal first, then each
// team they belong to) whose manifest or source name is that app. A source
// with no `views` (or none of that name) answers null, and the page shows its
// own rendering instead.
import { v } from "convex/values";
import { action, internalQuery } from "../functions";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { getAuthenticatedUserId } from "../pendingMessages";
import { workspaceKey } from "../lib/accessKeys";
import { sourceFilingScope } from "../lib/ingestScope";
import { appCall, cachedManifest, grantUrlFor, withManifest } from "./app";
import { normalizeSourceName } from "@codecast/shared/contracts/ingest";
import { parseProductViewRef, type ProductViewDef, type ProductViewRef } from "@codecast/shared/contracts/productView";
import type { AppManifest } from "@codecast/shared/contracts/appConnector";
import type { FetchLike } from "../tokenConnectors";

export const VIEW_TOKEN_ACTION = "views.token";

/** What the browser gets: a url to frame, or why there is none. Null means the app declares no such view. */
export type ProductViewMint =
  | { ok: true; url: string; origin: string; expires_at: string; app: string; view: string; title: string }
  | { ok: false; app: string; view: string; title: string; error: string; grant_url?: string };

/** The source among `rows` that answers for `app` and declares `view`: by manifest name first, then source name. */
export function viewSourceFor(
  rows: ReadonlyArray<{ row: Pick<Doc<"event_sources">, "name" | "status">; manifest: AppManifest | null }>,
  app: string,
  view: string,
): { index: number; def: ProductViewDef; appTitle: string } | null {
  const want = app.toLowerCase();
  const named = (r: (typeof rows)[number]) => r.manifest?.name.toLowerCase() === want || normalizeSourceName(r.row.name) === want;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!named(r) || r.row.status === "paused" || !r.manifest) continue;
    const def = r.manifest.views.find((d) => d.name === view);
    if (def) return { index: i, def, appTitle: r.manifest.name };
  }
  return null;
}

/**
 * The app's answer read as a frame url: JSON with an http(s) `url` whose path
 * is the one the manifest declares for the view, so a token answer cannot
 * steer the frame to a screen the app never listed.
 */
export function readViewToken(text: string | undefined, def: Pick<ProductViewDef, "path">): { url: string; origin: string; expires_at: string } | { error: string } {
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
  const expires = typeof raw.expires_at === "string" && Number.isFinite(Date.parse(raw.expires_at)) ? raw.expires_at : new Date(Date.now() + 5 * 60_000).toISOString();
  return { url: u.toString(), origin: u.origin, expires_at: expires };
}

/** The caller's app sources, personal workspace first, each with its cached manifest. */
export const viewSources = internalQuery({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q) => q.eq("user_id", userId)).take(50);
    const keys = [workspaceKey({ type: "personal", userId }), ...memberships.map((m) => workspaceKey({ type: "team", teamId: m.team_id }))];
    const out: Array<{ short_id: string; name: string; status: Doc<"event_sources">["status"]; scope: ReturnType<typeof sourceFilingScope>; manifest_json: string | null }> = [];
    for (const key of keys) {
      const rows = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", key)).take(100);
      for (const row of rows) {
        if (row.provider !== "app") continue;
        const manifest = cachedManifest(await withManifest(ctx, row));
        out.push({ short_id: row.short_id, name: row.name, status: row.status, scope: sourceFilingScope(row), manifest_json: manifest ? JSON.stringify(manifest) : null });
      }
    }
    return { user_id: userId as Id<"users">, sources: out };
  },
});

/** `mint`, with the fetch it calls the app through (a test passes its own). */
export async function mintProductView(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  args: { ref: string; api_token?: string },
  fetchImpl: FetchLike,
): Promise<ProductViewMint | null> {
  const ref: ProductViewRef | null = parseProductViewRef(args.ref);
  if (!ref) return null;
  const found = await ctx.runQuery(internal.sources.appViews.viewSources, { api_token: args.api_token });
  if (!found) return null;
  const rows = found.sources.map((s: any) => ({ row: s, manifest: s.manifest_json ? (JSON.parse(s.manifest_json) as AppManifest) : null }));
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
  const token = readViewToken(res.text, hit.def);
  if ("error" in token) return { ok: false, ...base, error: token.error };
  return { ok: true, ...base, ...token };
}

/** Mint a frame url for one product view reference, or null when no connected app declares that view. */
export const mint = action({
  args: { ref: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ProductViewMint | null> => mintProductView(ctx, args, fetch),
});
