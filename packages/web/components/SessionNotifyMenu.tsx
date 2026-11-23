"use client";
import { Bell, BellDot, BellOff, BellRing } from "lucide-react";
import { broadlyMuted, sessionFolderOf } from "@codecast/convex/convex/lib/sessionWatch";
import { sessionNotifyKey, useInboxStore, useTrackedStore, type SessionNotifyLevel } from "../store/inboxStore";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type NotifyConversation = {
  _id: string;
  user_id?: string;
  project_id?: string;
  git_root?: string;
  project_path?: string;
  user?: { name?: string; email?: string } | null;
};

type Level = SessionNotifyLevel | "default";

const LEVELS: { key: Level; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "all", label: "Every message" },
  { key: "needs_input", label: "When it needs input" },
  { key: "muted", label: "Muted" },
];

const toggle = (list: string[] | undefined, id: string, on: boolean) =>
  on ? [...(list ?? []).filter((x) => x !== id), id] : (list ?? []).filter((x) => x !== id);

function useSessionNotify(conversation: NotifyConversation) {
  const key = sessionNotifyKey(conversation._id);
  const s = useTrackedStore([
    (s) => s.sessionNotify[key],
    (s) => s.currentUser?._id,
    (s) => s.currentUser?.muted_members,
    (s) => s.currentUser?.muted_projects,
    (s) => s.currentUser?.muted_folders,
    (s) => (conversation.project_id ? s.projects[conversation.project_id]?.title : undefined),
  ]);
  const me = s.currentUser;
  const level: Level = (s.sessionNotify[key] as { level: SessionNotifyLevel } | undefined)?.level ?? "default";
  const viewer = { _id: me?._id ?? "", muted_members: me?.muted_members, muted_projects: me?.muted_projects, muted_folders: me?.muted_folders };
  const broad = !!me && broadlyMuted(viewer, conversation as any);
  const folder = sessionFolderOf(conversation);
  const projectTitle: string | undefined = conversation.project_id ? (s.projects[conversation.project_id] as any)?.title : undefined;
  const teammate = me && conversation.user_id && conversation.user_id !== me._id ? conversation.user_id : null;
  const teammateName = conversation.user?.name || conversation.user?.email?.split("@")[0] || "teammate";
  return { me, level, broad, folder, projectTitle, teammate, teammateName };
}

function NotifyItems({ conversation }: { conversation: NotifyConversation }) {
  const { me, level, broad, folder, projectTitle, teammate, teammateName } = useSessionNotify(conversation);
  const setSessionNotify = useInboxStore((s) => s.setSessionNotify);
  const updateSettings = useInboxStore((s) => s.updateNotificationSettings);
  if (!me) return null;
  const folderName = folder?.split("/").filter(Boolean).pop();
  const projectMuted = !!conversation.project_id && !!me.muted_projects?.includes(conversation.project_id);
  const folderMuted = !!folder && !!me.muted_folders?.includes(folder);
  const teammateMuted = !!teammate && !!me.muted_members?.includes(teammate);
  return (
    <>
      <DropdownMenuLabel className="text-mark uppercase tracking-wide text-sol-text-dim">This session</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={level} onValueChange={(v) => setSessionNotify(conversation._id, v as Level)}>
        {LEVELS.map((l) => (
          <DropdownMenuRadioItem key={l.key} value={l.key} onSelect={(e) => e.preventDefault()}>
            {l.label}
            {l.key === "default" && broad && <span className="ml-auto pl-3 text-sol-text-dim">muted</span>}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {(conversation.project_id || folder || teammate) && <DropdownMenuSeparator />}
      {(conversation.project_id || folder || teammate) && (
        <DropdownMenuLabel className="text-mark uppercase tracking-wide text-sol-text-dim">Mute everything from</DropdownMenuLabel>
      )}
      {conversation.project_id && (
        <DropdownMenuCheckboxItem
          checked={projectMuted}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => updateSettings({ muted_projects: toggle(me.muted_projects, conversation.project_id!, on) })}
        >
          Project {projectTitle ?? ""}
        </DropdownMenuCheckboxItem>
      )}
      {folder && (
        <DropdownMenuCheckboxItem
          checked={folderMuted}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => updateSettings({ muted_folders: toggle(me.muted_folders, folder, on) })}
        >
          <span title={folder}>Folder {folderName}</span>
        </DropdownMenuCheckboxItem>
      )}
      {teammate && (
        <DropdownMenuCheckboxItem
          checked={teammateMuted}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => updateSettings({ muted_members: toggle(me.muted_members, teammate, on) })}
        >
          {teammateName}
        </DropdownMenuCheckboxItem>
      )}
    </>
  );
}

function LevelIcon({ level, broad, className }: { level: Level; broad: boolean; className: string }) {
  if (level === "all") return <BellRing className={className} />;
  if (level === "needs_input") return <BellDot className={className} />;
  if (level === "muted" || broad) return <BellOff className={className} />;
  return <Bell className={className} />;
}

const LEVEL_TITLE: Record<Level, string> = {
  default: "Notifications",
  all: "Notifying on every message",
  needs_input: "Notifying when it needs input",
  muted: "Muted",
};

/** The session menu's Notifications submenu. */
export function SessionNotifySubmenu({ conversation }: { conversation: NotifyConversation }) {
  const { level, broad } = useSessionNotify(conversation);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <LevelIcon level={level} broad={broad} className="w-3.5 h-3.5 mr-2" />
        Notifications
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[14rem]">
        <NotifyItems conversation={conversation} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A bell in the header row, shown only while the session is not on default
 *  (subscribed, or muted by any rule), opening the same controls. */
export function SessionNotifyIndicator({ conversation }: { conversation: NotifyConversation }) {
  const { level, broad } = useSessionNotify(conversation);
  if (level === "default" && !broad) return null;
  const title = level === "default" ? "Muted by a project, folder or teammate mute" : LEVEL_TITLE[level];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-cc-keep
          aria-label={title}
          title={title}
          className={`p-1 rounded hover:bg-sol-bg-alt transition-colors ${level === "all" || level === "needs_input" ? "text-sol-yellow" : "text-sol-text-dim"}`}
        >
          <LevelIcon level={level} broad={broad} className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        <NotifyItems conversation={conversation} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
