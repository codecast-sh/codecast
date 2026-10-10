// What a session card says at close zoom beyond its title (orgZoom): the line
// that says where the session stands, and the task it is bound to. Both come
// from the session's inbox row in the store, never from a query of the chart's
// own. The layout books the card's height from the same detail the card draws
// (orgLayout.sessionCloseHeight), so the two cannot disagree.
import { threadStateCardLine } from "@codecast/shared/contracts";
import type { InboxSession } from "../../store/inboxStore";
import type { OrgSessionDetail } from "./orgLayout";

export type { OrgSessionDetail };

type DetailRow = Pick<InboxSession, "thread_state" | "idle_summary" | "active_task"> | null | undefined;

export function sessionDetailOf(row: DetailRow): OrgSessionDetail {
  const pinned = row?.thread_state?.trim() ? threadStateCardLine(row.thread_state) : "";
  const line = pinned || row?.idle_summary?.trim() || null;
  const t = row?.active_task;
  return { line, task: t?.short_id ? { short_id: t.short_id, title: t.title ?? "" } : null };
}

/** A key over exactly what the close cards draw for these sessions: the chart
 *  re-lays out when a line or a task changes, never on a heartbeat. */
export function sessionDetailsSig(ids: readonly string[], sessions: Record<string, DetailRow>): string {
  let out = "";
  for (const id of ids) {
    const r = sessions[id];
    if (!r) continue;
    out += `${id}\u0001${r.thread_state ?? ""}\u0001${r.idle_summary ?? ""}\u0001${r.active_task?.short_id ?? ""}\u0001${r.active_task?.title ?? ""}\u0002`;
  }
  return out;
}

export function sessionDetailsOf(ids: readonly string[], sessions: Record<string, DetailRow>): Record<string, OrgSessionDetail> {
  const out: Record<string, OrgSessionDetail> = {};
  for (const id of ids) {
    const d = sessionDetailOf(sessions[id]);
    if (d.line || d.task) out[id] = d;
  }
  return out;
}
