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
import { WORKERS } from "./fanout";
import { OBJECTS, PEOPLE, SESSIONS } from "./story";

export const entities: Record<string, EntityFixture> = {};

/** The worker's question: the reason the session needs input. */
export const ASK = "Should a 410 Gone count as failed? I'd retry 5xx, 429 and timeouts only.";

/** Alex's answer from the phone, short enough to stay on one line of the app's composer. */
export const STEER = "Agreed. Log 410s, never retry.";

/** The worker's reply as it carries on, streamed word by word: two lines on the phone, so the question it answers stays whole above it with the keyboard up. */
export const REPLY = "Got it: 410s logged once, never retried. Running the tests.";


/** The person on the phone, as the app's transcript names them. */
export const ME = PEOPLE.me.name;

/**
 * The worker's session as the phone's header and strip show it: Alex's own
 * session (so the model chip opens the switcher), running on the cloud host,
 * spawned by the lead (Parent). The app's strip scrolls sideways, so the
 * chips past the screen's edge are clipped there.
 */
export const PHONE_SESSION = {
  title: SESSIONS.api.title,
  agent: SESSIONS.api.agent,
  model: WORKERS.api.model,
  assignment: { device: { name: OBJECTS.hosts.cloud, remote: true, online: true }, owner: PEOPLE.me.name },
} as const;

/** What the worker had done before the question, oldest first: the task the lead handed it (the spawn's prompt, which the app shows as Alex's own message, since the lead runs as Alex), its plan, and its first two calls (fixtures/fanout.ts). */
export const EARLIER = {
  task: WORKERS.api.task,
  from: PEOPLE.me.name,
  plan: WORKERS.api.plan,
  calls: [
    { call: WORKERS.api.seed, result: WORKERS.api.seedResult },
    { call: WORKERS.api.tool, result: WORKERS.api.result },
  ],
} as const;
