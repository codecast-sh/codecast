import type { ComponentType } from "react";
import { Archive, ArrowUp, Bot, CircleDot, Clock, Copy, CornerDownRight, Cpu, ExternalLink, EyeOff, FileText, Folder, Forward, GitBranch, Link, Moon, Pencil, Pin, PinOff, Play, RefreshCw, Square, Star, Tag, Trash2, User, CalendarDays, Plus } from "lucide-react";
import { getShortcutsForAction, inputGuardBypass, isEditableTarget, matchShortcut, type ShortcutAction } from "../shortcuts/registry";
import { canControlModel } from "./modelSwitch";
import { isForeignSession } from "./liveEntities";

export type PaletteTargetType = "session" | "task" | "doc" | "plan" | "project" | "trigger";
export type PaletteAction = {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  hotkey?: string;
  shortcutAction?: ShortcutAction;
};

export function paletteObjectPath(type: PaletteTargetType, target: any): string {
  const route = { session: "conversation", task: "tasks", doc: "docs", plan: "plans", project: "projects", trigger: "triggers" }[type];
  return `/${route}/${target._id}`;
}

export function paletteActions(type: PaletteTargetType | null, targets: any[], userId?: string, chatOn = false): PaletteAction[] {
  const target = targets[0];
  if (!type || !target) return [];
  const single = targets.length === 1;
  const row = (key: string, label: string, icon: PaletteAction["icon"], hotkey?: string, shortcutAction?: ShortcutAction): PaletteAction => ({ key, label, icon, hotkey: shortcutAction ? undefined : hotkey, shortcutAction });
  const common = single ? [
    row("open", "Open", ExternalLink, "o"),
    row("newtab", "Open in new tab", ExternalLink, "n"),
    row("copy", `Copy ${type} ID`, Copy, "i"),
    row("copylink", "Copy link", Link, "c", type === "session" ? "conv.copyLink" : undefined),
    ...(chatOn ? [row("forward", "Send to chat…", Forward, "h")] : []),
  ] : [];
  if (type === "session") {
    const own = !target.authorName && !!userId && !isForeignSession(target, target, userId);
    if (!own) return common;
    return [
      row("agent_switch", "Switch agent…", Bot, "a"),
      row("agent_fork", "Fork session as…", GitBranch, "f"),
      ...(canControlModel(target.agent_type, (target.message_count ?? 0) === 0) ? [row("model", "Change model & effort…", Cpu, "m")] : []),
      row("rename", "Rename session…", Pencil, "r", "session.rename"),
      row("session_pin", target.is_pinned ? "Unpin session" : "Pin session", target.is_pinned ? PinOff : Pin, "p", "session.pin"),
      row("session_favorite", target.is_favorite ? "Remove from favorites" : "Add to favorites", Star, "v", "conv.favorite"),
      row("bucket", "Label session…", Tag, "l", "session.moveToBucket"),
      ...((target.dismissed || target.inbox_stashed_at || target.inbox_killed_at || target.inbox_dismissed_at) ? [row("session_restore", "Restore session to inbox", RefreshCw, "u")] : [
        row("session_stash", "Stash session", Archive, "s", "session.stash"),
        row("session_stash_hide", "Stash and hide session", EyeOff, "b", "session.stashHide"),
        row("session_defer", "Defer session", Clock, "d", "session.deferAdvance"),
        row("session_dormant", "Dormant — a machine wakes it", Moon, "z", "session.dormantAdvance"),
      ]),
      ...(!target.inbox_killed_at ? [row("session_kill", "Kill session", Square, "k", "session.kill")] : []),
      ...(target.parent_conversation_id ? [row("session_parent", "View parent conversation", GitBranch)] : []),
      ...(target.git_branch ? [row("session_branch", "Copy branch name", GitBranch)] : []),
      ...(target.project_path || target.git_root ? [row("session_files", "Open project files", Folder)] : []),
      ...common,
    ];
  }
  if (type === "task") return [
    row("status", "Change status…", CircleDot, "s", "task.status"),
    row("priority", "Set priority…", ArrowUp, "p", "task.priority"),
    row("labels", "Edit labels…", Tag, "l", "task.labels"),
    row("assign", "Assign to…", User, "a", "task.assign"),
    row("project", "Move to project…", Folder, "j"),
    row("parent", "Set parent…", CornerDownRight, "t"),
    ...(targets.some(t => t.parent_id) ? [row("remove_parent", "Remove parent", CornerDownRight)] : []),
    row("agent_run", "Start agent run…", Bot, "g"),
    ...(single ? [row("rename", "Rename task…", Pencil, "r")] : []),
    ...common,
    row("drop", "Drop task", Trash2, "x"),
  ];
  if (type === "doc") return [
    row("type", "Change type…", FileText, "t", "doc.type"),
    row("labels", "Edit labels…", Tag, "l", "doc.labels"),
    ...(single ? [row("rename", "Rename document…", Pencil, "r"), row("pin", target.pinned ? "Unpin document" : "Pin document", Pin, "p")] : []),
    ...common,
    row("archive", "Archive document", Archive, "x"),
  ];
  if (type === "plan") return [
    row("plan_status", "Change status…", CircleDot, "s"),
    row("rename", "Rename plan…", Pencil, "r"),
    row("create_task", "Add task to plan…", Plus, "t"),
    ...common,
  ];
  if (type === "project") return [
    row("project_status", "Change status…", CircleDot, "s"),
    row("rename", "Rename project…", Pencil, "r"),
    row("deadline", "Set target date…", CalendarDays, "d"),
    ...(target.target_date ? [row("clear_deadline", "Clear target date", CalendarDays)] : []),
    row("create_task", "Add task to project…", Plus, "t"),
    row("create_plan", "Add plan to project…", Plus, "p"),
    row("create_doc", "Add document to project…", Plus, "f"),
    ...common,
  ];
  const armed = ["scheduled", "paused", "running"].includes(target.status);
  return [
    ...(armed ? [
      row("trigger_runNow", "Run trigger now", Play, "r"),
      target.status === "paused" ? row("trigger_resume", "Resume trigger", Play, "p") : row("trigger_pause", "Pause trigger", Square, "p"),
      row("trigger_cancel", "Cancel trigger…", Trash2, "x"),
    ] : [row("trigger_reactivate", "Reactivate trigger", RefreshCw, "r")]),
    ...(["scheduled", "paused"].includes(target.status) ? [row("trigger_edit", "Edit prompt & cadence…", Pencil, "e")] : []),
    row("trigger_duplicate", "Duplicate trigger…", Copy, "d"),
    row("trigger_prompt", "Copy prompt", Copy, "m"),
    ...(!armed ? [row("trigger_delete", "Delete trigger…", Trash2, "x")] : []),
    ...common,
  ];
}

export function paletteDigitIndex(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean }, count: number): number {
  if (event.isComposing || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey) || !/^[1-9]$/.test(event.key)) return -1;
  const index = Number(event.key) - 1;
  return index < count ? index : -1;
}

export function paletteActionForKey(event: KeyboardEvent, actions: PaletteAction[]): PaletteAction | undefined {
  if (event.isComposing || event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  return actions.find(action => {
    if (action.shortcutAction) {
      return getShortcutsForAction(action.shortcutAction).some(def =>
        matchShortcut(event, def) && (!isEditableTarget(target) || inputGuardBypass(def, target)),
      );
    }
    return event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
      && !!action.hotkey && event.code === `Key${action.hotkey.toUpperCase()}`;
  });
}
