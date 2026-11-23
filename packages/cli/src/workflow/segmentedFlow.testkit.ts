/**
 * A flow built from the shipped check and review segments (flows.md FL2), for tests about a segment's stations inside a
 * flow: each segment's failure goes back to the session, and a check the machine could not run goes to the machine's
 * own stop. No shipped flow strings these two segments together, so the tests carry their own.
 */
export const SEGMENTED_FLOW = `digraph checked {
  graph [kind="line", label="Checked", takes="task,branch", on_failure=stop]
  start [shape=Mdiamond]
  check  [flow="check"]
  review [flow="review"]
  exit [shape=Msquare, label="Done"]
  fix_check [label="Fix check", backend=subject, max_visits=3, prompt="Fix what Check found."]
  fix_review [label="Address review", backend=subject, max_visits=3, prompt="Address the review."]
  unchecked [shape=Msquare, label="Not checked here", machine=true, stop="$stop_reason"]
  rejected  [shape=Msquare, label="Rejected", stop="The reviewer rejected the change. $review_note"]
  start -> check
  check -> review
  check -> fix_check [condition="outcome = failure and check.exit != unjudged", label="check failed"]
  check -> unchecked [condition="outcome = failure and check.exit = unjudged", label="not checked here"]
  review -> exit
  review -> fix_review [condition="outcome = failure and review.exit = changes", label="changes asked"]
  review -> rejected   [condition="outcome = failure and review.exit = rejected", label="rejected"]
  fix_check -> check
  fix_review -> check
}
`;
