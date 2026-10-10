// A conversation with a project's line (docs/architecture/line-workspace.md
// LW1 Chat, LW4). The line is answered for by a real session of its own,
// started for this person's chat at their first message and briefed to answer
// for the line, nested under the standing session of the role that leads the
// project when it can be reached, so the lead owns it and the lead's own
// thread never mixes a line answer with its other work. A line session that
// was killed gets a successor at the next message.
//
// A person's words travel the ordinary pending message rail in a <line-chat>
// frame (shared contracts/lineChat). The first message an answering session
// receives from a chat carries the brief: what the line is, where its record
// lives, and the `line` fence a reply draws widgets with. The asks are kept
// on the person's row (line_chats); each reply is the last thing the answering
// session said after reading the ask, read back from its transcript the way a
// decision's discussion reads its owner (decisionDiscussion placeReplies), so
// there is no second copy of anything the session said.
import { query } from "./functions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessProject } from "./lib/access";
import { resolveActor } from "./lib/actor";
import { leadRoleOf } from "./lineCause";
import { reachableRole, enqueuePendingMessage } from "./pendingMessages";
import { spawnSessionCore } from "./spawn";
import { normalizeSubagentCaps } from "@codecast/shared/contracts";
import { DISCUSSION_MAX_CHARS, ownerName, placeReplies } from "./decisionDiscussion";
import { formatLineChat, lineFenceGuide, parseLineChat } from "@codecast/shared/contracts/lineChat";

type Ctx = { db: any };

/** Why a session answers the line: it was started for this chat, under the project's lead ("lead") or on its own ("line"). */
export type LineChatVia = "lead" | "line";
export type LineChatOwner = { conversation: Doc<"conversations">; via: LineChatVia };

/** The most asks a row keeps: a conversation, not a log. */
export const LINE_CHAT_MAX_ASKS = 200;

const projectRef = (p: Pick<Doc<"projects">, "_id" | "short_id">) => p.short_id ?? String(p._id);

const alive = (conv: any) => !!conv && !conv.inbox_killed_at;

/** The lead's standing session, when the project has a lead that can be reached: a line session starts under it. */
async function leadSession(ctx: Ctx, project: Doc<"projects">): Promise<Doc<"conversations"> | null> {
  const lead = await leadRoleOf(ctx, project);
  const standing = lead ? (await reachableRole(ctx, lead._id))?.standing : null;
  return alive(standing) ? standing : null;
}

/** The session that answers a person's chat with a project's line right now, or null when the next message must start one. */
export async function lineChatOwner(ctx: Ctx, _project: Doc<"projects">, row: Pick<Doc<"line_chats">, "line_conversation_id"> | null): Promise<LineChatOwner | null> {
  const own = row?.line_conversation_id ? await ctx.db.get(row.line_conversation_id) : null;
  if (!alive(own)) return null;
  return { conversation: own, via: own.parent_conversation_id ? "lead" : "line" };
}

/**
 * What an answering session reads before its first message from a chat. It
 * states the job and where the truth lives, and hands over the fence's
 * vocabulary; how to phrase an answer is the session's own judgment.
 */
export function lineChatBrief(project: Pick<Doc<"projects">, "_id" | "short_id" | "title" | "line_profile">, graph: string | null): string {
  const ref = projectRef(project);
  const root = (project.line_profile as { root?: string } | undefined)?.root;
  return [
    `You answer for the line of project "${project.title}" (${ref})${graph ? `, graph ${graph}` : ""}, in its workspace's chat. People come here to understand how the line handles real cases and to change it: why a step decided what it did, which paths runs take and how often, what a run did, what a prompt says, and what an edit would change.`,
    "",
    `Answer from the line's own record rather than from memory: the project and its problems (\`cast project show ${ref}\`, \`cast task show <ct-N> -c\`), the runs on a problem (\`cast workflow runs --task <ct-N>\`), and the graph with its prompt files${root ? ` (the checkout at ${root} publishes this project's line)` : ""}. When the record does not hold the answer, say so.`,
    "",
    "Your reply renders as markdown in the chat. Keep the prose short and let a widget carry whatever it shows better than words.",
    "",
    lineFenceGuide(ref, graph),
    "",
    "A problem that came back after a fix shipped carries its earlier attempts in its record (its runs, their cards and how each was answered). Before proposing anything for it, read what was tried, say why that fix did not hold, and do not propose it again.",
    "",
    "When someone asks for a change to the line, show it as a diff widget, with a before/after table when you replayed cases, and change the prompt file once they confirm.",
  ].join("\n");
}

/**
 * A person says something to a project's line. Whoever may read the project
 * may talk with its line. Idempotent on the client id, so the outbox can
 * redeliver. With no session to answer, one is started for this chat, its
 * first turn the person's words with the brief.
 */
export async function sendLineChatCore(
  ctx: any,
  userId: Id<"users">,
  args: { project_id: string; text: string; client_id: string; graph?: string | null; focus?: string | null },
): Promise<{ ok: true; conversation_id: Id<"conversations"> } | { error: string }> {
  const projectId = ctx.db.normalizeId("projects", args.project_id);
  const project: Doc<"projects"> | null = projectId ? await ctx.db.get(projectId) : null;
  if (!project || !(await canAccessProject(ctx, userId, project))) return { error: "Project not found" };
  const text = (args.text ?? "").trim();
  if (!text) return { error: "The message is empty" };
  if (text.length > DISCUSSION_MAX_CHARS) return { error: `A message to the line can be at most ${DISCUSSION_MAX_CHARS.toLocaleString("en-US")} characters` };
  const graph = args.graph?.trim() || null;
  const focus = args.focus?.trim().slice(0, 300) || null;

  const row: Doc<"line_chats"> | null = await ctx.db
    .query("line_chats")
    .withIndex("by_project_user", (q: any) => q.eq("project_id", project._id).eq("user_id", userId))
    .first();
  const already = row?.asks.find((a) => a.client_id === args.client_id);
  if (already) return { ok: true, conversation_id: already.conversation_id };

  const from = (await resolveActor(ctx, userId, null)).name ?? "A person";
  const ref = projectRef(project);
  const brief = lineChatBrief(project, graph);
  const owner = await lineChatOwner(ctx, project, row);
  let conversationId: Id<"conversations">;
  let spawned: Id<"conversations"> | null = null;
  if (owner) {
    // The brief rides the first message this session hears from this chat.
    const briefed = row?.asks.some((a) => String(a.conversation_id) === String(owner.conversation._id)) ?? false;
    await enqueuePendingMessage(ctx, owner.conversation, userId, {
      content: formatLineChat({ project: ref, graph, from, body: text, focus, brief: briefed ? null : brief }),
      client_id: args.client_id,
      human: true,
    });
    conversationId = owner.conversation._id;
  } else {
    const root = (project.line_profile as { root?: string; publisher_user_id?: string } | undefined);
    // The checkout that publishes the line, when this person published it; else the project's own folder.
    const path = root?.root && root.publisher_user_id === String(userId) ? root.root : project.project_path;
    const parent = await leadSession(ctx, project);
    const started = await spawnSessionCore(ctx, userId, {
      projectPath: path,
      gitRoot: path,
      title: `${project.title} · line chat`,
      prompt: formatLineChat({ project: ref, graph, from, body: text, focus, brief }),
      subagentFields: parent ? { parent_conversation_id: parent._id, is_subagent: true } : null,
      spawnerConversationId: parent?._id,
      fleet: parent ? { device: null, caps: normalizeSubagentCaps(undefined) } : undefined,
    });
    conversationId = started.conversationId;
    spawned = conversationId;
  }

  const now = Date.now();
  const ask = { client_id: args.client_id, text, at: now, user_id: userId, conversation_id: conversationId, ...(graph ? { graph } : {}) };
  if (row) {
    await ctx.db.patch(row._id, {
      asks: [...row.asks, ask].slice(-LINE_CHAT_MAX_ASKS),
      ...(spawned ? { line_conversation_id: spawned } : {}),
      updated_at: now,
    });
  } else {
    await ctx.db.insert("line_chats", {
      project_id: project._id,
      user_id: userId,
      ...(spawned ? { line_conversation_id: spawned } : {}),
      asks: [ask],
      created_at: now,
      updated_at: now,
    });
  }
  return { ok: true, conversation_id: conversationId };
}

/** A chat's asks with the replies their sessions gave. */
export async function lineChatTurns(ctx: Ctx, project: Pick<Doc<"projects">, "_id" | "short_id">, asks: Doc<"line_chats">["asks"]) {
  const ref = projectRef(project);
  return placeReplies(ctx, asks, (content) => {
    const said = parseLineChat(content);
    return said && said.project === ref ? said.body : null;
  });
}

/**
 * The viewer's chat with a project's line: who answers it now (resolved at
 * every read, so the composer names who it goes to before anything is said;
 * null when the first message will start a line session), and each ask with
 * its reply. Keyed by the project's id. Null when the viewer may not read the
 * project.
 */
export const thread = query({
  args: { project_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const projectId = ctx.db.normalizeId("projects", args.project_id);
    const project: Doc<"projects"> | null = projectId ? await ctx.db.get(projectId) : null;
    if (!project || !(await canAccessProject(ctx, userId, project))) return null;
    const row: Doc<"line_chats"> | null = await ctx.db
      .query("line_chats")
      .withIndex("by_project_user", (q: any) => q.eq("project_id", project._id).eq("user_id", userId))
      .first();
    const owner = await lineChatOwner(ctx, project, row);
    const turns = row ? await lineChatTurns(ctx, project, row.asks) : [];
    return {
      _id: String(project._id),
      project_id: String(project._id),
      owner: owner
        ? { conversation_id: String(owner.conversation._id), short_id: owner.conversation.short_id ?? null, name: await ownerName(ctx, owner.conversation), via: owner.via }
        : null,
      turns: turns.map((t) => ({
        client_id: t.client_id,
        text: t.text,
        at: t.at,
        graph: t.graph ?? null,
        conversation_id: String(t.conversation_id),
        delivered: t.delivered,
        reply: t.reply,
      })),
    };
  },
});
