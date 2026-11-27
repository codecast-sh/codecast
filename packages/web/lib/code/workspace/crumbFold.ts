// How the breadcrumb row folds its leading folders when space runs out.

/** Width the "…" crumb takes with its chevron, in px. */
const ELLIPSIS_PX = 30;

/** How many leading folders to fold into "…" so the rest fit `avail` px:
 *  none when everything fits, never the nearest folder. */
export function foldedFolders(widths: readonly number[], avail: number): number {
  let total = widths.reduce((a, b) => a + b, 0);
  if (total <= avail) return 0;
  for (let hide = 1; hide < widths.length; hide++) {
    total -= widths[hide - 1];
    if (total + ELLIPSIS_PX <= avail) return hide;
  }
  return Math.max(0, widths.length - 1);
}
