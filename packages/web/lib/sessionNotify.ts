// How loudly the viewer hears one session, read from the store: the session's
// own level and every broader mute that covers it (its project, its folder,
// the teammate who ran it). One reader for the web menu and the phone sheet,
// so both show the same state and write the same fields. Relative imports
// only: the phone bundle reaches this file.
import { broadlyMuted, sessionFolderOf } from "@codecast/convex/convex/lib/sessionWatch";
import { useTrackedStore } from "../store/inboxStore";
import { sessionNotifyKey, type SessionNotifyLevel } from "../store/sessionNotifyTypes";

export type NotifyConversation = {
  _id: string;
  user_id?: string;
  project_id?: string;
  git_root?: string;
  project_path?: string;
  user?: { name?: string; email?: string } | null;
};

export type NotifyLevelChoice = SessionNotifyLevel | "default";

export const NOTIFY_LEVELS: { key: NotifyLevelChoice; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "all", label: "Every message" },
  { key: "needs_input", label: "When it needs input" },
  { key: "muted", label: "Muted" },
];

export const NOTIFY_LEVEL_TITLE: Record<NotifyLevelChoice, string> = {
  default: "Notifications",
  all: "Notifying on every message",
  needs_input: "Notifying when it needs input",
  muted: "Muted",
};

/** A muted-list with `id` added (on) or taken out (off). */
export function toggleMuted(list: readonly string[] | undefined, id: string, on: boolean): string[] {
  const rest = (list ?? []).filter((x) => x !== id);
  return on ? [...rest, id] : rest;
}

/** What the controls show for one session, and what each mute would write. */
export function useSessionNotify(conversation: NotifyConversation) {
  const key = sessionNotifyKey(conversation._id);
  const s = useTrackedStore([
    (s) => s.sessionNotify[key],
    (s) => s.currentUser?._id,
    (s) => s.currentUser?.muted_members,
    (s) => s.currentUser?.muted_projects,
    (s) => s.currentUser?.muted_folders,
    (s) => (conversation.project_id ? (s.projects[conversation.project_id] as any)?.title : undefined),
  ]);
  const me = s.currentUser;
  const level: NotifyLevelChoice = (s.sessionNotify[key] as { level: SessionNotifyLevel } | undefined)?.level ?? "default";
  const viewer = { _id: me?._id ?? "", muted_members: me?.muted_members, muted_projects: me?.muted_projects, muted_folders: me?.muted_folders };
  const broad = !!me && broadlyMuted(viewer, conversation as any);
  const folder = sessionFolderOf(conversation);
  const projectId = conversation.project_id ?? null;
  const teammate = me && conversation.user_id && conversation.user_id !== me._id ? conversation.user_id : null;
  return {
    me,
    level,
    /** Silenced by a project, folder or teammate mute (the session's own level wins over it). */
    broad,
    project: projectId
      ? { id: projectId, title: ((s.projects[projectId] as any)?.title as string | undefined) ?? "", muted: !!me?.muted_projects?.includes(projectId) }
      : null,
    folder: folder
      ? { path: folder, name: folder.split("/").filter(Boolean).pop() ?? folder, muted: !!me?.muted_folders?.includes(folder) }
      : null,
    teammate: teammate
      ? { id: teammate, name: conversation.user?.name || conversation.user?.email?.split("@")[0] || "teammate", muted: !!me?.muted_members?.includes(teammate) }
      : null,
  };
}

export type SessionNotifyView = ReturnType<typeof useSessionNotify>;

/** The settings patch that mutes or unmutes one of the broader scopes. */
export function mutePatch(
  view: SessionNotifyView,
  scope: "project" | "folder" | "teammate",
  on: boolean,
): { muted_projects?: string[]; muted_folders?: string[]; muted_members?: string[] } {
  const me = view.me;
  if (scope === "project" && view.project) return { muted_projects: toggleMuted(me?.muted_projects, view.project.id, on) };
  if (scope === "folder" && view.folder) return { muted_folders: toggleMuted(me?.muted_folders, view.folder.path, on) };
  if (scope === "teammate" && view.teammate) return { muted_members: toggleMuted(me?.muted_members, view.teammate.id, on) };
  return {};
}
