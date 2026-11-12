// Finding a board, sheet or dashboard by the words inside it. Each artifact
// keeps one live_search row: the text shared/artifacts/search.ts draws from its
// saved layer, under the doc's workspace key. A write to the saved layer asks
// for a reindex a little later (one per quiet spell, not one per keystroke);
// a search reads the viewer's own workspaces and checks access on each hit.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { canAccessDoc } from "./lib/access";
import { resolveWorkspaceKey } from "./lib/accessKeys";
import { artifactSearchText, isArtifactDocType, searchSnippet, type ArtifactElement } from "@codecast/shared/artifacts";

/** How long after a write the text is redrawn: edits inside it share one reindex. */
export const SEARCH_REINDEX_MS = 20_000;
/** Rows a reindex reads; a bigger artifact indexes its first rows. */
const INDEX_ROWS_MAX = 6000;

/** Ask for a reindex unless one is already on its way. Called inside the write's transaction. */
export async function scheduleLiveSearch(ctx: any, head: { _id: any; search_due?: number }, docId: Id<"docs">) {
  // A marker older than a few reindex windows belongs to a job that failed: ask again.
  if (head.search_due && Date.now() - head.search_due < 5 * 60_000) return;
  await ctx.db.patch(head._id, { search_due: Date.now() });
  await ctx.scheduler.runAfter(SEARCH_REINDEX_MS, internal.liveSearch.reindex, { doc_id: docId });
}

/**
 * Reindex an artifact whose search row is missing (written before search
 * existed) or stale in what writes to its elements never touch: its title
 * (the row's first line) or its workspace (moved between personal and team).
 */
export async function ensureLiveSearch(ctx: any, docId: Id<"docs">) {
  const row = await ctx.db.query("live_search").withIndex("by_doc", (q: any) => q.eq("doc_id", docId)).first();
  if (row) {
    const doc = await ctx.db.get(docId);
    if (!doc) return;
    if (row.text.split("\n", 1)[0] === (doc.title ?? "") && row.workspace === (await resolveWorkspaceKey(ctx, doc))) return;
  }
  const head = await ctx.db.query("live_heads").withIndex("by_doc", (q: any) => q.eq("doc_id", docId)).first();
  if (head) await scheduleLiveSearch(ctx, head, docId);
}

export const reindex = internalMutation({
  args: { doc_id: v.id("docs") },
  handler: async (ctx, args) => {
    const head = await ctx.db.query("live_heads").withIndex("by_doc", (q: any) => q.eq("doc_id", args.doc_id)).first();
    if (head?.search_due) await ctx.db.patch(head._id, { search_due: undefined });
    const doc = await ctx.db.get(args.doc_id);
    const existing = await ctx.db.query("live_search").withIndex("by_doc", (q: any) => q.eq("doc_id", args.doc_id)).first();
    if (!doc || !isArtifactDocType(doc.doc_type)) {
      if (existing) await ctx.db.delete(existing._id);
      return;
    }
    const rows = await ctx.db
      .query("live_elements")
      .withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", args.doc_id).eq("layer", "main"))
      .take(INDEX_ROWS_MAX);
    const elements = rows.filter((r: any) => !r.deleted).map((r: any) => ({ ...(r.fields ?? {}), key: r.key, kind: r.kind, rev: r.rev }) as ArtifactElement);
    const fields = { workspace: await resolveWorkspaceKey(ctx, doc), text: artifactSearchText(doc.title ?? "", elements), at: Date.now() };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("live_search", { doc_id: args.doc_id, ...fields });
  },
});

/** Boards, sheets and dashboards whose words match, in the viewer's workspaces, best first. */
export const search = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const q = args.query.trim();
    if (!userId || q.length < 2) return [];
    const limit = Math.min(args.limit ?? 8, 20);
    const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (x: any) => x.eq("user_id", userId)).take(50);
    const keys = [`user:${userId}`, ...memberships.map((m: any) => `team:${m.team_id}`)];
    // Every workspace the viewer belongs to, each hit saying where it lives; most recently changed first across them.
    const out: Array<{ _id: string; title: string; doc_type: string; snippet: string; updated_at?: number; where: string }> = [];
    const seen = new Set<string>();
    const teamNames = new Map<string, string>();
    for (const m of memberships) {
      const t = await ctx.db.get(m.team_id);
      if (t) teamNames.set(`team:${m.team_id}`, (t as any).name ?? "Team");
    }
    for (const key of keys) {
      const hits = await ctx.db
        .query("live_search")
        .withSearchIndex("search_text", (s: any) => s.search("text", q).eq("workspace", key))
        .take(limit);
      for (const h of hits) {
        if (seen.has(String(h.doc_id))) continue;
        seen.add(String(h.doc_id));
        const doc = await ctx.db.get(h.doc_id);
        if (!doc || doc.archived_at || !isArtifactDocType(doc.doc_type)) continue;
        if (!(await canAccessDoc(ctx, userId, doc))) continue;
        out.push({ _id: String(doc._id), title: doc.title, doc_type: doc.doc_type, snippet: searchSnippet(h.text.slice(h.text.indexOf("\n") + 1), q), updated_at: doc.updated_at, where: teamNames.get(key) ?? "Personal" });
      }
    }
    // An artifact named for the words comes first, then the rest, each most recently changed first.
    const lq = q.toLowerCase();
    const named = (h: { title: string }) => (h.title.toLowerCase().includes(lq) ? 0 : 1);
    return out.sort((a, b) => named(a) - named(b) || (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, limit);
  },
});
