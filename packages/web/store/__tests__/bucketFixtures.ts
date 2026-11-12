import type { BucketItem, InboxSession } from "../inboxStore";

export const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id}`,
  updated_at: Date.now(),
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  ...extra,
});

// Real Convex ids are 32 chars; these pass isConvexId so actions dispatch-path
// logic treats them as server-known rows.
export const convexId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);

export const bucket = (id: string, name: string, extra: Partial<BucketItem> = {}): BucketItem => ({
  _id: id,
  name,
  created_at: 1,
  updated_at: 1,
  ...extra,
});
