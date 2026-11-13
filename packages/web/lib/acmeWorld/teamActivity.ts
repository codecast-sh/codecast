// The team feed (/team/activity): what Acme's teammates' sessions did on the
// webhook retry work, as the server's team page sends it. Alex's own rows
// come from the inbox; these are the teammates', drawn from the shared
// teammate list (./teamSessions) and the teammates' inbox rows (./inbox). Mobile's
// Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { TEAM_SESSIONS as INBOX_TEAM } from "./inbox";
import { TEAM_SESSIONS, type TeamSession } from "./teamSessions";
import { MIN, PEOPLE } from "./world";

/** The teammates' sessions that are also inbox rows (./inbox), at the same ids:
 *  Maya's dead-letter worker running now (the Now strip) and Sarah's HMAC one. */
const LIVE: TeamSession[] = [
  { ...INBOX_TEAM.dlq, who: PEOPLE.maya, ago: 50_000, project: "~/src/billing", messages: 41, state: "working" },
  { ...INBOX_TEAM.hmac, who: PEOPLE.sarah, ago: 9 * MIN, project: "~/src/billing", messages: 22, state: "done" },
];
const { dlq: _dlq, hmac: _hmac, ...HISTORY } = TEAM_SESSIONS;

const FEED = (now: number) =>
  [...LIVE, ...Object.values(HISTORY)].map((t) => ({
    _id: t._id,
    short_id: t.short_id,
    user_id: t.who._id,
    author_name: t.who.name,
    author_avatar: t.who.image,
    is_own: false,
    title: t.title,
    agent_type: t.agent_type,
    project_path: t.project,
    git_root: t.project,
    started_at: now - t.ago - 40 * MIN,
    updated_at: now - t.ago,
    duration_ms: 40 * MIN,
    message_count: t.messages,
    is_active: t.state === "working",
    is_private: false,
    team_visibility: "full",
    visibility_mode: "full" as const,
  }));

export const TEAM_ACTIVITY_PART: AcmePart = {
  name: "teamActivity",
  answers: {
    // The team feed only; a personal feed asks with another filter.
    "conversations:listConversations": (args) => (args?.filter === "team" ? { conversations: FEED(Date.now()), nextCursor: null, isDone: true } : undefined),
  },
};
