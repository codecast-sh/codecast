// The one way to copy a link into a call: a turn, a passage, the summary, an
// action item. Every one is a CallAnchor, so the link it copies is the same
// one the page lands on (callAnchorHref / parseCallAnchor).
import { Link2 } from "lucide-react";
import type { CallAnchor } from "@codecast/shared/contracts";
import { copyCallLink } from "../../lib/calls/callLinks";

/** A hover-revealed link glyph. Its parent carries `group`; the click never
 *  reaches the row under it (a turn click selects, a head click folds). */
export function CallLinkButton({
  callId,
  anchor,
  title,
  className = "",
}: {
  callId: string;
  anchor: CallAnchor;
  title: string;
  className?: string;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        copyCallLink(callId, anchor);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        copyCallLink(callId, anchor);
      }}
      className={`inline-flex shrink-0 cursor-pointer items-center rounded p-0.5 text-sol-text-dim opacity-0 transition-opacity hover:text-sol-cyan focus:opacity-100 group-hover:opacity-100 ${className}`}
    >
      <Link2 className="h-3 w-3" />
    </span>
  );
}
