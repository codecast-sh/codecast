import { useMemo } from "react";
import { Clock, FileText, Hash, Headphones, ListTodo, Map as MapIcon, MessageSquare, PanelBottom, type LucideIcon } from "lucide-react";
import { useInboxStore, type CreateModalKind } from "../store/inboxStore";
import { useCallsAvailable, useTeamFeature } from "../lib/teamFeatures";
import { useHostedMode, useModeWords, useSurfaceMode } from "../lib/surfaces";
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
 *  workspace and mode offer. The header's New menu and the palette's Create
 *  group both render this list. */
export function useCreateKinds(): CreateKind[] {
  const words = useModeWords();
  const mode = useSurfaceMode();
  const hosted = useHostedMode();
  const chatOn = useTeamFeature("chat");
  const callsOn = useCallsAvailable();
  return useMemo(() => {
    const lead = hosted ? "text-sol-text-dim" : "text-sol-cyan";
    const kinds: Array<CreateKind | false> = [
      { id: "session", label: words.newConversation, noun: words.conversation, keywords: "session conversation start agent compose run ask", icon: MessageSquare, tone: lead, key: "s", shortcut: "session.compose", run: (env) => env.compose(false) },
      mode.shows("actions.fleet") && { id: "session-docked", label: `${words.newConversation} (docked)`, noun: `${words.conversation} (docked)`, keywords: "session conversation docked small composer minimize corner", icon: PanelBottom, tone: "text-sol-cyan", shortcut: "session.composeDock", variant: true, run: (env) => env.compose(true) },
      { id: "task", label: words.newTask, noun: words.task, keywords: "create todo to-do task add", icon: ListTodo, tone: lead, key: "t", run: (env) => env.openModal("task") },
      { id: "doc", label: words.newDoc, noun: words.doc, keywords: "create note doc document write", icon: FileText, tone: "text-sol-text-dim", key: "d", run: (env) => env.openModal("doc") },
      // A plan is a company's page (pages.company), with no hosted page to land on.
      mode.shows("pages.company") && { id: "plan", label: "New plan", noun: "Plan", keywords: "create project", icon: MapIcon, tone: "text-sol-yellow", key: "p", run: (env) => env.openModal("plan") },
      chatOn && { id: "channel", label: "New channel", noun: "Channel", keywords: "create chat room", icon: Hash, tone: "text-sol-cyan", key: "c", run: (env) => env.openModal("chat") },
      callsOn && { id: "huddle", label: hosted ? "Start a call" : "Start huddle", noun: hosted ? "Call" : "Huddle", keywords: "new call ring people group voice", icon: Headphones, tone: "text-sol-violet", key: "h", run: (env) => env.openModal("huddle") },
      { id: "trigger", label: words.newTrigger, noun: words.trigger, keywords: "create trigger routine schedule cron automation reminder recurring", icon: Clock, tone: "text-sol-violet", key: "r", run: (env) => env.navigate("/triggers?new=1") },
    ];
    return kinds.filter((k): k is CreateKind => !!k);
  }, [words, mode, hosted, chatOn, callsOn]);
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
