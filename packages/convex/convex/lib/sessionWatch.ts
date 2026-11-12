// How loudly one person hears one session. The session's own setting wins
// (entity_subscriptions.notify on the conversation): "all", "needs_input" or
// "muted". Without one, a muted project, folder or teammate silences it, and
// otherwise the ordinary rules apply ("default"). Kept free of heavy imports:
// sessionNotify reads it on every session ping.

export type SessionNotifyLevel = "default" | "all" | "needs_input" | "muted";
export type SessionNotifySetting = Exclude<SessionNotifyLevel, "default">;

export const SESSION_NOTIFY_LEVELS: readonly SessionNotifySetting[] = ["all", "needs_input", "muted"];

/** The folder a session belongs to: its repo root, else the directory it ran in. */
export function sessionFolderOf(conv: { git_root?: string | null; project_path?: string | null }): string | null {
  return conv.git_root || conv.project_path || null;
}

type Conv = {
  _id: any;
  user_id: any;
  project_id?: any;
  git_root?: string | null;
  project_path?: string | null;
};

type Viewer = {
  _id: any;
  muted_members?: any[];
  muted_projects?: any[];
  muted_folders?: string[];
};

export async function sessionSettingOf(ctx: { db: any }, userId: any, conversationId: any): Promise<any | null> {
  const row = await ctx.db
    .query("entity_subscriptions")
    .withIndex("by_user_entity", (q: any) =>
      q.eq("user_id", userId).eq("entity_type", "conversation").eq("entity_id", conversationId.toString()),
    )
    .first();
  return row?.notify ? row : null;
}

/** The broad mutes alone, ignoring any per-session setting. */
export function broadlyMuted(viewer: Viewer, conv: Conv): boolean {
  if (conv.project_id && viewer.muted_projects?.some((p) => p.toString() === conv.project_id.toString())) return true;
  const folder = sessionFolderOf(conv);
  if (folder && viewer.muted_folders?.includes(folder)) return true;
  const runner = conv.user_id?.toString();
  if (runner && runner !== viewer._id.toString() && viewer.muted_members?.some((m) => m.toString() === runner)) return true;
  return false;
}

export async function sessionNotifyLevel(ctx: { db: any }, viewer: Viewer, conv: Conv): Promise<SessionNotifyLevel> {
  const setting = await sessionSettingOf(ctx, viewer._id, conv._id);
  if (setting) return setting.notify as SessionNotifySetting;
  return broadlyMuted(viewer, conv) ? "muted" : "default";
}
