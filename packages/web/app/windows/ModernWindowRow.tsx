import { Plus } from "lucide-react";
import { railRowPlacement, type InboxSession } from "../../store/inboxStore";
import { sessionStatusOf } from "../../lib/sessionStatus";
import { cleanTitle } from "../../lib/conversationProcessor";
import { formatRowTime } from "../../lib/sessionCard";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { SessionStatusMark, SessionStatusWord } from "../../components/inbox/SessionStatusMark";

/** A session the Window Manager can open, in the Modern style: the state's
 *  mark and word from the status vocabulary (lib/sessionStatus), the title and
 *  the time, one line. */
export function ModernWindowRow({ session, now, onOpen }: { session: InboxSession; now: number; onOpen: (id: string) => void }) {
  const status = sessionStatusOf({ row: session, placement: railRowPlacement(session, now), now, hosted: isHostedAgentType(session.agent_type) });
  return (
    <button
      type="button"
      data-mc-status={status}
      onClick={() => onOpen(session._id)}
      className="group flex w-full min-w-0 items-center gap-2.5 rounded-control px-3 py-2 text-left transition-colors hover:bg-sol-text/[0.05]"
    >
      <SessionStatusMark status={status} />
      <span className="min-w-0 flex-1 truncate text-ui text-sol-text">{cleanTitle(session.title || "New Session")}</span>
      <SessionStatusWord status={status} className="shrink-0 text-meta" />
      <span className="shrink-0 text-meta tabular-nums text-sol-text-dim">{formatRowTime(session.updated_at, isHostedAgentType(session.agent_type), now)}</span>
      <Plus aria-hidden className="h-3.5 w-3.5 shrink-0 text-sol-text-dim group-hover:text-sol-cyan" />
    </button>
  );
}
