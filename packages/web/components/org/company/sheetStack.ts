// An object the Org screen's panel can open (essence spec §3.2, §5): its kind
// and the ref its address uses, and the address itself. The panel holds one
// object at a time and the browser's history is its Back, so there is no
// stack here. Pure, so the rules test without a DOM.
import { objectHref, orgObjectOfRef, type OrgObjectKind } from "@codecast/shared/entities";
import { currentPagePath } from "../../../lib/renamedPages";

/** One object: its kind and the ref its address uses (`in-2`, `pj-k3x9`,
 *  `or-7`, a person's handle). A stub goal's key and a Convex id are refs
 *  too, until the row names its short form. */
export type SheetRef = {
  kind: OrgObjectKind;
  ref: string;
  /** The open sheet's identity, set when its ref is renamed so the sheet
   *  stays the same one (mounted, its draft kept) under the new address. */
  id?: string;
};

export const sheetKey = (s: SheetRef | null | undefined): string | null => (s ? `${s.kind}:${s.ref.replace(/^@/, "").toLowerCase()}` : null);

/** Which open sheet this is: the key it was opened under, through any rename. */
export const sheetId = (s: SheetRef): string => s.id ?? sheetKey(s)!;

export const sameSheet = (a: SheetRef | null | undefined, b: SheetRef | null | undefined): boolean => !!a && !!b && sheetKey(a) === sheetKey(b);

/** The read views' segments: `/org/goals/in-2` names the goal under the Goals view. */
const VIEW_SEGMENT = /^(goals|projects)$/;

/** How an `/org...` pathname reads: the read view it sits under and the raw
 *  ref of the object it opens (`/org/in-2`, `/org/goals/in-2`,
 *  `/org/projects/pj-1`), or null when the path is not under /org. The ref
 *  is raw, so a stub goal's key or a Convex id still comes through. The one
 *  parser of these addresses: titles, icons and accents all read it. */
export function orgRefOfPath(pathname: string | null | undefined): { view?: "goals" | "projects"; ref?: string } | null {
  // A goal's own page names it the way /org/<in-N> did.
  const goal = /^\/goals(?:\/([^/?#]+))?(?:[/?#]|$)/.exec(pathname ?? "");
  if (goal) return { view: "goals", ref: goal[1] };
  const m = /^\/org(?:\/([^/?#]+)(?:\/([^/?#]+))?)?(?:[/?#]|$)/.exec(pathname ?? "");
  if (!m) return null;
  if (m[1] && VIEW_SEGMENT.test(m[1])) return { view: m[1] as "goals" | "projects", ref: m[2] };
  return m[1] && !m[2] ? { ref: m[1] } : {};
}

/** Whether a stored path (old addresses included) is a goal page (the Goals
 *  view or a goal) or a project page (the Projects view, a project, or a
 *  project's board), for the icon and accent a reference to it wears. */
export function orgPageKind(path: string): "goal" | "project" | null {
  const current = currentPagePath(path);
  if (/^\/projects(?:[/?#]|$)/.test(current)) return "project";
  const org = orgRefOfPath(current);
  if (!org) return null;
  const kind = org.ref ? orgObjectOfRef(org.ref)?.kind : null;
  if (org.view === "goals" || kind === "initiative") return "goal";
  if (org.view === "projects" || kind === "project") return "project";
  return null;
}

/** The object an `/org/...` pathname names (`/org/in-2`, `/org/goals/in-2`),
 *  or null for the canvas, a view, or a scope page. */
export function sheetOfPath(pathname: string | null | undefined): SheetRef | null {
  const ref = orgRefOfPath(pathname)?.ref;
  return ref ? orgObjectOfRef(ref) : null;
}

/** An object's address on the canvas, the query kept. */
export function sheetPath(top: SheetRef | null, search = ""): string {
  const q = search.replace(/^\?/, "");
  const base = top ? objectHref(top.kind, top.ref) : "/org";
  return q ? `${base}?${q}` : base;
}
