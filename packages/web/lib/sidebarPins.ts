import { useInboxStore } from "../store/inboxStore";

// Pinning a sidebar subsection row to the top of the rail.
//
// One generalized shape for every pinnable kind — a project, a saved task/doc
// view, a chat channel — so "pin to top" is a single mechanism rather than a
// per-section feature. The pin stores IDENTITY plus a fallback label; the rail
// resolves the live name/icon/route at render from the store, so a renamed
// project renames its pin. A pin whose object has vanished still renders (by
// the fallback label) with its unpin affordance — silently dropping it would
// make pins feel lossy.
//
// Persisted in clientState.ui.sidebar_pins, a stamped per-user LWW key, so a
// pin made on one device stays pinned on the others. Unstamped, an empty list
// on a second client clobbered the pin.

export type SidebarPinKind = "project" | "view" | "channel";

export type SidebarPin = {
  kind: SidebarPinKind;
  id: string;
  /** Fallback label from pin time, used when the live object is not in the
   *  store (other team's cache pruned, deleted object). */
  label: string;
};

// Stable no-pins reference: readPins is used inside zustand selectors, and a
// fresh [] per call reads as a changed snapshot on every check — an infinite
// re-render loop for any user with no pins yet.
const NO_PINS: SidebarPin[] = [];

export function readPins(state: any): SidebarPin[] {
  const raw = state.clientState?.ui?.sidebar_pins;
  return Array.isArray(raw) ? (raw as SidebarPin[]) : NO_PINS;
}

export function isPinned(state: any, kind: SidebarPinKind, id: string): boolean {
  return readPins(state).some((p) => p.kind === kind && p.id === id);
}

/** The Threads page's pin. It pins as a view today; before the page left chat
 *  it pinned as `{kind:"channel", id:"threads"}` (the route segment it had),
 *  and persisted arrays still carry that form. Both resolve to /threads — the
 *  stored array is never rewritten (readPins must hand back a stable ref). */
export function isThreadsPin(pin: Pick<SidebarPin, "kind" | "id">): boolean {
  return pin.id === "threads" && (pin.kind === "view" || pin.kind === "channel");
}

/** The desktop app a pin belongs to (lib/desktopApps): a channel and the
 *  threads inbox are chat's; a project and a saved task or doc view are
 *  work's. Each app's own window shows only its own pins. */
export function pinApp(pin: Pick<SidebarPin, "kind" | "id">): "chat" | "work" {
  return pin.kind === "channel" || isThreadsPin(pin) ? "chat" : "work";
}

/** Add or remove one pin. Order is pin order — newest last, no re-sorting:
 *  the user's own sequence IS the arrangement. */
export function togglePin(kind: SidebarPinKind, id: string, label: string): void {
  const store = useInboxStore.getState();
  const pins = readPins(store);
  const exists = pins.some((p) => p.kind === kind && p.id === id);
  const next = exists
    ? pins.filter((p) => !(p.kind === kind && p.id === id))
    : [...pins, { kind, id, label }];
  store.updateClientUI({ sidebar_pins: next });
}
