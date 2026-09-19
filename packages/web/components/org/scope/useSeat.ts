// How a standing conversation reads when it is the left side of a page
// (docs/architecture/initiatives-projects-role-page.md I3): the agent's
// opening bubble pinned above it, the condensed density with working turns
// folded, the composer as Talk, and the Session view control. One definition,
// so a role's page and an initiative's page show the same conversation.
import { useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { SeatConversation } from "../../../app/inbox/QueuePageClient";
import { askSessionView } from "../../../lib/sessionViewVisit";

export function useSeat({ conversationId, speaker, lead, canTalk, hideDiff, onSessionView }: {
  conversationId: string | null | undefined;
  /** Who the composer addresses: "Ask <speaker> for anything". */
  speaker: string;
  lead: ReactNode;
  /** The person may talk to the seat (host, parent or admin); anyone else reads and asks to send. */
  canTalk: boolean;
  /** The panel beside the conversation is open, so the diff stays shut. */
  hideDiff: boolean;
  /** The pane that renders this page in place of a session supplies its own. */
  onSessionView?: () => void;
}): SeatConversation {
  const router = useRouter();
  return useMemo(() => ({
    layout: {
      leadNode: lead,
      leadPinned: true,
      stickyPrompt: false,
      initialDensity: "condensed",
      foldWorkingTurns: true,
      composerPlaceholder: `Ask ${speaker} for anything…`,
      hideDiff,
    },
    seedOwnership: canTalk,
    // From a page's own route the plain view is the session's address; the
    // pane that opens it reads the ask (lib/sessionViewVisit).
    onSessionView: onSessionView ?? (() => { if (!conversationId) return; askSessionView(conversationId); router.push(`/conversation/${conversationId}`); }),
  }), [lead, speaker, hideDiff, canTalk, onSessionView, conversationId, router]);
}
