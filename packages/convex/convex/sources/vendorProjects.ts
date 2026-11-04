// The projects a vendor connection can read, for the add-source form's
// picker: Sentry's projects in the connection's org, PostHog's projects the
// key reaches. Each says which source of this workspace already reads it, so
// a person picks rows rather than typing slugs and ids blind, and a typo can
// no longer make a source that never fills.
import { v } from "convex/values";
import { action, internalQuery } from "../functions";
import { internal } from "../_generated/api";
import { scopeArgs, scopeOf } from "../lib/ingestScope";
import { connectionIdForSource, tokenFor } from "../tokenConnectors";
import { sentryCall, SENTRY_DEFAULT_HOST } from "./sentry";
import { tokenHttp } from "../lib/tokenHttp";

export type VendorProject = { id: string; slug?: string; name: string; platform?: string; taken_by?: string };
export type VendorProjects = { ok: true; projects: VendorProject[]; account?: string } | { ok: false; error: string };

const vendorValidator = v.union(v.literal("sentry"), v.literal("posthog"));
const LIST_MAX_BYTES = 512 * 1024;

/** The workspace's connection for the vendor and what its sources already read. */
export const projectsTarget = internalQuery({
  args: { ...scopeArgs, provider: vendorValidator },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const connection_id = await connectionIdForSource(ctx, { provider: args.provider, workspace: workspaceKey, owner_user_id: userId });
    const sources = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", workspaceKey)).take(500);
    const reads = sources
      .filter((s) => s.provider === args.provider)
      .map((s) => ({ name: s.name, projects: s.config?.projects ?? [], project_id: s.config?.project_id ?? null }));
    return { connection_id, reads };
  },
});

/** Which source reads a project: by id or slug for Sentry (a source naming none reads them all), by id for PostHog. */
export function takenBy(provider: "sentry" | "posthog", p: { id: string; slug?: string }, reads: { name: string; projects: string[]; project_id: string | null }[], connectionProject?: string): string | undefined {
  for (const r of reads) {
    if (provider === "sentry" && (!r.projects.length || r.projects.includes(p.id) || (p.slug && r.projects.includes(p.slug)))) return r.name;
    if (provider === "posthog" && (r.project_id ?? connectionProject) === p.id) return r.name;
  }
  return undefined;
}

export const listVendorProjects = action({
  args: { ...scopeArgs, provider: vendorValidator },
  handler: async (ctx, args): Promise<VendorProjects> => {
    const target: { connection_id: string | null; reads: { name: string; projects: string[]; project_id: string | null }[] } = await ctx.runQuery(internal.sources.vendorProjects.projectsTarget, args);
    const cred = await tokenFor(ctx, target.connection_id, args.provider);
    if (!cred.ok) return { ok: false, error: cred.error };
    const config = cred.config as Record<string, string | undefined>;
    if (args.provider === "sentry") {
      const host = (config.host || SENTRY_DEFAULT_HOST).replace(/\/+$/, "");
      if (!config.org) return { ok: false, error: "The Sentry connection names no organization: reconnect Sentry" };
      const answer = await sentryCall(fetch, cred.token, `${host}/api/0/organizations/${encodeURIComponent(config.org)}/projects/?per_page=100`, { maxBytes: LIST_MAX_BYTES });
      if (!answer.ok) return { ok: false, error: answer.error };
      const projects = (Array.isArray(answer.json) ? answer.json : []).map((p: any): VendorProject => ({ id: String(p?.id), slug: String(p?.slug ?? ""), name: String(p?.name ?? p?.slug ?? p?.id), ...(p?.platform ? { platform: String(p.platform) } : {}) }));
      return { ok: true, account: config.org, projects: projects.map((p) => ({ ...p, ...(takenBy("sentry", p, target.reads) ? { taken_by: takenBy("sentry", p, target.reads) } : {}) })) };
    }
    if (!config.host) return { ok: false, error: "The PostHog connection has no host: reconnect PostHog" };
    const res = await tokenHttp(fetch, { url: `${config.host.replace(/\/+$/, "")}/api/projects/?limit=200`, method: "GET", token: cred.token, maxBytes: LIST_MAX_BYTES, timeoutMs: 15_000, vendor: "PostHog" });
    if (res.failure || !res.ok) return { ok: false, error: res.error ?? `PostHog answered ${res.status} listing projects` };
    let body: any = null;
    try {
      body = JSON.parse(res.text ?? "");
    } catch {
      return { ok: false, error: "PostHog's project list was not JSON" };
    }
    const rows: any[] = Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];
    const projects = rows.map((p): VendorProject => ({ id: String(p?.id), name: String(p?.name ?? p?.id) }));
    return { ok: true, projects: projects.map((p) => ({ ...p, ...(takenBy("posthog", p, target.reads, config.project_id) ? { taken_by: takenBy("posthog", p, target.reads, config.project_id) } : {}) })) };
  },
});
