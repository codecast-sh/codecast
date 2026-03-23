type Message = {
  _id: string;
  message_uuid?: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  tool_results?: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
  images?: Array<{ media_type: string; data?: string; storage_id?: string }>;
  subtype?: string;
};

type Commit = {
  _id: string;
  sha: string;
  message: string;
  timestamp: number;
  files_changed?: number;
  insertions?: number;
  deletions?: number;
  author_name?: string;
  author_email?: string;
  repository?: string;
  files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
};

type PullRequest = {
  _id: string;
  number: number;
  title: string;
  body?: string;
  state: string;
  repository?: string;
  author_github_username?: string;
  head_ref?: string;
  base_ref?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits_count?: number;
  files?: any[];
  created_at: number;
  updated_at?: number;
  merged_at?: number;
};

export type TimelineItem =
  | { type: 'message'; data: Message; timestamp: number }
  | { type: 'commit'; data: Commit; timestamp: number }
  | { type: 'pull_request'; data: PullRequest; timestamp: number };

export function buildCompositeTimeline(
  messages: Message[],
  commits: Commit[],
  pullRequests: PullRequest[],
  activeBranches: Record<string, string>,
  loadedForkMessages: Record<string, Message[]>,
): TimelineItem[] {
  let effectiveMessages = messages;

  const activeForkUuids = Object.keys(activeBranches);
  if (activeForkUuids.length > 0) {
    const sortedForkPoints = activeForkUuids
      .map((uuid) => {
        const idx = messages.findIndex((m) => m.message_uuid === uuid);
        return { uuid, idx };
      })
      .filter((fp) => fp.idx !== -1)
      .sort((a, b) => a.idx - b.idx);

    if (sortedForkPoints.length > 0) {
      const firstForkPoint = sortedForkPoints[0];
      const forkConvId = activeBranches[firstForkPoint.uuid];
      const forkMsgs = loadedForkMessages[forkConvId];

      if (forkMsgs !== undefined) {
        const mainPrefix = messages.slice(0, firstForkPoint.idx + 1);
        const forkPointInFork = forkMsgs.findIndex(
          (m) => m.message_uuid === firstForkPoint.uuid
        );
        const divergentForkMsgs =
          forkPointInFork !== -1
            ? forkMsgs.slice(forkPointInFork + 1)
            : forkMsgs;
        effectiveMessages = [...mainPrefix, ...divergentForkMsgs];
      }
    }
  }

  const items: TimelineItem[] = [
    ...effectiveMessages.map((msg) => ({
      type: 'message' as const,
      data: msg,
      timestamp: msg.timestamp,
    })),
    ...commits.map((commit) => ({
      type: 'commit' as const,
      data: commit,
      timestamp: commit.timestamp,
    })),
    ...pullRequests.map((pr) => ({
      type: 'pull_request' as const,
      data: pr,
      timestamp: pr.created_at,
    })),
  ];

  items.sort((a, b) => a.timestamp - b.timestamp);

  const seenUuids = new Set<string>();
  const seenIds = new Set<string>();
  const seenUserContent = new Map<string, number>();
  return items.filter((item) => {
    if (item.type !== 'message') return true;
    const msg = item.data as Message;
    if (msg._id) {
      if (seenIds.has(msg._id)) return false;
      seenIds.add(msg._id);
    }
    if (msg.message_uuid) {
      if (seenUuids.has(msg.message_uuid)) return false;
      seenUuids.add(msg.message_uuid);
    }
    if (msg.role === 'user' && msg.content?.trim()) {
      const key = msg.content.trim();
      const lastTs = seenUserContent.get(key);
      if (lastTs !== undefined && Math.abs(msg.timestamp - lastTs) < 60_000) return false;
      seenUserContent.set(key, msg.timestamp);
    }
    if (msg.role === 'user' && msg.tool_results && msg.tool_results.length > 0) return false;
    if (msg.role === 'user' && (!msg.content || !msg.content.trim()) && !(msg.images && msg.images.length > 0)) return false;
    return true;
  });
}
