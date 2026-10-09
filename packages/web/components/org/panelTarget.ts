// What the Org screen's one panel can hold (essence spec §3.2, §5): a goal,
// project, role or person; a conversation; or a proposal. The address is the
// only durable state: `/org/<ref>` (or `/org/<view>/<ref>`) names an object,
// `?session=` a conversation and `?proposal=` a proposal, in that order of
// precedence (session over proposal over object). Pure, so the rules test
// without a DOM.
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";
import { sheetKey, type SheetRef } from "./company/sheetStack";

/** An object in the panel. `intent` is how it was opened, held by the screen
 *  for this visit only: a project opened to pick its lead opens the picker. */
export type ObjectPanelRef = SheetRef & { intent?: "pick-lead" };

/** Where an open decision was asked, so a conversation lands on its card. */
export type DecisionAt = { id: string; question: string; createdAt: number };

export type PanelRef =
  | ObjectPanelRef
  | { kind: "session"; id: string; decision?: DecisionAt }
  | { kind: "proposal"; id: string; seq?: number };

export const isObjectPanel = (p: PanelRef | null | undefined): p is ObjectPanelRef => !!p && p.kind !== "session" && p.kind !== "proposal";

/** The one identity of a panel: the same object, conversation or proposal under any case. */
export function panelKey(p: PanelRef | null | undefined): string | null {
  if (!p) return null;
  if (p.kind === "session") return `session:${p.id}`;
  if (p.kind === "proposal") return `proposal:${p.id.toLowerCase()}`;
  return sheetKey(p);
}

/** `open(to)` and the older `open(kind, ref)` read as one target. */
export function panelRefOf(to: PanelRef | OrgObjectKind, ref?: string): PanelRef | null {
  if (typeof to !== "string") return to;
  return ref ? { kind: to, ref } : null;
}

/** The screen behind the panel: the canvas, or one of the two read views. */
export type OrgView = "canvas" | "goals" | "projects";

/** Whether an address segment names a read view rather than an object. */
export const isOrgViewSegment = (s: string | null | undefined): s is "goals" | "projects" => s === "goals" || s === "projects";

/** The view and the object ref an `/org/...` address names. */
export function orgAddressOf(params: { view?: string | null; id?: string | null }): { view: OrgView; ref: string | null } {
  const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const view = params.view ? decode(params.view) : null;
  const id = params.id ? decode(params.id) : null;
  if (isOrgViewSegment(view)) return { view, ref: id };
  if (isOrgViewSegment(id)) return { view: id, ref: null };
  return { view: "canvas", ref: id };
}

/** The address of a view with nothing open. */
export const orgViewPath = (view: OrgView): string => (view === "canvas" ? "/org" : `/org/${view}`);

/** An object's address inside a view: `/org/in-2`, `/org/projects/pj-k3x9`. */
export function orgObjectPath(view: OrgView, kind: OrgObjectKind, ref: string): string {
  const href = objectHref(kind, ref);
  return view === "canvas" ? href : `${orgViewPath(view)}/${href.slice("/org/".length)}`;
}

/** The parameters that outlive an open or a close (the dev preview). */
const KEPT = ["preview"] as const;

function keptQuery(search: string): URLSearchParams {
  const from = new URLSearchParams(search.replace(/^\?/, ""));
  const q = new URLSearchParams();
  for (const k of KEPT) { const v = from.get(k); if (v !== null) q.set(k, v); }
  return q;
}

const withQuery = (path: string, q: URLSearchParams) => { const s = q.toString(); return s ? `${path}?${s}` : path; };

/** The address that opens `to` in the panel of `view`. Every other panel
 *  parameter is dropped, so the address names exactly one thing. */
export function panelHref(view: OrgView, to: PanelRef | null, search = ""): string {
  const q = keptQuery(search);
  if (!to) return withQuery(orgViewPath(view), q);
  if (to.kind === "session") { q.set("session", to.id); return withQuery(orgViewPath(view), q); }
  if (to.kind === "proposal") {
    q.set("proposal", to.id.toLowerCase());
    if (to.seq !== undefined) q.set("focus", String(to.seq));
    return withQuery(orgViewPath(view), q);
  }
  return withQuery(orgObjectPath(view, to.kind, to.ref), q);
}

/** The panel an address holds: `?session=` over `?proposal=` over the object
 *  its path names. `object` is the path's object as the store resolved it. */
export function panelOfAddress(object: SheetRef | null, q: { session: string | null; proposal: string | null; focus: number | null }): PanelRef | null {
  if (q.session) return { kind: "session", id: q.session };
  if (q.proposal) return { kind: "proposal", id: q.proposal, ...(q.focus !== null ? { seq: q.focus } : {}) };
  return object;
}
