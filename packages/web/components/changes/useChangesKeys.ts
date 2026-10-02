// The Changes keyboard (spec 6.1), bound through the shortcuts registry's
// `changes` context. The context stands only while the page is the active
// pane, and every handler declines otherwise: a visited Changes tab stays
// mounted hidden, and its `j` must not answer for the page in front.
import { createElement, Fragment, useCallback, type ReactNode } from "react";
import { formatShortcutParts, getShortcutsForAction, useShortcutAction, useShortcutContext } from "../../shortcuts";
import type { ShortcutAction } from "../../shortcuts";
import { KeyCap } from "../KeyboardShortcutsHelp";

type Handler = () => boolean;

export type ChangesKeyHandlers = {
  prevDay: Handler;
  nextDay: Handler;
  today: Handler;
  next: Handler;
  prev: Handler;
  evidence: Handler;
  open: Handler;
  waiting: Handler;
  risks: Handler;
  branches: Handler;
  mode: Handler;
  filter: Handler;
  copyLink: Handler;
  escape: Handler;
};

export function useChangesKeys(active: boolean, h: ChangesKeyHandlers): void {
  useShortcutContext("changes", active);
  const here = useCallback((fn: Handler) => () => (active ? fn() : false), [active]);
  useShortcutAction("changes.prevDay", here(h.prevDay));
  useShortcutAction("changes.nextDay", here(h.nextDay));
  useShortcutAction("changes.today", here(h.today));
  useShortcutAction("changes.next", here(h.next));
  useShortcutAction("changes.prev", here(h.prev));
  useShortcutAction("changes.evidence", here(h.evidence));
  useShortcutAction("changes.open", here(h.open));
  useShortcutAction("changes.waiting", here(h.waiting));
  useShortcutAction("changes.risks", here(h.risks));
  useShortcutAction("changes.branches", here(h.branches));
  useShortcutAction("changes.mode", here(h.mode));
  useShortcutAction("changes.filter", here(h.filter));
  useShortcutAction("changes.copyLink", here(h.copyLink));
  useShortcutAction("changes.escape", here(h.escape));
}

/** The first binding of a Changes action, as keycaps. */
export function KeyHint({ action, size = "xs" }: { action: ShortcutAction; size?: "sm" | "xs" }): ReactNode {
  const def = getShortcutsForAction(action)[0];
  if (!def) return null;
  return createElement(Fragment, null, ...formatShortcutParts(def).map((k) => createElement(KeyCap, { key: k, size }, k)));
}
