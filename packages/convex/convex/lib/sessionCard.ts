// A session as its card shows it to one viewer, for readers outside the app
// (the MCP read tools). The level is the app's: the owner sees the whole card;
// a teammate sees it only when the session is shared with the team at all
// (teamReadLevelSync), and then only the fields its visibility mode shows in
// the team feed (resolveVisibilityMode): "minimal" is the project alone,
// "summary" adds the title, "detailed" and "full" add what the session is
// doing now. Text goes through the server's secret pass on the way out.
import type { Doc, Id } from "../_generated/dataModel";
import {
  getOwnerMembership,
  isConversationOwner,
  isTeamMember,
  resolveVisibilityMode,
  teamReadLevelSync,
  type VisibilityMode,
} from "../privacy";
import { effectiveMembershipVisibility } from "../teamVisibility";
import { redactSecrets } from "../redact";

export type SessionCard = {
  id: string;
  visibility: VisibilityMode;
  author: string;
  project: string;
  status: string;
  updated_at: string;
  started_at: string;
  messages: number;
  title?: string;
  subtitle?: string;
  state?: string;
  summary?: string;
};

/** The viewer's level on this session: null when its card does not reach them. */
export async function sessionVisibilityFor(
  ctx: { db: any },
  viewerId: Id<"users">,
  conv: Doc<"conversations">,
): Promise<VisibilityMode | null> {
  if (await isConversationOwner(ctx, viewerId, conv as any)) return "full";
  if (!conv.team_id || !(await isTeamMember(ctx, viewerId, conv.team_id))) return null;
  const membership = await getOwnerMembership(ctx, conv.user_id, conv.team_id);
  const ownerLevel = effectiveMembershipVisibility(membership, conv.started_at);
  if (teamReadLevelSync(conv as any, ownerLevel) === "none") return null;
  return resolveVisibilityMode(conv.team_visibility, ownerLevel, true);
}

const clean = (s: string | undefined | null): string | undefined => (s ? redactSecrets(s) : undefined);

export function sessionCard(conv: Doc<"conversations">, mode: VisibilityMode, authorName: string): SessionCard {
  const project = (conv.project_path || conv.git_root)?.split("/").pop() || "unknown project";
  const card: SessionCard = {
    id: conv.short_id ?? String(conv._id),
    visibility: mode,
    author: authorName,
    project,
    status: conv.status,
    updated_at: new Date(conv.updated_at).toISOString(),
    started_at: new Date(conv.started_at).toISOString(),
    messages: conv.message_count ?? 0,
  };
  if (mode === "minimal") return card;
  card.title = clean(conv.title) ?? "New Session";
  card.subtitle = clean(conv.subtitle);
  if (mode === "summary") return card;
  card.state = clean(conv.thread_state);
  card.summary = clean(conv.idle_summary);
  return card;
}

/** The card, or null when the viewer may not see this session at all. */
export async function sessionCardFor(
  ctx: { db: any },
  viewerId: Id<"users">,
  conv: Doc<"conversations">,
): Promise<SessionCard | null> {
  const mode = await sessionVisibilityFor(ctx, viewerId, conv);
  if (!mode) return null;
  const author = await ctx.db.get(conv.user_id);
  return sessionCard(conv, mode, author?.name || author?.email?.split("@")[0] || "Unknown");
}
