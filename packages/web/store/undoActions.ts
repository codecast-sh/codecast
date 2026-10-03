// The animated session gestures. Undo itself is generic: every action these
// call has a spec in store/undo/policies/sessions.ts, so the engine records the
// cells it changed and puts them back through the ordinary action pipeline.
// What stays here is motion (rows collapse out and grow back in) and the
// grouping that makes a multi-row gesture one undo.
import { askRetireInstead } from "../lib/seatKill";
import { soundDormant } from "../lib/sounds";
import { useInboxStore, type InboxSession } from "./inboxStore";
import type { UserRest } from "@codecast/shared/contracts";
import { undoGroup, type UndoEntry } from "./undoStack";
import { registerUndoRevert } from "./undo/onRevert";
import { USER_REST_LABEL } from "./undo/policies/sessions";
import { counted } from "./undo/labels";
import { toast } from "sonner";

export { USER_REST_LABEL };

// How long a restored row may take to mount before its entrance is dropped.
const ENTER_WAIT_MS = 1000;

/**
 * Play the enter animation on a session's row when it next mounts. Call it
 * BEFORE the store write that brings the row back.
 *
 * A MutationObserver callback runs as a microtask right after React inserts
 * the node and before the browser paints, so the first frame of the row is
 * already the first frame of the animation. Adding the class any later (a
 * timer, a rAF) paints the row at full size first, and the keyframe then
 * snaps it to zero height and grows it back: the flash this replaces.
 */
export function animateSessionEnter(id: string, leaving?: Element | null) {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  const selector = `[data-session-id="${id}"]`;
  // Already on screen: nothing is entering, and animating it would blink it.
  // A row moving between sections is the exception: the card on screen is the
  // one leaving, and the entrance belongs to the copy that mounts in its place.
  const entering = () => Array.from(document.querySelectorAll(selector)).find((el) => el !== leaving);
  if (entering()) return;
  const observer = new MutationObserver(() => {
    const card = entering();
    if (!card) return;
    stop();
    const target = (card.parentElement ?? card) as HTMLElement;
    // Drive the keyframe off the row's real height (it may hold a parent card
    // plus subagent cards) so it never coasts on a short row or clips a tall one.
    target.style.setProperty("--row-h", `${target.offsetHeight}px`);
    target.classList.add("session-entering");
    target.addEventListener("animationend", () => {
      target.classList.remove("session-entering");
      target.style.removeProperty("--row-h");
    }, { once: true });
  });
  const timer = setTimeout(() => stop(), ENTER_WAIT_MS);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
}

export type HideSessionMode = "stash" | "kill";
/** `hidden` = "Stash and hide": the stash survives trigger wakes (stash mode only). */
export type HideSessionOpts = { hidden?: boolean };

/** Collapse a session card out of its list, then run `then` (the store write
 *  that moves the row). Runs `then` at once when the card is not on screen. */
function animateSessionExit(id: string, then: (leaving: Element | null) => void) {
  if (typeof document === "undefined") return then(null);
  const card = document.querySelector(`[data-session-id="${id}"]`);
  const wrapper = card?.parentElement;
  if (!wrapper) return then(null);
  // Measure the real height (parent + any subagent rows) so the collapse
  // animates the whole stack, not just the first 80px the old cap allowed.
  wrapper.style.setProperty('--row-h', `${wrapper.offsetHeight}px`);
  wrapper.classList.add('session-dismissing');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    then(card);
  };
  wrapper.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 250);
}

/** Fold every undoable write `fn` makes into one undo. One write keeps its own
 *  label; several take `summary`. */
export function undoAsOne<T>(summary: string | ((entries: UndoEntry[]) => string), fn: () => T): T {
  return undoGroup(
    (entries: UndoEntry[]) => (entries.length === 1 ? entries[0]!.label : typeof summary === "function" ? summary(entries) : summary),
    fn,
  );
}

const exitFinished = (id: string) => new Promise<Element | null>((resolve) => animateSessionExit(id, resolve));

/** Animate a session card sliding out, then stash or kill it. */
export function animatedHideSession(id: string, mode: HideSessionMode, opts?: HideSessionOpts) {
  void animatedHideSessions([id], mode, opts);
}

/** Stash or kill a selection as one gesture: every card collapses out, then
 *  all of them are hidden together as one undo. A seat asks to be retired
 *  instead of killed and is left out. Resolves to the ids it hid. */
export async function animatedHideSessions(ids: string[], mode: HideSessionMode, opts?: HideSessionOpts): Promise<string[]> {
  const list = mode === "kill" ? ids.filter((id) => !askRetireInstead(id)) : ids;
  if (list.length === 0) return list;
  await Promise.all(list.map(exitFinished));
  const store = useInboxStore.getState();
  if (mode === "kill") {
    if (list.length === 1) store.killSession(list[0]!);
    else store.killSessions(list);
  } else {
    const verb = opts?.hidden ? "Stashed and hid" : "Stashed";
    undoAsOne(`${verb} ${counted(list.length, "session")}`, () => {
      for (const id of list) store.stashSession(id, opts);
    });
  }
  return list;
}

/** File sessions under a rest verdict the way stash moves them: each card
 *  collapses out of its section, and once every collapse has ended they are
 *  filed together (one undo) and grow into the section they land in. Dormant
 *  sounds its own cue, once per gesture however many rows it files. */
export async function animatedSetSessionRest(ids: string | string[], rest: UserRest): Promise<void> {
  const list = typeof ids === "string" ? [ids] : ids;
  if (list.length === 0) return;
  if (rest === "dormant") soundDormant();
  const rows = useInboxStore.getState().sessions;
  // Already filed there: the row stays put, so nothing should leave or enter.
  const moving = list.filter((id) => rows[id]?.user_rest !== rest);
  const leaving = new Map(await Promise.all(moving.map(async (id) => [id, await exitFinished(id)] as const)));
  // The entrance arms before the write, so it is on the row's first frame.
  for (const id of moving) animateSessionEnter(id, leaving.get(id));
  const label = `Filed ${counted(list.length, "session")} as ${USER_REST_LABEL[rest]}`;
  undoAsOne(label, () => {
    const store = useInboxStore.getState();
    for (const id of list) store.setSessionRest(id, rest);
  });
}

/**
 * File many sessions under one rest verdict at once: the drop on a status
 * section, the multi-selection menu and the selection bar all land here.
 * Killed rows are skipped; the rest file as one undo.
 */
export function fileSessionsAsRest(ids: string[], rest: UserRest): Promise<void> {
  const store = useInboxStore.getState();
  const rows = ids.map((id) => store.sessions[id]).filter((row): row is InboxSession => !!row);
  const live = rows.filter((row) => !row.inbox_killed_at);
  if (live.length === 0) {
    if (rows.length) toast.error("A killed session can't be filed — restore it first");
    return Promise.resolve();
  }
  return animatedSetSessionRest(live.map((row) => row._id), rest);
}

// An undo that un-hides a session row plays the row's entrance, whichever
// gesture hid it: a stash, a kill, a snooze, a teammate's row the hide forgot.
const HIDE_FIELDS = new Set(["inbox_dismissed_at", "inbox_stashed_at", "inbox_killed_at", "inbox_snoozed_until"]);
registerUndoRevert("sessions", (rows) => {
  for (const { id, cells } of rows) {
    const unhid = cells.some((c) =>
      c.field === undefined
        ? c.hadBefore && !c.hadAfter
        : HIDE_FIELDS.has(c.field) && !!c.after && !c.before);
    if (unhid) animateSessionEnter(id);
  }
});
