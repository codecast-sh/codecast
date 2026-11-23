"use client";
// Each project's sessions by work state, counted by the one membership rule
// (store/workProjects, session-projects.md SP1): put in the project, bound to
// its task or plan, or started by a session in it. The subscription is a short
// digest of the counts, so a heartbeat that changes no state wakes nothing,
// and the digest is computed only for the projects asked about, once per
// change of the sessions, the membership or the clock.
import { useMemo, useRef } from "react";
import { personSessionWorkState, useInboxStore } from "../store/inboxStore";
import { workProjectsBySession } from "../store/workProjects";
import { useCoarseNow } from "./useCoarseNow";
import { EMPTY_COUNTS, type StateCounts } from "../components/org/orgTypes";

const NO_COUNTS: ReadonlyMap<string, StateCounts> = new Map();

// Each project's sessions, inverted once per membership map (the map keeps its
// ref until a session's project changes), so a count reads only the sessions
// of the projects it asks about.
const byProjectOf = new WeakMap<ReadonlyMap<string, string | null>, Map<string, string[]>>();
function sessionsByProject(by: ReadonlyMap<string, string | null>): Map<string, string[]> {
  let out = byProjectOf.get(by);
  if (!out) {
    out = new Map();
    for (const [sessionId, projectId] of by) if (projectId) (out.get(projectId) ?? out.set(projectId, []).get(projectId)!).push(sessionId);
    byProjectOf.set(by, out);
  }
  return out;
}

/** The counts digest for one store state: recomputed only when the sessions,
 *  the membership map, the clock or the asked projects change. */
export function countsDigest(s: any, wantedKey: string, wanted: ReadonlySet<string> | null, now: number, memo: { current: { sessions: unknown; by: unknown; now: number; wantedKey: string; digest: string } | null }): string {
  const by = workProjectsBySession(s);
  const m = memo.current;
  if (m && m.sessions === s.sessions && m.by === by && m.now === now && m.wantedKey === wantedKey) return m.digest;
  const index = sessionsByProject(by);
  const parts: string[] = [];
  for (const projectId of wanted ?? index.keys()) {
    const c: Record<string, number> = {};
    for (const sessionId of index.get(projectId) ?? []) {
      const row = s.sessions[sessionId];
      if (!row) continue;
      const state = personSessionWorkState(row, now);
      c[state] = (c[state] ?? 0) + 1;
    }
    const body = Object.entries(c).map(([k, v]) => `${k}:${v}`).join(",");
    if (body) parts.push(`${projectId}=${body}`);
  }
  const digest = parts.sort().join(";");
  memo.current = { sessions: s.sessions, by, now, wantedKey, digest };
  return digest;
}

/** `only` limits the count to those projects; an empty list reads nothing. */
export function useProjectSessionCounts(only?: readonly string[]): ReadonlyMap<string, StateCounts> {
  const now = useCoarseNow(30_000);
  const wantedKey = only ? [...only].sort().join(",") : "*";
  const wanted = useMemo(() => (wantedKey === "*" ? null : new Set(wantedKey ? wantedKey.split(",") : [])), [wantedKey]);
  const memo = useRef<Parameters<typeof countsDigest>[4]["current"]>(null);
  const digest = useInboxStore((s) => (wanted && wanted.size === 0 ? "" : countsDigest(s, wantedKey, wanted, now, memo)));
  return useMemo(() => {
    if (!digest) return NO_COUNTS;
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
