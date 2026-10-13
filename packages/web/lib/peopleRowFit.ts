// Which person pills fit on one row, given each pill's measured width. When they
// don't all fit, room is kept for the "+N" overflow pill and the selected person
// claims a slot first so the active filter never hides in the menu. Returns the
// visible indices in their original order.
export function fitPeopleRow(widths: number[], available: number, gap: number, moreWidth: number, selected = -1): number[] {
  const all = widths.map((_, i) => i);
  const total = widths.reduce((s, w) => s + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return all;
  const order = selected >= 0 ? [selected, ...all.filter((i) => i !== selected)] : all;
  const picked: number[] = [];
  let used = moreWidth;
  for (const i of order) {
    const next = used + gap + widths[i];
    if (next > available) break;
    picked.push(i);
    used = next;
  }
  return picked.sort((a, b) => a - b);
}
