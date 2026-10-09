// An object the Org screen's panel can open (essence spec §3.2, §5): its kind
// and the ref its address uses, and the address itself. The panel holds one
// object at a time and the browser's history is its Back, so there is no
// stack here. Pure, so the rules test without a DOM.
import { objectHref, orgObjectOfRef, type OrgObjectKind } from "@codecast/shared/entities";

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

/** The object an `/org/...` pathname names (`/org/in-2`, `/org/goals/in-2`),
 *  or null for the canvas, a view, or a scope page. */
export function sheetOfPath(pathname: string | null | undefined): SheetRef | null {
  const m = /^\/org\/([^/?#]+)(?:\/([^/?#]+))?/.exec(pathname ?? "");
  if (!m) return null;
  if (VIEW_SEGMENT.test(m[1])) return m[2] ? orgObjectOfRef(m[2]) : null;
  return m[2] ? null : orgObjectOfRef(m[1]);
}

/** An object's address on the canvas, the query kept. */
export function sheetPath(top: SheetRef | null, search = ""): string {
  const q = search.replace(/^\?/, "");
  const base = top ? objectHref(top.kind, top.ref) : "/org";
  return q ? `${base}?${q}` : base;
}
