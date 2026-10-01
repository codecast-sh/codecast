/**
 * Chapter 5, Agents talk: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * The API worker tells the dashboard worker where the endpoint is with
 * `cast send`; the dashboard worker answers the same way; then you steer the
 * API worker (it owns the retries) to replay the failures with fixed backoff
 * too, and that turn forks: the API worker keeps the exponential line, and the
 * fork opens beside it to try the fixed one.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import type { ForkChild, InboxSession } from "@/store/inboxStore";
import { WORKERS } from "./fanout";
import { MIN, PEOPLE, SESSIONS } from "./story";

const DOC_ID = "hero_retry_schema";
const DOC_REF = `doc:${DOC_ID}`;

const session = (s: (typeof SESSIONS)[keyof typeof SESSIONS], status: string, messages: number, model: string) => ({
  _id: s.id,
  short_id: s.shortId,
  title: s.title,
  agent_type: s.agent,
  project_path: s.project,
  status,
  message_count: messages,
  model,
  author_name: PEOPLE.me.name,
  updated_at: Date.now() - MIN,
});

// A doc pill resolves by its bare id with the type given, so the fixture is keyed by the id, not the `doc:` reference.
export const entities: Record<string, EntityFixture> = {
  [SESSIONS.api.shortId]: { type: "session", entity: session(SESSIONS.api, "active", 38, WORKERS.api.model) },
  [SESSIONS.ui.shortId]: { type: "session", entity: session(SESSIONS.ui, "active", 27, WORKERS.ui.model) },
  [SESSIONS.fork.shortId]: { type: "session", entity: session(SESSIONS.fork, "active", 6, WORKERS.api.model) },
  [DOC_ID]: {
    type: "doc",
    entity: {
      _id: DOC_ID,
      title: "Retry API schema",
      doc_type: "spec",
      created_at: Date.now() - 40 * MIN,
      updated_at: Date.now() - 2 * MIN,
      content:
        "# Retry API schema\n\nPOST /v2/hooks/retry\n\n- delivery_id: the failed delivery\n- attempt: 1 to 5\n- next_at: when the next attempt runs\n\nStates: queued, retrying, delivered, dead.",
    },
  },
};

/** The message, as typed by the API worker; the mention renders as the doc's pill. */
export const MESSAGE = `API is on \`/v2/hooks/retry\`, schema in @[Retry API schema ${DOC_REF}]`;
export const REPLY = "Retry states are in, staging green.";

const sendTool = (id: string, to: string, body: string): ToolCall => ({ id, name: "Bash", input: JSON.stringify({ command: `cast send ${to} '${body}'` }) });

/** pairA runs this; pairB runs the reply. Stable objects: the cast parser caches by tool. */
export const SEND = sendTool("hero-tool-send", SESSIONS.ui.shortId, MESSAGE);
export const SEND_RESULT: ToolResult = { tool_use_id: SEND.id, content: `Sent to ${SESSIONS.ui.shortId}` };
export const REPLY_SEND = sendTool("hero-tool-reply", SESSIONS.api.shortId, REPLY);
export const REPLY_RESULT: ToolResult = { tool_use_id: REPLY_SEND.id, content: `Sent to ${SESSIONS.api.shortId}` };

/** Your steer on the API worker, the turn the fork leaves the line at: the fork takes it, the worker keeps exponential. */
export const FORK_PROMPT = "Replay the failures with fixed 30s backoff too.";
export const MAIN_LINE = "keep exponential";

export const FORK_CHILDREN: ForkChild[] = [
  {
    _id: SESSIONS.fork.id,
    short_id: SESSIONS.fork.shortId,
    title: SESSIONS.fork.title,
    agent_type: SESSIONS.fork.agent,
    origin_id: SESSIONS.api.id,
    parent_message_uuid: "hero-m-fork",
    first_divergent_preview: FORK_PROMPT,
    message_count: 6,
    fork_copied: 4,
  },
];

/** The fork's first answer, in its own window. */
export const FORK_ANSWER = "Replaying the last 24h of failed deliveries on staging with a fixed 30s retry, beside the exponential line.";
export const FORK_REPLAY = { id: "hero-tool-fork-replay", name: "Bash", input: JSON.stringify({ command: "bun run replay --since 24h --backoff fixed:30s" }) } satisfies ToolCall;

/** The fork as the inbox lists it, carried from the worker's turn to its own window. */
export function forkRow(now: number): InboxSession {
  return {
    _id: SESSIONS.fork.id,
    session_id: `${SESSIONS.fork.id}-sess`,
    title: SESSIONS.fork.title,
    agent_type: SESSIONS.fork.agent,
    user_id: PEOPLE.me.id,
    project_path: "/u/src/billing",
    git_root: "/u/src/billing",
    message_count: 6,
    is_idle: false,
    has_pending: false,
    forked_from: SESSIONS.api.id,
    started_at: now - 2_000,
    updated_at: now - 1_000,
  } as unknown as InboxSession;
}
