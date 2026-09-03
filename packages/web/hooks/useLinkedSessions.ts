// The store rows for a named set of sessions (a PR's linked sessions, and
// anything else that holds ids rather than rows).
//
// Re-render discipline (CLAUDE.md store rules): never subscribe to the whole
// `sessions` collection, a liveness heartbeat on any session hands back a new
// ref and re-renders on every tick. This subscribes to a signature over ONLY
// the named rows and only the fields a session card paints.
import { useMemo } from "react";
import { useTrackedStore } from "../store/inboxStore";

const cardSig = (row: any): string =>
  row
    ? `${row.title}|${row.is_active}|${row.updated_at}|${row.message_count ?? ""}|${row.summary ?? ""}`
    : "none";

export function useLinkedSessions(ids: readonly string[]): any[] {
  const key = ids.join(",");
  const dep = useMemo(
    () =>
      Object.assign(
        (st: any) => ids.map((id) => cardSig(st.sessions?.[id] ?? st.conversations?.[id])).join("\n"),
        { label: `linkedSessions(${key})` },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the joined key stands in for the array
    [key],
  );
  const s = useTrackedStore([dep]);
  return ids
    .map((id) => (s as any).sessions?.[id] ?? (s as any).conversations?.[id])
    .filter(Boolean);
}
