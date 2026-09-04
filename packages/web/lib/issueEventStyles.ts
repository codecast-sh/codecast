import { ArrowRightLeft, CircleCheck, CircleDot, MessageSquare, Pencil, RotateCcw, UserCheck } from "lucide-react";
import { registerExternalEventStyles, type ExternalEventStyle } from "./externalEvents";

// Feed styles for the issue kinds (docs/architecture/issue-sync.md S8). The
// rows themselves render through ExternalEventRow; this file only teaches it
// the icon, accent and verb for each kind. Imported once from App.tsx so the
// registration runs before any feed paints.
export const ISSUE_EVENT_STYLES: Record<string, ExternalEventStyle> = {
  issue_opened: { icon: CircleDot, accent: "green", verb: "opened" },
  issue_assigned: { icon: UserCheck, accent: "blue", verb: "assigned" },
  issue_closed: { icon: CircleCheck, accent: "violet", verb: "closed" },
  issue_reopened: { icon: RotateCcw, accent: "yellow", verb: "reopened" },
  issue_commented: { icon: MessageSquare, accent: "cyan", verb: "commented on" },
  issue_status: { icon: ArrowRightLeft, accent: "blue", verb: "moved" },
  issue_edited: { icon: Pencil, accent: "muted", verb: "edited" },
};

registerExternalEventStyles(ISSUE_EVENT_STYLES);
