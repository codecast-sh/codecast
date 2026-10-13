// Everything one app's page shares between its parts, in four contexts that
// change at different rates, so a part re-renders only for what it reads:
// the app and where you are in it (slow), who is here (presence), the room's
// stream (messages and builds), and the composer (its mode and attachments;
// the text itself is a draft store only the field subscribes to, so a
// keystroke re-renders the field and nothing else). AppPage owns them; the
// room, capsule and timeline read them.
import { createContext, useCallback, useContext, useSyncExternalStore, type Context } from "react";
import type { AppView } from "../../convex/apps";
import type { MessageView } from "../../convex/messages";
import type { TimelineEntry } from "../../convex/versions";
import type { ElementRef } from "../../convex/validators";
import type { Here } from "../data/presence";

export type Mode = "auto" | "change" | "chat";

export type AppState = {
  app: AppView;
  timeline: TimelineEntry[] | undefined;
  versionByNumber: Map<number, TimelineEntry>;
  /** The version you are looking at, or null for live. Private to you. */
  viewing: number | null;
  view: (n: number | null) => void;
  /** Have version `n` ready out of sight (the timeline's hover), so showing
   *  it is instant. */
  warm: (n: number | null) => void;
  /** Someone is reaching for the room or the timeline: load its part and
   *  its data now, so opening it draws at once. */
  prepare: (part: "room" | "timeline") => void;
  /** Flash the app column to say "this is live". */
  flashLive: () => void;
  /** When an action whose point is the app itself last ran (See it, View,
   *  Back to live, a restore): on a phone the sheet gets out of its way. */
  showAppAt: number;
  roomOpen: boolean;
  setRoomOpen: (open: boolean) => void;
  picking: boolean;
  setPicking: (on: boolean) => void;
  /** The live version on your screen. A new live version runs ahead of it
   *  while it loads, and its card keeps building until the app swaps, so
   *  everything lands in one beat. */
  landed: number;
  /** Clay is making the app's first version: what is live is still the
   *  starter (v0), and a build is on its way. */
  making: boolean;
  /** The last version that landed while you were here (0 before any): the
   *  one celebration (DESIGN 4.4.3) keys off it. */
  cheer: number;
  /** Make version `n` live again, as long as `expectedLive` (the live version
   *  you chose it against) is still live. */
  restore: (n: number, expectedLive: number) => Promise<void>;
  startFork: (n: number) => void;
  openCharacterPicker: () => void;
  /** Bring a message into view in the stream (the toast's click). */
  reveal: string | null;
  setReveal: (id: string | null) => void;
};

export type StreamState = {
  /** Oldest first. Pending (optimistic) messages carry ids starting "pending:". */
  messages: MessageView[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: () => void;
  /** The request Clay is landing or building now (else the next in line), or null.
   *  The app stays live meanwhile; the timeline's bead and the capsule say so. */
  building: MessageView | null;
};

/** The composer's text, outside React state so typing re-renders only the
 *  field that reads it (useDraft). */
export type Draft = { get: () => string; set: (text: string) => void; subscribe: (listener: () => void) => () => void };

export function createDraft(): Draft {
  let text = "";
  const listeners = new Set<() => void>();
  return {
    get: () => text,
    set: (next) => {
      if (next === text) return;
      text = next;
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const useDraft = (draft: Draft) => useSyncExternalStore(draft.subscribe, draft.get);

export type ComposerState = {
  draft: Draft;
  mode: Mode;
  setMode: (m: Mode) => void;
  element: ElementRef | null;
  setElement: (e: ElementRef | null) => void;
  /** Open the room and put the cursor in the field. */
  focus: () => void;
  /** When focus was last asked for; a part mounting later honors only a fresh ask. */
  focusAt: number;
};

/** A focus ask this recent still applies to a part that just mounted. */
const FOCUS_FRESH_MS = 1000;
export const freshFocus = (at: number) => at > 0 && Date.now() - at < FOCUS_FRESH_MS;

export const AppStateContext = createContext<AppState | null>(null);
export const HereContext = createContext<Here | null>(null);
export const StreamContext = createContext<StreamState | null>(null);
export const ComposerContext = createContext<ComposerState | null>(null);

function use<T>(context: Context<T | null>, name: string): T {
  const value = useContext(context);
  if (!value) throw new Error(`${name} outside AppPage`);
  return value;
}

export const useAppState = () => use(AppStateContext, "useAppState");
export const useHereState = () => use(HereContext, "useHereState");
export const useStream = () => use(StreamContext, "useStream");
export const useComposer = () => use(ComposerContext, "useComposer");

/** Put a change request in the composer, unsent, in Change it mode: Fix it,
 *  Edit, an idea. An element given replaces the attached one. */
export function useAskChange(): (text: string, element?: ElementRef | null) => void {
  const { setMode, draft, setElement, focus } = useComposer();
  return useCallback(
    (text: string, element?: ElementRef | null) => {
      setMode("change");
      draft.set(text);
      if (element !== undefined) setElement(element);
      focus();
    },
    [setMode, draft, setElement, focus],
  );
}

export const fixText = (error: string) => `Fix this error: ${error}`;
