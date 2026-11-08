/*
 * The one change the page follows from signal to autonomy. Every section
 * draws these same names, ids and shas, so a reader can watch a single
 * problem travel the whole pipeline. Everything here is illustrative; the
 * rules each section applies to it are real (see the header of Page.tsx).
 *
 * The plot: an agent's change (CAUSE) lands and ships. Days later a Sentry
 * error starts arriving (PROBLEM). A person picks the problem up in their
 * session and sends the fix (CHANGE) through the Change flow; it lands,
 * deploys to web and backend, and is watched. That night the trace reads the
 * fix and blames its lines back to CAUSE, which becomes a regretted change on
 * its role's record, and that record is what the role's merge setting reads.
 */

export const PROBLEM = {
  title: "Checkout total throws on an empty cart",
  source: "sentry",
  sourceLabel: "New issues",
  key: "sentry:checkout-total",
  signals: 42,
  task: "ct-4182",
} as const;

/** The fix a person sends through Change, snapshot by snapshot. */
export const CHANGE = {
  title: "Fix checkout total for an empty cart",
  task: PROBLEM.task,
  branch: "codecast/change-ct-4182",
  /** Frozen from the session. */
  frozen: "a41c9e2",
  /** After Fix check. */
  afterFix: "7d03b5f",
  /** After Address review; what Review approved and Decide accepted. */
  approved: "c92e1a4",
  /** On main after Land. */
  landed: "e3f0a71",
  subject: "fix(web): total of an empty cart is 0",
  files: ["packages/web/lib/cart/total.ts", "packages/convex/convex/checkout.ts"],
  targets: ["web", "backend"] as const,
  deploys: { web: "dp-411", backend: "dp-412" },
  landedOn: "Nov 3",
  liveOn: "Nov 4",
  watchUntil: "Nov 11",
  session: "jx7m4q2",
} as const;

/** The earlier change the fix's lines blame back to. */
export const CAUSE = {
  sha: "3e9b2a0",
  subject: "feat(web): totals from line items",
  role: "Checkout",
  session: "jx7k2qa",
  sessionTitle: "Totals from line items",
  /** Lines of the fix that blame to it (the top introducer). */
  lines: 3,
} as const;

/** The role whose line wrote CAUSE; its merge setting reads its own rate. */
export const ROLE = { name: "Checkout", lead: "Checkout lead" } as const;
