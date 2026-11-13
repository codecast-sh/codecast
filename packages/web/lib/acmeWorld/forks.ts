// The Webhook retries session's fork family: the original thread and two
// branches forked from its combined answer, one trying a queue, one per-endpoint
// limits. The branch map reads the family from conversations:getConversationTree;
// each branch is a conversation record (not an inbox card) with its own transcript (the copied history, then
// its own turns). Mobile's Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { DECISION_SESSIONS, RETRIES_TRANSCRIPT, openableOnly } from "./decisions";
import { MIN, cid, session } from "./world";

const ROOT = DECISION_SESSIONS.retries;

export const FORK_SESSIONS = {
  queue: { _id: cid("sforkqueue"), short_id: "jx7f2qa", title: "Webhook retries as a queue", agent_type: "claude_code" },
  limits: { _id: cid("sforklimits"), short_id: "jx7f5pl", title: "Per-endpoint retry limits", agent_type: "claude_code" },
} as const;

const F = FORK_SESSIONS;
/** The fork point: the combined answer, the history both branches copied. */
const FORK_AT = "hero-rt-m6";
const COPIED = 6;

const t = (now: number, minsAgo: number) => now - minsAgo * MIN;
const call = (id: string, name: string, input: unknown) => ({ id, name, input: JSON.stringify(input) });
const result = (id: string, content: string) => ({ tool_use_id: id, content });

/** The root's history up to the fork point, re-keyed for a branch. */
const copied = (now: number, prefix: string) =>
  RETRIES_TRANSCRIPT(now)
    .slice(0, COPIED)
    .map((m) => ({ ...m, _id: `${prefix}-${m._id}`, message_uuid: `${prefix}-${m._id}-uuid` }));

export const QUEUE_BRANCH_TRANSCRIPT = (now: number) => [
  ...copied(now, "hero-fq"),
  { _id: "hero-fq-m1", message_uuid: "hero-fq-m1-uuid", role: "user", content: "Try it as a queue: every failed delivery goes on a retry queue a worker drains.", timestamp: t(now, 5) },
  {
    _id: "hero-fq-m2",
    message_uuid: "hero-fq-m2-uuid",
    role: "assistant",
    content: "Putting failed deliveries on a retry_queue table with a next_attempt_at column. A worker polls every second and picks up whatever is due, so a ledger restart only delays events instead of dropping them.",
    tool_calls: [
      call("hero-fq-tc1", "Write", { file_path: "src/billing/retryQueue.ts", content: "export async function enqueue(event: WebhookEvent, attempt: number) { /* next_attempt_at = now + backoff(attempt) */ }" }),
      call("hero-fq-tc2", "Bash", { command: "bun test src/billing/retryQueue.test.ts" }),
    ],
    tool_results: [result("hero-fq-tc1", "File created successfully at: src/billing/retryQueue.ts"), result("hero-fq-tc2", "11 pass\n0 fail\nRan 11 tests across 1 file. [122ms]")],
    timestamp: t(now, 3),
  },
  {
    _id: "hero-fq-m3",
    message_uuid: "hero-fq-m3-uuid",
    role: "assistant",
    content: "The queue holds up: 11 tests green, and replaying last night's two dropped Stripe events delivers both on the second attempt. Next I measure how far the queue backs up during a ledger restart.",
    timestamp: t(now, 1),
  },
];

export const LIMITS_BRANCH_TRANSCRIPT = (now: number) => [
  ...copied(now, "hero-fl"),
  { _id: "hero-fl-m1", message_uuid: "hero-fl-m1-uuid", role: "user", content: "Try per-endpoint limits instead: each receiving endpoint gets its own retry budget.", timestamp: t(now, 12) },
  { _id: "hero-fl-m2", message_uuid: "hero-fl-m2-uuid", role: "assistant", content: "Each endpoint now gets 20 retries an hour. A receiver that stays down stops eating the budget of the healthy ones.", timestamp: t(now, 9) },
];

const sessions = (now: number) => [
  session(now, F.queue, {
    ago: MIN,
    waiting: "done",
    project: "~/src/billing",
    messages: COPIED + 3,
    state: "Retry queue branch: both dropped events delivered on attempt 2\nStatus: 11 tests green",
    extra: { forked_from: ROOT._id, parent_message_uuid: FORK_AT, fork_copied: COPIED },
  }),
  session(now, F.limits, {
    ago: 9 * MIN,
    waiting: "done",
    project: "~/src/billing",
    messages: COPIED + 2,
    state: "Per-endpoint limits branch: 20 retries an hour per receiver\nStatus: sketched, not tested",
    extra: { forked_from: ROOT._id, parent_message_uuid: FORK_AT, fork_copied: COPIED },
  }),
];

const tree = () => {
  const now = Date.now();
  const node = (s: { _id: string; short_id: string; title: string; agent_type: string }, o: { count: number; label?: string; ago: number; children?: any[] }) => ({
    id: s._id,
    short_id: s.short_id,
    title: s.title,
    message_count: o.count,
    started_at: now - o.ago,
    status: "active",
    agent_type: s.agent_type,
    ...(o.label ? { branch_label: o.label, branch_message_count: o.count - COPIED, parent_message_uuid: FORK_AT } : {}),
    children: o.children ?? [],
  });
  return {
    tree: node(ROOT, {
      count: 14,
      ago: 48 * MIN,
      children: [node(F.queue, { count: COPIED + 3, label: "queue approach", ago: 5 * MIN }), node(F.limits, { count: COPIED + 2, label: "per-endpoint limits", ago: 12 * MIN })],
    }),
  };
};

export const FORKS_PART: AcmePart = {
  name: "forks",
  answers: { "conversations:getConversationTree": tree },
  // Branches open from the branch map, never as inbox cards of their own.
  seed: (s, now) => {
    openableOnly(s, sessions(now));
    s.applyTailMessages(F.queue._id, 0, QUEUE_BRANCH_TRANSCRIPT(now) as any, null);
    s.applyTailMessages(F.limits._id, 0, LIMITS_BRANCH_TRANSCRIPT(now) as any, null);
  },
};
