// Which of the Ops tabs fit the bar's width, for a narrow window: the tabs in
// order while they fit beside a "More" menu that holds the rest, the active
// tab always among those drawn. Pure, so the rule is tested on its own.

/**
 * The indexes of the tabs drawn in the bar. All of them when they fit;
 * otherwise as many from the left as fit with room for `more`, and the active
 * one swapped in for the last of those when it would have been folded away.
 * A tab not measured yet (width 0) counts as fitting, so the first render
 * draws everything and measures it.
 */
export function fitTabs(widths: readonly number[], avail: number, more: number, gap: number, active: number): number[] {
  const all = widths.map((_, i) => i);
  const total = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1);
  if (!avail || total <= avail || widths.some((w) => !w)) return all;
  const out: number[] = [];
  let used = more;
  for (const i of all) {
    const add = widths[i] + gap;
    if (used + add > avail) break;
    out.push(i);
    used += add;
  }
  if (active >= 0 && !out.includes(active)) {
    // Drop from the end until the active tab fits in place of what it pushes out.
    while (out.length && used + widths[active] + gap > avail) used -= widths[out.pop()!] + gap;
    out.push(active);
  }
  return out.length ? out : [Math.max(0, active)];
}
