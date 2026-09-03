import type { ExternalEventRecord } from './externalEvents';

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
  | { type: 'pull_request'; data: PullRequest; timestamp: number }
  | { type: 'external_event'; data: ExternalEventRecord; timestamp: number };

// Cache keyed by the messages array reference. Lets re-visits to a previously-built
// timeline (e.g. switching back to a conversation whose messages haven't mutated)
// skip the O(n log n) sort + O(n) dedupe entirely.
const timelineCache = new WeakMap<object, {
  commits: Commit[];
  pullRequests: PullRequest[];
  gitEvents: ExternalEventRecord[];
  result: TimelineItem[];
}>();

const NO_EXTERNAL_EVENTS: ExternalEventRecord[] = [];

export function buildCompositeTimeline(
  messages: Message[],
  commits: Commit[],
  pullRequests: PullRequest[],
  gitEvents: ExternalEventRecord[] = NO_EXTERNAL_EVENTS,
): TimelineItem[] {
  const cached = timelineCache.get(messages);
  if (
    cached &&
    cached.commits === commits &&
    cached.pullRequests === pullRequests &&
    cached.gitEvents === gitEvents
  ) {
    return cached.result;
  }
  // A commit that arrives as a git event is the same commit the commits lane
  // holds. Show one of them, and prefer the event: it carries the actor, the
  // links to the task and the PR, and the same row style as everything else
  // git puts in the transcript.
  const gitEventShas = new Set<string>();
  for (const e of gitEvents) if (e.sha) gitEventShas.add(e.sha);
  const items: TimelineItem[] = [
    ...messages.map((msg) => ({
      type: 'message' as const,
      data: msg,
      timestamp: msg.timestamp,
    })),
    ...commits
      .filter((commit) => !commit.sha || !gitEventShas.has(commit.sha))
      .map((commit) => ({
        type: 'commit' as const,
        data: commit,
        timestamp: commit.timestamp,
      })),
    ...pullRequests.map((pr) => ({
      type: 'pull_request' as const,
      data: pr,
      timestamp: pr.created_at,
    })),
    ...gitEvents.map((event) => ({
      type: 'external_event' as const,
      data: event,
      timestamp: event.created_at ?? 0,
    })),
  ];

  items.sort((a, b) => a.timestamp - b.timestamp);

  const seenUuids = new Set<string>();
  const seenIds = new Set<string>();
  const seenUserContent = new Map<string, number>();
  const result = items.filter((item) => {
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
    if (
      msg.tool_results &&
      msg.tool_results.length > 0 &&
      (!msg.content || !msg.content.trim()) &&
      !msg.thinking &&
      !(msg.tool_calls && msg.tool_calls.length > 0) &&
      !(msg.images && msg.images.length > 0)
    ) {
      return false;
    }
    if (msg.role === 'user' && (!msg.content || !msg.content.trim()) && !(msg.images && msg.images.length > 0)) return false;
    return true;
  });
  timelineCache.set(messages, { commits, pullRequests, gitEvents, result });
  return result;
}
