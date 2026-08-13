/**
 * Saved views: which one you are looking at, and what "the same view" means.
 *
 * A view is a named set of list preferences — filters, grouping, sort. So "am I
 * in this view" is not a route question (every view lives at /tasks); it is a
 * question about whether the list is currently arranged the way the view says.
 * That comparison is fiddly enough to be worth naming and testing: absent, empty
 * string and the field's default all mean "not set", and treating them as
 * different is what makes a view look unselected the moment you open it.
 */

export type ViewPrefs = Record<string, unknown>;

/** Fields that describe presentation rather than which rows you are looking at.
 *  A view still counts as selected when only these differ, so flipping to the
 *  board or reversing the sort does not silently deselect it. */
const PRESENTATION_FIELDS = new Set(["view", "dir"]);

/** Every value that means "the user did not choose anything here". */
function isUnset(v: unknown): boolean {
  return v === undefined || v === null || v === "" || v === false;
}

/** The prefs that actually distinguish one view from another, normalised. */
export function significantPrefs(prefs: ViewPrefs | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(prefs ?? {})) {
    if (PRESENTATION_FIELDS.has(k) || isUnset(v)) continue;
    out[k] = String(v);
  }
  return out;
}

/**
 * Is the list currently arranged the way this view describes?
 *
 * Both directions matter. A view with `{status: "open"}` is not selected while
 * the list also filters by label — you have narrowed past it — and a view with
 * two filters is not selected when only one is applied.
 */
export function isViewActive(viewPrefs: ViewPrefs | undefined, currentPrefs: ViewPrefs | undefined): boolean {
  const want = significantPrefs(viewPrefs);
  const have = significantPrefs(currentPrefs);
  const wantKeys = Object.keys(want);
  if (wantKeys.length !== Object.keys(have).length) return false;
  // An empty view matches only an empty list — otherwise a view saved with no
  // filters would light up on every screen and mean nothing.
  return wantKeys.every((k) => have[k] === want[k]);
}

/**
 * The view the list is currently showing, if any. When several views describe
 * the same arrangement the first wins, so the order the rail renders them in is
 * the order that decides — never a random pick that changes between renders.
 */
export function activeViewId<T extends { id: string; prefs?: ViewPrefs }>(
  views: T[],
  currentPrefs: ViewPrefs | undefined,
): string | undefined {
  return views.find((v) => isViewActive(v.prefs, currentPrefs))?.id;
}
