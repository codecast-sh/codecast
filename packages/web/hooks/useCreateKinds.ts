import { useMemo } from "react";
import { Clock, FileText, Hash, Headphones, ListTodo, Map as MapIcon, MessageSquare, PanelBottom, type LucideIcon } from "lucide-react";
import { useInboxStore, type CreateModalKind } from "../store/inboxStore";
import { useCallsAvailable, useTeamFeature } from "../lib/teamFeatures";
import type { ShortcutAction } from "../shortcuts";

/** How a create reaches its surface. Each host supplies its own: the command
 *  palette closes itself first and, as its own Electron window, hands compose
 *  and navigation back to the main window. */
export type CreateEnv = {
  compose: (dock: boolean) => void;
  openModal: (kind: CreateModalKind) => void;
  navigate: (href: string) => void;
};

export type CreateKind = {
  id: string;
  /** The full name, for a list that mixes creates with other commands. */
  label: string;
  /** The name under a "New" heading. */
  noun: string;
  keywords: string;
  icon: LucideIcon;
  tone: string;
  /** Picks the row while its menu is open. */
  key?: string;
  /** The global shortcut that creates it from anywhere. */
  shortcut?: ShortcutAction;
  /** A variant of the row above it, offered only where every command is. */
  variant?: boolean;
  run: (env: CreateEnv) => void;
};

/** Everything a person can create, in order, filtered to what this
 *  workspace offers. The header's New menu and the palette's Create
 *  group both render this list. */
export function useCreateKinds(): CreateKind[] {
  const chatOn = useTeamFeature("chat");
  const callsOn = useCallsAvailable();
  return useMemo(() => {
    const kinds: Array<CreateKind | false> = [
      { id: "session", label: "New session", noun: "Session", keywords: "session conversation start agent compose run ask", icon: MessageSquare, tone: "text-sol-cyan", key: "s", shortcut: "session.compose", run: (env) => env.compose(false) },
      { id: "session-docked", label: "New session (docked)", noun: "Session (docked)", keywords: "session conversation docked small composer minimize corner", icon: PanelBottom, tone: "text-sol-cyan", shortcut: "session.composeDock", variant: true, run: (env) => env.compose(true) },
      { id: "task", label: "New task", noun: "Task", keywords: "create todo to-do task add", icon: ListTodo, tone: "text-sol-cyan", key: "t", shortcut: "task.create", run: (env) => env.openModal("task") },
      { id: "doc", label: "New document", noun: "Doc", keywords: "create note doc document write", icon: FileText, tone: "text-sol-text-dim", key: "d", run: (env) => env.openModal("doc") },
      { id: "plan", label: "New plan", noun: "Plan", keywords: "create project", icon: MapIcon, tone: "text-sol-yellow", key: "p", run: (env) => env.openModal("plan") },
      chatOn && { id: "channel", label: "New channel", noun: "Channel", keywords: "create chat room", icon: Hash, tone: "text-sol-cyan", key: "c", run: (env) => env.openModal("chat") },
      callsOn && { id: "huddle", label: "Start huddle", noun: "Huddle", keywords: "new call ring people group voice", icon: Headphones, tone: "text-sol-violet", key: "h", run: (env) => env.openModal("huddle") },
      { id: "trigger", label: "New trigger", noun: "Trigger", keywords: "create trigger routine schedule cron automation reminder recurring", icon: Clock, tone: "text-sol-violet", key: "r", run: (env) => env.navigate("/triggers?new=1") },
    ];
    return kinds.filter((k): k is CreateKind => !!k);
  }, [chatOn, callsOn]);
}

/** The env for a surface inside the main window. */
export function inAppCreateEnv(navigate: (href: string) => void): CreateEnv {
  const store = useInboxStore.getState;
  return {
    compose: (dock) => store().openCompose(undefined, undefined, { dock }),
    openModal: (kind) => store().openCreateModal(kind),
    navigate,
  };
}
