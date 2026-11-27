// The data under "Where your messages went" (components/priorities/MessagesByWorkspace):
// each workspace the viewer belongs to, its typing per day (convex
// priorities.history) split by today's ranks (priorities.list). Enrichment
// reads beside the store: other workspaces' priorities are not in it.
import { useMemo } from "react";
import { useQueries } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { PriorityHistory, PriorityList } from "@codecast/shared/contracts/priorities";
import { splitDays, type WorkspaceDays } from "../lib/priorityBreakdown";
import { useInboxStore } from "../store/inboxStore";

/**
 * Every workspace the viewer belongs to (each team, and their personal one),
 * its typing per day split by today's ranks. One useQueries call holds the
 * two reads per workspace, so the set can change without breaking hook order;
 * a failed read comes back as its Error and counts as no data.
 */
export function useWorkspaceDays(days: string[]): WorkspaceDays[] {
  const teams = useInboxStore((s) => s.teams);
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const spaces = useMemo(
    () => [
      ...(teams ?? []).map((t: { _id: string; name: string }) => ({ workspace: `team:${t._id}`, name: t.name })),
      ...(viewerId ? [{ workspace: `user:${viewerId}`, name: "Personal" }] : []),
    ],
    [teams, viewerId],
  );
  const n = days.length;
  const tz = new Date().getTimezoneOffset();
  const queries = useMemo(
    () => Object.fromEntries(spaces.flatMap((w) => [
      [`history:${w.workspace}`, { query: api.priorities.history, args: { workspace: w.workspace, days: n, tz_offset_minutes: tz } }],
      [`list:${w.workspace}`, { query: api.priorities.list, args: { workspace: w.workspace } }],
    ])),
    [spaces, n, tz],
  );
  const results = useQueries(queries);
  return spaces.map((w) => {
    const history = answer<PriorityHistory>(results[`history:${w.workspace}`]);
    const list = answer<PriorityList | null>(results[`list:${w.workspace}`]);
    const split = splitDays(history, list?.priorities ?? [], days);
    return { ...w, days: split, total: split.reduce((c, d) => c + d.total, 0) };
  });
}

const answer = <T>(value: unknown): T | undefined => (value === undefined || value instanceof Error ? undefined : (value as T));
