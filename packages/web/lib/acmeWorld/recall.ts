// Recall: Alex asks why webhook retries back off the way they do, and the
// agent looks the decision up in Maya's earlier session and cites it. The
// session started with the team's stable context feed, so its transcript
// opens on the strip of session pointers it was handed. The same feed
// (conversations.feedForCLI) answers the new-session screen's Context
// preview. The conversation is written as a conversation record only, never
// an inbox row, so the inbox shots stay as they are. Mobile's Metro reaches
// this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { MIN, PEOPLE, TEAM_ID, WORKSPACE, cid } from "./world";
import { OWN_SESSIONS, TEAM_SESSIONS as T, type TeamSession } from "./teamSessions";

export const RECALL_SESSION = { _id: cid("whybackoff"), short_id: "jx7z4wb", title: "Why webhook retries back off", agent_type: "claude_code" };

/** The feed, newest first: what a team-mode session is pointed at when it starts. */
const FEED: TeamSession[] = [...OWN_SESSIONS, ...Object.values(T)].sort((a, b) => a.ago - b.ago);

const feedItem = (s: TeamSession, now: number) => ({
  id: s._id,
  title: s.title,
  project_path: s.project,
  updated_at: new Date(now - s.ago).toISOString(),
  message_count: s.messages,
  work_state: s.state,
  is_live: s.state === "working",
  user_name: s.who.name,
  owned_by_me: s.who._id === PEOPLE.me._id,
});

/** The record `cast stable-context` posts at injection: 15 pointers from the team feed. */
const STABLE_CONTEXT = (now: number) =>
  JSON.stringify({ mode: "team", global: false, injected_at: now - 6 * MIN, items: FEED.slice(0, 15).map((s) => feedItem(s, now)) });

const REPLY = `Because Maya measured it. In [Backoff schedule for webhook retries](/conversation/${T.backoff._id}) she replayed a week of failed deliveries: exponential backoff with jitter recovered 96% by the fifth attempt, against 71% for a fixed 5s retry. The 2s, 4s, 8s, 16s steps outlast the ledger's restarts without piling retries onto it while it comes back, and the jitter keeps a burst of failures from retrying in lockstep.`;

export const RECALL_TRANSCRIPT = (now: number) => {
  const t = (minsAgo: number) => now - minsAgo * MIN;
  const bash = (id: string, command: string, description: string) => ({ id, name: "Bash", input: JSON.stringify({ command, description }) });
  return [
    { _id: "hero-why-m1", role: "user", content: "Why do webhook retries back off the way they do?", timestamp: t(5) },
    {
      _id: "hero-why-m2",
      role: "assistant",
      content: "That was decided in an earlier session. Looking it up.",
      tool_calls: [
        bash("hero-why-tc1", 'cast search "webhook retry backoff"', "Search past sessions"),
        bash("hero-why-tc2", `cast read ${T.backoff.short_id} --ask "Why exponential backoff with jitter for webhook retries?"`, "Ask the session that decided it"),
      ],
      tool_results: [
        {
          tool_use_id: "hero-why-tc1",
          content: `${T.backoff.short_id}  Backoff schedule for webhook retries   Maya Ortiz  2d ago  58 msgs\n  "Exponential backoff with jitter recovers 96% of failed webhook deliveries by the fifth retry"\n${T.replay.short_id}  Replay dropped Stripe webhooks         Sarah Chen  1d ago  18 msgs\n${T.dlq.short_id}  Dead-letter queue for poisoned events  Maya Ortiz  5h ago  37 msgs`,
        },
        {
          tool_use_id: "hero-why-tc2",
          content: "Maya replayed last week's 1,284 failed deliveries under three schedules (lines 31-38). Fixed 5s recovered 71% by attempt 5, linear 82%, exponential with jitter 96%. She chose exponential, capped at 5 attempts, so a retry outlasts a ledger restart (line 44). Jitter was added after the replay showed retries landing together (line 47).",
        },
      ],
      timestamp: t(4),
    },
    { _id: "hero-why-m3", role: "assistant", content: REPLY, timestamp: t(3) },
  ];
};

const recallRow = (now: number) => ({
  _id: RECALL_SESSION._id,
  session_id: `${RECALL_SESSION._id}-sess`,
  short_id: RECALL_SESSION.short_id,
  title: RECALL_SESSION.title,
  agent_type: RECALL_SESSION.agent_type,
  user_id: PEOPLE.me._id,
  author_name: PEOPLE.me.name,
  is_own: true,
  status: "active",
  team_id: TEAM_ID,
  workspace: WORKSPACE,
  project_path: "~/src/billing",
  git_root: "~/src/billing",
  git_branch: "main",
  message_count: 3,
  started_at: now - 6 * MIN,
  updated_at: now - 3 * MIN,
  last_message_at: now - 3 * MIN,
  agent_status: "done",
  agent_status_at: now - 3 * MIN,
  is_idle: true,
  stable_context: STABLE_CONTEXT(now),
});

export const RECALL_PART: AcmePart = {
  name: "recall",
  seed: (s, now) => {
    s.syncRecord("conversations", RECALL_SESSION._id, recallRow(now));
    s.applyTailMessages(RECALL_SESSION._id, 0, RECALL_TRANSCRIPT(now) as any, null);
  },
  answers: {
    "conversations:feedForCLI": (a) => {
      const now = Date.now();
      const limit = Number(a?.limit) || 15;
      return { conversations: FEED.slice(0, limit).map((s) => ({ ...feedItem(s, now), user: { name: s.who.name } })) };
    },
  },
};
