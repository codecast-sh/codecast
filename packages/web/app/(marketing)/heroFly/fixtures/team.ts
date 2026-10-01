/**
 * Chapter 9, Team: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * The beat: in #eng Sarah asks the lead session about dropped Stripe events,
 * the session answers in the channel, the team huddles over the backoff
 * numbers with live captions, and the org chart shows the billing role that
 * outlives the sessions it runs.
 */

import type { WorkState } from "@codecast/shared/contracts";
import { countStates, sortOrgSessions, type OrgSession, type OrgTree } from "@/components/org/orgTypes";
import type { EntityFixture } from "@/lib/entityDisplay";
import { HOUR, MIN, OBJECTS, PEOPLE, SESSIONS } from "./story";

/** Film-time cues inside the chapter (the camera holds 55.4 to 60.8). */
export const TEAM = {
  ask: 55.5,
  thinking: 56.05,
  reply: 56.85,
  reactA: 57.35,
  reactB: 57.75,
  feedOut: 57.0,
  huddle: 57.1,
  faces: [57.22, 57.3, 57.38] as const,
  turns: [57.55, 58.15, 58.75] as const,
  orgOut: 59.2,
  org: 59.3,
  cursor: 59.6,
  typing: 58.2,
  followUp: 58.9,
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
  me: { id: PEOPLE.me.id, name: "Ashot Petrosian", handle: PEOPLE.me.handle, avatarUrl: FACES.me },
  sarah: { id: PEOPLE.sarah.id, name: PEOPLE.sarah.name, handle: PEOPLE.sarah.handle, avatarUrl: FACES.sarah },
  maya: { id: PEOPLE.maya.id, name: PEOPLE.maya.name, handle: PEOPLE.maya.handle, avatarUrl: FACES.maya },
  /** The lead session, speaking in the channel as itself and crediting the human it runs as. */
  lead: { id: SESSIONS.lead.id, name: SESSIONS.lead.title, isAgent: true, session: { id: SESSIONS.lead.id, agentType: SESSIONS.lead.agent, via: "Ashot" } },
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
    ago: 2 * MIN,
    cue: TEAM.ask,
    content: `@${SESSIONS.lead.shortId} support has two tickets about Stripe events dropped overnight. Would the retry work have caught them?`,
    mentionRefs: [leadMention],
  },
  {
    id: "hero-m4",
    who: "lead",
    ago: 90_000,
    cue: TEAM.thinking,
    answered: TEAM.reply,
    content: `Yes. Both failed on a 502 from the ledger, and a failed delivery now goes to a retry queue with exponential backoff, at most 5 attempts. Both would have landed on the second try. The PR is green and the task is in review:\n\n${OBJECTS.task.shortId}`,
  },
  { id: "hero-m5", who: "maya", ago: 0, cue: TEAM.followUp, content: "Adding a retry queue panel to the billing dashboard so support can see it too." },
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
    author_name: "Ashot Petrosian",
    agent_type: SESSIONS.lead.agent,
    project_path: "/Users/ashot/src/billing",
    subtitle: "Failed deliveries retry with exponential backoff, at most 5 attempts. Two workers split the API and the dashboard.",
    message_count: 64,
    duration_ms: 38 * MIN,
    ago: 1 * MIN,
    is_active: true,
  },
  {
    _id: "hero-s-maya1",
    title: "Retry queue dashboard panel",
    author_name: PEOPLE.maya.name,
    agent_type: "cursor",
    project_path: "/Users/maya/src/billing",
    subtitle: "A panel on the billing dashboard that lists queued retries with their next attempt time.",
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
    { id: PEOPLE.me.id, name: "Ashot Petrosian", image: FACES.me, isLocal: false, muted: false, hasVideo: false },
    { id: PEOPLE.maya.id, name: PEOPLE.maya.name, image: FACES.maya, isLocal: false, muted: true, hasVideo: false },
  ],
  startedAgo: 4 * MIN,
  segments: [
    { who: "sarah", t0: 182_000, text: "Five attempts over how long, worst case?" },
    { who: "me", t0: 188_000, text: "About thirty minutes. Two, four, eight, then sixteen, with jitter." },
    { who: "sarah", t0: 196_000, text: "That covers the ledger restarts. Ship it." },
  ],
  recap: {
    summary: "Webhook retries back off exponentially for about thirty minutes, which covers the ledger restarts. Sarah approved shipping it.",
    items: ["Maya adds the retry queue to the billing dashboard"],
  },
} as const;

/** The org: three people, and the billing role whose sessions come and go while it stays. */
export const ORG_ROLE = {
  id: "hero-role-billing",
  shortId: "or-hero1",
  name: "Billing lead",
  handle: "billing",
  charter: "Owns payments reliability: webhooks, retries and the ledger.",
  standing: { shortId: "jx7hbil", line: "Watching retries in prod" },
};

type OrgSeed = { id: string; shortId: string; title: string; agent: string; project: string; state: WorkState; ago: number };

const ORG_SEEDS: Record<"me" | "role" | "sarah" | "maya", OrgSeed[]> = {
  me: [
    { id: "hero-s-email", shortId: "jx7hem1", title: "Onboarding email copy", agent: "claude_code", project: "~/src/web", state: "done", ago: 3 * HOUR },
    { id: "hero-s-audit", shortId: "jx7hau1", title: "Audit log export to S3", agent: "codex", project: "~/src/infra", state: "done", ago: 47 * MIN },
  ],
  // The lead and everything it started run under the role: the sessions come and go, the role stays.
  role: [
    { ...SESSIONS.lead, state: "working", ago: 1 * MIN },
    { ...SESSIONS.api, state: "working", ago: 2 * MIN },
    { ...SESSIONS.ui, state: "done", ago: 9 * MIN },
    { ...SESSIONS.fork, state: "done", ago: 21 * MIN },
  ],
  sarah: [
    { id: "hero-s-sarah1", shortId: "jx7hsr1", title: "Stripe signature check", agent: "claude_code", project: "~/src/billing", state: "needs_input", ago: 4 * MIN },
    { id: "hero-s-sarah2", shortId: "jx7hsr2", title: "Support ticket triage", agent: "codex", project: "~/src/support", state: "dormant", ago: 40 * MIN },
  ],
  maya: [{ id: "hero-s-maya1", shortId: "jx7hmy1", title: "Retry queue dashboard panel", agent: "cursor", project: "~/src/billing", state: "working", ago: 30_000 }],
};

/** The org as `org.tree` returns it, stamped against the hero's `now`. */
export function orgTree(now: number): OrgTree {
  const sessions = (seeds: OrgSeed[], owner: string, role?: string): OrgSession[] =>
    sortOrgSessions(
      seeds.map((s) => ({
        _id: s.id,
        short_id: s.shortId,
        title: s.title,
        agent_type: s.agent,
        state: s.state,
        updated_at: now - s.ago,
        owner_user_id: owner,
        org_role_id: role,
        subagent_count: 0,
        is_anchor: false,
        project_path: s.project,
        git_branch: "main",
      })),
    );
  const person = (who: "me" | "sarah" | "maya", role: "owner" | "member", presence: "online" | "away") => {
    const list = sessions(ORG_SEEDS[who], PEOPLE[who].id);
    return { user_id: PEOPLE[who].id, name: PEOPLE[who].name, image: FACES[who], role, is_me: who === "me", presence, counts: countStates(list), sessions: list, total: list.length };
  };
  const roleSessions = sessions(ORG_SEEDS.role, PEOPLE.me.id, ORG_ROLE.id);
  return {
    workspace: { kind: "team", id: "hero-team", name: "Acme" },
    people: [person("me", "owner", "online"), person("sarah", "member", "online")],
    roles: [
      {
        _id: ORG_ROLE.id,
        short_id: ORG_ROLE.shortId,
        scope_type: "team",
        team_id: "hero-team",
        host_user_id: PEOPLE.me.id,
        name: ORG_ROLE.name,
        handle: ORG_ROLE.handle,
        scope: { project_ids: ["hero-project-billing"], plan_ids: ["hero-plan-1"] },
        reports_to: { kind: "user", user_id: PEOPLE.me.id },
        status: "active",
        charter: ORG_ROLE.charter,
        created_by: PEOPLE.me.id,
        created_at: now - 40 * 24 * HOUR,
        updated_at: now - 5 * MIN,
        counts: countStates(roleSessions),
        sessions: roleSessions,
        total: 14,
        standing: { conversation_id: "hero-s-billing", short_id: ORG_ROLE.standing.shortId, state: "working", state_line: ORG_ROLE.standing.line, state_status: "working", state_at: now - 3 * MIN },
        scope_names: { projects: [{ id: "hero-project-billing", title: "Billing" }], plans: [{ id: "hero-plan-1", title: OBJECTS.plan.title, short_id: OBJECTS.plan.shortId }] },
      },
    ],
    anchors: [],
    generated_at: now,
  };
}

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
