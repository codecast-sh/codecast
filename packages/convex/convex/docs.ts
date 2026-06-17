import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./functions";
import { Id, type Doc } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext, scopedFetch, resolveEffectiveTeam } from "./data";
import { resolveTeamForPath, isTeamMember, createTeamFeedFilter } from "./privacy";
// Owner-or-team access check for a doc. Moved to lib/access.ts (Wave-1 auth/access
// seam). Imported for local use here and re-exported below so the web mutation
// and the dispatch side-effect still enforce one rule, not two.
import { canAccessDoc } from "./lib/access";
import { packSnapshotContent } from "./lib/docSnapshot";
export { canAccessDoc };

function generatePlanShortId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "pl-";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function normalizeToRoot(path: string): string {
  const parts = path.split('/');
  const srcIndex = parts.findIndex(p => p === 'src' || p === 'projects' || p === 'repos' || p === 'code');
  if (srcIndex >= 0 && srcIndex < parts.length - 1) {
    return parts.slice(0, srcIndex + 2).join('/');
  }
  return path;
}

function repoName(path: string): string {
  return normalizeToRoot(path).split('/').filter(Boolean).pop() || path;
}

function docGitRoot(d: any, convMap: Map<string, any>): string | null {
  const cid = d.conversation_id || d.related_conversation_ids?.[0];
  if (cid) {
    const conv = convMap.get(String(cid));
    if (conv?.git_root) return conv.git_root;
  }
  return null;
}

function dedupeProjectPaths(paths: string[], docs?: any[], convMap?: Map<string, any>): string[] {
  const gitRootForPath = new Map<string, string>();
  if (docs && convMap) {
    for (const d of docs) {
      if (!d.project_path) continue;
      const root = docGitRoot(d, convMap);
      if (root) gitRootForPath.set(d.project_path, root);
    }
  }

  const byName = new Map<string, string>();
  for (const path of paths) {
    const root = gitRootForPath.get(path) || normalizeToRoot(path);
    const name = root.split('/').filter(Boolean).pop() || path;
    const existing = byName.get(name);
    if (!existing || (path.includes('/src/') && !existing.includes('/src/'))) {
      byName.set(name, path);
    }
  }
  return Array.from(byName.values());
}

function docRepoName(d: any, convMap: Map<string, any>): string {
  const root = docGitRoot(d, convMap);
  if (root) return root.split('/').filter(Boolean).pop() || root;
  return d.project_path ? repoName(d.project_path) : "";
}


function isNoiseDocForWeb(d: any): boolean {
  const CONFIG_DOC_NAMES = new Set(["README", "AGENTS", "CLAUDE", "CLAUDE.md", "AGENTS.md", "README.md"]);
  return CONFIG_DOC_NAMES.has(d.title);
}

function extractPlanTitleForWeb(d: any) {
  if (d.source === "plan_mode" && d.content) {
    const match = d.content.match(/^#\s+(.+)/m);
    if (match) return { ...d, display_title: match[1].trim(), plan_name: d.title };
  }
  return d;
}

export type WebDocRelatedConversation = {
  _id: Id<"conversations">;
  session_id: string;
  title?: string;
  project_path?: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  short_id?: string;
};

export type WebDocActivePlan = {
  _id: Id<"plans">;
  short_id: string;
  title: string;
  status: string;
};

export type WebDocDetail = Doc<"docs"> & {
  display_title?: string;
  plan_name?: string;
  related_conversations?: WebDocRelatedConversation[];
  active_plan?: WebDocActivePlan;
};

export function isWebDocOwner(doc: Doc<"docs"> | null | undefined, userId: Id<"users">): doc is Doc<"docs"> {
  return !!doc && doc.user_id === userId;
}

export function mapWebDocDetail(input: {
  doc: Doc<"docs">;
  relatedConversations?: WebDocRelatedConversation[];
  activePlan?: WebDocActivePlan;
}): WebDocDetail {
  const result: WebDocDetail = { ...input.doc };

  if (input.doc.source === "plan_mode" && input.doc.content) {
    const match = input.doc.content.match(/^#\s+(.+)/m);
    if (match) {
      result.display_title = match[1].trim();
      result.plan_name = input.doc.title;
    }
  }

  if (input.relatedConversations && input.relatedConversations.length > 0) {
    result.related_conversations = input.relatedConversations;
  }

  if (input.activePlan) {
    result.active_plan = input.activePlan;
  }

  return result;
}

async function buildWebDocList(
  ctx: any,
  args: {
    doc_type?: string;
    project_id?: string;
    project_path?: string;
    scope?: string;
    team_id?: Id<"teams">;
    workspace?: "personal" | "team" | "all";
  },
  requestedCount?: number
) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return { docs: [], projectPaths: [] };

  const user = await ctx.db.get(userId);
  const resolvedTeamId = args.workspace === "team" && args.team_id
    ? args.team_id
    : !args.workspace ? user?.active_team_id : undefined;
  const effectiveWorkspace = args.scope === "projects"
    ? "personal" as const
    : args.workspace;

  const { records: rawDocs, convMap } = await scopedFetch(ctx, "docs", {
    userId,
    teamId: resolvedTeamId,
    workspace: effectiveWorkspace,
    limit: requestedCount,
    stripFields: ["content", "embedding", "entries"],
  });

  let docs: any[];
  let projectPaths: string[] = [];

  if (args.scope === "projects" || args.project_path) {
    if (args.scope === "projects") {
      docs = rawDocs;
      if (args.project_path) {
        const filterName = repoName(args.project_path);
        docs = docs.filter((d) => d.project_path && docRepoName(d, convMap) === filterName);
      }
    } else {
      const filterName = repoName(args.project_path!);
      docs = rawDocs.filter((d) => d.project_path && docRepoName(d, convMap) === filterName);
    }
    const unscopedDocs = rawDocs.filter((d) => !d.archived_at && !isNoiseDocForWeb(d));
    projectPaths = dedupeProjectPaths([...new Set(unscopedDocs.map((d) => d.project_path).filter(Boolean))] as string[], unscopedDocs, convMap);
  } else {
    docs = rawDocs;
  }

  // No server-side doc_type filter — all filtering is client-side.
  docs = docs.filter((d) => !d.archived_at && !isNoiseDocForWeb(d) && d.source !== "plan_mode");

  if (!projectPaths.length) {
    projectPaths = dedupeProjectPaths([...new Set(docs.map((d) => d.project_path).filter(Boolean))] as string[], docs, convMap);
  }

  const enriched = docs.map((d) => {
    const cid = d.conversation_id || (d.related_conversation_ids?.[0]);
    const conv = cid ? convMap.get(String(cid)) : undefined;
    if (conv?.started_at) return { ...d, originated_at: conv.started_at };
    return d;
  });

  enriched.sort((a: any, b: any) => (b.originated_at || b.created_at) - (a.originated_at || a.created_at));

  const userIds = new Set<string>();
  for (const d of enriched) {
    if (d.user_id) userIds.add(String(d.user_id));
  }
  const userMap = new Map<string, { name?: string; image?: string; github_username?: string }>();
  for (const uid of userIds) {
    const u = await ctx.db.get(uid as Id<"users">);
    if (u) userMap.set(uid, { name: u.name, image: u.image || (u as any).github_avatar_url, github_username: (u as any).github_username });
  }

  const planIds = new Set<string>();
  const docIdsNeedingPlan: string[] = [];
  for (const d of enriched) {
    if (d.plan_id) planIds.add(String(d.plan_id));
    else if (d.doc_type === "plan") docIdsNeedingPlan.push(d._id as string);
  }
  const planMap = new Map<string, { short_id: string; status: string }>();
  for (const pid of planIds) {
    const p = await ctx.db.get(pid as Id<"plans">);
    if (p) planMap.set(pid, { short_id: (p as any).short_id, status: (p as any).status });
  }
  const docToPlanMap = new Map<string, { short_id: string; status: string }>();
  for (const docId of docIdsNeedingPlan) {
    const p = await ctx.db.query("plans").withIndex("by_doc_id", (q: any) => q.eq("doc_id", docId)).first();
    if (p) {
      docToPlanMap.set(docId, { short_id: p.short_id, status: p.status as string });
    }
  }

  const withAuthors = enriched.map(extractPlanTitleForWeb).map((d: any) => {
    const author = d.user_id ? userMap.get(String(d.user_id)) : undefined;
    const plan = d.plan_id ? planMap.get(String(d.plan_id)) : (docToPlanMap.get(d._id as string) || undefined);
    return {
      ...d,
      ...(author ? { author_name: author.name, author_image: author.image, author_username: author.github_username } : {}),
      ...(plan ? { plan_short_id: plan.short_id, plan_status: plan.status } : {}),
    };
  });

  return { docs: withAuthors, projectPaths };
}

type DocNode = { type: string; attrs?: Record<string, any>; content?: DocNode[]; text?: string };

function markdownToDoc(text: string): DocNode {
  const lines = text.split("\n");
  const content: DocNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const node: DocNode = { type: "codeBlock" };
      if (lang) node.attrs = { language: lang };
      if (codeLines.length > 0) node.content = [{ type: "text", text: codeLines.join("\n") }];
      content.push(node);
      continue;
    }

    if (/^---+$/.test(line.trim())) { content.push({ type: "horizontalRule" }); i++; continue; }

    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      content.push({ type: "heading", attrs: { level: hm[1].length }, content: [{ type: "text", text: hm[2] }] });
      i++;
      continue;
    }

    if (line.startsWith("> ")) {
      const ql: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) { ql.push(lines[i].slice(2)); i++; }
      content.push({ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: ql.join("\n") }] }] });
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      const items: DocNode[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: lines[i].replace(/^[-*]\s/, "") }] }] });
        i++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    if (line.trim() === "") { i++; continue; }

    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" &&
           !lines[i].startsWith("#") && !lines[i].startsWith("```") &&
           !lines[i].startsWith("> ") && !/^[-*]\s/.test(lines[i]) &&
           !/^---+$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    const pc: DocNode[] = [];
    paraLines.forEach((pl, idx) => {
      if (idx > 0) pc.push({ type: "hardBreak" });
      pc.push({ type: "text", text: pl });
    });
    if (pc.length > 0) content.push({ type: "paragraph", content: pc });
  }

  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "doc", content };
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

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });
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
        const userTeamId = db.workspace.type === "team" ? db.workspace.teamId : undefined;
        if ((args.source || existing.source) === "plan_mode") {
          await syncDocToPlanEntity(ctx, existing._id, args.content, auth.userId, userTeamId, existing.project_id, existing.conversation_id);
        }
        return { id: existing._id, updated: true };
      }
    }

    let conversation_id = undefined;
    let team_id = db.workspace.type === "team" ? db.workspace.teamId : undefined;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) {
        conversation_id = conv._id;
        if (!team_id) {
          const shared = !conv.is_private || conv.auto_shared
            || (conv.team_visibility && conv.team_visibility !== "private");
          team_id = shared ? conv.team_id : undefined;
        }
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
          const planIds = (conv as any).plan_ids || [];
          if (!planIds.some((pid: any) => pid.toString() === plan._id.toString())) {
            planIds.push(plan._id);
          }
          await ctx.db.patch(conversationId, { active_plan_id: plan._id, plan_ids: planIds });
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
        const planIds = (conv as any).plan_ids || [];
        if (!planIds.some((pid: any) => pid.toString() === existingPlan._id.toString())) {
          planIds.push(existingPlan._id);
        }
        await ctx.db.patch(conversationId, { active_plan_id: existingPlan._id, plan_ids: planIds });
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
      const planIds = (conv as any).plan_ids || [];
      planIds.push(planId);
      await ctx.db.patch(conversationId, { active_plan_id: planId, plan_ids: planIds });
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
    if (args.content !== undefined) updates.content = args.content;
    if (args.doc_type) updates.doc_type = args.doc_type;
    if (args.labels) updates.labels = args.labels;
    if (args.pinned !== undefined) updates.pinned = args.pinned;
    if (args.archived !== undefined) updates.archived_at = args.archived ? Date.now() : undefined;
    if (args.project_id !== undefined) updates.project_id = args.project_id || undefined;

    await ctx.db.patch(args.id, updates);

    // sync state reset is handled by docs.resetSync called from the HTTP route

    return { success: true };
  },
});

export const addComment = mutation({
  args: {
    api_token: v.string(),
    id: v.id("docs"),
    content: v.string(),
    type: v.optional(v.string()),
    rationale: v.optional(v.string()),
    path_or_url: v.optional(v.string()),
    session_id: v.optional(v.string()),
    author: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== auth.userId) throw new Error("Doc not found");

    const entries = (doc as any).entries || [];
    const entry: Record<string, any> = {
      type: args.type || "note",
      timestamp: Date.now(),
      content: args.content,
    };
    if (args.session_id) entry.session_id = args.session_id;
    if (args.author) entry.author = args.author;
    if (args.rationale) entry.rationale = args.rationale;
    if (args.path_or_url) entry.path_or_url = args.path_or_url;

    entries.push(entry);
    await ctx.db.patch(args.id, { entries, updated_at: Date.now() } as any);
    return { success: true };
  },
});

export const resetSync = mutation({
  args: {
    api_token: v.string(),
    id: v.id("docs"),
    content: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const docId = args.id as string;
    const snapshots = await ctx.db
      .query("doc_snapshots")
      .withIndex("id_version", (q: any) => q.eq("id", docId))
      .collect();
    const deltas = await ctx.db
      .query("doc_deltas")
      .withIndex("id_version", (q: any) => q.eq("id", docId))
      .collect();
    for (const d of deltas) await ctx.db.delete(d._id);

    const json = JSON.stringify(markdownToDoc(args.content || ""));

    if (snapshots.length > 0) {
      const latest = snapshots.reduce((a: any, b: any) => a.version > b.version ? a : b);
      // Write the compressed form and drop any legacy uncompressed content so the
      // row carries exactly one representation (see doc_snapshots in schema.ts).
      await ctx.db.patch(latest._id, {
        content_gz: packSnapshotContent(json),
        content: undefined,
        version: latest.version + 1,
      });
      for (const s of snapshots) {
        if (s._id !== latest._id) await ctx.db.delete(s._id);
      }
    } else {
      await ctx.db.insert("doc_snapshots", { id: docId, version: 1, content_gz: packSnapshotContent(json) });
    }
    await ctx.db.patch(args.id, { cli_edited_at: Date.now() });
    return { success: true };
  },
});

export const patch = mutation({
  args: {
    api_token: v.string(),
    id: v.id("docs"),
    old_string: v.string(),
    new_string: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== auth.userId) throw new Error("Doc not found");

    const content = doc.content || "";
    const idx = content.indexOf(args.old_string);
    if (idx === -1) throw new Error("old_string not found in document content");

    const newContent = content.slice(0, idx) + args.new_string + content.slice(idx + args.old_string.length);
    const now = Date.now();
    await ctx.db.patch(args.id, { content: newContent, updated_at: now, cli_edited_at: now });

    if (doc.plan_id) {
      const plan = await ctx.db.get(doc.plan_id);
      if (plan) {
        const { title, goal } = extractPlanInfo(newContent);
        if (title) await ctx.db.patch(plan._id, { title, goal, updated_at: Date.now() });
      }
    }

    return { success: true, length: newContent.length, content: newContent };
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
      .withSearchIndex("search_docs_v2", (q) => {
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
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"), v.literal("all"))),
  },
  handler: async (ctx, args) => {
    const fetchCount = args.limit || undefined;
    const { docs, projectPaths } = await buildWebDocList(ctx, args, fetchCount);
    return { docs, projectPaths };
  },
});

// Cursor format: JSON-encoded { phase, inner } where phase is "primary" or
// "orphans" and inner is the Convex paginate cursor for that phase. Two-phase
// pagination lets team view stream team-tagged records first, then the
// viewer's untagged orphans, without merging both streams in one handler.
// Long-term: heavy fields (content/embedding/entries) should move to a
// sibling doc_contents table so list queries never pay their memory cost.
type WebDocsCursor = { phase: "primary" | "orphans"; inner: string | null };

function parseCursor(cursor: string | null): WebDocsCursor {
  if (!cursor) return { phase: "primary", inner: null };
  try {
    const parsed = JSON.parse(cursor);
    if (parsed?.phase === "primary" || parsed?.phase === "orphans") {
      return { phase: parsed.phase, inner: typeof parsed.inner === "string" ? parsed.inner : null };
    }
  } catch {}
  return { phase: "primary", inner: null };
}

function encodeCursor(c: WebDocsCursor): string {
  return JSON.stringify(c);
}

function stripDoc(d: any): any {
  const { content, embedding, entries, ...rest } = d;
  return rest;
}

async function buildConvMapForPage(ctx: any, records: any[]): Promise<Map<string, any>> {
  const convIds = new Set<string>();
  for (const r of records) {
    const cid = r.conversation_id || r.created_from_conversation || r.related_conversation_ids?.[0] || r.conversation_ids?.[0];
    if (cid) convIds.add(String(cid));
  }
  const convMap = new Map<string, any>();
  for (const cid of convIds) {
    const conv = await ctx.db.get(cid as any);
    if (conv) convMap.set(cid, {
      team_id: conv.team_id,
      is_private: conv.is_private,
      auto_shared: conv.auto_shared,
      team_visibility: conv.team_visibility,
      git_root: conv.git_root,
      started_at: conv.started_at,
      project_path: conv.project_path,
    });
  }
  return convMap;
}

async function enrichPage(
  ctx: any,
  records: any[],
  convMap: Map<string, any>,
  args: { doc_type?: string; project_id?: string; project_path?: string; scope?: string },
): Promise<any[]> {
  let docs = records;

  if (args.scope === "projects" || args.project_path) {
    if (args.project_path) {
      const filterName = repoName(args.project_path);
      docs = docs.filter((d) => d.project_path && docRepoName(d, convMap) === filterName);
    }
  }

  docs = docs.filter((d) => !d.archived_at && !isNoiseDocForWeb(d) && d.source !== "plan_mode");

  const enriched = docs.map((d) => {
    const cid = d.conversation_id || (d.related_conversation_ids?.[0]);
    const conv = cid ? convMap.get(String(cid)) : undefined;
    if (conv?.started_at) return { ...d, originated_at: conv.started_at };
    return d;
  });
  enriched.sort((a: any, b: any) => (b.originated_at || b.created_at) - (a.originated_at || a.created_at));

  const userIds = new Set<string>();
  for (const d of enriched) if (d.user_id) userIds.add(String(d.user_id));
  const userMap = new Map<string, any>();
  for (const uid of userIds) {
    const u = await ctx.db.get(uid as Id<"users">);
    if (u) userMap.set(uid, { name: u.name, image: u.image || (u as any).github_avatar_url, github_username: (u as any).github_username });
  }

  const planIds = new Set<string>();
  const docIdsNeedingPlan: string[] = [];
  for (const d of enriched) {
    if (d.plan_id) planIds.add(String(d.plan_id));
    else if (d.doc_type === "plan") docIdsNeedingPlan.push(d._id as string);
  }
  const planMap = new Map<string, { short_id: string; status: string }>();
  for (const pid of planIds) {
    const p = await ctx.db.get(pid as Id<"plans">);
    if (p) planMap.set(pid, { short_id: (p as any).short_id, status: (p as any).status });
  }
  const docToPlanMap = new Map<string, { short_id: string; status: string }>();
  for (const docId of docIdsNeedingPlan) {
    const p = await ctx.db.query("plans").withIndex("by_doc_id", (q: any) => q.eq("doc_id", docId)).first();
    if (p) docToPlanMap.set(docId, { short_id: p.short_id, status: p.status as string });
  }

  return enriched.map(extractPlanTitleForWeb).map((d: any) => {
    const author = d.user_id ? userMap.get(String(d.user_id)) : undefined;
    const plan = d.plan_id ? planMap.get(String(d.plan_id)) : (docToPlanMap.get(d._id as string) || undefined);
    return {
      ...d,
      ...(author ? { author_name: author.name, author_image: author.image, author_username: author.github_username } : {}),
      ...(plan ? { plan_short_id: plan.short_id, plan_status: plan.status } : {}),
    };
  });
}

// Change-feed batch fetch: current state for a set of doc ids the user can
// access (own or team). Decorates like enrichPage (display_title via
// extractPlanTitleForWeb, author + plan badges) but DELIBERATELY skips
// enrichPage's presentation filters: catch-up must deliver an archived doc WITH
// archived_at set (so the client hides it) and plan-docs too, rather than
// dropping them. Inaccessible / gone ids are omitted; the feed drives the prune.
// See changeFeed.ts.
export const webGetByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { docs: [] };
    const rows: any[] = [];
    for (const raw of args.ids.slice(0, 300)) {
      const id = ctx.db.normalizeId("docs", raw);
      if (!id) continue;
      const doc = await ctx.db.get(id);
      if (!doc || !(await canAccessDoc(ctx, userId, doc))) continue;
      rows.push(doc);
    }
    const userMap = new Map<string, any>();
    for (const d of rows) {
      const uid = d.user_id ? String(d.user_id) : null;
      if (!uid || userMap.has(uid)) continue;
      const u = await ctx.db.get(uid as Id<"users">);
      if (u) userMap.set(uid, { name: u.name, image: u.image || (u as any).github_avatar_url, github_username: (u as any).github_username });
    }
    const planMap = new Map<string, { short_id: string; status: string }>();
    const docToPlan = new Map<string, { short_id: string; status: string }>();
    for (const d of rows) {
      if (d.plan_id) {
        const p = await ctx.db.get(d.plan_id as Id<"plans">);
        if (p) planMap.set(String(d.plan_id), { short_id: (p as any).short_id, status: (p as any).status });
      } else if (d.doc_type === "plan") {
        const p = await ctx.db.query("plans").withIndex("by_doc_id", (q: any) => q.eq("doc_id", d._id as string)).first();
        if (p) docToPlan.set(d._id as string, { short_id: p.short_id, status: p.status as string });
      }
    }
    const docs = rows.map(extractPlanTitleForWeb).map((d: any) => {
      const author = d.user_id ? userMap.get(String(d.user_id)) : undefined;
      const plan = d.plan_id ? planMap.get(String(d.plan_id)) : docToPlan.get(d._id as string);
      return {
        ...d,
        ...(author ? { author_name: author.name, author_image: author.image, author_username: author.github_username } : {}),
        ...(plan ? { plan_short_id: plan.short_id, plan_status: plan.status } : {}),
      };
    });
    return { docs };
  },
});

export const webListPaginated = query({
  args: {
    doc_type: v.optional(v.string()),
    project_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
    scope: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };

    // Only read the (hot, heartbeat-churned) user doc when we actually need its
    // active_team_id — i.e. when the caller didn't pin a workspace. Reading it
    // unconditionally made this subscription invalidate on every daemon heartbeat.
    let resolvedTeamId: typeof args.team_id | undefined;
    if (args.workspace === "team" && args.team_id) {
      resolvedTeamId = args.team_id;
    } else if (!args.workspace) {
      const user = await ctx.db.get(userId);
      resolvedTeamId = user?.active_team_id;
    } else {
      resolvedTeamId = undefined;
    }
    const effectiveWorkspace = args.scope === "projects"
      ? "personal" as const
      : args.workspace;
    const isTeamView = !!resolvedTeamId && (effectiveWorkspace === "team" || !effectiveWorkspace);

    // Defensive clamp: Convex returns full documents from storage before our
    // strip step runs, so a single page that includes a doc with multi-MB
    // content/entries can blow the 64MB query memory cap. Originally 100 —
    // lowered to 30 after observing TooMuchMemoryCarryOver on this UDF
    // (2026-05-13), then tightened to 12. Confirmed 2026-05-30: bumping to 24
    // re-triggered TooMuchMemoryCarryOver (~63 MiB carryover) because Convex
    // loads each doc's full content/entries into the isolate heap before
    // stripDoc runs — so per-doc size, not count, is the binding limit. The
    // webListPaginated invalidation storm is addressed client-side instead (cap
    // the auto-load of all pages in useSyncDocs), not by enlarging the page.
    const paginationOpts = {
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 12),
    };
    const cursor = parseCursor(paginationOpts.cursor);

    // Phase: primary stream.
    //   Team view: paginate by_team_id, keep records whose effective team matches.
    //   Personal view: paginate by_user_id, keep records with no effective team.
    if (cursor.phase === "primary") {
      const primaryQuery = isTeamView
        ? ctx.db.query("docs").withIndex("by_team_id", (q: any) => q.eq("team_id", resolvedTeamId)).order("desc")
        : ctx.db.query("docs").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).order("desc");

      const result = await primaryQuery.paginate({ ...paginationOpts, cursor: cursor.inner });
      const stripped = result.page.map(stripDoc);
      const convMap = await buildConvMapForPage(ctx, stripped);

      const filtered = stripped.filter((r) => {
        const eff = resolveEffectiveTeam(r, convMap);
        if (isTeamView) {
          if (eff) return String(eff) === String(resolvedTeamId);
          return String(r.user_id) === String(userId);
        }
        return !eff;
      });

      const page = await enrichPage(ctx, filtered, convMap, args);

      // Primary stream still has more → stay in primary phase.
      if (!result.isDone) {
        return {
          page,
          isDone: false,
          continueCursor: encodeCursor({ phase: "primary", inner: result.continueCursor }),
        };
      }
      // Primary done. Team view has a second phase for orphans; personal does not.
      if (isTeamView) {
        return {
          page,
          isDone: false,
          continueCursor: encodeCursor({ phase: "orphans", inner: null }),
        };
      }
      return { page, isDone: true, continueCursor: "" };
    }

    // Phase: orphan stream (team view only).
    //   Paginate user's records, keep ones with no effective team. Records we
    //   already returned in the primary phase have team_id == resolvedTeamId,
    //   so the no-effective-team filter naturally excludes them.
    const orphanQuery = ctx.db
      .query("docs")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .order("desc");
    const result = await orphanQuery.paginate({ ...paginationOpts, cursor: cursor.inner });
    const stripped = result.page.map(stripDoc);
    const convMap = await buildConvMapForPage(ctx, stripped);
    const orphans = stripped.filter((r) => !resolveEffectiveTeam(r, convMap));
    const page = await enrichPage(ctx, orphans, convMap, args);

    return {
      page,
      isDone: result.isDone,
      continueCursor: result.isDone
        ? ""
        : encodeCursor({ phase: "orphans", inner: result.continueCursor }),
    };
  },
});

export const webGet = query({
  // Accept a raw string rather than v.id("docs"). These ids arrive from clickable
  // pills/links embedded in untrusted message and doc content, where a stale or
  // mistyped id (e.g. a conversation id in a malformed /docs/<id> link) would make
  // the v.id("docs") validator throw ArgumentValidationError and crash the page.
  // normalizeId returns null for anything that isn't a docs-table id, so we degrade
  // to "not found" instead. (It also avoids ctx.db.get silently returning a
  // cross-table document, since Convex ids are globally unique.)
  args: {
    id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const docId = ctx.db.normalizeId("docs", args.id);
    if (!docId) return null;
    const doc = await ctx.db.get(docId);
    if (!doc) return null;
    // Creator OR any member of the doc's team — same access rule as
    // tasks.webGet. Creator-only made a teammate's embedded doc reference
    // (inline pill / hover preview) resolve to nothing.
    const hasAccess = doc.user_id === userId
      || (doc.team_id ? await isTeamMember(ctx, userId, doc.team_id) : false);
    if (!hasAccess) return null;

    const convIds = doc.related_conversation_ids || (doc.conversation_id ? [doc.conversation_id] : []);
    const relatedConversations: WebDocRelatedConversation[] = [];
    if (convIds.length > 0) {
      for (const cid of convIds) {
        const conv = await ctx.db.get(cid);
        if (conv) relatedConversations.push({
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
    }

    let activePlan: WebDocActivePlan | undefined;
    if (doc.conversation_id) {
      const conv = await ctx.db.get(doc.conversation_id);
      if (conv?.active_plan_id) {
        const plan = await ctx.db.get(conv.active_plan_id);
        if (plan) {
          activePlan = { _id: plan._id, short_id: plan.short_id, title: plan.title, status: plan.status };
        }
      }
    }

    return mapWebDocDetail({ doc, relatedConversations, activePlan });
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
    const team_id = user?.active_team_id;

    const results = await ctx.db
      .query("docs")
      .withSearchIndex("search_docs_v2", (q) => {
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
      if (conv) convMap.set(cid, {
        team_id: conv.team_id,
        is_private: conv.is_private,
        auto_shared: conv.auto_shared,
        team_visibility: conv.team_visibility,
      });
    }

    const resolveTeam = (d: any) => {
      const cid = d.conversation_id || (d.related_conversation_ids?.[0]);
      const conv = cid ? convMap.get(String(cid)) : undefined;
      if (conv) {
        if (!conv.is_private || conv.auto_shared) return conv.team_id;
        if (conv.team_visibility && conv.team_visibility !== "private") return conv.team_id;
        return undefined;
      }
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
    if (!doc) throw new Error("Doc not found");
    if (!(await canAccessDoc(ctx, userId, doc))) throw new Error("Unauthorized");

    const updates: any = { updated_at: Date.now() };
    if (args.title !== undefined) updates.title = args.title;
    if (args.content !== undefined) updates.content = args.content;
    if (args.doc_type !== undefined) updates.doc_type = args.doc_type;
    if (args.labels !== undefined) updates.labels = args.labels;
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
  args: { team_id: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const batchSize = args.limit || 500;
    let docs;
    if (args.team_id) {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id as any))
        .take(batchSize);
    } else {
      docs = await ctx.db.query("docs").take(batchSize);
    }
    let updated = 0;
    const mappingsCache = new Map<string, any[]>();
    for (const doc of docs) {
      const path = doc.project_path;
      if (!path) continue;

      const uid = String(doc.user_id);
      if (!mappingsCache.has(uid)) {
        mappingsCache.set(uid, await ctx.db
          .query("directory_team_mappings")
          .withIndex("by_user_id", (q: any) => q.eq("user_id", doc.user_id))
          .collect());
      }
      const { teamId: resolvedTeamId } = resolveTeamForPath(mappingsCache.get(uid)!, path, undefined);

      if (String(doc.team_id || "") !== String(resolvedTeamId || "")) {
        await ctx.db.patch(doc._id, { team_id: resolvedTeamId || undefined });
        updated++;
      }
    }
    return { updated, total: docs.length };
  },
});

export const webPatch = mutation({
  args: {
    id: v.id("docs"),
    old_string: v.string(),
    new_string: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc) throw new Error("Doc not found");
    if (doc.user_id !== userId) throw new Error("Not authorized");

    const idx = doc.content.indexOf(args.old_string);
    if (idx === -1) throw new Error("old_string not found in document");

    const newContent =
      doc.content.slice(0, idx) +
      args.new_string +
      doc.content.slice(idx + args.old_string.length);

    await ctx.db.patch(args.id, {
      content: newContent,
      updated_at: Date.now(),
    });

    return { success: true, content: newContent };
  },
});

export const webMentionList = query({
  args: {
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"), v.literal("all"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { items: [] };

    // Bound the scan to a small recent slice. The client only renders the
    // top-6-per-type "recents" (see useMentionQuery); anything beyond that is
    // served by `mentionSearch`. The old 4000/1500 caps were chosen for the
    // 8192-array return limit, but the real failure mode is MEMORY: `.take()`
    // materializes whole `docs` rows — including the heavy `content` body,
    // the ~8KB `embedding`, and the unbounded `entries[]` timeline (Convex has
    // no field projection) — so thousands of rows blow the 64 MB isolate cap
    // and crash the whole app. A small cap keeps the scan well under it while
    // still giving the client plenty of recent candidates.
    const MAX_TOTAL = 50;
    const MAX_PER_TEAM = 25;
    const seen = new Set<string>();
    const docs: any[] = [];
    const pushUnique = (d: any) => {
      if (docs.length >= MAX_TOTAL) return;
      const id = String(d._id);
      if (!seen.has(id)) { seen.add(id); docs.push(d); }
    };

    if (args.workspace === "all") {
      const memberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();
      for (const m of memberships) {
        const teamDocs = await ctx.db
          .query("docs")
          .withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id))
          .order("desc")
          .take(MAX_PER_TEAM);
        for (const d of teamDocs) pushUnique(d);
        if (docs.length >= MAX_TOTAL) break;
      }
      if (docs.length < MAX_TOTAL) {
        const userDocs = await ctx.db
          .query("docs")
          .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
          .order("desc")
          .take(MAX_PER_TEAM);
        for (const d of userDocs) pushUnique(d);
      }
    } else if (args.workspace === "team" && args.team_id) {
      const teamDocs = await ctx.db
        .query("docs")
        .withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id))
        .order("desc")
        .take(MAX_TOTAL);
      for (const d of teamDocs) pushUnique(d);
    } else {
      const userDocs = await ctx.db
        .query("docs")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .order("desc")
        .take(MAX_TOTAL);
      for (const d of userDocs) {
        if (args.workspace === "personal" && d.team_id) continue;
        pushUnique(d);
      }
    }

    return {
      items: docs
        .filter((d: any) => !d.archived_at && d.source !== "plan_mode")
        .map((d: any) => ({
          _id: String(d._id),
          title: d.title,
          doc_type: d.doc_type,
          // Filename/path so the palette can find a file-synced doc by its name,
          // not just its content-derived title (e.g. "backend/ROADMAP_EXPLAINED.md").
          source_file: d.source_file ?? null,
          updated_at: d.updated_at,
          team_id: d.team_id ?? null,
          user_id: d.user_id ?? null,
        })),
    };
  },
});

export const mentionSearch = query({
  args: {
    query: v.string(),
    types: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
    projectPath: v.optional(v.string()),
    teamId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const user = await ctx.db.get(userId);
    const db = await createDataContext(ctx, {
      userId,
      project_path: args.projectPath,
      active_team_id: user?.active_team_id || (user as any)?.team_id,
    });
    const teamId = args.teamId || (db.workspace.type === "team" ? db.workspace.teamId : undefined);
    const q = args.query.toLowerCase();
    const limit = args.limit || 10;
    const types = args.types || ["person", "doc", "task", "session", "plan"];
    const results: Array<{
      id: string;
      type: string;
      label: string;
      sublabel?: string;
      image?: string;
      shortId?: string;
      status?: string;
      priority?: string;
      docType?: string;
      messageCount?: number;
      projectPath?: string;
      goal?: string;
      model?: string;
      agentType?: string;
      updatedAt?: number;
      idleSummary?: string;
    }> = [];

    const perType = Math.max(10, Math.ceil(limit / types.length));

    if (types.includes("person") && teamId) {
      const memberships = await db.raw
        .query("team_memberships")
        .withIndex("by_team_id", (tm: any) => tm.eq("team_id", teamId))
        .collect();
      let count = 0;
      for (const m of memberships) {
        if (count >= perType) break;
        const u = await db.raw.get(m.user_id);
        if (!u) continue;
        const name = (u.name || "").toLowerCase();
        const username = (u.github_username || "").toLowerCase();
        if (q && !name.includes(q) && !username.includes(q)) continue;
        results.push({
          id: String(u._id),
          type: "person",
          label: u.name || u.github_username || "Unknown",
          sublabel: u.github_username ? `@${u.github_username}` : u.email,
          image: u.image || u.github_avatar_url,
          shortId: u.github_username ? `@${u.github_username}` : undefined,
        });
        count++;
      }
    }

    if (types.includes("task")) {
      let tasks;
      if (teamId && q) {
        // Team workspace with query: use full-text search on title, then filter
        // by team_id. Without this, the by_team_id-only path is capped at the
        // most-recent N tasks and older matches are invisible.
        const teamStr = String(teamId);
        const searchHits = await ctx.db
          .query("tasks")
          .withSearchIndex("search_tasks_v2", (s: any) => s.search("title", args.query))
          .take(perType * 20);
        tasks = searchHits.filter((t: any) => String(t.team_id || "") === teamStr);
      } else if (teamId) {
        tasks = await ctx.db
          .query("tasks")
          .withIndex("by_team_id", (t: any) => t.eq("team_id", teamId))
          .order("desc")
          .take(perType * 10);
      } else if (q) {
        tasks = await ctx.db
          .query("tasks")
          .withSearchIndex("search_tasks_v2", (s: any) => s.search("title", args.query).eq("user_id", userId))
          .take(perType * 5);
      } else {
        tasks = await ctx.db
          .query("tasks")
          .withIndex("by_user_id", (t: any) => t.eq("user_id", userId))
          .order("desc")
          .take(perType * 5);
      }
      for (const task of tasks.slice(0, perType)) {
        results.push({
          id: String(task._id),
          type: "task",
          label: task.title,
          sublabel: task.short_id,
          shortId: task.short_id,
          status: task.status,
          priority: (task as any).priority,
        });
      }
    }

    if (types.includes("doc")) {
      // A file-synced doc is titled from its content heading, not its filename, so
      // match the source file path too — lets you find a doc by name/path.
      const docMatches = (d: any) =>
        d.title?.toLowerCase().includes(q) || d.source_file?.toLowerCase().includes(q);
      let docs;
      if (teamId) {
        docs = await ctx.db
          .query("docs")
          .withIndex("by_team_id", (d: any) => d.eq("team_id", teamId))
          .order("desc")
          .take(perType * 10);
        if (q) docs = docs.filter(docMatches);
      } else if (q) {
        // The title search index can't see source_file, so union the title-index
        // hits with filename hits from a bounded recent scan.
        const byTitle = await db.raw
          .query("docs")
          .withSearchIndex("search_docs_v2", (s: any) => s.search("title", args.query).eq("user_id", userId))
          .take(perType * 5);
        const byFile = (await db.raw
          .query("docs")
          .withIndex("by_user_id", (d: any) => d.eq("user_id", userId))
          .order("desc")
          .take(perType * 20))
          .filter((d: any) => d.source_file?.toLowerCase().includes(q));
        const seen = new Set(byTitle.map((d: any) => String(d._id)));
        docs = [...byTitle, ...byFile.filter((d: any) => !seen.has(String(d._id)))];
      } else {
        docs = await db.raw
          .query("docs")
          .withIndex("by_user_id", (d: any) => d.eq("user_id", userId))
          .order("desc")
          .take(perType * 5);
      }
      for (const doc of docs.filter((d: any) => !d.archived_at).slice(0, perType)) {
        results.push({
          id: String(doc._id),
          type: "doc",
          label: doc.title,
          // Show the filename when the doc is backed by a file, so a name/path
          // match is legible (the title may not contain what you typed).
          sublabel: doc.source_file ? (doc.source_file.split("/").pop() || doc.doc_type) : doc.doc_type,
          docType: doc.doc_type,
        });
      }
    }

    if (types.includes("plan")) {
      let plans;
      if (teamId) {
        plans = await ctx.db
          .query("plans")
          .withIndex("by_team_id", (p: any) => p.eq("team_id", teamId))
          .order("desc")
          .take(perType * 10);
      } else {
        plans = await db.raw
          .query("plans")
          .withIndex("by_user_id", (p: any) => p.eq("user_id", userId))
          .order("desc")
          .take(perType * 5);
      }
      const filtered = q
        ? plans.filter((p: any) => p.title?.toLowerCase().includes(q))
        : plans;
      for (const plan of filtered.slice(0, perType)) {
        results.push({
          id: String(plan._id),
          type: "plan",
          label: plan.title,
          sublabel: plan.short_id,
          shortId: plan.short_id,
          status: (plan as any).status,
          goal: (plan as any).goal,
        });
      }
    }

    if (types.includes("session")) {
      let sessions;
      if (teamId) {
        sessions = await ctx.db
          .query("conversations")
          .withIndex("by_team_id", (c: any) => c.eq("team_id", teamId))
          .order("desc")
          .take(perType * 10);
      } else {
        sessions = await db.raw
          .query("conversations")
          .withIndex("by_user_updated", (c: any) => c.eq("user_id", userId))
          .order("desc")
          .take(perType * 5);
      }
      let filtered = q
        ? sessions.filter((s: any) =>
            s.title?.toLowerCase().includes(q) ||
            s.idle_summary?.toLowerCase().includes(q))
        : sessions;
      if (q) {
        // The recency window above only sees the most recent rows; a full-text
        // title lookup reaches sessions far older than any client cache window.
        // Recency matches stay first (most likely target), older hits fill in.
        let titleHits;
        if (teamId) {
          const teamStr = String(teamId);
          titleHits = (await ctx.db
            .query("conversations")
            .withSearchIndex("search_title_v2", (s: any) => s.search("title", args.query))
            .take(perType * 20))
            .filter((c: any) => String(c.team_id || "") === teamStr);
        } else {
          titleHits = await ctx.db
            .query("conversations")
            .withSearchIndex("search_title_v2", (s: any) =>
              s.search("title", args.query).eq("user_id", userId))
            .take(perType * 5);
        }
        const seen = new Set(filtered.map((c: any) => String(c._id)));
        for (const hit of titleHits) {
          if (!seen.has(String(hit._id))) filtered.push(hit);
        }
      }
      if (teamId) {
        // team_id is routing, not visibility — without this gate teammates'
        // private session titles would surface in mention results.
        const feedFilter = await createTeamFeedFilter(ctx, teamId as any);
        filtered = filtered.filter((c: any) =>
          String(c.user_id) === String(userId) || feedFilter.isVisible(c));
      }
      for (const sess of filtered.slice(0, perType)) {
        results.push({
          id: String(sess._id),
          type: "session",
          label: sess.title || "Untitled Session",
          sublabel: (sess as any).idle_summary?.slice(0, 80) || sess.short_id,
          shortId: sess.short_id,
          messageCount: sess.message_count,
          projectPath: sess.project_path,
          status: sess.status,
          model: sess.model,
          agentType: sess.agent_type,
          updatedAt: sess.updated_at,
          idleSummary: (sess as any).idle_summary,
        });
      }
    }

    return results;
  },
});

export const expandMentions = query({
  args: {
    mentions: v.array(v.object({
      type: v.string(),
      shortId: v.optional(v.string()),
      id: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const results: Array<{ type: string; shortId?: string; id?: string; markdown: string }> = [];

    for (const mention of args.mentions) {
      try {
        if (mention.type === "task" && mention.shortId) {
          const task = await ctx.db.query("tasks")
            .filter((q: any) => q.eq(q.field("short_id"), mention.shortId))
            .first();
          if (task && task.user_id === userId) {
            const comments = await ctx.db.query("task_comments")
              .withIndex("by_task_id", (c: any) => c.eq("task_id", task._id))
              .order("desc")
              .take(10);
            let md = `\n\n---\n### Task: ${task.title}\n`;
            md += `\`${task.short_id}\` | Status: **${task.status || "open"}** | Priority: **${(task as any).priority || "medium"}**\n`;
            if ((task as any).labels?.length) md += `Labels: ${(task as any).labels.join(", ")}\n`;
            md += `\n`;
            if ((task as any).body) {
              md += `#### Description\n\n${(task as any).body}\n\n`;
            }
            if ((task as any).acceptance_criteria) {
              md += `#### Acceptance Criteria\n\n${(task as any).acceptance_criteria}\n\n`;
            }
            // Linked sessions
            const linkedConvs = await ctx.db.query("conversations")
              .withIndex("by_user_updated", (c: any) => c.eq("user_id", userId))
              .order("desc")
              .take(100);
            const taskSessions = linkedConvs.filter((c: any) => String(c.active_task_id) === String(task._id)).slice(0, 5);
            if (taskSessions.length > 0) {
              md += `#### Linked Sessions\n\n`;
              for (const s of taskSessions) {
                md += `- **${s.title || "Untitled"}** \`${(s as any).short_id}\` (${(s as any).message_count || 0} msgs)`;
                if ((s as any).idle_summary) md += ` — ${(s as any).idle_summary.slice(0, 200)}`;
                md += `\n`;
              }
              md += `\n`;
            }
            if (comments.length > 0) {
              md += `#### Activity Log (${comments.length} recent)\n\n`;
              for (const c of comments.reverse()) {
                const content = (c as any).content || "";
                const ts = new Date((c as any)._creationTime).toISOString().slice(0, 16).replace("T", " ");
                const tag = (c as any).comment_type ? `[${(c as any).comment_type}]` : "";
                md += `**${ts}** ${tag}\n${content.slice(0, 500)}${content.length > 500 ? "..." : ""}\n\n`;
              }
            }
            md += `> \`cast task context ${task.short_id}\` for full context including all sessions and docs\n---\n`;
            results.push({ type: "task", shortId: mention.shortId, markdown: md });
          }

        } else if (mention.type === "plan" && mention.shortId) {
          const plan = await ctx.db.query("plans")
            .filter((q: any) => q.eq(q.field("short_id"), mention.shortId))
            .first();
          if (plan && (plan as any).user_id === userId) {
            let md = `\n\n---\n### Plan: ${(plan as any).title}\n`;
            md += `\`${(plan as any).short_id}\` | Status: **${(plan as any).status || "draft"}**\n\n`;
            if ((plan as any).goal) {
              md += `#### Goal\n\n${(plan as any).goal}\n\n`;
            }
            if ((plan as any).acceptance_criteria) {
              md += `#### Acceptance Criteria\n\n${(plan as any).acceptance_criteria}\n\n`;
            }
            const taskIds = (plan as any).task_ids || [];
            if (taskIds.length > 0) {
              let doneCount = 0, ipCount = 0, openCount = 0;
              md += `#### Tasks (${taskIds.length})\n\n`;
              for (const tid of taskIds.slice(0, 20)) {
                const t = await ctx.db.get(tid);
                if (!t) continue;
                const st = (t as any).status || "open";
                if (st === "done") doneCount++;
                else if (st === "in_progress") ipCount++;
                else openCount++;
                const icon = st === "done" ? "[x]" : st === "in_progress" ? "[~]" : "[ ]";
                md += `- ${icon} **${(t as any).title}** \`${(t as any).short_id}\` — ${st}`;
                if ((t as any).priority && (t as any).priority !== "medium") md += ` (${(t as any).priority})`;
                md += `\n`;
                if ((t as any).body) {
                  const bodyPreview = (t as any).body.slice(0, 200);
                  md += `  ${bodyPreview}${(t as any).body.length > 200 ? "..." : ""}\n`;
                }
              }
              md += `\nProgress: ${doneCount}/${taskIds.length} done, ${ipCount} in progress, ${openCount} open\n\n`;
            }
            // Comments timeline (unified entries + legacy arrays)
            const entries: any[] = [...((plan as any).entries || [])];
            const seenKeys = new Set(entries.map((e: any) => `${e.timestamp}:${e.content}`));
            for (const e of ((plan as any).progress_log || [])) {
              const key = `${e.timestamp}:${e.entry}`;
              if (!seenKeys.has(key)) entries.push({ type: "progress", timestamp: e.timestamp, content: e.entry });
            }
            for (const e of ((plan as any).decision_log || [])) {
              const key = `${e.timestamp}:${e.decision}`;
              if (!seenKeys.has(key)) entries.push({ type: "decision", timestamp: e.timestamp, content: e.decision, rationale: e.rationale });
            }
            for (const e of ((plan as any).discoveries || [])) {
              const key = `${e.timestamp}:${e.finding}`;
              if (!seenKeys.has(key)) entries.push({ type: "discovery", timestamp: e.timestamp, content: e.finding });
            }
            entries.sort((a: any, b: any) => a.timestamp - b.timestamp);

            const decisions = entries.filter((e: any) => e.type === "decision").slice(-5);
            if (decisions.length) {
              md += `#### Decisions\n\n`;
              for (const d of decisions) {
                md += `- **${d.content}**${d.rationale ? `: ${d.rationale}` : ""}\n`;
              }
              md += `\n`;
            }
            const recentProgress = entries.filter((e: any) => e.type === "progress").slice(-5);
            if (recentProgress.length) {
              md += `#### Progress Log (recent)\n\n`;
              for (const entry of recentProgress) {
                const ts = entry.timestamp ? new Date(entry.timestamp).toISOString().slice(0, 16).replace("T", " ") : "";
                md += `**${ts}** ${entry.content}\n\n`;
              }
            }
            // Linked doc content
            if ((plan as any).doc_id) {
              const doc = await ctx.db.get((plan as any).doc_id);
              if (doc && (doc as any).content) {
                md += `#### Plan Document\n\n${(doc as any).content.slice(0, 3000)}${(doc as any).content.length > 3000 ? "\n\n..." : ""}\n\n`;
              }
            }
            md += `> \`cast plan show ${(plan as any).short_id}\` for full plan with all task details\n---\n`;
            results.push({ type: "plan", shortId: mention.shortId, markdown: md });
          }

        } else if (mention.type === "session" && mention.shortId) {
          const sess = await ctx.db.query("conversations")
            .filter((q: any) => q.eq(q.field("short_id"), mention.shortId))
            .first();
          if (sess && sess.user_id === userId) {
            let md = `\n\n---\n### Session: ${sess.title || "Untitled"}\n`;
            md += `\`${(sess as any).short_id}\` | ${(sess as any).message_count || 0} messages | ${sess.status || "active"}`;
            if ((sess as any).project_path) md += ` | ${(sess as any).project_path}`;
            if ((sess as any).agent_type) md += ` | Agent: ${(sess as any).agent_type}`;
            md += `\n\n`;
            if ((sess as any).idle_summary) {
              md += `#### Summary\n\n${(sess as any).idle_summary}\n\n`;
            }
            // Fetch messages — get a mix of user and assistant
            const messages = await ctx.db.query("messages")
              .withIndex("by_conversation_id", (m: any) => m.eq("conversation_id", sess._id))
              .order("asc")
              .take(50);
            const significant = messages.filter((m: any) =>
              m.role === "user" || (m.role === "assistant" && (m.content?.length || 0) > 100)
            );
            if (significant.length > 0) {
              md += `#### Conversation Highlights\n\n`;
              // First user message in full
              const firstUser = significant.find((m: any) => m.role === "user");
              if (firstUser) {
                md += `**User** (initial):\n${(firstUser as any).content?.slice(0, 800) || ""}${((firstUser as any).content?.length || 0) > 800 ? "..." : ""}\n\n`;
              }
              // Last few exchanges
              const recent = significant.slice(-8);
              for (const m of recent) {
                if (m === firstUser) continue;
                const role = (m as any).role === "user" ? "**User**" : "**Assistant**";
                const content = (m as any).content || "";
                const limit = (m as any).role === "user" ? 500 : 800;
                md += `${role}:\n${content.slice(0, limit)}${content.length > limit ? "..." : ""}\n\n`;
              }
            }
            // Active task/plan context
            if ((sess as any).active_task_id) {
              const t = await ctx.db.get((sess as any).active_task_id);
              if (t) md += `Active task: **${(t as any).title}** \`${(t as any).short_id}\`\n\n`;
            }
            if ((sess as any).active_plan_id) {
              const p = await ctx.db.get((sess as any).active_plan_id);
              if (p) md += `Active plan: **${(p as any).title}** \`${(p as any).short_id}\`\n\n`;
            }
            md += `> \`cast read ${(sess as any).short_id}\` for full conversation transcript\n---\n`;
            results.push({ type: "session", shortId: mention.shortId, markdown: md });
          }

        } else if (mention.type === "doc" && mention.id) {
          const doc = await ctx.db.get(mention.id as Id<"docs">);
          if (doc && doc.user_id === userId) {
            let md = `\n\n---\n### Doc: ${doc.title}\n`;
            md += `Type: ${doc.doc_type || "note"}`;
            if ((doc as any).labels?.length) md += ` | Labels: ${(doc as any).labels.join(", ")}`;
            md += `\n\n`;
            if (doc.content) {
              const contentLimit = 4000;
              md += doc.content.slice(0, contentLimit);
              if (doc.content.length > contentLimit) md += `\n\n... (${Math.round(doc.content.length / 1000)}k chars total)`;
              md += `\n\n`;
            }
            // Related conversations
            const linkedConvs = await ctx.db.query("conversations")
              .withIndex("by_user_updated", (c: any) => c.eq("user_id", userId))
              .order("desc")
              .take(50);
            const docSessions = linkedConvs.filter((c: any) => String((c as any).active_doc_id) === String(doc._id)).slice(0, 3);
            if (docSessions.length > 0) {
              md += `#### Related Sessions\n\n`;
              for (const s of docSessions) {
                md += `- **${s.title || "Untitled"}** \`${(s as any).short_id}\` (${(s as any).message_count || 0} msgs)\n`;
              }
              md += `\n`;
            }
            md += `> \`cast doc read ${String(doc._id).slice(-6)}\` for full document\n---\n`;
            results.push({ type: "doc", id: mention.id, markdown: md });
          }

        } else if (mention.type === "label" && mention.id) {
          // A label (inbox bucket) mention expands to the sessions the user
          // filed under it, so the agent can pull any of them with cast read.
          const bucket = await ctx.db.get(mention.id as Id<"inbox_buckets">);
          if (bucket && String((bucket as any).user_id) === String(userId)) {
            const assignments = await ctx.db.query("bucket_assignments")
              .withIndex("by_user_id", (a: any) => a.eq("user_id", userId))
              .collect();
            const convIds = assignments
              .filter((a: any) => String(a.bucket_id) === String(bucket._id))
              .map((a: any) => a.conversation_id);
            const convs = (await Promise.all(convIds.slice(0, 30).map((id: any) => ctx.db.get(id))))
              .filter((c): c is NonNullable<typeof c> => c !== null)
              .sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0));
            let md = `\n\n---\n### Label: ${(bucket as any).name}\n`;
            md += `${convs.length} session${convs.length === 1 ? "" : "s"} filed under this label\n\n`;
            for (const s of convs as any[]) {
              md += `- **${s.title || "Untitled"}** \`${s.short_id}\` (${s.message_count || 0} msgs${s.project_path ? `, ${s.project_path}` : ""})`;
              if (s.idle_summary) md += ` — ${s.idle_summary.slice(0, 150)}`;
              md += `\n`;
            }
            md += `\n> \`cast sessions --label "${(bucket as any).name}" -a\` for live state · \`cast read <id>\` for a transcript\n---\n`;
            results.push({ type: "label", id: mention.id, markdown: md });
          }

        } else if (mention.type === "person") {
          results.push({ type: "person", shortId: mention.shortId, id: mention.id, markdown: "" });
        }
      } catch {}
    }
    return results;
  },
});

export const webCreate = mutation({
  args: {
    title: v.string(),
    content: v.optional(v.string()),
    doc_type: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    parent_id: v.optional(v.id("docs")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const user = await ctx.db.get(userId);
    const now = Date.now();

    // If adding under a parent, compute sort_order as last child
    let sort_order: number | undefined;
    if (args.parent_id) {
      const siblings = await ctx.db
        .query("docs")
        .withIndex("by_parent_id", (q) => q.eq("parent_id", args.parent_id!))
        .collect();
      sort_order = siblings.length > 0
        ? Math.max(...siblings.map((s) => s.sort_order ?? 0)) + 1
        : 0;
    }

    const id = await ctx.db.insert("docs", {
      user_id: userId,
      team_id: user?.active_team_id,
      title: args.title,
      content: args.content || "",
      doc_type: (args.doc_type || "note") as any,
      source: "human" as any,
      labels: args.labels,
      parent_id: args.parent_id,
      sort_order,
      created_at: now,
      updated_at: now,
    });

    return { id };
  },
});

/** Move a doc to a new parent (or to root if parent_id is null) and update sort_order */
export const webMoveDoc = mutation({
  args: {
    id: v.id("docs"),
    parent_id: v.optional(v.id("docs")),
    sort_order: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== userId) throw new Error("Not found");

    // Prevent circular: can't parent under self or a descendant
    if (args.parent_id) {
      let current: Id<"docs"> | undefined = args.parent_id;
      while (current) {
        if (current === args.id) throw new Error("Cannot nest a doc under itself");
        const ancestor: any = await ctx.db.get(current);
        current = ancestor?.parent_id;
      }
    }

    await ctx.db.patch(args.id, {
      parent_id: args.parent_id,
      sort_order: args.sort_order ?? 0,
      updated_at: Date.now(),
    });
  },
});

/** Reorder children within a parent — bulk update sort_order */
export const webReorderDocs = mutation({
  args: {
    items: v.array(v.object({
      id: v.id("docs"),
      sort_order: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    for (const item of args.items) {
      const doc = await ctx.db.get(item.id);
      if (doc && doc.user_id === userId) {
        await ctx.db.patch(item.id, { sort_order: item.sort_order });
      }
    }
  },
});

/** Add/remove a wiki link between two docs */
export const webToggleDocLink = mutation({
  args: {
    doc_id: v.id("docs"),
    linked_doc_id: v.id("docs"),
    action: v.union(v.literal("add"), v.literal("remove")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.doc_id);
    if (!doc || doc.user_id !== userId) throw new Error("Not found");

    const existing = doc.linked_doc_ids ?? [];
    const linkedStr = String(args.linked_doc_id);

    if (args.action === "add") {
      if (!existing.some((id) => String(id) === linkedStr)) {
        await ctx.db.patch(args.doc_id, {
          linked_doc_ids: [...existing, args.linked_doc_id],
          updated_at: Date.now(),
        });
      }
    } else {
      await ctx.db.patch(args.doc_id, {
        linked_doc_ids: existing.filter((id) => String(id) !== linkedStr),
        updated_at: Date.now(),
      });
    }
  },
});

/** Lightweight query for sidebar doc tree — returns id, title, parent_id, sort_order, doc_type only */
export const webDocTree = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const user = await ctx.db.get(userId);
    const teamId = user?.active_team_id;

    const { records } = await scopedFetch(ctx, "docs", {
      userId,
      teamId,
      workspace: teamId ? "team" : "personal",
      stripFields: ["content", "embedding", "entries", "task_ids", "related_conversation_ids", "labels", "share_token"],
    });

    return records
      .filter((d: any) => !d.archived_at && !isNoiseDocForWeb(d) && d.source !== "plan_mode")
      .map((d: any) => ({
        _id: d._id,
        title: d.title,
        parent_id: d.parent_id ?? null,
        sort_order: d.sort_order ?? 0,
        doc_type: d.doc_type,
        source: d.source,
        pinned: d.pinned,
        updated_at: d.updated_at,
        created_at: d.created_at,
      }));
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

export const webPromoteToPlan = mutation({
  args: { doc_id: v.id("docs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const doc = await ctx.db.get(args.doc_id);
    if (!doc || doc.user_id !== userId) throw new Error("Doc not found");

    if (doc.plan_id) {
      const existing = await ctx.db.get(doc.plan_id);
      if (existing) return { plan_id: doc.plan_id, short_id: (existing as any).short_id };
    }

    const { nextShortId } = await import("./counters");
    const short_id = await nextShortId(ctx.db, "pl");
    const now = Date.now();
    const planId = await ctx.db.insert("plans", {
      user_id: doc.user_id,
      team_id: doc.team_id,
      project_id: doc.project_id,
      short_id,
      title: doc.title,
      status: "draft" as const,
      source: "promoted" as const,
      owner_id: userId,
      doc_id: args.doc_id,
      task_ids: [],
      progress: { total: 0, done: 0, in_progress: 0, open: 0 },
      progress_log: [],
      decision_log: [],
      discoveries: [],
      context_pointers: [],
      session_ids: [],
      created_at: now,
      updated_at: now,
    });
    await ctx.db.patch(args.doc_id, { plan_id: planId, doc_type: "plan" as const });
    return { plan_id: planId, short_id };
  },
});

// ── Public Sharing ─────────────────────────────────────────

export const generateShareLink = mutation({
  args: { id: v.id("docs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== userId) throw new Error("Doc not found");
    if (doc.share_token) return { share_token: doc.share_token };
    const share_token = crypto.randomUUID();
    await ctx.db.patch(args.id, { share_token });
    return { share_token };
  },
});

export const unshare = mutation({
  args: { id: v.id("docs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== userId) throw new Error("Doc not found");
    await ctx.db.patch(args.id, { share_token: undefined });
    return { success: true };
  },
});

export const getShared = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("docs")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .first();
    if (!doc) return null;
    const user = await ctx.db.get(doc.user_id);
    return {
      _id: doc._id,
      title: doc.title,
      content: doc.content,
      doc_type: doc.doc_type,
      labels: doc.labels,
      entries: doc.entries,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      user: user ? { name: user.name, image: user.image } : null,
    };
  },
});
