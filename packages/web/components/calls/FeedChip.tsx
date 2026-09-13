import { useMemo } from "react";
import { X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";

// A session row in the store by any of the ids a route target can carry: the
// conversation id, the agent's session id, or the short id. Shared by every
// call surface that names a fed session (the feed chips, the chat rail's
// participants strip) so they cannot disagree about which session a route is.
export function findSessionRow(state: any, ref: string): any | null {
  const direct = state.sessions?.[ref];
  if (direct) return direct;
  const rows = Object.values(state.sessions ?? {}) as any[];
  return (
    rows.find(
      (x) =>
        x &&
        (String(x._id) === ref || String(x.session_id) === ref || String(x.short_id ?? "") === ref),
    ) ?? null
  );
}

// A live transcript route rendered as a chip: what kind, where, removable by
// its adder. Shared by the call stage's transcript rail and the call page
// header so a feed reads the same wherever it appears.
export function FeedChip({
  route,
  removable,
  onRemove,
}: {
  route: { kind: string; target: string; mode: string };
  removable: boolean;
  onRemove: () => void;
}) {
  const label = useMemo(() => {
    if (route.kind === "slack") return `#${route.target.slice(0, 12)}`;
    const st = useInboxStore.getState() as any;
    if (route.kind === "session") {
      return (findSessionRow(st, route.target)?.title || "session").slice(0, 26);
    }
    const doc = (st.docs ?? {})[route.target];
    return (doc?.title || doc?.display_title || "doc").slice(0, 26);
  }, [route.kind, route.target]);
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-sol-bg-highlight px-2 py-0.5 font-mono text-[10.5px] text-sol-text-muted">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          route.kind === "session" ? "bg-sol-violet" : route.kind === "doc" ? "bg-sol-yellow" : "bg-sol-cyan"
        }`}
      />
      <span className="max-w-[130px] truncate">{label}</span>
      {removable && (
        <button onClick={onRemove} className="text-sol-text-muted hover:text-sol-red" title="Stop this feed">
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
