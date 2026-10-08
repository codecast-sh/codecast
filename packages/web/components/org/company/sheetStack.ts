// The Org screen's sheets (cohesive build spec §5.1, D3, D4, D5): which
// objects are open over the company pane, in the order the person opened
// them, and how wide the top one is. The address holds only the top of the
// stack (`/org/<ref>`); the steps under it are this visit's, so Back walks
// them and Esc pops one, then closes. Pure, so the rules test without a DOM.
import { objectHref, orgObjectOfRef, type OrgObjectKind } from "@codecast/shared/entities";

/** One open sheet: the object's kind and the ref its address uses (`in-2`,
 *  `pj-k3x9`, `or-7`, a person's handle). A stub goal's key and a Convex id
 *  are refs too, until the row names its short form. */
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

/** The object an `/org/...` pathname names, or null for the company itself. */
export function sheetOfPath(pathname: string | null | undefined): SheetRef | null {
  const m = /^\/org\/([^/?#]+)/.exec(pathname ?? "");
  if (!m) return null;
  return orgObjectOfRef(m[1]);
}

/** The address of the top sheet, the screen's query kept (the lens, a proposal). */
export function sheetPath(top: SheetRef | null, search = ""): string {
  const q = search.replace(/^\?/, "");
  const base = top ? objectHref(top.kind, top.ref) : "/org";
  return q ? `${base}?${q}` : base;
}

/** Opening an object from inside the screen: on top of the stack. The object
 *  already on top stays as it is; one further down is returned to, so the
 *  stack never holds a loop (a crumb back to the goal a project serves). */
export function pushSheet(stack: readonly SheetRef[], s: SheetRef): SheetRef[] {
  const at = stack.findIndex((x) => sameSheet(x, s));
  if (at >= 0) return stack.slice(0, at + 1);
  return [...stack, s];
}

/** One step back: the sheet under the top, or none. */
export const popSheet = (stack: readonly SheetRef[]): SheetRef[] => stack.slice(0, -1);

/** The stack after the address moved to `top`. An open made inside the
 *  screen (D5b) keeps the steps under it; an arrival by address (a link, a
 *  new tab, the sidebar) starts over on the object it names. */
export function stackForAddress(stack: readonly SheetRef[], top: SheetRef | null, inScreen: boolean): SheetRef[] {
  if (!top) return [];
  if (sameSheet(stack[stack.length - 1], top)) return [...stack];
  if (!inScreen) return [top];
  return pushSheet(stack, top);
}

/** The same stack with one ref renamed (a stub goal's key once the server
 *  minted its `in-N`, a Convex id once the store names the short form). The
 *  entry keeps its identity, so it is the same sheet under the new ref. */
export function renameSheet(stack: readonly SheetRef[], from: SheetRef, to: SheetRef): SheetRef[] {
  return stack.map((s) => (sameSheet(s, from) ? { kind: to.kind, ref: to.ref, id: sheetId(s) } : s));
}

/** What a sheet leaves of the lens beside it (D3). */
export const SHEET_MAX_W = 560;
export const SHEET_MIN_W = 400;
export const LENS_KEEP_W = 260;

/** The top sheet's width in a right pane `pane` px wide, and whether it covers
 *  the lens: `clamp(400, pane - 260, 560)`, and a pane under 660px is covered. */
export function sheetWidth(pane: number, keep: number = LENS_KEEP_W): { width: number; covers: boolean } {
  if (pane < SHEET_MIN_W + LENS_KEEP_W) return { width: Math.max(0, pane), covers: true };
  const width = Math.min(SHEET_MAX_W, Math.max(SHEET_MIN_W, pane - LENS_KEEP_W));
  // A lens that needs more than the map's 260px to be read (the document)
  // is covered whole rather than left as a column of cut-off names.
  if (pane - width < keep) return { width: Math.max(0, pane), covers: true };
  return { width, covers: false };
}

/** What the document needs beside a sheet to stay readable: under this it is covered. */
export const DOC_KEEP_W = 360;
