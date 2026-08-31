import { Archive, Clock, Moon, Pin, Square, Tag, type LucideIcon } from "lucide-react";
import type { ShortcutAction } from "../../shortcuts/registry";

// The triage vocabulary, in one place. The bar, the intro tour, and any
// future surface render from this catalog so the icon, the color, and the
// one-line meaning of each verb never drift between surfaces. The icons and
// accents match the ones the session context menu and the card hover toolbar
// already established (menus/ObjectContextMenus.tsx, GlobalSessionPanel.tsx).

export type TriageVerbId = "defer" | "dormant" | "stash" | "kill" | "pin" | "label";

export interface TriageVerb {
  id: TriageVerbId;
  /** The registry action whose binding renders on the button. */
  action: ShortcutAction;
  label: string;
  /** Past tense, for the "just happened" feedback line. */
  done: string;
  icon: LucideIcon;
  /** One plain line on what the verb does. Tooltips and the tour show it. */
  blurb: string;
  /**
   * Accent classes. Tailwind needs literal class strings, so each verb
   * carries its own. `hover` styles the bar button; `text` and `bg` style
   * the tour's verb rows.
   */
  hover: string;
  text: string;
  bg: string;
  danger?: boolean;
}

/**
 * The four parking verbs: what you do with a card when you are not going to
 * reply right now. Ordered by escalation, lightest first.
 */
export const PARK_VERBS: TriageVerb[] = [
  {
    id: "defer",
    action: "session.deferAdvance",
    label: "Defer",
    done: "Deferred",
    icon: Clock,
    blurb: "Not now. The card drops down the stack and returns on its next activity.",
    hover: "hover:text-sol-orange hover:bg-sol-orange/10",
    text: "text-sol-orange",
    bg: "bg-sol-orange/10",
  },
  {
    id: "dormant",
    action: "session.dormantAdvance",
    label: "Dormant",
    done: "Dormant",
    icon: Moon,
    blurb: "Parked. A machine wakes it: a trigger, a watcher, another session.",
    hover: "hover:text-sol-blue hover:bg-sol-blue/10",
    text: "text-sol-blue",
    bg: "bg-sol-blue/10",
  },
  {
    id: "stash",
    action: "session.stash",
    label: "Stash",
    done: "Stashed",
    icon: Archive,
    blurb: "Out of the inbox. The agent keeps running out of sight.",
    hover: "hover:text-sol-yellow hover:bg-sol-yellow/10",
    text: "text-sol-yellow",
    bg: "bg-sol-yellow/10",
  },
  {
    id: "kill",
    action: "session.kill",
    label: "Kill",
    done: "Killed",
    icon: Square,
    blurb: "Done with it. Tears the agent down; the transcript stays.",
    hover: "hover:text-sol-red hover:bg-sol-red/10",
    text: "text-sol-red",
    bg: "bg-sol-red/10",
    danger: true,
  },
];

/** The two filing verbs: organize without removing. */
export const FILE_VERBS: TriageVerb[] = [
  {
    id: "pin",
    action: "session.pin",
    label: "Pin",
    done: "Pinned",
    icon: Pin,
    blurb: "Keeps this session at the top of the list.",
    hover: "hover:text-sol-magenta hover:bg-sol-magenta/10",
    text: "text-sol-magenta",
    bg: "bg-sol-magenta/10",
  },
  {
    id: "label",
    action: "session.moveToBucket",
    label: "Label",
    done: "Labeled",
    icon: Tag,
    blurb: "Files this session under a label.",
    hover: "hover:text-sol-cyan hover:bg-sol-cyan/10",
    text: "text-sol-cyan",
    bg: "bg-sol-cyan/10",
  },
];

export const TRIAGE_VERBS: TriageVerb[] = [...PARK_VERBS, ...FILE_VERBS];
