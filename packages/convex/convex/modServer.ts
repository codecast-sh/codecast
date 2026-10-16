import { v } from "convex/values";
import { action, internalQuery } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { canReadConnector, secretFor, type ModManifest } from "@codecast/shared/contracts/mods";
import { appCall } from "./sources/app";
import { reachesMod } from "./modLocal";
import { decryptModSecret } from "./modSecrets";

/**
 * The requests a mod's UI makes that cannot run in the viewer's browser: a
 * connector reader (codecast signs those, so no key exists to hold) and a
 * fetch carrying one of the mod's secrets. Both run as the person viewing the
 * mod, for mods they may run: their own, and their team's shared ones.
 */

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE = 1_000_000;

export const modFor = internalQuery({
  args: { mod_id: v.id("mods"), user_id: v.id("users") },
  handler: async (ctx, args) => {
    const mod = await ctx.db.get(args.mod_id);
    if (!mod || !(await reachesMod(ctx, args.user_id, mod))) return null;
    return { _id: mod._id, name: mod.name, team_id: mod.team_id, manifest: mod.manifest as ModManifest };
  },
});

type Answer = { ok: boolean; status?: number; text?: string; json?: unknown; headers?: Record<string, string>; error?: string };

function withJson(text: string | undefined): { json?: unknown } {
  if (text === undefined) return {};
  try { return { json: JSON.parse(text) }; } catch { return {}; }
}

export const call = action({
  args: {
    mod_id: v.id("mods"),
    method: v.union(v.literal("connector.read"), v.literal("http.fetch")),
    /** The SDK call's arguments as JSON: a reader's args or a fetch's body need not be valid Convex values. */
    args_json: v.string(),
    /** The viewer's active team, for a personal mod reading a team's connector. */
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<Answer> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false, error: "Not signed in" };
    const mod = await ctx.runQuery(internal.modServer.modFor, { mod_id: args.mod_id, user_id: userId });
    if (!mod) return { ok: false, error: "this mod is not one you run" };
    const callArgs = JSON.parse(args.args_json) as unknown[];

    if (args.method === "connector.read") {
      const [source, reader, readerArgs] = callArgs as [string, string, Record<string, unknown> | undefined];
      if (!canReadConnector(mod.manifest, String(source))) return { ok: false, error: `permissions.connectors does not list "${source}"` };
      const res = await appCall(ctx, "read", {
        user_id: userId, team_id: mod.team_id ?? args.team_id, workspace: mod.team_id || args.team_id ? "team" : undefined,
        source: String(source), name: String(reader), args_json: readerArgs ? JSON.stringify(readerArgs) : undefined,
      }, fetch);
      return { ok: res.ok, status: res.status, text: res.text, ...withJson(res.text), error: res.error };
    }

    const [url, init] = callArgs as [string, { method?: string; headers?: Record<string, string>; body?: string; secret?: string } | undefined];
    const allowed = secretFor(mod.manifest, String(init?.secret ?? ""), String(url));
    if (!allowed.ok) return { ok: false, error: allowed.error };
    const enc = await ctx.runQuery(internal.modSecrets.secretValueEnc, { mod_id: mod._id, name: allowed.secret.name });
    if (!enc) return { ok: false, error: `${allowed.secret.name} is not set: its author sets it on the Mods page (or cast mod secret set ${mod.name} ${allowed.secret.name})` };
    const value = await decryptModSecret(enc);
    if (!value) return { ok: false, error: `${allowed.secret.name} can no longer be read (the deployment key changed): set it again` };
    const header = allowed.secret.header ?? "Authorization";
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(init?.headers ?? {})) if (k.toLowerCase() !== header.toLowerCase()) headers[k] = String(val);
    headers[header] = allowed.secret.header ? value : `Bearer ${value}`;
    try {
      // Redirects come back as they are: following one could carry the key to an origin it was never declared for.
      const res = await fetch(String(url), { method: init?.method ?? "GET", headers, body: init?.body, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const text = await res.text();
      if (text.length > MAX_RESPONSE) return { ok: false, status: res.status, error: `the response is over ${MAX_RESPONSE / 1_000_000} MB` };
      const contentType = res.headers.get("content-type");
      return { ok: res.ok, status: res.status, text, ...withJson(text), headers: contentType ? { "content-type": contentType } : {} };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
