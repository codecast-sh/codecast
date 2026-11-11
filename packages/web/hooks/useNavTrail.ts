import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { useTabContext } from "../lib/tabParams";
import { backEntry, subscribeTrail, trailOf, trailVersion } from "../lib/navTrail";
import { noteTrailBack, shownPlace } from "../lib/navTrailRecorder";
import { canonicalPlacePath, placeOf, placeSessionId } from "../lib/navPlace";
import { placeNamesOf, placeTitle } from "../lib/placeTitle";
import { pathLabel } from "../lib/pathLabel";

// The Modern back control's brain: where Back goes from the page this hook
// runs in, under what name, and the move that gets there. Closing an item
// follows the same rule in every style (useNavClose): Classic and Minimal have
// no Back control, but their ✕, back arrow and Esc land where Modern's would.
//
// Along the trail (lib/navTrail) when the page is its app tab's own page and
// the trail holds a step before it; otherwise up to the page's parent
// (lib/navPlace): a task's list or project, a doc's list, a session's inbox.
// A pane of a split or a page drawn inside a conversation has no trail of
// its own, so it only ever goes up.

export type BackTarget = {
  /** The destination's name, as the rail, the tab and the crumbs say it. */
  label: string;
  path: string;
  /** Along the trail (true) or up to the parent (false). */
  fromTrail: boolean;
  go: () => void;
};

/** Go to a place the way its own surface opens it: a session through the
 *  inbox (in place there, else leaving for it), the inbox's home by raising
 *  it, any other page by its address. */
export function goToPlace(path: string, push: (path: string) => void, openSession: (id: string) => void): void {
  const sid = placeSessionId(path);
  if (sid) {
    openSession(sid);
    return;
  }
  if (path.split("?")[0] === "/inbox" && !path.includes("s=")) {
    const store = useInboxStore.getState();
    store.setShowMySessions(true);
    const shown = shownPlace(store);
    if (shown && shown.path.split("?")[0] === "/inbox") return;
  }
  push(path);
}

/** Open a session the way the inbox does: in place on the inbox, else leaving
 *  for it with the session current (useOpenSession's two paths, by the store
 *  alone, so a page that never mounts a router-aware hook can go back too). */
export function openSessionFromBack(id: string, push: (path: string) => void): void {
  const store = useInboxStore.getState();
  const onInbox = shownPlace(store)?.path.split("?")[0] === "/inbox";
  store.navigateToSession(id);
  if (store.showMySessions) store.setShowMySessions(false);
  if (!onInbox) push(`/inbox?s=${id}`);
}

/** Where Back goes from the active tab's page, outside React (the nav.back
 *  shortcut): along its trail, else up. Null when there is nowhere to go. */
export function backTargetOfActiveTab(): { path: string; fromTrail: boolean } | null {
  const st = useInboxStore.getState();
  const shown = shownPlace(st);
  if (!shown) return null;
  const dest = backEntry(trailOf(shown.scope), shown.path);
  if (dest) return { path: dest.path, fromTrail: true };
  const parent = placeOf(shown.path, placeNamesOf(st)).parent;
  return parent ? { path: parent.href, fromTrail: false } : null;
}

/** The nav.back shortcut in Modern: the active tab's back target, else history. */
export function goBackInTrail(push: (path: string) => void): void {
  const target = backTargetOfActiveTab();
  if (!target) {
    window.history.back();
    return;
  }
  noteTrailBack(target.path, target.fromTrail ? "back" : "up");
  goToPlace(target.path, push, (id) => openSessionFromBack(id, push));
}

/**
 * Where Back goes from this page. `fallback` overrides the parent the address
 * implies (a page that knows its container better). Null when there is
 * nowhere to go: a section page reached cold.
 */
export function useBackTarget(fallback?: { label: string; href: string } | null): BackTarget | null {
  const tabCtx = useTabContext();
  const router = useRouter();
  // Only a tab's own page walks the tab's trail.
  const scope = tabCtx && !tabCtx.navigate && !tabCtx.leafId ? tabCtx.tabId : null;
  const here = tabCtx ? tabCtx.pathname + (tabCtx.searchParams.toString() ? `?${tabCtx.searchParams.toString()}` : "") : null;
  const shownPath = useInboxStore((s) => {
    if (!scope) return null;
    const shown = shownPlace(s);
    return shown && shown.scope === scope ? shown.path : null;
  });
  useSyncExternalStore(subscribeTrail, trailVersion, trailVersion);
  const dest = scope && shownPath ? backEntry(trailOf(scope), shownPath) : null;
  const ownPath = shownPath ?? here;
  // The parent the address implies, named from the store (a project's title).
  const parentSig = useInboxStore((s) => {
    if (dest || fallback || !ownPath) return "";
    const parent = placeOf(ownPath, placeNamesOf(s)).parent;
    return parent ? `${parent.label}\x1f${parent.href}` : "";
  });
  const parent = fallback ?? (parentSig ? { label: parentSig.split("\x1f")[0], href: parentSig.split("\x1f")[1] } : null);
  const path = dest?.path ?? parent?.href ?? null;
  // The destination's live name; the name the trail recorded when the store
  // no longer holds the object; the page's own name last.
  const liveName = useInboxStore((s) => (dest ? placeTitle(s, dest.path) : null));
  const label = dest ? liveName ?? dest.title ?? pathLabel(canonicalPlacePath(dest.path)) : parent?.label ?? "";
  const fromTrail = !!dest;
  const go = useCallback(() => {
    if (!path) return;
    noteTrailBack(path, fromTrail ? "back" : "up");
    const push = (p: string) => router.push(p);
    goToPlace(path, push, (id) => openSessionFromBack(id, push));
  }, [path, fromTrail, router]);
  return useMemo(() => (path ? { label, path, fromTrail, go } : null), [label, path, fromTrail, go]);
}

/**
 * Closing a detail (its ✕, its back arrow, or Esc where the page takes it), in
 * every style. It follows the back control's rule, so a task opened from a
 * project returns to the project and one opened from a conversation returns
 * to the conversation; with no trail (a cold link) it goes to the list.
 * `href` is where the close goes, for a control drawn as a link.
 */
export function useNavCloseTarget(closeHref: string): { href: string; close: () => void } {
  const router = useRouter();
  // The list as the fallback, so with no trail the close goes there, and the
  // parent lookup never runs.
  const fallback = useMemo(() => ({ label: "", href: closeHref }), [closeHref]);
  const target = useBackTarget(fallback);
  const close = useCallback(() => {
    if (target) target.go();
    else router.push(closeHref);
  }, [target, router, closeHref]);
  const href = target?.path ?? closeHref;
  return useMemo(() => ({ href, close }), [href, close]);
}

/** The close alone (useNavCloseTarget), for a control drawn as a button or a key. */
export function useNavClose(closeHref: string): () => void {
  return useNavCloseTarget(closeHref).close;
}
