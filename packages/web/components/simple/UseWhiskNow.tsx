// "Use Whisk for mail now": a quiet link out to Whisk, the step that works
// today while mail cannot reach the assistant yet (connecting is closed on
// this deployment). Settings' Whisk card, the chip under a reply that says
// mail is coming (conversation/HostedNotice MailConnectChip) and /welcome's
// Start step all draw it.
import { ExternalLink } from "lucide-react";
import { LANE_COPY } from "./lane";
import { WHISK_HOME } from "./useLaneMail";

// /welcome's Start step says the same link inline, after MAIL_COMING, so the
// funnel and the app never disagree about mail (`inline`, in the step's own
// link style).
export function UseWhiskNow({ inline = false, className }: { inline?: boolean; className?: string } = {}) {
  if (inline) {
    return (
      <a href={WHISK_HOME} target="_blank" rel="noreferrer" className={className}>
        {LANE_COPY.connections.useWhiskNow}
      </a>
    );
  }
  return (
    <a href={WHISK_HOME} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-md border border-sol-border px-2.5 text-xs text-sol-text no-underline transition-colors hover:bg-sol-bg-highlight">
      {LANE_COPY.connections.useWhiskNow}
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}
