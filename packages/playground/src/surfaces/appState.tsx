// Everything one app's page shares between its parts: the app, its timeline,
// who is here, the stream, which version you are viewing, the composer and
// point-and-talk. AppPage owns it; the room, capsule and timeline read it.
import { createContext, useContext } from "react";
import type { AppView } from "../../convex/apps";
import type { MessageView } from "../../convex/messages";
import type { TimelineEntry } from "../../convex/versions";
import type { ElementRef } from "../../convex/validators";
import type { Here } from "../data/presence";

export type Mode = "auto" | "change" | "chat";

/** A Clay note the shell writes itself: the app hit an error in this browser. */
export type AppErrorNote = { id: string; version: number; message: string; at: number };

export type Stream = {
  /** Oldest first. Pending (optimistic) messages carry ids starting "pending:". */
  messages: MessageView[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: () => void;
};

export type AppState = {
  app: AppView;
  timeline: TimelineEntry[] | undefined;
  versionByNumber: Map<number, TimelineEntry>;
  here: Here;
  stream: Stream;
  errorNotes: AppErrorNote[];
  /** The version you are looking at, or null for live. Private to you. */
  viewing: number | null;
  view: (n: number | null) => void;
  /** Flash the app column to say "this is live". */
  flashLive: () => void;
  roomOpen: boolean;
  setRoomOpen: (open: boolean) => void;
  composer: {
    text: string;
    setText: (t: string) => void;
    mode: Mode;
    setMode: (m: Mode) => void;
    element: ElementRef | null;
    setElement: (e: ElementRef | null) => void;
    /** Open the room and put the cursor in the field. */
    focus: () => void;
    focusTick: number;
  };
  picking: boolean;
  setPicking: (on: boolean) => void;
  /** A build is running: the timeline shows its bead. */
  building: boolean;
  restore: (n: number) => Promise<void>;
  startFork: (n: number) => void;
  openCharacterPicker: () => void;
  /** Bring a message into view in the stream (the toast's click). */
  reveal: string | null;
  setReveal: (id: string | null) => void;
};

export const AppStateContext = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const s = useContext(AppStateContext);
  if (!s) throw new Error("useAppState outside AppPage");
  return s;
}
