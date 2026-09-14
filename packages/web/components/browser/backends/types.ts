// The contract between BrowserPane and whatever is actually showing the page.
//
// The pane owns the chrome — the address strip, the title, the states it
// paints over the content — and knows nothing about how a backend draws. A
// backend owns the pixels and reports back through these callbacks. That is
// what lets the stream and native backends land later without BrowserPane
// changing at all.

import type { ReactNode } from "react";
import type { BrowserSource } from "../../../lib/browserPane";

export type BrowserPaneState =
  /** Asked for, nothing shown yet. */
  | { kind: "loading" }
  /** Showing the page. `opaque` means the backend cannot read what it shows
   *  (a cross-origin frame), so "it loaded" is the last thing it can tell us. */
  | { kind: "ready"; opaque: boolean }
  /** Nothing answered at the address. */
  | { kind: "unreachable"; loopback: boolean }
  /** This page cannot be shown here at all, and we can prove it: an http page
   *  under an https app (the browser blocks it), or a native view that was
   *  told the site refuses to be embedded. */
  | { kind: "blocked"; reason: "insecure" | "refused" | "local-network" }
  /** The backend itself failed — a dead daemon, a missing bridge. */
  | { kind: "error"; message: string };

/** A verb a backend puts in the pane's address strip. The pane draws it as one
 *  of its own `.cc-panel__btn` icons, so a backend's actions are indistinguish-
 *  able from the strip's built-in reload and open — which is the point: they
 *  are the same kind of thing, and only the backend knows which ones exist. */
export type PaneStripAction = {
  icon: ReactNode;
  /** The tooltip, and the accessible name. A whole short sentence, not a word. */
  label: string;
  /** Lit: this verb is currently in effect (the stream's drive mode). */
  active?: boolean;
  onClick: () => void;
};

export type BackendProps = {
  source: BrowserSource;
  /** This pane is the focused one in the active tab: backends that take input
   *  (the stream, the native view) act only when focused. */
  focused: boolean;
  /** Bumped when the user asks for a reload; a backend remounts its content. */
  reloadToken: number;
  /** The page's own title, when the backend can read one. */
  onTitle: (title: string | null) => void;
  /** The address actually being shown, once it differs from the one asked for
   *  (a redirect, a link followed inside a native view). */
  onUrl: (url: string) => void;
  onState: (state: BrowserPaneState) => void;
  /** Verbs this backend wants in the strip, re-registered whenever they change.
   *  A backend that has none never calls it. */
  onActions?: (actions: PaneStripAction[]) => void;
};
