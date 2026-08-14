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
// Persisted in clientState.ui (the per-user LWW prefs bag), so pins follow the
// user across devices like every other layout preference.

export type SidebarPinKind = "project" | "view" | "channel";

export type SidebarPin = {
  kind: SidebarPinKind;
  id: string;
  /** Fallback label from pin time, used when the live object is not in the
   *  store (other team's cache pruned, deleted object). */
  label: string;
};

export function readPins(state: any): SidebarPin[] {
  const raw = state.clientState?.ui?.sidebar_pins;
  return Array.isArray(raw) ? (raw as SidebarPin[]) : [];
}

export function isPinned(state: any, kind: SidebarPinKind, id: string): boolean {
  return readPins(state).some((p) => p.kind === kind && p.id === id);
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
