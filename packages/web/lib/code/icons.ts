// The editor's line icons outside React (status items, breadcrumb separators,
// fold markers): lucide's geometry on a 24-unit grid, stroke 2, round caps, the
// same as the lucide-react icons the chrome draws at h-3. One builder, so a
// status item, a crumb and a gutter mark cannot drift apart in size or weight.
// Each distinct icon is parsed once and cloned after.

const templates = new Map<string, SVGSVGElement>();

/** The status bar's icon size: one step with its 12px text. */
export const STATUS_ICON_PX = 12;

/** A lucide-style icon from its path markup, `px` square. */
export function lineIcon(paths: string, px = STATUS_ICON_PX, className?: string): SVGSVGElement {
  const key = `${px}|${paths}`;
  let t = templates.get(key);
  if (!t) {
    const holder = document.createElement("span");
    holder.innerHTML = `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    t = holder.firstElementChild as SVGSVGElement;
    templates.set(key, t);
  }
  const svg = t.cloneNode(true) as SVGSVGElement;
  if (className) svg.setAttribute("class", className);
  return svg;
}

/** lucide ChevronRight and ChevronDown. */
export const CHEVRON_RIGHT = '<path d="m9 18 6-6-6-6"/>';
export const CHEVRON_DOWN = '<path d="m6 9 6 6 6-6"/>';
