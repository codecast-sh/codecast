// Who hears about a comment on a live artifact (board, sheet, dashboard).
// Called by applyBatchCore for every comment the batch creates, inside the
// same transaction, so a comment and its notifications land together.
//
//   - A person it names (`@handle`, the team roster's rule) gets a mention.
//   - A session it names (`@[Title jx…]`) gets the comment as an ask, the same
//     brief the page's Ask agent sends, and the comment records `sent_to`.
//   - A reply reaches everyone already in the thread (people only).
//   - A new thread nobody was named in reaches the artifact's owner.
//
// An agent session's reply to a thread that was sent to an agent marks the
// thread answered: that reply is how an Ask reports back, and the asker is
// in the thread, so it reaches them as a reply.
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { canAccessDoc } from "./lib/access";
import { resolveMentions, resolveSessionMentions } from "./lib/mentionResolve";
import { canSendProductMessage, enqueuePendingMessage } from "./pendingMessages";
import { siteUrl } from "./lib/siteUrl";
import { artifactSpec, askAgentBrief, type ArtifactOp, type ArtifactType } from "@codecast/shared/artifacts";
import type { Caller } from "./lib/liveArtifactAccess";

export type NewComment = { key: string; text: string; parent?: string; sent_to?: string };

/** Comment rows a thread lookup reads at most. */
const THREAD_ROWS_MAX = 500;

function personOf(actor: unknown): Id<"users"> | null {
  const s = String(actor ?? "");
  return s.startsWith("u:") ? (s.slice(2) as Id<"users">) : null;
}

async function commentRows(ctx: any, docId: Id<"docs">): Promise<Doc<"live_elements">[]> {
  return await ctx.db
    .query("live_elements")
    .withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", docId).eq("layer", "comments"))
    .take(THREAD_ROWS_MAX);
}

/**
 * Notify for the comments a batch created. Returns follow-up ops for the
 * comments layer (sent_to stamps, answered stamps) the caller writes after.
 */
export async function notifyLiveComments(
  ctx: any,
  doc: Doc<"docs">,
  caller: Caller,
  created: NewComment[],
): Promise<ArtifactOp[]> {
  if (created.length === 0) return [];
  const followUps: ArtifactOp[] = [];
  const type = doc.doc_type as ArtifactType;
  const noun = artifactSpec(type).label.toLowerCase();
  const title = doc.title || `Untitled ${noun}`;
  const all = created.some((c) => c.parent) ? await commentRows(ctx, doc._id) : [];
  const byKey = new Map(all.map((r) => [r.key, r]));

  for (const c of created) {
    const rootKey = c.parent ?? c.key;
    const link = `/docs/${doc._id}?c=${rootKey}`;
    // A person never hears about their own comment; an agent session's comment
    // reaches its owner like anyone's (that is how an Ask reports back).
    const notified = new Set<string>(caller.kind === "person" ? [String(caller.userId)] : []);
    const emit = async (event_type: "mention" | "comment_reply" | "doc_commented", to: Id<"users">, message: string) => {
      if (notified.has(String(to))) return;
      notified.add(String(to));
      // The text goes into the bell: only someone who can open the artifact gets it.
      if (!(await canAccessDoc(ctx, to, doc))) return;
      await ctx.runMutation(internal.notificationRouter.emit, {
        event_type,
        // An agent session acts for its owner; naming the owner as actor would
        // drop the owner's own notification (the router skips self-notices).
        ...(caller.kind === "agent" ? { actor_name: caller.name } : { actor_user_id: caller.userId }),
        entity_type: "doc",
        entity_id: String(doc._id),
        message,
        link,
        push_subtitle: title,
        push_body: c.text.slice(0, 180),
        direct_recipient_id: to,
      });
    };

    let named = false;
    if (doc.team_id) {
      for (const uid of await resolveMentions(ctx, doc.team_id, c.text, caller.userId)) {
        named = true;
        await emit("mention", uid, `${caller.name} mentioned you on the ${noun} "${title}"`);
      }
    }

    // A person naming a session hands it the comment as an ask. A session
    // naming another stays prose: agents do not start each other from comments.
    if (caller.kind === "person" && !c.sent_to) {
      const sessions = await resolveSessionMentions(ctx, c.text, (conv) => canSendProductMessage(ctx, caller.userId, conv));
      for (const conv of sessions.slice(0, 3)) {
        named = true;
        const brief = askAgentBrief({
          prompt: c.text,
          doc: { _id: String(doc._id), title, doc_type: type },
          url: `${siteUrl()}/docs/${doc._id}`,
          comment_key: rootKey,
        });
        await enqueuePendingMessage(ctx, conv, caller.userId, { content: brief, human: true });
        if (!c.parent) followUps.push({ k: c.key, set: { sent_to: String(conv._id) } });
      }
    }

    if (c.parent) {
      const root = byKey.get(c.parent);
      // Everyone already in the thread: its author and each replier.
      const people = new Set<string>();
      const rootAuthor = personOf(root?.fields?.author);
      if (rootAuthor) people.add(rootAuthor);
      for (const r of all) if (r.fields?.parent === c.parent && r.key !== c.key) {
        const p = personOf(r.fields?.author);
        if (p) people.add(p);
      }
      for (const p of people) await emit("comment_reply", p as Id<"users">, `${caller.name} replied on the ${noun} "${title}"`);
      if (caller.kind === "agent" && root?.fields?.sent_to && !root.fields.answered_at) {
        followUps.push({ k: c.parent, set: { answered_at: Date.now(), answered_by: caller.actor, answered_by_name: caller.name } });
      }
    } else if (!named && String(doc.user_id) !== String(caller.userId)) {
      await emit("doc_commented", doc.user_id, `${caller.name} commented on the ${noun} "${title}"`);
    }
  }
  return followUps;
}
