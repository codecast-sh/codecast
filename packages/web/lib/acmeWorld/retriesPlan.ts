// The live side of the core "Webhook retries" plan (./world PLANS, TASKS):
// Maya's dashboard session working its retry history task, the live agent on
// each in-progress task (tasks.webActiveSessions, what the plan's
// Orchestration tab and the task rows' agent pills read), and the task detail
// the task page asks for (taskMining.webGetTaskDetail). Mobile's Metro reaches
// this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { MAYA_DASHBOARD, PEOPLE, SESSIONS, TASKS, session } from "./world";

const live = (s: { _id: string; title: string; agent_type: string }, by: string, ago: number, now: number) => ({
  _id: s._id,
  session_id: `${s._id}-sess`,
  title: s.title,
  agent_type: s.agent_type,
  agent_status: "working",
  started_by: by,
  last_message_at: now - ago,
});

/** Each in-progress plan task's working agent, by task id. */
export const ACTIVE_TASK_SESSIONS = (now: number) => ({
  "hero-t1": live(SESSIONS.lead, PEOPLE.me.name, 20_000, now),
  "hero-t9": live(MAYA_DASHBOARD, PEOPLE.maya.name, 60_000, now),
});

const LINKABLE = [SESSIONS.lead, MAYA_DASHBOARD];

const detail = (a: any) => {
  const t: any = TASKS(Date.now()).find((r) => r._id === a?.id || r.short_id === a?.id);
  if (!t) return undefined;
  const linked = LINKABLE.filter((s) => (t.conversation_ids ?? []).includes(s._id));
  return { ...t, linked_conversations: linked.map((s) => ({ _id: s._id, title: s.title, agent_type: s.agent_type, short_id: s.short_id })) };
};

export const MAYA_DASHBOARD_SESSION = (now: number) =>
  session(now, MAYA_DASHBOARD, {
    ago: 60_000,
    waiting: "working",
    project: "~/src/billing",
    messages: 31,
    owner: PEOPLE.maya,
    state: "Attempt history renders per webhook\nStatus: wiring the Retry button",
  });

export const RETRIES_PLAN_PART: AcmePart = {
  name: "retriesPlan",
  sessions: (now) => [MAYA_DASHBOARD_SESSION(now)],
  answers: {
    // The task feed's bootstrap read: the world's tasks, so the list settles instead of syncing.
    "tasks:webList": () => ({ items: TASKS(Date.now()) }),
    "tasks:webActiveSessions": () => ACTIVE_TASK_SESSIONS(Date.now()),
    "taskMining:webGetTaskDetail": detail,
  },
};
