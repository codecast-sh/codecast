import { useInboxStore, convHasPendingSend, type InboxSession } from "../../store/inboxStore";
import { closeFactsOf, closeTooltip } from "../../lib/sessionClose";
import { armedInjectTasksFor, type TaskRow } from "../triggerTasks";

/** The Close button's tooltip: what Close does to this session now. Drawn
 *  only while the tooltip is open, so the trigger roster is read then, not by
 *  every card. */
export function SessionCloseTip({ session }: { session: InboxSession }) {
  const triggers = useInboxStore((s) => armedInjectTasksFor(Object.values(s.agentTasks ?? {}) as TaskRow[], session._id).length);
  const pendingSend = useInboxStore((s) => convHasPendingSend(s.pendingMessages[session._id]));
  return <>{closeTooltip(closeFactsOf(session, triggers, Date.now(), pendingSend))}</>;
}
