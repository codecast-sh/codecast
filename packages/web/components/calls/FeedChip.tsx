import { Sparkles, X } from "lucide-react";
import { useTrackedStore } from "../../store/inboxStore";
import { findSessionRow } from "../../lib/calls/findSessionRow";

/** What a session route is called before its session has a title. The room
 *  thread's roster uses the same word, so one missing title has one name. */
export const NEW_AGENT_NAME = "new agent";

// A live transcript route rendered as a chip: what kind, where, removable by
// its adder. Shared by the call stage's thread and the call page so a feed
// reads the same wherever it appears. The label follows the store, so a
// session added before it has a title takes the title when it lands; a
// caller that already knows the name passes `label`.
function routeLabel(st: any, route: { kind: string; target: string }): string {
  if (route.kind === "slack") return `#${route.target.slice(0, 12)}`;
  if (route.kind === "session") return findSessionRow(st, route.target)?.title || NEW_AGENT_NAME;
  const doc = (st.docs ?? {})[route.target];
  return doc?.title || doc?.display_title || "doc";
}

export function FeedChip({
  route,
  label: given,
  removable,
  onRemove,
}: {
  route: { kind: string; target: string; mode: string };
  label?: string;
  removable: boolean;
  onRemove: () => void;
}) {
  const st = useTrackedStore([(s) => routeLabel(s, route)]);
  const label = (given ?? routeLabel(st, route)).slice(0, 26);
  const agent = route.kind === "session";
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-sol-bg-highlight px-2 py-0.5 font-mono text-[10.5px] text-sol-text-muted">
      {agent ? (
        <Sparkles className="h-2.5 w-2.5 shrink-0 text-sol-violet" />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${route.kind === "doc" ? "bg-sol-yellow" : "bg-sol-cyan"}`} />
      )}
      <span className="max-w-[130px] truncate">{label}</span>
      {removable && (
        <button
          type="button"
          onClick={onRemove}
          className="fc-remove text-sol-text-muted hover:text-sol-red"
          title={agent ? `Remove ${label} from the room` : "Stop this feed"}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
