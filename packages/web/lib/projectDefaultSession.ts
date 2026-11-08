import type { InboxSession } from "../store/inboxStore";

export type ProjectRow = { _id: string; title?: string; goal?: string; description?: string; project_path?: string; owner_role_id?: string; default_session_id?: string };
export type RoleSeat = { _id: string; standing?: { conversation_id: string } | null };

/** The project's default session id: its seated lead's standing session, else
 *  its canonical session (the server's pointer, or the stub its composer just
 *  started, which the server's pointer replaces once it lands). */
export function projectDefaultSessionOf(
  project: ProjectRow,
  sessions: Record<string, InboxSession>,
  roles: readonly RoleSeat[] = [],
): string | null {
  if (project.owner_role_id) {
    const lead = String(project.owner_role_id);
    const seat = roles.find((r) => String(r._id) === lead)?.standing?.conversation_id
      ?? Object.values(sessions).find((s) => s.standing_role_id && String(s.standing_role_id) === lead)?._id;
    if (seat) return seat;
  }
  if (project.default_session_id) return project.default_session_id;
  return Object.values(sessions).find((s) => s._projectDefault && s.project_id === project._id)?._id ?? null;
}
