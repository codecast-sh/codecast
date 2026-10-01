/**
 * Chapter 6, Decide: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * The lead asks with `cast decide` once the fork has run fixed backoff beside
 * exponential; each option carries its cost and its risk.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { SessionDecisionItem } from "@/store/inboxStore";
import { OBJECTS, SESSIONS } from "./story";

export const entities: Record<string, EntityFixture> = {};

export const DECISION: SessionDecisionItem = {
  _id: "hero-dec1",
  short_id: "sd-hero1",
  conversation_id: SESSIONS.lead.id,
  session_id: "hero-sid-lead",
  question: OBJECTS.decision.question,
  context_md:
    "The fork ran both against a 10 minute partner outage. Fixed backoff queued 4,800 retries in the first minute; exponential queued 310.",
  options: [
    { label: "Exponential, capped at 5 attempts", description: "1s, 4s, 16s, 64s, 256s, then the dead letter queue.", cost: "40 lines, ships today" },
    { label: "Fixed, every 30 seconds", description: "What the fork tried.", cost: "15 lines", risk: "retry storms in an outage" },
    { label: "Exponential with jitter", description: "Spreads retries across tenants.", cost: "half a day more", risk: "harder to test" },
  ],
  blocking: true,
  status: "pending",
  kind: "single",
  session_title: SESSIONS.lead.title,
  project_path: SESSIONS.lead.project,
  created_at: 0,
} as SessionDecisionItem;

/** The asking session's row as the card draws it. */
export const ASKING = { _id: SESSIONS.lead.id, title: SESSIONS.lead.title, project_path: SESSIONS.lead.project, status: "working", agent_type: SESSIONS.lead.agent };

/** How long before the film's ask the decision was created, so the card reads "asked just now". */
export const ASKED_AGO = 20_000;

/** The option the film picks. */
export const ANSWER = 0;
