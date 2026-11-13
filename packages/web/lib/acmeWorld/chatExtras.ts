// #eng beyond the core day (./world ENG_MESSAGES): the digest yesterday's
// "Webhook retry backoff" huddle left in the channel (./calls), and a thread
// under the Retry failed webhooks session's answer where Sarah asks a
// follow-up and the session replies. Chat rows merge as a delta overlay, so
// these sit beside the core's. Mobile's Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { CALL_ID, CALL_SUMMARY } from "./calls";
import { HOUR, MIN, PEOPLE, SESSIONS, TEAM_ID, cid } from "./world";

const ENG = "hero-ch-eng";
/** The core's session-authored answer in #eng: the thread's root. */
const ROOT = cid("hero-m-6");
const LEAD = { origin: "agent" as const, origin_session_id: SESSIONS.lead._id, origin_session_title: SESSIONS.lead.title, origin_agent_type: SESSIONS.lead.agent_type };

const line = (now: number, id: string, o: { who: { _id: string }; ago: number; content: string; agent?: boolean; extra?: Record<string, unknown> }) => ({
  _id: cid(id),
  team_id: TEAM_ID,
  channel_id: ENG,
  user_id: o.who._id,
  content: o.content,
  created_at: now - o.ago,
  updated_at: now - o.ago,
  ...(o.agent ? LEAD : { author_kind: "user" as const }),
  ...o.extra,
});

export const ENG_EXTRAS = (now: number) => [
  // The huddle's digest, posted when it ended yesterday.
  line(now, "hero-m-digest", { who: PEOPLE.me, ago: 22 * HOUR - 14 * MIN, content: CALL_SUMMARY, extra: { call: { transcript_id: CALL_ID } } }),
  // A thread under the session's answer.
  line(now, "hero-m-t1", { who: PEOPLE.sarah, ago: 90_000, content: "Can it replay the two from last night once it ships, or do I file them by hand?", extra: { thread_root_id: ROOT } }),
  line(now, "hero-m-t2", {
    who: PEOPLE.me,
    agent: true,
    ago: 60_000,
    content: "It can. Once PR #482 lands I'll enqueue both events from the Stripe log, evt_1Q8 and evt_1Q9, and post here when they're delivered.",
    extra: { thread_root_id: ROOT },
  }),
];

/** Acme's Slack workspace, installed and not yet mirrored to any channel, and its channels the mirror dialog lists. */
const SLACK_TEAM = () => ({
  installation: { workspace_name: "Acme", workspace_id: "T0ACME000", team_id: TEAM_ID },
  missing_scopes: [],
  is_admin: true,
  you_connected: true,
  you_missing_scopes: [],
  dm_ready: false,
  dm_sync: null,
  links: [],
  pending_jobs: 0,
});

const SLACK_CHANNELS = [
  { id: "C0ACMEENG", name: "eng", is_private: false, is_member: true, you_are_in: true, num_members: 14 },
  { id: "C0ACMEGEN", name: "general", is_private: false, is_member: true, is_general: true, you_are_in: true, num_members: 41 },
  { id: "C0ACMEINC", name: "incidents", is_private: false, is_member: false, you_are_in: true, num_members: 18 },
  { id: "C0ACMEBIL", name: "billing-alerts", is_private: false, is_member: false, you_are_in: false, num_members: 7 },
  { id: "C0ACMESUP", name: "support-escalations", is_private: true, is_member: false, you_are_in: true, num_members: 9 },
];

export const CHAT_EXTRAS_PART: AcmePart = {
  name: "chat-extras",
  answers: {
    "slackSync:getTeamSlack": SLACK_TEAM,
    "slackSync:listSlackChannels": () => ({ ok: true, channels: SLACK_CHANNELS }),
  },
  seed: (s, now) => s.syncTable("chatMessages", ENG_EXTRAS(now), { isDelta: true }),
};
