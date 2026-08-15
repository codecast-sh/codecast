/**
 * The two site-policy hooks every browser driver path calls.
 *
 * `cast browser` can drive Chrome through more than one engine (the built-in
 * CDP driver, the agent-browser engine, the extension bridge). The allowlist
 * and the audit trail must behave identically on all of them, so the decision
 * lives here and each driver adds exactly two calls:
 *
 *   1. `refuseNavigation(url, ...)` BEFORE an explicit navigation. Non-null
 *      means "do not navigate": the caller prints/throws the message and stops.
 *      The refused attempt is already on the audit trail by the time it
 *      returns.
 *   2. `auditLanding(...)` AFTER any step that can move the page — same call
 *      the built-in driver makes after `settle`. It records the origin and
 *      returns a warning when the page is somewhere the policy would not have
 *      allowed (an in-page click, a redirect). It never yanks the page back.
 *
 * Both take the current URL as a string, so an engine only has to be able to
 * say where its tab is — nothing about CDP leaks through this seam.
 */

import { denyNavigation, loadSitePolicy, type SitePolicy } from "./policy.js";
import { auditLanding, recordBlocked, type AuditVia } from "./audit.js";

export { auditLanding };
export type { AuditVia, SitePolicy };

/** Normalise the way `open` does, so a bare host is checked as https. */
export function withScheme(url: string): string {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * The pre-navigation gate. Returns the refusal to show, or null to proceed.
 * Loads the policy itself unless one is passed (a batch loads once).
 */
export function refuseNavigation(
  url: string,
  session: string | null,
  via: AuditVia,
  policy: SitePolicy | null = loadSitePolicy(),
): { message: string; hint: string } | null {
  const target = withScheme(url);
  const deny = denyNavigation(policy, target);
  if (!deny) return null;
  recordBlocked(target, session, via);
  return deny;
}

/**
 * Verbs that can change which page a tab is on. Drivers with a passthrough
 * shape (one engine call per verb) audit after any of these; drivers with
 * per-verb code call `auditLanding` where they already settle.
 */
export const NAVIGATING_VERBS: ReadonlySet<string> = new Set([
  "open", "goto", "click", "type", "fill", "press", "select", "back", "forward", "reload", "do", "batch",
]);

/** Which audit `via` label a passthrough verb maps to. */
export function viaFor(verb: string): AuditVia {
  if (verb === "open" || verb === "goto") return "open";
  if (verb === "back" || verb === "forward") return "history";
  if (verb === "reload") return "reload";
  if (verb === "do" || verb === "batch") return "batch";
  return "action";
}
