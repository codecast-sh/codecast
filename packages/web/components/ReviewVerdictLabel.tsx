import { REVIEW_VERDICT_WORDS, type ReviewVerdict } from "../lib/quoteFormat";
import "./ReviewNavigation.css";

// A typed verdict's words in the review tray's verdict colours, shared by the
// message rail's chips and the composer's batch tray.
export function VerdictLabel({ verdict }: { verdict: ReviewVerdict }) {
  return <span className="cc-review-tray-verdict" data-verdict={verdict}>{REVIEW_VERDICT_WORDS[verdict]}</span>;
}
