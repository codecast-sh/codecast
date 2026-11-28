"use client";
import { Bell, BellDot, BellOff, BellRing } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import {
  mutePatch,
  NOTIFY_LEVEL_TITLE,
  NOTIFY_LEVELS,
  useSessionNotify,
  type NotifyConversation,
  type NotifyLevelChoice,
  type SessionNotifyView,
} from "../lib/sessionNotify";
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

function NotifyItems({ conversation, view }: { conversation: NotifyConversation; view: SessionNotifyView }) {
  const setSessionNotify = useInboxStore((s) => s.setSessionNotify);
  const updateSettings = useInboxStore((s) => s.updateNotificationSettings);
  if (!view.me) return null;
  const { level, broad, project, folder, teammate } = view;
  const hasScopes = !!(project || folder || teammate);
  return (
    <>
      <DropdownMenuLabel className="text-mark uppercase tracking-wide text-sol-text-dim">This session</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={level} onValueChange={(v) => setSessionNotify(conversation._id, v as NotifyLevelChoice)}>
        {NOTIFY_LEVELS.map((l) => (
          <DropdownMenuRadioItem key={l.key} value={l.key} onSelect={(e) => e.preventDefault()}>
            {l.label}
            {l.key === "default" && broad && <span className="ml-auto pl-3 text-sol-text-dim">muted</span>}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {hasScopes && <DropdownMenuSeparator />}
      {hasScopes && <DropdownMenuLabel className="text-mark uppercase tracking-wide text-sol-text-dim">Mute everything from</DropdownMenuLabel>}
      {project && (
        <DropdownMenuCheckboxItem checked={project.muted} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => updateSettings(mutePatch(view, "project", on))}>
          Project {project.title}
        </DropdownMenuCheckboxItem>
      )}
      {folder && (
        <DropdownMenuCheckboxItem checked={folder.muted} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => updateSettings(mutePatch(view, "folder", on))}>
          <span title={folder.path}>Folder {folder.name}</span>
        </DropdownMenuCheckboxItem>
      )}
      {teammate && (
        <DropdownMenuCheckboxItem checked={teammate.muted} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => updateSettings(mutePatch(view, "teammate", on))}>
          {teammate.name}
        </DropdownMenuCheckboxItem>
      )}
    </>
  );
}

function LevelIcon({ level, broad, className }: { level: NotifyLevelChoice; broad: boolean; className: string }) {
  if (level === "all") return <BellRing className={className} />;
  if (level === "needs_input") return <BellDot className={className} />;
  if (level === "muted" || broad) return <BellOff className={className} />;
  return <Bell className={className} />;
}

/** The session menu's Notifications submenu. */
export function SessionNotifySubmenu({ conversation }: { conversation: NotifyConversation }) {
  const view = useSessionNotify(conversation);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <LevelIcon level={view.level} broad={view.broad} className="w-3.5 h-3.5 mr-2" />
        Notifications
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[14rem]">
        <NotifyItems conversation={conversation} view={view} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A bell in the header row, shown only while the session is not on default
 *  (subscribed, or muted by any rule), opening the same controls. */
export function SessionNotifyIndicator({ conversation }: { conversation: NotifyConversation }) {
  const view = useSessionNotify(conversation);
  const { level, broad } = view;
  if (level === "default" && !broad) return null;
  const title = level === "default" ? "Muted by a project, folder or teammate mute" : NOTIFY_LEVEL_TITLE[level];
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
        <NotifyItems conversation={conversation} view={view} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
