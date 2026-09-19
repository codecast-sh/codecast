// The reveal host contract: which object reference is open as an inline
// full-page band, where the band sits, and how a reference toggles itself.
// Data and hooks only — the provider and the band are components in
// components/ObjectReveal.tsx. Its own module so that file stays a Fast
// Refresh boundary (a hook exported next to components remounts every
// importer on an unrelated edit).
//
// ONE band is open at a time, page wide: opening a reference closes whatever
// was open, so the reader is never stacking pages inside a conversation. The
// band opens right under the block that holds the reference (the paragraph,
// the list item, the card row), in a slot placed into the DOM there — the
// host renders the band into that slot through a portal, so React context
// (router, tab, store) flows from the host while the DOM sits under the line.
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type RefObject,
} from "react";

export type RevealTarget = {
  /** The object's page — the same href the reference links to. */
  href: string;
  /** The band's strip title: "Task: Fix the auth race". */
  title: string;
  /** "Open task" — the juicy hit before and after the framed page. */
  openLabel?: string;
  /** The reference's own open handler (a session routes through
   *  useOpenLinkedSession); the band's open link calls it too. */
  onOpen?: (e: MouseEvent) => void;
};

/** The one open reveal on the page. */
export type OpenReveal = {
  hostKey: string;
  target: RevealTarget;
  /** The element the band renders into, placed right under the reference's block. */
  slot: HTMLElement;
  /** The reference that opened it. */
  anchor: HTMLElement;
  /** Just opened by a click — grows in and takes the scroll — as opposed to
   *  restored when a recycled transcript row scrolls back into view. */
  fresh: boolean;
  /** Where the anchor sat (viewport top) as the click landed, when another
   *  band was open: the new band holds it there while the old one's removal
   *  moves the page, so the line the reader clicked stays under the cursor. */
  holdTop: number | null;
};

let current: OpenReveal | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
export function subscribeReveal(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export const currentReveal = (): OpenReveal | null => current;
const none = () => null;

export function useOpenReveal(): OpenReveal | null {
  return useSyncExternalStore(subscribeReveal, currentReveal, none);
}

// The block a reference sits in, which the band opens right under: the card
// row for a card, else the paragraph, list item, heading or table for a pill.
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, table, dl, figure";
function placeSlot(anchor: HTMLElement): HTMLElement {
  const block = anchor.closest<HTMLElement>(".entity-card-row") ?? anchor.closest<HTMLElement>(BLOCK) ?? anchor;
  const slot = document.createElement("div");
  slot.className = "object-reveal-slot";
  // Chrome, not content: quote units (lib/quoteUnits) skip it, so comment
  // anchors below the band keep their indices while it is open.
  slot.setAttribute("data-reveal-slot", "");
  block.after(slot);
  return slot;
}

export function toggleReveal(hostKey: string, target: RevealTarget, anchor: HTMLElement) {
  if (current && current.hostKey === hostKey && current.target.href === target.href) {
    closeReveal();
    return;
  }
  const prev = current;
  const holdTop = prev ? anchor.getBoundingClientRect().top : null;
  prev?.slot.remove();
  current = { hostKey, target, slot: placeSlot(anchor), anchor, fresh: true, holdTop };
  emit();
}

export function closeReveal() {
  if (!current) return;
  const { slot } = current;
  current = null;
  emit();
  slot.remove();
}

/**
 * A recycled row came back with the open reference in it: the reference
 * re-places the slot under itself, so the band is where the reader left it.
 * A no-op while the slot is still in the document.
 */
export function reattachReveal(hostKey: string, href: string, anchor: HTMLElement) {
  if (!current || current.hostKey !== hostKey || current.target.href !== href) return;
  if (current.slot.isConnected) return;
  current = { ...current, slot: placeSlot(anchor), anchor, fresh: false, holdTop: null };
  emit();
}

export type RevealHostValue = { hostKey: string };

export const RevealHostCtx = createContext<RevealHostValue | null>(null);

/** The host a reference toggles itself in — null on a surface without one. */
export function useRevealHost(): RevealHostValue | null {
  return useContext(RevealHostCtx);
}

/** Whether this host's reference at `href` is the open reveal; re-renders only when that flips. */
export function useIsRevealOpen(hostKey: string | null, href: string): boolean {
  return useSyncExternalStore(
    subscribeReveal,
    () => !!current && current.hostKey === hostKey && current.target.href === href,
    () => false,
  );
}

/**
 * Everything a reference (a pill, a card's button) needs: whether a host
 * exists, whether it is the open reveal, a toggle bound to its host and its
 * own element, and the re-place when it mounts already open.
 */
export function useRevealRef(target: RevealTarget, ref: RefObject<HTMLElement | null>) {
  const host = useRevealHost();
  const hostKey = host?.hostKey ?? null;
  const open = useIsRevealOpen(hostKey, target.href);
  useLayoutEffect(() => {
    if (open && hostKey && ref.current) reattachReveal(hostKey, target.href, ref.current);
  }, [open, hostKey, target.href, ref]);
  const toggle = useCallback(() => {
    if (hostKey && ref.current) toggleReveal(hostKey, target, ref.current);
  }, [hostKey, target, ref]);
  return { host: host !== null, open, toggle };
}

/**
 * Does the surface around `ref` HOST the open band? The band is portalled
 * into a slot placed in the surface's own DOM, so containment answers it —
 * and a slot that left the document (its conversation gone, its row recycled)
 * is contained by nothing.
 *
 * `subject` is what the surface is currently showing. The check has to run
 * again when that changes: the inbox reuses ONE conversation view for every
 * session it selects, so a surface that hosted a band and then swapped to
 * another session would otherwise keep reporting that it hosts one — the
 * reader lands on a conversation folded down to its title with no band in
 * sight, and nothing unfolds it again.
 */
export function useHostsReveal(
  ref: RefObject<HTMLElement | null>,
  rootSelector: string,
  subject?: unknown,
): boolean {
  const reveal = useOpenReveal();
  const [hosting, setHosting] = useState(false);
  useLayoutEffect(() => {
    const root = ref.current?.closest(rootSelector);
    setHosting(!!(reveal && root && root.contains(reveal.slot)));
  }, [ref, rootSelector, reveal, subject]);
  return hosting;
}

/** True inside a band: a host there is inert, so a reference in a revealed
 *  page is the link it is on the stage (and navigates the band) rather than
 *  a reveal that would close the band it sits in. */
export const RevealInBandCtx = createContext(false);

/**
 * The conversations this render is inside, outermost first: the transcript
 * on the stage, then the conversation of each reveal band nested in it. A
 * band never shows one of these — a conversation rendered inside itself
 * renders its own open bands again, and that has no floor.
 */
export const RevealAncestryCtx = createContext<readonly string[]>([]);

export function useRevealAncestry(): readonly string[] {
  return useContext(RevealAncestryCtx);
}

/** The ancestry a transcript hands to its own bands: what it is inside, plus itself. */
export function useRevealAncestryWith(conversationId: string): readonly string[] {
  const outer = useContext(RevealAncestryCtx);
  return useMemo(() => [...outer, conversationId], [outer, conversationId]);
}
