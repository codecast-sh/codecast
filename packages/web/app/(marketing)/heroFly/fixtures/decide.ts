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
    "The fork ran both through a 10 minute outage: fixed queued 4,800 retries in a minute, exponential 310.",
  options: [
    { label: "Exponential, 5 attempts", description: "2, 4, 8, 16 minutes with jitter, then dead letters.", cost: "40 lines, today" },
    { label: "Fixed, every 30s", cost: "15 lines", risk: "retry storms" },
    { label: "Linear, every 5 minutes", cost: "20 lines", risk: "slow after a short blip" },
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
