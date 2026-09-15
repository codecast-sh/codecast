// The reveal host contract: which object references are open as inline
// full-page bands, and how a reference toggles itself. Data and hook only —
// the provider and the band are components in components/ObjectReveal.tsx.
// Its own module so that file stays a Fast Refresh boundary (a hook exported
// next to components remounts every importer on an unrelated edit).
import { createContext, useContext, useMemo, type MouseEvent } from "react";

export type RevealTarget = {
  /** The object's page — the same href the reference links to. */
  href: string;
  /** The band's strip title: "Task: Fix the auth race". */
  title: string;
  /** The reference's own open handler (a session routes through
   *  useOpenLinkedSession); the band's open link calls it too. */
  onOpen?: (e: MouseEvent) => void;
};

export type RevealHostValue = {
  toggle: (target: RevealTarget) => void;
  isOpen: (href: string) => boolean;
};

export const RevealHostCtx = createContext<RevealHostValue | null>(null);

/** The host a reference toggles itself in — null on a surface without one. */
export function useRevealHost(): RevealHostValue | null {
  return useContext(RevealHostCtx);
}

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
