// The plan detail the plan page asks for (plans.webGet): the world's plan row
// with its tasks, the sessions working it and its progress, the joins the
// server adds. Answered by the offline Convex client (./convexStub).

import { computePlanProgress } from "../liveEntities";
import { INBOX, PLANS, TASKS } from "./world";

export function planDetail(now: number, a: { id?: string; short_id?: string }) {
  const plan = PLANS(now).find((p) => p._id === a.id || p.short_id === a.short_id);
  if (!plan) return null;
  const tasks = TASKS(now).filter((t) => t.plan_id === plan._id);
  const sessions = INBOX(now)
    .filter((r) => plan.conversation_ids.includes(r._id))
    .map((r) => ({ ...r, is_active: r.agent_status === "working" }));
  return { ...plan, tasks, sessions, task_ids: tasks.map((t) => t._id), progress: computePlanProgress(tasks), comments: [] };
}

export const PLAN_ANSWERS = {
  "plans:webGet": (a: any) => planDetail(Date.now(), a),
};
