/**
 * Chapter 9, Team: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * The beat: in #eng Sarah asks the lead session about dropped Stripe events,
 * the session answers in the channel, and the team huddles over the backoff
 * numbers with live captions while the channel carries on beside it.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import { HOUR, MIN, OBJECTS, PEOPLE, SESSIONS } from "./story";

/** Film-time cues inside the chapter (the camera holds 55.4 to 60.8). */
export const TEAM = {
  ask: 55.5,
  thinking: 56.0,
  reply: 56.7,
  reactA: 57.1,
  reactB: 57.4,
  feedOut: 57.6,
  huddle: 57.7,
  faces: [57.82, 57.9, 57.98] as const,
  /** Each caption reads for 0.7s; the last ("Ship it once the checks are green.") holds to the end of the hold. */
  turns: [58.2, 58.9, 59.6] as const,
  typing: 58.5,
  followUp: 59.2,
} as const;

/** A head-and-shoulders silhouette on a soft ground: a face without a stranger's photo. */
function portrait(ground: string, skin: string, hair: string, shirt: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="${ground}"/><path d="M20 160c4-30 28-44 60-44s56 14 60 44z" fill="${shirt}"/><rect x="68" y="96" width="24" height="26" rx="10" fill="${skin}"/><ellipse cx="80" cy="74" rx="30" ry="35" fill="${skin}"/><path d="M48 72c0-26 14-40 32-40s32 14 32 40c-4-14-16-20-32-20s-28 6-32 20z" fill="${hair}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const FACES = {
  me: portrait("#d9e6e4", "#e3b590", "#3b2a22", "#268bd2"),
  sarah: portrait("#efe0cc", "#f1d2b6", "#16110e", "#859900"),
  maya: portrait("#e6dcef", "#b97f58", "#5a3420", "#d33682"),
};

export const CHAT_PEOPLE = {
  me: { id: PEOPLE.me.id, name: PEOPLE.me.name, handle: PEOPLE.me.handle, avatarUrl: FACES.me },
  sarah: { id: PEOPLE.sarah.id, name: PEOPLE.sarah.name, handle: PEOPLE.sarah.handle, avatarUrl: FACES.sarah },
  maya: { id: PEOPLE.maya.id, name: PEOPLE.maya.name, handle: PEOPLE.maya.handle, avatarUrl: FACES.maya },
  /** The lead session, speaking in the channel as itself and crediting the human it runs as. */
  lead: { id: SESSIONS.lead.id, name: SESSIONS.lead.title, isAgent: true, session: { id: SESSIONS.lead.id, agentType: SESSIONS.lead.agent, via: PEOPLE.me.name } },
};

export const CHANNELS = [
  { id: "hero-ch-eng", name: OBJECTS.channel.name, topic: "Billing and payments engineering" },
  { id: "hero-ch-billing", name: "billing-alerts", unreadCount: 3 },
  { id: "hero-ch-incidents", name: "incidents" },
  { id: "hero-ch-agents", name: "agents", kind: "agents" as const, unreadCount: 7 },
  { id: "hero-ch-design", name: "design" },
  { id: "hero-ch-random", name: "random", unreadCount: 1 },
];

const leadMention = { kind: "session" as const, conversation_id: SESSIONS.lead.id, short_id: SESSIONS.lead.shortId };

/** The channel, in order; `cue` is when a line lands (absent: already there), `ago` its timestamp. */
export const MESSAGES = [
  // Earlier in the day, so the channel opens full rather than on a half-empty column.
  { id: "hero-m-4", who: "me", ago: 7 * HOUR, content: "Billing deploy freeze lifts at noon. Queue anything that touches payouts for after." },
  { id: "hero-m-3", who: "sarah", ago: 6 * HOUR, content: "Holding the refunds change until then." },
  { id: "hero-m-1", who: "maya", ago: 5 * HOUR, content: "The ledger restarts for the Postgres upgrade tonight. Expect a few minutes of 502s around 2am." },
  { id: "hero-m-2", who: "sarah", ago: 4 * HOUR, content: "Stripe retries on its own for three days, but we drop anything that fails on our side in the meantime." },
  { id: "hero-m0", who: "sarah", ago: 3 * HOUR, content: "Refund webhooks are idempotent now, so replaying one is safe." },
  { id: "hero-m1", who: "maya", ago: 2 * HOUR, content: "Staging is on the new billing build. Invoices and refunds both green." },
  {
    id: "hero-m2",
    who: "me",
    ago: 3 * MIN,
    content: `Heads up, agents are on webhook retries now. @${SESSIONS.lead.shortId} is the lead.`,
    mentionRefs: [leadMention],
  },
  {
    id: "hero-m3",
    who: "sarah",
    // After Track's activity (the task was filed a minute ago), so the clock times read in story order.
    ago: 40_000,
    cue: TEAM.ask,
    content: `Support has two tickets about Stripe events dropped overnight. Would @${SESSIONS.lead.shortId} have caught them?`,
    mentionRefs: [leadMention],
  },
  {
    id: "hero-m4",
    who: "lead",
    ago: 25_000,
    cue: TEAM.thinking,
    answered: TEAM.reply,
    content: `Yes. Both failed on a 502 from the ledger, and a failed delivery now goes to a retry queue with exponential backoff, at most 5 attempts. Both would have landed on the second try. The PR is up and its checks are running; the task is in review:\n\n${OBJECTS.task.shortId}`,
  },
  { id: "hero-m5", who: "maya", ago: 0, cue: TEAM.followUp, content: "I'll point support at the retry queue once it ships." },
] as const;

/** Reactions on the session's answer, landing one after the other. */
export const REACTIONS = [
  { emoji: "🎉", cue: TEAM.reactA, names: ["Sarah"] },
  { emoji: "🙌", cue: TEAM.reactB, names: ["Maya"] },
] as const;

/** The team feed beside the channel: what teammates' sessions are doing right now. */
export const FEED = [
  {
    _id: SESSIONS.lead.id,
    title: SESSIONS.lead.title,
    author_name: PEOPLE.me.name,
    agent_type: SESSIONS.lead.agent,
    project_path: "/u/src/billing",
    subtitle: "Failed deliveries retry with exponential backoff, at most 5 attempts. Two workers split the API and the dashboard.",
    message_count: 64,
    duration_ms: 38 * MIN,
    ago: 1 * MIN,
    is_active: true,
  },
  {
    _id: SESSIONS.ui.id,
    title: SESSIONS.ui.title,
    author_name: PEOPLE.me.name,
    agent_type: SESSIONS.ui.agent,
    project_path: "/u/src/billing",
    subtitle: "A Retry button and the attempt history on each failed webhook, reading the retry endpoint's states.",
    message_count: 18,
    duration_ms: 12 * MIN,
    ago: 30_000,
    is_active: true,
  },
  {
    _id: "hero-s-sarah1",
    title: "Stripe signature check",
    author_name: PEOPLE.sarah.name,
    agent_type: "claude_code",
    project_path: "/Users/sarah/src/billing",
    subtitle: "Rejects webhooks whose signature is older than five minutes. Waiting on Sarah to pick the tolerance.",
    message_count: 27,
    duration_ms: 21 * MIN,
    ago: 4 * MIN,
    is_active: false,
  },
] as const;

/** The huddle in #eng: who is in it, and what they say (live captions). */
export const HUDDLE = {
  people: [
    { id: PEOPLE.sarah.id, name: PEOPLE.sarah.name, image: FACES.sarah, isLocal: false, muted: false, hasVideo: false },
    { id: PEOPLE.me.id, name: PEOPLE.me.name, image: FACES.me, isLocal: false, muted: false, hasVideo: false },
    { id: PEOPLE.maya.id, name: PEOPLE.maya.name, image: FACES.maya, isLocal: false, muted: true, hasVideo: false },
  ],
  // A short huddle, so the captions' offsets fit the length its header states.
  startedAgo: 30_000,
  segments: [
    { who: "sarah", t0: 2_000, text: "Five attempts over how long, worst case?" },
    { who: "me", t0: 8_000, text: "About thirty minutes. Two, four, eight, then sixteen, with jitter." },
    { who: "sarah", t0: 16_000, text: "That covers the ledger restarts. Ship it once the checks are green." },
  ],
  recap: {
    summary: "Webhook retries back off exponentially for about thirty minutes, which covers the ledger restarts. Sarah approved shipping it once the checks are green.",
    items: ["Sarah adds paging when an event reaches its fifth attempt"],
  },
} as const;

export const entities: Record<string, EntityFixture> = {
  [SESSIONS.lead.shortId]: {
    type: "session",
    entity: { _id: SESSIONS.lead.id, short_id: SESSIONS.lead.shortId, title: SESSIONS.lead.title, agent_type: SESSIONS.lead.agent, project_path: SESSIONS.lead.project, status: "active" },
  },
  [OBJECTS.task.shortId]: {
    type: "task",
    entity: { _id: "hero-task-1", short_id: OBJECTS.task.shortId, title: OBJECTS.task.title, status: "in_review", priority: "high", task_type: "task", external: { provider: "linear", id: "hero-lin-214", identifier: "BIL-214", url: "https://linear.app/acme/issue/BIL-214" }, description: "Queue failed Stripe deliveries and retry them with exponential backoff, at most 5 attempts, then dead-letter." },
  },
};
