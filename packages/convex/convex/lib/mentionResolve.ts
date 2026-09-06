// Who a message names.
//
// Two grammars, one module. A person is `@handle`, resolved against ONE
// team's roster (chat, code comments). A session is `@[Title jx7c6zk]`, the
// entity mention every composer inserts, resolved through the same lookup
// `cast send` uses. Chat and code comments both call these, so the rules
// about who may be named live here once.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_MENTIONS, botHandle, extractMentionHandles } from "@codecast/shared/chat";
import { entityMentionRegex } from "@codecast/shared/entities";
import { emailLocalHandle } from "../chatText";
import { findConversationByAnyRefWhere } from "../conversationSessionLookup";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export async function teamRoster(ctx: ReadCtx, teamId: Id<"teams">): Promise<Doc<"users">[]> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
    .collect();
  const users = await Promise.all(
    memberships.map((m: { user_id: Id<"users"> }) => ctx.db.get(m.user_id)),
  );
  return users.filter((u): u is Doc<"users"> => u !== null);
}

function emailHandle(user: Doc<"users">): string | null {
  return emailLocalHandle(user.email ?? undefined);
}

// Resolve the handles WRITTEN in a message to real users, against this team's
// roster only. Never against `user.name` for a human: display names are
// self-editable, so matching them would let a member rename themselves to
// intercept a teammate's mentions. Bots are matched on their name because an
// anchor's name is admin-set, and a bot has no GitHub handle to match instead.
// An ambiguous handle resolves to nobody rather than to a guess.
// One handle → at most one roster member: a GitHub login first, then an email
// local part, then a bot's name — and only when exactly one member matches at
// that level. Shared by @mention resolution and by `--dm <handle>`.
export function matchHandle(roster: Doc<"users">[], rawHandle: string): Doc<"users"> | null {
  const handle = rawHandle.replace(/^@/, "").toLowerCase();
  const byGithub = roster.filter(
    (u) => !u.is_bot && u.github_username?.toLowerCase() === handle,
  );
  const byEmail = roster.filter((u) => !u.is_bot && emailHandle(u) === handle);
  const byBot = roster.filter((u) => u.is_bot && botHandle(u.name) === handle);
  return byGithub.length === 1 ? byGithub[0]
    : byGithub.length === 0 && byEmail.length === 1 ? byEmail[0]
    : byGithub.length === 0 && byEmail.length === 0 && byBot.length === 1 ? byBot[0]
    : null;
}

export async function resolveMentions(
  ctx: ReadCtx,
  teamId: Id<"teams">,
  content: string,
  senderId: Id<"users">,
): Promise<Id<"users">[]> {
  const handles = extractMentionHandles(content);
  if (handles.length === 0) return [];
  const roster = await teamRoster(ctx, teamId);

  const resolved: Id<"users">[] = [];
  const seen = new Set<string>();
  for (const handle of handles) {
    const match = matchHandle(roster, handle);
    if (!match) continue;
    const key = match._id.toString();
    if (key === senderId.toString() || seen.has(key)) continue;
    seen.add(key);
    resolved.push(match._id);
    if (resolved.length >= MAX_MENTIONS) break;
  }
  return resolved;
}


/** The ids inside `@[Title id]` mentions that name a session: a short id
 *  (`jx…`) or a raw conversation id. Tasks, plans and docs are left alone. */
export function sessionRefsIn(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(entityMentionRegex({ requireId: true }))) {
    const id = (match[2] ?? "").trim();
    if (!id || !/^(jx\w+|[a-z0-9]{32})$/i.test(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

/** The sessions a message names that pass `accept` (the caller's own rule:
 *  may the writer send to it, may the reader see it). Unknown references are
 *  dropped, never an error: a mention is prose. */
export async function resolveSessionMentions(
  ctx: ReadCtx,
  content: string,
  accept: (conversation: Doc<"conversations">) => boolean | Promise<boolean>,
): Promise<Doc<"conversations">[]> {
  const out: Doc<"conversations">[] = [];
  const seen = new Set<string>();
  for (const ref of sessionRefsIn(content)) {
    const conversation = await findConversationByAnyRefWhere(ctx as any, ref, accept as any);
    if (!conversation || seen.has(String(conversation._id))) continue;
    seen.add(String(conversation._id));
    out.push(conversation as Doc<"conversations">);
  }
  return out;
}
