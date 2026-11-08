"use client";
// Each project's sessions by work state, counted by the one membership rule
// (store/workProjects, session-projects.md SP1): put in the project, bound to
// its task or plan, or started by a session in it. The subscription is a short
// digest of the counts, so a heartbeat that changes no state wakes nothing.
import { useMemo } from "react";
import { sessionWorkState, useInboxStore } from "../store/inboxStore";
import { workProjectsBySession } from "../store/workProjects";
import { useCoarseNow } from "./useCoarseNow";
import { EMPTY_COUNTS, type StateCounts } from "../components/org/orgTypes";

export function useProjectSessionCounts(): ReadonlyMap<string, StateCounts> {
  const now = useCoarseNow(30_000);
  const digest = useInboxStore((s) => {
    const by = workProjectsBySession(s);
    const counts = new Map<string, Record<string, number>>();
    for (const [sessionId, projectId] of by) {
      const row = projectId ? s.sessions[sessionId] : undefined;
      if (!row) continue;
      const state = sessionWorkState(row, now);
      const c = counts.get(projectId!) ?? {};
      c[state] = (c[state] ?? 0) + 1;
      counts.set(projectId!, c);
    }
    return [...counts].map(([p, c]) => `${p}=${Object.entries(c).map(([k, v]) => `${k}:${v}`).join(",")}`).sort().join(";");
  });
  return useMemo(() => {
    const out = new Map<string, StateCounts>();
    for (const part of digest.split(";").filter(Boolean)) {
      const [p, body] = part.split("=");
      const c: StateCounts = { ...EMPTY_COUNTS };
      for (const kv of body.split(",")) { const [k, v] = kv.split(":"); (c as any)[k] = Number(v); }
      out.set(p, c);
    }
    return out;
  }, [digest]);
}
