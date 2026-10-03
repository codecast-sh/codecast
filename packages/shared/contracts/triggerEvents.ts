// The vocabulary of `cast trigger add --on <event>`: one name per thing worth
// waking for, and the filter each name arms.
//
// This lives here because three copies of it had already drifted. The CLI knew
// the derived pull request events and the web did not, the web's label map knew
// a fourth subset, and `pr_merged` armed the raw "pull request closed" webhook,
// which also fires when a pull request is closed WITHOUT merging. Anything that
// offers or renders this choice imports these.
//
// Two kinds of name live here, and the difference is where the filter comes
// from:
//
//   DERIVED — the backend fires the name itself (prShepherd.firePrTrigger and
//   githubWebhooks.fireTrigger), so the filter is just the name. A trigger
//   waits for "the checks went red" instead of decoding a webhook payload.
//
//   RAW — the name stands for a GitHub webhook kind and action, because
//   nothing derives that event. The backend still matches these, which is also
//   what keeps triggers armed before the derived names existed working.

export interface TriggerEventFilter {
  event_type: string;
  action?: string;
}

/** A derived event's filter is its own name. */
const derived = (name: string): TriggerEventFilter => ({ event_type: name });

export const TRIGGER_EVENT_SHORTHANDS: Record<string, TriggerEventFilter> = {
  // ── Derived pull request events ──
  pr_opened: derived("pr_opened"),
  pr_synchronize: derived("pr_synchronize"),
  pr_ready: derived("pr_ready"),
  pr_review_requested: derived("pr_review_requested"),
  pr_review: derived("pr_review"),
  pr_approved: derived("pr_approved"),
  pr_changes_requested: derived("pr_changes_requested"),
  pr_check_failed: derived("pr_check_failed"),
  pr_checks_green: derived("pr_checks_green"),
  pr_behind: derived("pr_behind"),
  pr_conflict: derived("pr_conflict"),
  // Merged and closed are separate names because the backend fires them
  // separately: a pull request closed without merging is not a merge, and a
  // trigger that waits for one should never fire on the other.
  pr_merged: derived("pr_merged"),
  pr_closed: derived("pr_closed"),

  // ── Raw GitHub webhooks ──
  // Nothing derives a review comment or a push, so these name the webhook.
  pr_comment: { event_type: "pull_request_review_comment", action: "created" },
  push: { event_type: "push" },

  // Issue events. Linear and GitHub both normalize into this provider pair
  // before the filter is matched, so one trigger covers an issue wherever it
  // lives (docs/architecture/issue-sync.md S7).
  issue_opened: { event_type: "issues", action: "opened" },
  issue_assigned: { event_type: "issues", action: "assigned" },
  issue_labeled: { event_type: "issues", action: "labeled" },
  issue_closed: { event_type: "issues", action: "closed" },
  issue_commented: { event_type: "issue_comment", action: "created" },

  // ── Derived ingestion events (docs/architecture/external-data.md X4) ──
  // Fired by the group upsert on a transition (ingest.transitionTriggerEvent),
  // narrowed by `source` rather than a repository.
  error_new: derived("error_new"),
  error_regressed: derived("error_regressed"),
  error_spike: derived("error_spike"),
  job_failed: derived("job_failed"),
  check_failed: derived("check_failed"),
  check_recovered: derived("check_recovered"),
  metric_alert: derived("metric_alert"),
  metric_recovered: derived("metric_recovered"),
  deploy: derived("deploy"),
};

/**
 * Fired by the backend for a role, never armed by hand: a session that reports
 * to the role needs input (docs/architecture/org-staffing.md S28). It is not a
 * shorthand, because `--on` arms a trigger on any session and only a role's
 * own trigger is ever fired with it.
 */
export const SESSION_NEEDS_INPUT_EVENT = "session_needs_input";

/**
 * Fired by the area watch for the Head of People, never armed by hand
 * (docs/architecture/org-staffing.md S29): an area read stuck or overloaded
 * at two checks in a row, or a project with work has no role looking after it.
 */
export const ORG_AREA_CHANGE_EVENT = "org_area_change";

export type TriggerEventName = keyof typeof TRIGGER_EVENT_SHORTHANDS;

/** Every name, in the order above, for help text and pickers. */
export const TRIGGER_EVENT_NAMES = Object.keys(TRIGGER_EVENT_SHORTHANDS);

/**
 * What each name means, for a person reading a trigger rather than writing
 * one. Rendered in the web trigger list and detail pages.
 */
export const TRIGGER_EVENT_LABELS: Record<string, string> = {
  pr_opened: "PR opened",
  pr_synchronize: "PR got new commits",
  pr_ready: "PR ready for review",
  pr_review_requested: "review requested",
  pr_review: "PR reviewed",
  pr_approved: "PR approved",
  pr_changes_requested: "changes requested",
  pr_check_failed: "checks went red",
  pr_checks_green: "checks went green",
  pr_behind: "PR fell behind",
  pr_conflict: "PR has conflicts",
  pr_merged: "PR merged",
  pr_closed: "PR closed without merging",
  pr_comment: "PR comment",
  push: "push",
  issue_opened: "issue opened",
  issue_assigned: "issue assigned",
  issue_labeled: "issue labeled",
  issue_closed: "issue closed",
  issue_commented: "issue comment",
  error_new: "new error",
  error_regressed: "error came back",
  error_spike: "error spiked",
  job_failed: "job failed",
  check_failed: "check went red",
  check_recovered: "check recovered",
  metric_alert: "metric crossed its line",
  metric_recovered: "metric back inside its line",
  deploy: "deploy",
  [SESSION_NEEDS_INPUT_EVENT]: "a session under the role needs input",
  [ORG_AREA_CHANGE_EVENT]: "an area of the company changed and it lasted",
};

/**
 * The events about one pull request. These are the ones a repository and a
 * pull request number narrow, so the CLI scopes them to the checkout it runs
 * in when the caller does not say otherwise.
 */
export const PR_TRIGGER_EVENTS = TRIGGER_EVENT_NAMES.filter((name) => name.startsWith("pr_"));

export function isPrTriggerEvent(name: string | undefined): boolean {
  return !!name && PR_TRIGGER_EVENTS.includes(name);
}

/**
 * The events a running product reports through a source. These are the ones
 * `--source <name>` narrows, the way a repository narrows the pull request
 * events.
 */
export const INGEST_TRIGGER_EVENTS = [
  "error_new",
  "error_regressed",
  "error_spike",
  "job_failed",
  "check_failed",
  "check_recovered",
  "metric_alert",
  "metric_recovered",
  "deploy",
];

export function isIngestTriggerEvent(name: string | undefined): boolean {
  return !!name && INGEST_TRIGGER_EVENTS.includes(name);
}

/**
 * The shorthand a stored filter came from, so a trigger reads back in the same
 * words it was armed with. Falls back to the raw pair for a filter nothing
 * here names, which is what an old trigger armed on a raw webhook looks like.
 */
export function triggerEventShorthand(filter: TriggerEventFilter | undefined): string | undefined {
  if (!filter) return undefined;
  for (const [name, def] of Object.entries(TRIGGER_EVENT_SHORTHANDS)) {
    if (def.event_type === filter.event_type && (def.action ?? undefined) === (filter.action ?? undefined)) {
      return name;
    }
  }
  return filter.action ? `${filter.event_type}:${filter.action}` : filter.event_type;
}

/** The label for a stored filter or a bare name, never blank. */
export function triggerEventLabel(nameOrFilter: string | TriggerEventFilter | undefined): string {
  if (!nameOrFilter) return "event";
  const name = typeof nameOrFilter === "string" ? nameOrFilter : triggerEventShorthand(nameOrFilter);
  if (!name) return "event";
  return TRIGGER_EVENT_LABELS[name] ?? name.replace(/_/g, " ");
}

/** A stored event filter with the narrowings an event can carry. */
export interface TriggerScopeFilter extends TriggerEventFilter {
  repository?: string;
  pr_number?: number;
  source?: string;
}

/** What a trigger is watching, in one line, so nobody has to guess its scope. */
export function describeEventScope(filter: TriggerScopeFilter): string {
  const name = triggerEventShorthand(filter) ?? filter.event_type;
  if (isIngestTriggerEvent(filter.event_type)) {
    return `on ${name} from ${filter.source ? `source ${filter.source}` : "every source you can see"}`;
  }
  const where = filter.repository
    ? `${filter.repository}${filter.pr_number ? `#${filter.pr_number}` : ""}`
    : "every repository you can see";
  return `on ${name} in ${where}`;
}

/**
 * The filter a form saves for the event it shows: the event's own filter,
 * keeping the narrowings of the stored one that still apply to it (a source
 * for a source event, a repository for any repository event, a pull request
 * number for a pull request event). A form that offers only the event must not widen a trigger armed
 * from the CLI with --source or --repo when it saves.
 */
export function eventFilterForSave(eventName: string, prior: TriggerScopeFilter | undefined): TriggerScopeFilter | undefined {
  const base = TRIGGER_EVENT_SHORTHANDS[eventName];
  if (!base) return undefined;
  const out: TriggerScopeFilter = { ...base };
  if (prior && isIngestTriggerEvent(eventName) && prior.source) out.source = prior.source;
  // --repo narrows every repository event (push, issue_*, pr_*); --pr only pull requests.
  if (prior && !isIngestTriggerEvent(eventName) && prior.repository) out.repository = prior.repository;
  if (prior && isPrTriggerEvent(eventName) && prior.pr_number !== undefined) out.pr_number = prior.pr_number;
  return out;
}
