/**
 * Chapter 4, Chat: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * The API worker (codex, on the cloud host) stops on a question in its own
 * pane. Alex, away from the desk, answers it from the codecast app's
 * session screen: the question arrives there, the answer goes in, and the
 * worker carries on with it, live. The same three messages land in the
 * worker's pane on the desk.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import { WORKERS } from "./fanout";
import { PEOPLE, SESSIONS } from "./story";

export const entities: Record<string, EntityFixture> = {};

/** The worker's question: the reason the session needs input. */
export const ASK = "Should a 410 Gone count as failed? I'd retry 5xx and timeouts only.";

/** Alex's answer from the phone, short enough to stay on one line of the app's composer. */
export const STEER = "Agreed. Log 410s, never retry.";

/** The worker's reply as it carries on, streamed word by word. */
export const REPLY = "Got it: 5xx and timeouts retry with backoff, a 410 is logged once and dropped. Running the tests.";

/** The run the reply starts. */
export const TEST_CALL: ToolCall = { id: "hero-tool-api-test", name: "Bash", input: JSON.stringify({ command: "npm test --workspace packages/api" }) };
export const TEST_RESULT: ToolResult = { tool_use_id: TEST_CALL.id, content: "Tests  214 passed (214)\nTime   4.12s" };

/** The person on the phone, as the app's transcript names them. */
export const ME = PEOPLE.me.name;

/** The worker's session as the phone's header and strip show it. */
export const PHONE_SESSION = {
  title: SESSIONS.api.title,
  agent: SESSIONS.api.agent,
  model: WORKERS.api.model,
  branch: "retry-webhooks",
} as const;

/** What the worker had done before the question, oldest first: the task the lead handed it, its plan, and its first two calls (fixtures/fanout.ts). */
export const EARLIER = {
  task: WORKERS.api.task,
  from: SESSIONS.lead.title,
  plan: WORKERS.api.plan,
  calls: [
    { call: WORKERS.api.seed, result: WORKERS.api.seedResult },
    { call: WORKERS.api.tool, result: WORKERS.api.result },
  ],
} as const;
