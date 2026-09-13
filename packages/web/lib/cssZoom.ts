// The in-app zoom (DashboardLayout's zoom.in/out shortcuts) sets CSS zoom on
// <html>. Under CSS zoom, getBoundingClientRect() returns screen px (layout px
// × zoom) while everything layout math works in — scrollTop, scrollHeight,
// offsetHeight, inline margins and widths — stays layout px. Any rect-derived
// length must be divided by this factor before mixing with layout px.
export const cssZoomOf = (el: Element): number =>
  (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
