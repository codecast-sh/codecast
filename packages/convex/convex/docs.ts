import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";

function generatePlanShortId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "pl-";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function extractPlanInfo(content: string): { title: string; goal?: string } {
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const afterTitle = titleMatch ? content.slice(content.indexOf(titleMatch[0]) + titleMatch[0].length).trim() : content.trim();
  const firstPara = afterTitle.split(/\n\n/)[0]?.trim();
  const goal = firstPara && firstPara.length > 10 && !firstPara.startsWith("#") ? firstPara.slice(0, 500) : undefined;
  return { title, goal };
}

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    content: v.string(),
    doc_type: v.optional(v.string()),
    source: v.optional(v.string()),
    source_file: v.optional(v.string()),
    project_path: v.optional(v.string()),
    project_id: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const user = await ctx.db.get(auth.userId);
    const userTeamId = user?.active_team_id || user?.team_id;
    const now = Date.now();

    // Check for existing doc by source_file (for upsert on plan sync)
    if (args.source_file) {
      const existing = await ctx.db
        .query("docs")
        .withIndex("by_source_file", (q) => q.eq("source_file", args.source_file!))
        .first();
      if (existing && existing.user_id === auth.userId) {
        await ctx.db.patch(existing._id, {
          title: args.title,
          content: args.content,
          updated_at: now,
        });
        // Update linked plan entity if this is a plan doc
        if ((args.source || existing.source) === "plan_mode") {
          await syncDocToPlanEntity(ctx, existing._id, args.content, auth.userId, userTeamId, existing.project_id, existing.conversation_id);
        }
        return { id: existing._id, updated: true };
      }
    }

    let conversation_id = undefined;
    let team_id = userTeamId;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) {
        conversation_id = conv._id;
        team_id = (!conv.is_private || conv.auto_shared) ? conv.team_id : undefined;
      }
    }

    const id = await ctx.db.insert("docs", {
      user_id: auth.userId,
      team_id,
      title: args.title,
      content: args.content,
      doc_type: (args.doc_type || "note") as any,
      source: (args.source || "human") as any,
      source_file: args.source_file,
      project_path: args.project_path,
      project_id: args.project_id as any,
      conversation_id,
      labels: args.labels,
      created_at: now,
      updated_at: now,
    });

    // Auto-create plan entity for plan_mode docs
    let plan_short_id: string | undefined;
    if (args.source === "plan_mode") {
      plan_short_id = await syncDocToPlanEntity(ctx, id, args.content, auth.userId, team_id, args.project_id as any, conversation_id);
    }

    return { id, updated: false, plan_short_id };
  },
});

async function syncDocToPlanEntity(
  ctx: any,
  docId: Id<"docs">,
  content: string,
  userId: Id<"users">,
  teamId: any,
  projectId: any,
  conversationId: any,
): Promise<string | undefined> {
  const now = Date.now();
  const { title, goal } = extractPlanInfo(content);
  if (!title) return undefined;

  const doc = await ctx.db.get(docId);
  if (doc?.plan_id) {
    const plan = await ctx.db.get(doc.plan_id);
    if (plan) {
      await ctx.db.patch(plan._id, { title, goal, updated_at: now });
      if (conversationId && !plan.session_ids?.some((id: any) => String(id) === String(conversationId))) {
        await ctx.db.patch(plan._id, { session_ids: [...(plan.session_ids || []), conversationId] });
      }
      if (conversationId) {
        const conv = await ctx.db.get(conversationId);
        if (conv && !conv.active_plan_id) {
          await ctx.db.patch(conversationId, { active_plan_id: plan._id });
        }
      }
      return plan.short_id;
    }
  }

  const existingPlan = await ctx.db
    .query("plans")
    .withIndex("by_doc_id", (q: any) => q.eq("doc_id", docId))
    .first();
  if (existingPlan) {
    await ctx.db.patch(existingPlan._id, { title, goal, updated_at: now });
    if (!doc?.plan_id) await ctx.db.patch(docId, { plan_id: existingPlan._id });
    if (conversationId && !existingPlan.session_ids?.some((id: any) => String(id) === String(conversationId))) {
      await ctx.db.patch(existingPlan._id, { session_ids: [...(existingPlan.session_ids || []), conversationId] });
    }
    if (conversationId) {
      const conv = await ctx.db.get(conversationId);
      if (conv && !conv.active_plan_id) {
        await ctx.db.patch(conversationId, { active_plan_id: existingPlan._id });
      }
    }
    return existingPlan.short_id;
  }

  const short_id = generatePlanShortId();
  const planId = await ctx.db.insert("plans", {
    user_id: userId,
    team_id: teamId || undefined,
    project_id: projectId || undefined,
    short_id,
    title,
    goal,
    status: "active" as const,
    source: "plan_mode" as const,
    doc_id: docId,
    session_ids: conversationId ? [conversationId] : [],
    created_from_conversation_id: conversationId || undefined,
    created_at: now,
    updated_at: now,
  });
  await ctx.db.patch(docId, { plan_id: planId });
  if (conversationId) {
    const conv = await ctx.db.get(conversationId);
    if (conv) {
      await ctx.db.patch(conversationId, { active_plan_id: planId });
    }
  }
  return short_id;
}

export const list = query({
  args: {
    api_token: v.string(),
    doc_type: v.optional(v.string()),
    project_id: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    let docs;
    if (args.doc_type) {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_user_type", (q) =>
          q.eq("user_id", auth.userId).eq("doc_type", args.doc_type as any)
        )
        .collect();
    } else if (args.project_id) {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_user_id", (q) => q.eq("user_id", auth.userId))
        .collect();
    }

    // Exclude archived
    docs = docs.filter((d) => !d.archived_at);

    const limit = args.limit || 50;
    // Sort by updated_at desc
    docs.sort((a, b) => b.updated_at - a.updated_at);
    return docs.slice(0, limit);
  },
});

export const get = query({
  args: {
    api_token: v.string(),
    id: v.id("docs"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== auth.userId) return null;
    return doc;
  },
});

export const update = mutation({
  args: {
    api_token: v.string(),
    id: v.id("docs"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    doc_type: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),
    archived: v.optional(v.boolean()),
    project_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== auth.userId) throw new Error("Doc not found");

    const updates: any = { updated_at: Date.now() };
    if (args.title) updates.title = args.title;
    if (args.content) updates.content = args.content;
    if (args.doc_type) updates.doc_type = args.doc_type;
    if (args.labels) updates.labels = args.labels;
    if (args.pinned !== undefined) updates.pinned = args.pinned;
    if (args.archived !== undefined) updates.archived_at = args.archived ? Date.now() : undefined;
    if (args.project_id !== undefined) updates.project_id = args.project_id || undefined;

    await ctx.db.patch(args.id, updates);
    return { success: true };
  },
});

export const search = query({
  args: {
    api_token: v.string(),
    query: v.string(),
    doc_type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const results = await ctx.db
      .query("docs")
      .withSearchIndex("search_docs", (q) => {
        let search = q.search("title", args.query).eq("user_id", auth.userId);
        if (args.doc_type) search = search.eq("doc_type", args.doc_type as any);
        return search;
      })
      .take(args.limit || 20);

    return results.filter((d) => !d.archived_at);
  },
});

// --- Web-facing queries ---

export const webList = query({
  args: {
    doc_type: v.optional(v.string()),
    project_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
    scope: v.optional(v.string()),
    limit: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { docs: [], projectPaths: [] };

    const user = await ctx.db.get(userId);

    const CONFIG_DOC_NAMES = new Set(["README", "AGENTS", "CLAUDE", "CLAUDE.md", "AGENTS.md", "README.md"]);
    const isNoiseDoc = (d: any) => {
      if (CONFIG_DOC_NAMES.has(d.title)) return true;
      return false;
    };

    const extractPlanTitle = (d: any) => {
      if (d.source === "plan_mode" && d.content) {
        const match = d.content.match(/^#\s+(.+)/m);
        if (match) return { ...d, display_title: match[1].trim(), plan_name: d.title };
      }
      return d;
    };

    let docs;
    let projectPaths: string[] = [];

    const resolveConvTeamId = (d: any, convMap: Map<string, any>) => {
      const cid = d.conversation_id || (d.related_conversation_ids?.[0]);
      const conv = cid ? convMap.get(String(cid)) : undefined;
      if (conv) {
        return (!conv.is_private || conv.auto_shared) ? conv.team_id : undefined;
      }
      return d.team_id;
    };

    const queryLimit = args.limit || 100;
    const fetchLimit = queryLimit * 3;

    // Workspace-scoped fetching
    let userDocs: any[];
    let teamDocs: any[] = [];
    const resolvedTeamId = args.workspace === "team" && args.team_id
      ? args.team_id
      : !args.workspace ? (user?.active_team_id || (user as any)?.team_id) : undefined;

    if (args.workspace === "team" && args.team_id) {
      teamDocs = await ctx.db
        .query("docs")
        .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id!))
        .order("desc")
        .take(fetchLimit);
      userDocs = [];
    } else if (args.workspace === "personal") {
      userDocs = await ctx.db
        .query("docs")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .order("desc")
        .take(fetchLimit);
      teamDocs = [];
    } else {
      // Backwards compat: no workspace arg = merge user + team docs
      userDocs = await ctx.db
        .query("docs")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .order("desc")
        .take(fetchLimit);
      if (resolvedTeamId) {
        teamDocs = await ctx.db
          .query("docs")
          .withIndex("by_team_id", (q) => q.eq("team_id", resolvedTeamId))
          .order("desc")
          .take(fetchLimit);
      }
    }

    const seen = new Set<string>();
    const allDocs = [];
    for (const d of userDocs) { seen.add(String(d._id)); allDocs.push(d); }
    for (const td of teamDocs) {
      if (!seen.has(String(td._id))) allDocs.push(td);
    }

    const allConvIds = new Set<string>();
    for (const d of allDocs) {
      const cid = d.conversation_id || (d.related_conversation_ids?.[0]);
      if (cid) allConvIds.add(String(cid));
    }
    const convMap = new Map<string, any>();
    for (const cid of allConvIds) {
      const conv = await ctx.db.get(cid as Id<"conversations">);
      if (conv) convMap.set(cid, conv);
    }

    if (args.scope === "projects" || args.project_path) {
      const baseDocs = userDocs.length > 0 ? userDocs : allDocs;
      if (args.scope === "projects") {
        docs = baseDocs.filter((d) => {
          const effectiveTeamId = resolveConvTeamId(d, convMap);
          return !effectiveTeamId;
        });
        if (args.project_path) {
          docs = docs.filter((d) => d.project_path?.includes(args.project_path!));
        }
      } else {
        docs = baseDocs.filter((d) => d.project_path?.includes(args.project_path!));
      }
      const unscopedDocs = baseDocs.filter((d) => {
        const effectiveTeamId = resolveConvTeamId(d, convMap);
        return !effectiveTeamId && !d.archived_at && !isNoiseDoc(d);
      });
      projectPaths = [...new Set(unscopedDocs.map((d) => d.project_path).filter(Boolean))] as string[];
    } else if (args.workspace === "team" && args.team_id) {
      docs = allDocs;
    } else if (args.workspace === "personal") {
      docs = allDocs.filter((d) => {
        const effectiveTeamId = resolveConvTeamId(d, convMap);
        return !effectiveTeamId;
      });
    } else if (resolvedTeamId) {
      docs = allDocs.filter((d) => {
        const effectiveTeamId = resolveConvTeamId(d, convMap);
        return String(effectiveTeamId) === String(resolvedTeamId);
      });
    } else {
      docs = allDocs.filter((d) => {
        const effectiveTeamId = resolveConvTeamId(d, convMap);
        return !effectiveTeamId;
      });
    }

    if (args.doc_type) {
      docs = docs.filter((d) => d.doc_type === args.doc_type);
    }

    docs = docs.filter((d) => !d.archived_at && !isNoiseDoc(d) && d.source !== "plan_mode");

    const enriched = docs.map((d) => {
      const cid = d.conversation_id || (d.related_conversation_ids?.[0]);
      const conv = cid ? convMap.get(String(cid)) : undefined;
      if (conv?.started_at) return { ...d, originated_at: conv.started_at };
      return d;
    });

    enriched.sort((a: any, b: any) => (b.originated_at || b.created_at) - (a.originated_at || a.created_at));
    const result = enriched.slice(0, queryLimit);

    // Batch-load user profiles for author attribution
    const userIds = new Set<string>();
    for (const d of result) {
      if (d.user_id) userIds.add(String(d.user_id));
    }
    const userMap = new Map<string, { name?: string; image?: string }>();
    for (const uid of userIds) {
      const u = await ctx.db.get(uid as Id<"users">);
      if (u) userMap.set(uid, { name: u.name, image: u.image || (u as any).github_avatar_url });
    }

    const withAuthors = result.map(extractPlanTitle).map((d: any) => {
      const author = d.user_id ? userMap.get(String(d.user_id)) : undefined;
      if (author) return { ...d, author_name: author.name, author_image: author.image };
      return d;
    });

    return { docs: withAuthors, projectPaths };
  },
});

export const webGet = query({
  args: {
    id: v.id("docs"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== userId) return null;

    const result: any = { ...doc };

    if (doc.source === "plan_mode" && doc.content) {
      const match = doc.content.match(/^#\s+(.+)/m);
      if (match) {
        result.display_title = match[1].trim();
        result.plan_name = doc.title;
      }
    }

    // Load related conversations
    const convIds = doc.related_conversation_ids || (doc.conversation_id ? [doc.conversation_id] : []);
    if (convIds.length > 0) {
      const convs = [];
      for (const cid of convIds) {
        const conv = await ctx.db.get(cid);
        if (conv) convs.push({
          _id: conv._id,
          session_id: conv.session_id,
          title: conv.title,
          project_path: conv.project_path,
          started_at: conv.started_at,
          updated_at: conv.updated_at,
          message_count: conv.message_count,
          short_id: conv.short_id,
        });
      }
      result.related_conversations = convs;
    }

    // Resolve plan from conversation's active_plan_id
    if (doc.conversation_id) {
      const conv = await ctx.db.get(doc.conversation_id);
      if (conv?.active_plan_id) {
        const plan = await ctx.db.get(conv.active_plan_id);
        if (plan) result.active_plan = { _id: plan._id, short_id: plan.short_id, title: plan.title, status: plan.status };
      }
    }

    return result;
  },
});

export const webSearch = query({
  args: {
    query: v.string(),
    doc_type: v.optional(v.string()),
    limit: v.optional(v.number()),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id || (user as any)?.team_id;

    const results = await ctx.db
      .query("docs")
      .withSearchIndex("search_docs", (q) => {
        let search = q.search("title", args.query).eq("user_id", userId);
        if (args.doc_type) search = search.eq("doc_type", args.doc_type as any);
        return search;
      })
      .take((args.limit || 20) * 3);

    let filtered = results.filter((d) => !d.archived_at);

    const convIds = new Set<string>();
    for (const d of filtered) {
      const cid = d.conversation_id || (d.related_conversation_ids?.[0]);
      if (cid) convIds.add(String(cid));
    }
    const convMap = new Map<string, any>();
    for (const cid of convIds) {
      const conv = await ctx.db.get(cid as Id<"conversations">);
      if (conv) convMap.set(cid, conv);
    }

    const resolveTeam = (d: any) => {
      const cid = d.conversation_id || (d.related_conversation_ids?.[0]);
      const conv = cid ? convMap.get(String(cid)) : undefined;
      if (conv) return (!conv.is_private || conv.auto_shared) ? conv.team_id : undefined;
      return d.team_id;
    };

    if (args.scope === "projects") {
      filtered = filtered.filter((d) => !resolveTeam(d));
    } else if (team_id) {
      filtered = filtered.filter((d) => {
        const effectiveTeamId = resolveTeam(d);
        return String(effectiveTeamId) === String(team_id);
      });
    }

    return filtered.slice(0, args.limit || 20);
  },
});

export const webUpdate = mutation({
  args: {
    id: v.id("docs"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    doc_type: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== userId) throw new Error("Doc not found");

    const updates: any = { updated_at: Date.now() };
    if (args.title) updates.title = args.title;
    if (args.content) updates.content = args.content;
    if (args.doc_type) updates.doc_type = args.doc_type;
    if (args.labels) updates.labels = args.labels;
    if (args.pinned !== undefined) updates.pinned = args.pinned;
    if (args.archived !== undefined) updates.archived_at = args.archived ? Date.now() : undefined;

    await ctx.db.patch(args.id, updates);
    return { success: true };
  },
});

export const deleteBySource = internalMutation({
  args: {
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const docs = await ctx.db.query("docs").collect();
    const toDelete = docs.filter((d) => d.source === args.source);
    for (const doc of toDelete) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: toDelete.length };
  },
});

export const debugList = internalQuery({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("docs").collect();
    const bySource: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byTeam: Record<string, number> = {};
    const samples: Array<{ title: string; source: string; doc_type: string }> = [];
    for (const d of docs) {
      bySource[d.source] = (bySource[d.source] || 0) + 1;
      byType[d.doc_type] = (byType[d.doc_type] || 0) + 1;
      byTeam[d.team_id ? String(d.team_id) : "none"] = (byTeam[d.team_id ? String(d.team_id) : "none"] || 0) + 1;
      if (d.source === "inline_extract" && samples.length < 10) {
        let title = d.title;
        if (d.content) {
          const m = d.content.match(/^#\s+(.+)/m);
          if (m) title = m[1].trim();
        }
        samples.push({ title: title.slice(0, 80), source: d.source, doc_type: d.doc_type });
      }
    }
    return { total: docs.length, bySource, byType, byTeam, inlineSamples: samples };
  },
});

export const fixDocTeamsByProject = internalMutation({
  args: {
    teamPatterns: v.array(v.object({
      team_id: v.string(),
      patterns: v.array(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const docs = await ctx.db.query("docs").collect();
    let updated = 0;
    for (const doc of docs) {
      if (!doc.project_path) continue;
      let matchedTeam: string | undefined;
      for (const { team_id, patterns } of args.teamPatterns) {
        if (patterns.some((p) => doc.project_path!.includes(p))) {
          matchedTeam = team_id;
          break;
        }
      }
      if (matchedTeam && doc.team_id !== matchedTeam) {
        await ctx.db.patch(doc._id, { team_id: matchedTeam as any });
        updated++;
      } else if (!matchedTeam && doc.team_id) {
        await ctx.db.patch(doc._id, { team_id: undefined });
        updated++;
      }
    }
    return { updated, total: docs.length };
  },
});

export const backfillPlanDocs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query("docs")
      .collect();
    const planDocs = docs.filter(d => d.source === "plan_mode" && !d.plan_id);
    let created = 0;
    for (const doc of planDocs) {
      await syncDocToPlanEntity(ctx, doc._id, doc.content, doc.user_id, doc.team_id, doc.project_id, doc.conversation_id);
      created++;
    }
    return { created, total: planDocs.length };
  },
});

export const fixDocTeams = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("docs").collect();
    let updated = 0;
    for (const doc of docs) {
      const convIds = doc.related_conversation_ids || (doc.conversation_id ? [doc.conversation_id] : []);
      if (convIds.length === 0) continue;

      const conv = await ctx.db.get(convIds[0]);
      if (!conv) continue;

      const patch: any = {};
      // Team comes from the originating session
      if (conv.team_id && doc.team_id !== conv.team_id) {
        patch.team_id = conv.team_id;
      }
      if (!doc.project_path && conv.project_path) {
        patch.project_path = conv.project_path;
      }
      if (Object.keys(patch).length === 0) continue;
      await ctx.db.patch(doc._id, patch);
      updated++;
    }
    return { updated, total: docs.length };
  },
});

export const linkPlanToSessions = internalMutation({
  args: {
    mappings: v.array(v.object({
      plan_name: v.string(),
      session_ids: v.array(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    let updated = 0;
    for (const { plan_name, session_ids } of args.mappings) {
      const sourceFile = `/Users/ashot/.claude/plans/${plan_name}.md`;
      const doc = await ctx.db
        .query("docs")
        .withIndex("by_source_file", (q) => q.eq("source_file", sourceFile))
        .first();
      if (!doc) continue;

      const convIds = [];
      let firstConv: any = null;
      for (const sid of session_ids) {
        const conv = await ctx.db
          .query("conversations")
          .withIndex("by_session_id", (q) => q.eq("session_id", sid))
          .first();
        if (conv) {
          convIds.push(conv._id);
          if (!firstConv) firstConv = conv;
        }
      }
      if (convIds.length === 0) continue;

      const patch: any = {
        related_conversation_ids: convIds,
        updated_at: Date.now(),
      };
      if (!doc.conversation_id) {
        patch.conversation_id = convIds[0];
      }
      if (!doc.project_path && firstConv?.project_path) {
        patch.project_path = firstConv.project_path;
      }
      await ctx.db.patch(doc._id, patch);
      updated++;

      // Propagate session links to plan entity and set active_plan_id on conversations
      if (doc.plan_id) {
        const plan = await ctx.db.get(doc.plan_id);
        if (plan) {
          const existingIds = new Set((plan.session_ids || []).map((id: any) => String(id)));
          const newIds = convIds.filter((id: any) => !existingIds.has(String(id)));
          if (newIds.length > 0) {
            await ctx.db.patch(plan._id, {
              session_ids: [...(plan.session_ids || []), ...newIds],
              updated_at: Date.now(),
            });
          }
          for (const cid of convIds) {
            const conv = await ctx.db.get(cid);
            if (conv && !conv.active_plan_id) {
              await ctx.db.patch(cid, { active_plan_id: plan._id });
            }
          }
        }
      }
    }
    return { updated };
  },
});
