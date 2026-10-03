// The Changes keyboard (spec 6.1), bound through the shortcuts registry's
// `changes` context. The context stands only while the page is the active
// pane, and every handler declines otherwise: a visited Changes tab stays
// mounted hidden, and its `j` must not answer for the page in front. They
// decline as well while a menu is open over the page.
import { useCallback } from "react";
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

/** An open menu or listbox owns the keyboard: its arrows, letters, Enter and Escape are its own. */
export function layerOpen(doc: Pick<Document, "querySelector"> = document): boolean {
  return !!doc.querySelector('[role="menu"][data-state="open"], [role="listbox"][data-state="open"]');
}

/**
 * Whether Enter belongs to the focused control and not to the story around
 * it: a commit link, a session pill or "+149 more files" inside a story acts
 * on Enter itself. The story's own control (its trigger, or the week's story
 * button) is the one control whose Enter is the evidence key.
 */
export function keepsOwnEnter(active: Element | null): boolean {
  const ctl = active?.closest("button, a, input, [role=menuitem]");
  return !!ctl && !ctl.matches("[data-story-trigger]") && !ctl.matches("button[data-story-key]");
}

/** The commit page the focused control belongs to, when focus is in a commit row of an evidence drawer (`o` opens it, spec 3.3). */
export function focusedCommitHref(active: Element | null): string | null {
  return active?.closest<HTMLElement>("[data-commit-href]")?.dataset.commitHref ?? null;
}

export type EscapeStep = "clear-text" | "leave-field" | "close-story" | "clear-filters" | "close-filter" | null;

/**
 * What one Escape does. In the filter field it works on the field first: the
 * typed text goes, chips stay; a second press leaves the field. Anywhere else
 * it closes the open evidence, then clears every filter, then closes the
 * filter bar.
 */
export function escapeStep(s: { inFilterField: boolean; q: string | undefined; story: string | undefined; filtered: boolean; filterOpen: boolean }): EscapeStep {
  if (s.inFilterField) return s.q ? "clear-text" : "leave-field";
  if (s.story) return "close-story";
  if (s.filtered) return "clear-filters";
  return s.filterOpen ? "close-filter" : null;
}

export function useChangesKeys(active: boolean, h: ChangesKeyHandlers): void {
  useShortcutContext("changes", active);
  // One gate for every key: the page must be the active pane, with no menu open over it.
  const here = useCallback((fn: Handler) => () => (active && !layerOpen() ? fn() : false), [active]);
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
export function KeyHint({ action, size = "xs" }: { action: ShortcutAction; size?: "sm" | "xs" }) {
  const def = getShortcutsForAction(action)[0];
  if (!def) return null;
  return <>{formatShortcutParts(def).map((k) => <KeyCap key={k} size={size}>{k}</KeyCap>)}</>;
}

/**
 * After a day or week travel, the keyboard lands on the header's date label
 * when the control it was on left with the old view (a story's trigger, now
 * unmounted) and fell to the body; the label is a polite live region, so the
 * new day is said. Focus anywhere else on the page stays where it is.
 */
export function landTravelFocus(root: HTMLElement) {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && active.isConnected) return;
  root.querySelector<HTMLElement>("[data-changes-date]")?.focus({ preventScroll: true });
}
