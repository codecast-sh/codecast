/** Whether this click should start the top progress bar. Extracted so the
 *  opt-outs stay testable: `data-no-progress` is how a same-origin <a> says
 *  the click will not produce a router transition. */
export function shouldStartNavigationProgress(
  e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button" | "target">,
  locationHref: string,
): boolean {
  // NOT a defaultPrevented check: React Router's Link prevents default too,
  // and those DO complete normally. Suppressing every prevented click would
  // remove the bar from the one case it works for. An anchor that navigates
  // by some other means says so with data-no-progress instead.
  //
  // A modifier click opens a new tab or window; this view isn't going
  // anywhere.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return false;

  const target = e.target as Element | null;
  if (!target || typeof target.closest !== "function") return false;
  const anchor = target.closest("a");
  if (!anchor) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download") || anchor.dataset.noProgress !== undefined) return false;

  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) return false;

  try {
    const targetUrl = new URL(href, locationHref);
    // Only a same-origin http(s) link routes in-app. Custom schemes — the
    // vault's `wiki://` payloads among them — are data for a handler, not
    // destinations the router will ever navigate to.
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") return false;
    const currentUrl = new URL(locationHref);
    if (targetUrl.origin !== currentUrl.origin) return false;
    if (targetUrl.pathname === currentUrl.pathname && targetUrl.search === currentUrl.search) return false;
    return true;
  } catch {
    return false;
  }
}
