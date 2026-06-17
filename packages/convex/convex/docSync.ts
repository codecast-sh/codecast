import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { packSnapshotContent, readSnapshotContent } from "./lib/docSnapshot";

const MAX_DELTA_FETCH = 100;
const MAX_SNAPSHOT_FETCH = 10;

const vClientId = v.union(v.string(), v.number());

async function requireAuth(ctx: any): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

/**
 * The web editor seeds the collaborative snapshot from the doc's markdown the
 * first time a doc is opened. If that markdown prop hadn't loaded yet (the
 * snapshot query resolves before the heavier doc-detail query), it seeds an
 * EMPTY doc — and submitSnapshot would then overwrite the real markdown in
 * `doc.content` with "". This predicate detects that racy initial empty seed so
 * the mutation can reject it wholesale: no empty snapshot is written and the
 * markdown is preserved, so the doc re-seeds correctly on the next open.
 *
 * Scoped to the initial snapshot (version <= 1) only — a genuine full clear of
 * an existing doc arrives at version > 1 and must be allowed through.
 */
export function isRacyEmptySeed(args: {
  version: number;
  derivedMarkdown: string;
  existingContent: string | undefined | null;
}): boolean {
  if (args.version > 1) return false;
  if (args.derivedMarkdown.trim() !== "") return false;
  return (args.existingContent ?? "").trim() !== "";
}

export const getSnapshot = query({
  args: { id: v.string(), version: v.optional(v.number()) },
  returns: v.union(
    v.object({ content: v.null() }),
    v.object({ content: v.string(), version: v.number() }),
  ),
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const snapshot = await ctx.db
      .query("doc_snapshots")
      .withIndex("id_version", (q: any) =>
        q.eq("id", args.id).lte("version", args.version ?? Infinity),
      )
      .order("desc")
      .first();
    if (!snapshot) return { content: null };
    return { content: readSnapshotContent(snapshot), version: snapshot.version };
  },
});

export const submitSnapshot = mutation({
  args: {
    id: v.string(),
    version: v.number(),
    content: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const existing = await ctx.db
      .query("doc_snapshots")
      .withIndex("id_version", (q: any) =>
        q.eq("id", args.id).eq("version", args.version),
      )
      .first();
    if (existing) return;

    // Parse once and guard against the racy empty seed BEFORE writing anything.
    // Otherwise a v1 empty snapshot from a not-yet-loaded editor would clobber
    // the doc's real markdown (see isRacyEmptySeed).
    let parsed: any;
    try {
      parsed = JSON.parse(args.content);
    } catch {
      parsed = null;
    }
    const md = parsed ? toMarkdown(parsed).trim() : "";
    // The sync id is a real `docs` row id only for the document editor. The chat
    // composer reuses this same OT backend under a synthetic "compose:<convId>"
    // id, which is not a docs id — normalizeId returns null for it, so we skip the
    // docs-table coupling (content patch + mention notifications) entirely. Calling
    // ctx.db.get with a non-id string would throw.
    const docId = ctx.db.normalizeId("docs", args.id);
    const docForGuard = docId ? await ctx.db.get(docId) : null;
    if (
      isRacyEmptySeed({
        version: args.version,
        derivedMarkdown: md,
        existingContent: (docForGuard as any)?.content,
      })
    ) {
      return;
    }

    try {
      await ctx.db.insert("doc_snapshots", {
        id: args.id,
        version: args.version,
        content_gz: packSnapshotContent(args.content),
      });
    } catch (e: any) {
      if (e.message?.includes("duplicate") || e.message?.includes("conflict")) return;
      // Even gzipped, a pathologically huge doc could still exceed the 1 MiB
      // limit. Skip the snapshot rather than throwing — the doc stays syncable
      // via delta replay; only cold-load compaction is lost.
      if (e.message?.includes("too large")) return;
      throw e;
    }
    if (args.version > 1) {
      const oldSnapshots = await ctx.db
        .query("doc_snapshots")
        .withIndex("id_version", (q: any) =>
          q.eq("id", args.id).gt("version", 1).lt("version", args.version),
        )
        .take(MAX_SNAPSHOT_FETCH);
      await Promise.all(oldSnapshots.map((doc: any) => ctx.db.delete(doc._id)));
    }
    try {
      const doc = docForGuard;
      if (doc && parsed) {
        await ctx.db.patch(doc._id, { content: md, updated_at: Date.now() });

        const newMentions = extractPersonMentionIds(parsed);
        if (newMentions.size > 0) {
          let oldMentions = new Set<string>();
          if (args.version > 1) {
            const prevSnapshot = await ctx.db
              .query("doc_snapshots")
              .withIndex("id_version", (q: any) =>
                q.eq("id", args.id).lt("version", args.version),
              )
              .order("desc")
              .first();
            if (prevSnapshot) {
              try {
                oldMentions = extractPersonMentionIds(JSON.parse(readSnapshotContent(prevSnapshot)));
              } catch {}
            }
          }
          const added = [...newMentions].filter((id) => !oldMentions.has(id));
          if (added.length > 0) {
            const actor = await ctx.db.get(userId);
            const actorName = actor?.name || actor?.email || "Someone";
            const docTitle = doc.title || "a document";
            for (const mentionedId of added) {
              if (mentionedId === userId.toString()) continue;
              try {
                await ctx.runMutation(internal.notificationRouter.ensureSubscribed, {
                  user_id: mentionedId as Id<"users">,
                  entity_type: "doc",
                  entity_id: doc._id.toString(),
                  reason: "mentioned",
                });
                await ctx.runMutation(internal.notificationRouter.emit, {
                  event_type: "mention",
                  actor_user_id: userId,
                  entity_type: "doc",
                  entity_id: doc._id.toString(),
                  message: `${actorName} mentioned you in "${docTitle}"`,
                  conversation_id: doc.conversation_id,
                  direct_recipient_id: mentionedId as Id<"users">,
                });
              } catch {}
            }
          }
        }
      }
    } catch {}
  },
});

function wrapMarks(text: string, marks?: any[]): string {
  if (!marks?.length || !text) return text;
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "bold": case "strong": out = `**${out}**`; break;
      case "italic": case "em": out = `*${out}*`; break;
      case "strike": out = `~~${out}~~`; break;
      case "code": out = `\`${out}\``; break;
      case "link": out = `[${out}](${mark.attrs?.href || ""})`; break;
    }
  }
  return out;
}

function toMarkdown(node: any, ctx: { indent: string; ordered: boolean; itemIndex: number } = { indent: "", ordered: false, itemIndex: 0 }): string {
  if (node.type === "text") return wrapMarks(node.text || "", node.marks);
  if (node.type === "hardBreak") return "\n";
  if (node.type === "horizontalRule") return "\n---\n\n";
  if (node.type === "mention") return `@${node.attrs?.label || node.attrs?.id || ""}`;
  if (node.type === "image") {
    const alt = node.attrs?.alt || "";
    const src = node.attrs?.src || "";
    return `![${alt}](${src})`;
  }

  if (!node.content) {
    if (node.type === "paragraph") return "\n";
    return "";
  }

  const inline = (n: any) => toMarkdown(n, ctx);
  const children = node.content.map(inline).join("");

  switch (node.type) {
    case "heading":
      return "#".repeat(node.attrs?.level || 1) + " " + children.trim() + "\n\n";
    case "paragraph":
      return children + "\n\n";
    case "bulletList":
      return node.content.map((li: any, i: number) =>
        toMarkdown(li, { indent: ctx.indent, ordered: false, itemIndex: i })
      ).join("") + "\n";
    case "orderedList": {
      const start = node.attrs?.start ?? 1;
      return node.content.map((li: any, i: number) =>
        toMarkdown(li, { indent: ctx.indent, ordered: true, itemIndex: start + i })
      ).join("") + "\n";
    }
    case "taskList":
      return node.content.map((li: any, i: number) =>
        toMarkdown(li, { indent: ctx.indent, ordered: false, itemIndex: i })
      ).join("") + "\n";
    case "listItem": {
      const prefix = ctx.ordered ? `${ctx.itemIndex}. ` : "- ";
      const body = node.content.map((child: any) => {
        const md = toMarkdown(child, { indent: ctx.indent + "  ", ordered: false, itemIndex: 0 });
        return md.replace(/\n$/, "");
      }).join("\n" + ctx.indent + "  ");
      return ctx.indent + prefix + body.trim() + "\n";
    }
    case "taskItem": {
      const checked = node.attrs?.checked ? "x" : " ";
      const body = node.content.map((child: any) => {
        const md = toMarkdown(child, { indent: ctx.indent + "  ", ordered: false, itemIndex: 0 });
        return md.replace(/\n$/, "");
      }).join("\n" + ctx.indent + "  ");
      return ctx.indent + `- [${checked}] ` + body.trim() + "\n";
    }
    case "blockquote": {
      const inner = node.content.map(inline).join("");
      return inner.trim().split("\n").map((l: string) => "> " + l).join("\n") + "\n\n";
    }
    case "codeBlock": {
      const lang = node.attrs?.language || "";
      return "```" + lang + "\n" + children + "\n```\n\n";
    }
    case "table": {
      const rows = (node.content || []).map((row: any) =>
        (row.content || []).map((cell: any) =>
          (cell.content || []).map(inline).join("").replace(/\n+/g, " ").trim()
        )
      );
      if (rows.length === 0) return "";
      const colCount = Math.max(...rows.map((r: string[]) => r.length));
      const padded = rows.map((r: string[]) => {
        while (r.length < colCount) r.push("");
        return r;
      });
      let md = "| " + padded[0].join(" | ") + " |\n";
      md += "| " + padded[0].map(() => "---").join(" | ") + " |\n";
      for (let i = 1; i < padded.length; i++) {
        md += "| " + padded[i].join(" | ") + " |\n";
      }
      return md + "\n";
    }
    default:
      return children;
  }
}

function extractPersonMentionIds(node: any): Set<string> {
  const ids = new Set<string>();
  if (node.type === "mention" && node.attrs?.type === "person" && node.attrs?.id) {
    ids.add(node.attrs.id);
  }
  if (node.content) {
    for (const child of node.content) {
      for (const id of extractPersonMentionIds(child)) ids.add(id);
    }
  }
  return ids;
}

export const latestVersion = query({
  args: { id: v.string() },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const latestDelta = await ctx.db
      .query("doc_deltas")
      .withIndex("id_version", (q: any) => q.eq("id", args.id))
      .order("desc")
      .first();
    if (latestDelta) return latestDelta.version;
    const latestSnapshot = await ctx.db
      .query("doc_snapshots")
      .withIndex("id_version", (q: any) => q.eq("id", args.id))
      .order("desc")
      .first();
    return latestSnapshot?.version ?? null;
  },
});

export const getSteps = query({
  args: { id: v.string(), version: v.number() },
  returns: v.object({
    steps: v.array(v.string()),
    clientIds: v.array(vClientId),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const deltas = await ctx.db
      .query("doc_deltas")
      .withIndex("id_version", (q: any) =>
        q.eq("id", args.id).gt("version", args.version),
      )
      .take(MAX_DELTA_FETCH);
    const steps: string[] = [];
    const clientIds: (string | number)[] = [];
    if (deltas.length > 0) {
      const firstDelta = deltas[0];
      const startOffset = firstDelta.version - firstDelta.steps.length;
      if (startOffset < args.version) {
        const sliced = firstDelta.steps.slice(args.version - startOffset);
        for (const step of sliced) { steps.push(step); clientIds.push(firstDelta.clientId); }
        for (let i = 1; i < deltas.length; i++) {
          for (const step of deltas[i].steps) { steps.push(step); clientIds.push(deltas[i].clientId); }
        }
      } else {
        for (const delta of deltas) {
          for (const step of delta.steps) { steps.push(step); clientIds.push(delta.clientId); }
        }
      }
    }
    return { steps, clientIds, version: args.version + steps.length };
  },
});

export const submitSteps = mutation({
  args: {
    id: v.string(),
    version: v.number(),
    clientId: vClientId,
    steps: v.array(v.string()),
  },
  returns: v.union(
    v.object({
      status: v.literal("needs-rebase"),
      clientIds: v.array(vClientId),
      steps: v.array(v.string()),
    }),
    v.object({ status: v.literal("synced") }),
  ),
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const changes = await ctx.db
      .query("doc_deltas")
      .withIndex("id_version", (q: any) =>
        q.eq("id", args.id).gt("version", args.version),
      )
      .take(MAX_DELTA_FETCH);
    if (changes.length > 0) {
      const steps: string[] = [];
      const clientIds: (string | number)[] = [];
      for (const delta of changes) {
        for (const step of delta.steps) { steps.push(step); clientIds.push(delta.clientId); }
      }
      return { status: "needs-rebase" as const, clientIds, steps };
    }
    await ctx.db.insert("doc_deltas", {
      id: args.id,
      version: args.version + args.steps.length,
      clientId: args.clientId,
      steps: args.steps,
    });
    return { status: "synced" as const };
  },
});

// --- Presence ---

const PRESENCE_COLORS = [
  "#e06c75", "#61afef", "#c678dd", "#98c379", "#e5c07b",
  "#56b6c2", "#be5046", "#d19a66",
];

export const updatePresence = mutation({
  args: {
    doc_id: v.string(),
    cursor_pos: v.optional(v.number()),
    anchor_pos: v.optional(v.number()),
    // Composer co-presence only: the sender's live draft, capped so a long message
    // doesn't bloat the row. Omitted by the document editor.
    draft_text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const user = await ctx.db.get(userId);
    if (!user) return;
    const existing = await ctx.db
      .query("doc_presence")
      .withIndex("by_user_doc", (q: any) => q.eq("user_id", userId).eq("doc_id", args.doc_id))
      .first();
    const name = user.name || user.email || "Anonymous";
    const color = PRESENCE_COLORS[name.charCodeAt(0) % PRESENCE_COLORS.length];
    const draft = args.draft_text === undefined ? undefined : args.draft_text.slice(0, 2000);
    if (existing) {
      await ctx.db.patch(existing._id, {
        cursor_pos: args.cursor_pos,
        anchor_pos: args.anchor_pos,
        draft_text: draft,
        user_name: name,
        user_color: color,
        updated_at: Date.now(),
      });
    } else {
      await ctx.db.insert("doc_presence", {
        doc_id: args.doc_id,
        user_id: userId,
        user_name: name,
        user_color: color,
        cursor_pos: args.cursor_pos,
        anchor_pos: args.anchor_pos,
        draft_text: draft,
        updated_at: Date.now(),
      });
    }
  },
});

export const removePresence = mutation({
  args: { doc_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const existing = await ctx.db
      .query("doc_presence")
      .withIndex("by_user_doc", (q: any) => q.eq("user_id", userId).eq("doc_id", args.doc_id))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const getPresence = query({
  args: { doc_id: v.string() },
  returns: v.array(v.object({
    user_id: v.id("users"),
    user_name: v.string(),
    user_color: v.string(),
    cursor_pos: v.optional(v.number()),
    anchor_pos: v.optional(v.number()),
    draft_text: v.optional(v.string()),
    updated_at: v.number(),
  })),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const staleThreshold = Date.now() - 30_000;
    const presences = await ctx.db
      .query("doc_presence")
      .withIndex("by_doc", (q: any) => q.eq("doc_id", args.doc_id))
      .collect();
    return presences
      .filter((p: any) => p.user_id !== userId && p.updated_at > staleThreshold)
      .map((p: any) => ({
        user_id: p.user_id,
        user_name: p.user_name,
        user_color: p.user_color,
        cursor_pos: p.cursor_pos,
        anchor_pos: p.anchor_pos,
        draft_text: p.draft_text,
        updated_at: p.updated_at,
      }));
  },
});
