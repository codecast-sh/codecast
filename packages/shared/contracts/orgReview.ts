// The Company review (docs/architecture/org-staffing.md S6, S24): the Head of
// People's one routine, and the focuses a person can give one run of it from
// the role's own thread. The trigger's title is how every reader (the role
// page's offer, the health panel, the CLI) finds the routine among a seat's
// triggers, so it lives here beside the focuses rather than in convex alone.

export const COMPANY_REVIEW_TITLE = "Company review";

/** A focus narrows one run of the review without changing the trigger: the
 *  run arrives in the same frame with the focus named on it and its words
 *  ahead of the routine's prompt. The key is what the client asks for and the
 *  row stores (`requested_run_focus`); the label is what the run line says,
 *  and `running` how it reads while the run is in flight. */
export const ORG_REVIEW_FOCUSES = {
  goal_tree: {
    label: "Plan the goal tree",
    running: "Planning the goal tree",
    prompt: [
      "This run is about the goal tree, not the chart. Read what people said the company is pursuing, and the initiatives against the work that is actually happening, and propose the tree as it should stand: the goals the company is pursuing, which goal each one serves, who answers for it, the projects that carry it, and the metric that says whether each is on track, with a current value where the records give one.",
      "Bring the whole tree in this run, because a person can judge a tree only when they see all of it: the top level goal and every goal under it, each in its place, in as few small proposals as carry it. Leave roles, reporting lines and the records' statuses as they are unless a goal has no owner, and ask what people's own words cannot settle.",
    ].join("\n\n"),
  },
} as const;

export type OrgReviewFocusKey = keyof typeof ORG_REVIEW_FOCUSES;

export function isOrgReviewFocusKey(key: unknown): key is OrgReviewFocusKey {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(ORG_REVIEW_FOCUSES, key);
}

/** The focus a stored key names, or null for none or an unknown key. */
export function orgReviewFocusOf(key: string | null | undefined): { key: OrgReviewFocusKey; label: string; running: string; prompt: string } | null {
  return isOrgReviewFocusKey(key) ? { key, ...ORG_REVIEW_FOCUSES[key] } : null;
}
