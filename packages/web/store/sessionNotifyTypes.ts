// How loudly the viewer hears one session (sessionWatch.listMine): the
// `sessionNotify` rows the store holds. No row is the default: the ordinary
// rules, and the viewer's project, folder and teammate mutes.
export type SessionNotifyLevel = "all" | "needs_input" | "muted";

export type SessionNotifyItem = {
  _id: string;
  conversation_id: string;
  level: SessionNotifyLevel;
  updated_at: number;
};

/** The store key for a session's setting: the same on the optimistic row and the synced one. */
export const sessionNotifyKey = (conversationId: string) => `sn:${conversationId}`;
