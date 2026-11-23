import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { isConvexId } from "../lib/entityLinks";
import { composeDocId } from "../lib/composerPresence";
import { SharedDraftSession, sharedClientId, type SharedDraftServer } from "../lib/sharedDraft";
import { usePresenceRows, type PresenceRow } from "./useDocPresence";
import { useChangedState } from "./useChangedState";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

// One session's composer as a shared draft (lib/sharedDraft): the moment
// anyone else has this conversation's composer open, this box joins the
// shared buffer and stays in it until they leave. Alone, it costs the one
// presence subscription the composer already holds.
//
// The box stays a controlled textarea. Remote edits are written to the DOM
// node at once (with the caret mapped through them) as well as to the box's
// state, so a keystroke landing in the same frame is diffed against text that
// already includes them.

/** How long a remote keystroke keeps its author marked as typing. */
const TYPING_MS = 2500;

export type SharedDraftStatus = {
  active: boolean;
  /** My caret, as an offset into the shared text. */
  caret: number | null;
  /** user id -> when their last keystroke landed here. */
  editors: Record<string, number>;
};

const IDLE: SharedDraftStatus = { active: false, caret: null, editors: {} };

// The status by conversation, for the surfaces beside the box (the presence
// strip that broadcasts my caret, the faces) without threading props through
// the composer.
const statuses = new Map<string, SharedDraftStatus>();
const listeners = new Set<() => void>();
function publish(conversationId: string, status: SharedDraftStatus | null) {
  if (status) statuses.set(conversationId, status);
  else statuses.delete(conversationId);
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useSharedDraftStatus(conversationId: string): SharedDraftStatus {
  return useSyncExternalStore(subscribe, () => statuses.get(conversationId) ?? IDLE, () => IDLE);
}

/** Who has typed into the shared draft in the last few seconds, by user id. */
export function typingEditors(editors: Record<string, number>, now = Date.now()): string[] {
  return Object.entries(editors).filter(([, at]) => now - at < TYPING_MS).map(([id]) => id);
}

/**
 * A row from someone whose box is in the shared draft, focused or not. Its
 * caret alone would not say: an unfocused box reports none, and its words
 * would be taken for a leftover nobody is in and replaced on join.
 */
export function inSharedDraft(row: PresenceRow): boolean {
  return !!row.in_draft;
}

/** Words of their own outside the shared draft: a row only carries a draft while its box is not in one. */
function holdsOwnWords(row: PresenceRow): boolean {
  return !row.in_draft && !!row.draft_text?.trim();
}

/**
 * Whether anyone else's words are in the shared draft or on their way into
 * it, so the words my box brings go under theirs and never replace them.
 */
export function othersWriting(others: readonly PresenceRow[]): boolean {
  return others.some((r) => inSharedDraft(r) || holdsOwnWords(r));
}

/**
 * Whether my box, holding words of its own, must let another box holding
 * words join first. Two boxes that join at once both find the draft empty and
 * both put their words in it, so one would replace the other or the two would
 * run together. The lower user id goes first; the other joins once that row
 * reports it is in the draft (its words are on the server by then: join
 * resolves after its edit is confirmed). An empty box never waits.
 */
export function waitsToJoin(others: readonly PresenceRow[], me: string | null, mine: string): boolean {
  if (!me || !mine.trim()) return false;
  return others.some((r) => holdsOwnWords(r) && r.user_id < me);
}

function serverOf(convex: ReturnType<typeof useConvex>): SharedDraftServer {
  return {
    snapshot: (id) => convex.query(api.docSync.getSnapshot, { id }),
    steps: (id, version) => convex.query(api.docSync.getSteps, { id, version }),
    submit: (id, version, clientId, steps) => convex.mutation(api.docSync.submitSteps, { id, version, clientId, steps }),
    saveSnapshot: (id, version, content) => convex.mutation(api.docSync.submitSnapshot, { id, version, content }),
  };
}

export function useSharedDraft(opts: {
  conversationId: string;
  enabled: boolean;
  /** The owner's box: its words replace a leftover draft nobody is in. */
  seed: boolean;
  text: string;
  setText: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}): { active: boolean; others: PresenceRow[]; editors: Record<string, number> } {
  const { conversationId, enabled, seed, text, inputRef } = opts;
  const convex = useConvex();
  const myId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const docId = composeDocId(conversationId);
  const can = enabled && !!myId && isConvexId(conversationId);
  const others = usePresenceRows(docId, can);
  // Boxes holding words join one at a time (waitsToJoin). Once this box may
  // join it stays in until everyone leaves: a later typist never pulls it out.
  const clearedRef = useRef(false);
  if (!can || others.length === 0) clearedRef.current = false;
  else if (!clearedRef.current && !waitsToJoin(others, myId, text)) clearedRef.current = true;
  const active = can && others.length > 0 && clearedRef.current;

  const textRef = useRef(text);
  textRef.current = text;
  const setTextRef = useRef(opts.setText);
  setTextRef.current = opts.setText;
  const othersRef = useRef(others);
  othersRef.current = others;
  const sessionRef = useRef<SharedDraftSession | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [joined, setJoined] = useState(false);
  const [editors, setEditors] = useState<Record<string, number>>({});
  // Read after every keystroke: set only on a change.
  const [caret, setCaret] = useChangedState<number | null>(null);

  // Show the draft in the box, keeping my caret where it was among the words.
  const show = (next: string, map?: (pos: number) => number) => {
    const el = inputRef.current;
    if (el && el.value !== next) {
      const focused = typeof document !== "undefined" && document.activeElement === el;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      el.value = next;
      if (focused) {
        const s = map ? map(start) : next.length;
        const e = map ? map(end) : next.length;
        el.setSelectionRange(Math.min(s, next.length), Math.min(e, next.length));
      }
    }
    textRef.current = next;
    setTextRef.current(next);
  };

  useWatchEffect(() => {
    if (!active || !myId) return;
    const session = new SharedDraftSession(docId, sharedClientId(myId), serverOf(convex), {
      text: show,
      version: setVersion,
      remoteEdit: (userId) => {
        if (userId === myId) return;
        setEditors((prev) => ({ ...prev, [userId]: Date.now() }));
      },
      local: () => {
        const el = inputRef.current;
        return el ? { text: el.value, caret: el.selectionEnd ?? undefined } : null;
      },
    });
    sessionRef.current = session;
    void session
      .join(() => textRef.current, { seed, othersLive: () => othersWriting(othersRef.current) })
      .then((next) => {
        if (next == null || sessionRef.current !== session) return;
        if (next !== textRef.current) show(next);
        setJoined(true);
      })
      .catch(() => {});
    return () => {
      session.close();
      if (sessionRef.current === session) sessionRef.current = null;
      setJoined(false);
      setVersion(null);
      setEditors({});
    };
  }, [active, docId, myId]);

  // My edits, whatever made them: typing, a paste, a populate, the send that emptied the box.
  useWatchEffect(() => {
    const session = sessionRef.current;
    if (!session || !joined) return;
    const el = inputRef.current;
    session.edit(text, el && el.value === text ? el.selectionEnd ?? undefined : undefined);
  }, [text, joined]);

  // Everyone else's, live.
  const remote = useQueryNoThrow(api.docSync.getSteps, active && version != null ? { id: docId, version } : "skip").data;
  useWatchEffect(() => {
    if (remote) sessionRef.current?.receive(remote.version - remote.steps.length, remote.steps, remote.clientIds);
  }, [remote]);

  // Drop a typist's mark once they pause.
  useWatchEffect(() => {
    const live = typingEditors(editors);
    if (live.length === 0) return;
    const t = setTimeout(() => setEditors((prev) => ({ ...prev })), TYPING_MS);
    return () => clearTimeout(t);
  }, [editors]);

  // Where my caret is, for the others' boxes to draw: read after each commit
  // of the text and on selection moves. Never from the box's own `input`
  // event: the browser flushes React's sync render between that listener and
  // React's onChange, and a render there still holds the old text, so React
  // writes it back over the keystroke. Only a focused box has a caret: an idle
  // box's selection sits at the end of the text after every remote edit, which
  // drew a bare caret right behind the typist's own.
  const readCaret = () => {
    const el = inputRef.current;
    setCaret(el && joined && document.activeElement === el ? el.selectionEnd ?? null : null);
  };
  useWatchEffect(readCaret, [text, joined, inputRef]);
  useWatchEffect(() => {
    const el = inputRef.current;
    if (!el || !joined) return;
    document.addEventListener("selectionchange", readCaret);
    el.addEventListener("focus", readCaret);
    el.addEventListener("blur", readCaret);
    return () => {
      document.removeEventListener("selectionchange", readCaret);
      el.removeEventListener("focus", readCaret);
      el.removeEventListener("blur", readCaret);
    };
  }, [joined, inputRef]);

  useWatchEffect(() => {
    publish(conversationId, joined ? { active: true, caret, editors } : null);
  }, [conversationId, joined, caret, editors]);
  useWatchEffect(() => () => publish(conversationId, null), [conversationId]);

  return { active: joined, others, editors };
}
