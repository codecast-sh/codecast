// What the People chart reads from the store beyond the org tree, every piece
// of it derived here so the layout and the cards see one answer:
//  - a session card's detail: where it stands (its pinned state's card line,
//    else its idle summary), the task it is bound to, and the last few
//    messages the store has loaded for it (an open card lists them);
//  - which project a session works on (its bound task's or plan's project),
//    which places it under that project on the Everything chart;
//  - an open role card's lists: the projects it leads and the open tasks in its area.
// Each comes with a signature over exactly the fields it reads, so the chart
// re-lays out when a line, a task or a message changes and never on a heartbeat.
import { threadStateCardLine } from "@codecast/shared/contracts";
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";
import type { InboxSession, Message } from "../../store/inboxStore";
import type { OrgSessionDetail, RoleOpenDetail } from "./orgCardModel";
import type { OrgRole } from "./orgTypes";

export type { OrgSessionDetail };

type DetailRow = Pick<InboxSession, "thread_state" | "idle_summary" | "active_task"> & { active_plan?: { _id: string } | null } | null | undefined;
type Msgs = readonly Pick<Message, "_id" | "role" | "content">[] | undefined;

/** How many of a session's latest messages an open card shows. */
const MESSAGES = 3;
const MESSAGE_CHARS = 400;

const said = (m: Pick<Message, "role" | "content">): { who: string; text: string } | null => {
  if (m.role !== "user" && m.role !== "assistant") return null;
  const text = (m.content ?? "").replace(/\s+/g, " ").trim();
  return text ? { who: m.role === "user" ? "you" : "agent", text: text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS - 1)}…` : text } : null;
};

export function sessionDetailOf(row: DetailRow, messages?: Msgs): OrgSessionDetail {
  const pinned = row?.thread_state?.trim() ? threadStateCardLine(row.thread_state) : "";
  const line = pinned || row?.idle_summary?.trim() || null;
  const t = row?.active_task;
  const latest: { who: string; text: string }[] = [];
  for (let i = (messages?.length ?? 0) - 1; i >= 0 && latest.length < MESSAGES; i--) { const m = said(messages![i]); if (m) latest.unshift(m); }
  return { line, task: t?.short_id ? { short_id: t.short_id, title: t.title ?? "" } : null, ...(latest.length ? { messages: latest } : {}) };
}

const lastId = (m: Msgs) => (m?.length ? `${m.length}:${m[m.length - 1]._id}` : "");

/** A key over exactly what the cards draw for these sessions. */
export function sessionDetailsSig(ids: readonly string[], sessions: Record<string, DetailRow>, messages: Record<string, Msgs> = {}): string {
  let out = "";
  for (const id of ids) {
    const r = sessions[id];
    if (!r) continue;
    out += `${id}\u0001${r.thread_state ?? ""}\u0001${r.idle_summary ?? ""}\u0001${r.active_task?.short_id ?? ""}\u0001${r.active_task?.title ?? ""}\u0001${lastId(messages[id])}\u0002`;
  }
  return out;
}

export function sessionDetailsOf(ids: readonly string[], sessions: Record<string, DetailRow>, messages: Record<string, Msgs> = {}): Record<string, OrgSessionDetail> {
  const out: Record<string, OrgSessionDetail> = {};
  for (const id of ids) {
    const d = sessionDetailOf(sessions[id], messages[id]);
    if (d.line || d.task || d.messages) out[id] = d;
  }
  return out;
}

type ProjectOf = { project_id?: string | null };

/** Which project each session works on: its bound task's project, else its plan's. */
export function sessionProjectsOf(ids: readonly string[], sessions: Record<string, DetailRow>, tasks: Record<string, unknown>, plans: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const r = sessions[id];
    const viaTask = r?.active_task?._id ? (tasks[r.active_task._id] as ProjectOf | undefined)?.project_id : undefined;
    const viaPlan = r?.active_plan?._id ? (plans[r.active_plan._id] as ProjectOf | undefined)?.project_id : undefined;
    const pid = viaTask || viaPlan;
    if (pid) out[id] = pid;
  }
  return out;
}

export const sessionProjectsSig = (map: Record<string, string>) => Object.keys(map).sort().map((k) => `${k}:${map[k]}`).join("|");

type TaskRow = { _id: string; short_id: string; title: string; status: string; updated_at?: number; project_id?: string | null; plan?: { _id: string } | null; plan_id?: string | null };
type ProjectRow = { _id: string; title: string; short_id?: string; status?: string; owner_role_id?: string };

const CLOSED_TASK = new Set(["done", "dropped", "cancelled"]);
/** How many open tasks an open role card lists. */
const TASKS = 5;

/** What each listed role's open card shows: the projects it leads (the shared rule) and the open tasks in its area. */
export function roleDetailsOf(roleIds: readonly string[], roles: readonly OrgRole[], projects: Record<string, unknown>, tasks: Record<string, unknown>): Record<string, RoleOpenDetail> {
  const out: Record<string, RoleOpenDetail> = {};
  if (!roleIds.length) return out;
  const projectRows = Object.values(projects) as ProjectRow[];
  const taskRows = (Object.values(tasks) as TaskRow[]).filter((t) => t && !CLOSED_TASK.has(t.status));
  for (const id of roleIds) {
    const role = roles.find((r) => r._id === id);
    if (!role) continue;
    const leads = projectRows.filter((p) => { const l = projectLeadOf(p, roles); return l.kind === "lead" && String(l.role._id) === id && l.by !== "workspace"; })
      .map((p) => ({ id: p._id, title: p.title, ...(p.short_id ? { short_id: p.short_id } : {}) }));
    const area = new Set([...role.scope.project_ids, ...leads.map((p) => p.id)]);
    const plans = new Set(role.scope.plan_ids);
    const open = taskRows.filter((t) => (t.project_id && area.has(t.project_id)) || plans.has(t.plan?._id ?? t.plan_id ?? ""))
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, TASKS)
      .map((t) => ({ id: t._id, short_id: t.short_id, title: t.title, status: t.status }));
    out[id] = { leads, tasks: open };
  }
  return out;
}

export const roleDetailsSig = (d: Record<string, RoleOpenDetail>) => JSON.stringify(d);
