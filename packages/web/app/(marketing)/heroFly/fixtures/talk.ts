/**
 * Chapter 5, Agents talk: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * The API worker tells the dashboard worker where the endpoint is with
 * `cast send`; the dashboard worker answers the same way; then Ashot forks the
 * dashboard worker to try fixed backoff beside the exponential line.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import type { ForkChild } from "@/store/inboxStore";
import { MIN, PEOPLE, SESSIONS } from "./story";

const DOC_REF = "doc:hero_retry_schema";

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

export const entities: Record<string, EntityFixture> = {
  [SESSIONS.api.shortId]: { type: "session", entity: session(SESSIONS.api, "active", 38, "gpt-5.1-codex") },
  [SESSIONS.ui.shortId]: { type: "session", entity: session(SESSIONS.ui, "active", 27, "composer-1") },
  [SESSIONS.fork.shortId]: { type: "session", entity: session(SESSIONS.fork, "active", 6, "gpt-5.1-codex") },
  [DOC_REF]: {
    type: "doc",
    entity: {
      _id: "hero_retry_schema",
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
export const REPLY = "Retry states are in, staging green";

const sendTool = (id: string, to: string, body: string): ToolCall => ({ id, name: "Bash", input: JSON.stringify({ command: `cast send ${to} '${body}'` }) });

/** pairA runs this; pairB runs the reply. Stable objects: the cast parser caches by tool. */
export const SEND = sendTool("hero-tool-send", SESSIONS.ui.shortId, MESSAGE);
export const SEND_RESULT: ToolResult = { tool_use_id: SEND.id, content: `Sent to ${SESSIONS.ui.shortId}` };
export const REPLY_SEND = sendTool("hero-tool-reply", SESSIONS.api.shortId, REPLY);
export const REPLY_RESULT: ToolResult = { tool_use_id: REPLY_SEND.id, content: `Sent to ${SESSIONS.api.shortId}` };

/** Ashot's prompt on the dashboard worker, where the fork leaves the line. */
export const FORK_PROMPT = "Which backoff reads better on the retry timeline? Fork and try both.";
export const MAIN_LINE = "keep exponential";

export const FORK_CHILDREN: ForkChild[] = [
  {
    _id: SESSIONS.fork.id,
    short_id: SESSIONS.fork.shortId,
    title: SESSIONS.fork.title,
    agent_type: SESSIONS.fork.agent,
    origin_id: SESSIONS.ui.id,
    parent_message_uuid: "hero-m-fork",
    first_divergent_preview: SESSIONS.fork.title,
    message_count: 6,
    fork_copied: 4,
  },
];
