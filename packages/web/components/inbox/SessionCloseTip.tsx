import { useInboxStore, type InboxSession } from "../../store/inboxStore";
import { closeTooltip } from "../../lib/sessionClose";
import { closeFactsInStore } from "../../lib/closeFactsInStore";

/** The Close button's tooltip: what Close does to this session now. Drawn
 *  only while the tooltip is open, so the trigger roster and the nested
 *  group are read then, not by every card. */
export function SessionCloseTip({ session }: { session: InboxSession }) {
  const now = Date.now();
  const words = useInboxStore((s) => closeTooltip(closeFactsInStore(s as any, session, now)));
  return <>{words}</>;
}
