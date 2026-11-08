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
  /** Lines added and removed per file; total.ts is the diff the trace blames. */
  diff: { "packages/web/lib/cart/total.ts": { add: 2, del: 4 }, "packages/convex/convex/checkout.ts": { add: 3, del: 1 } },
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

/*
 * Shared numbers. Every count a section shows that also appears in another
 * section comes from here, so the page never disagrees with itself.
 */

/** The sources the Loop watches, with today's count and the silent-source state. */
export const SOURCES = [
  { label: "New issues", source: "sentry", today: 1892, state: "flowing" },
  { label: "Failed jobs", source: "ci", today: 311, state: "flowing" },
  { label: "Eval reds", source: "evals", today: 73, state: "flowing" },
  { label: "Teammate reports", source: "person", today: 0, state: "quiet" },
  { label: "Judge mistakes", source: "judge", today: 0, state: "stopped" },
] as const;
export const SIGNALS_TODAY = 2276;

/** Triage and the line right now. Queued never exceeds open. */
export const NOW = { open: 23, queued: 17, running: 2, slots: 4, onPerson: 2, liveToday: 42, watching: 47 } as const;

/**
 * Regret-free rates, settled changes only. The Checkout role is part of the
 * Line bucket. Before the trace, Checkout stood at 92% of 36 settled (its bar
 * is 90% over at least 20); the trace settles 3e9b2a0 as regretted, which
 * makes it 33 regret-free of 37 settled = 89%, under its bar, so its next
 * changes wait for a person.
 */
export const RATES = {
  line: { settled: 164, regretted: 13 }, // 92%
  person: { settled: 120, regretted: 12 }, // 90%
  noFlow: { settled: 912, regretted: 146 }, // 84%
  window: 6,
} as const;
export const CHECKOUT = { bar: 0.9, min: 20, before: { settled: 36, regretted: 3 } /* 92% */, after: { settled: 37, regretted: 4 }, dailyLimit: 5 } as const;
/** Roles that merge without a person before the trace; after it Checkout waits, leaving 7. */
export const ROLES = { merging: 8, total: 17 } as const;

/** What `cast flow await-deploy` prints when the change is live everywhere it ships. */
export const LIVE_LINE = "Live: e3f0a71 on web dp-411, backend dp-412.";
