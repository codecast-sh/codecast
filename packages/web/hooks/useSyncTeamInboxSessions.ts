import { useCallback, useEffect, useRef } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, InboxSession } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useRecoveryPoll } from "./useRecoveryPoll";

// Record the team-mode active id set, change-guarded so an identical payload
// doesn't allocate a new Set and re-render every subscriber. The panel gates the
// visible list on this while inbox_scope is "team" (see filterInboxScope). Mirror
// of applyLiveInboxIds for the team board.
export function applyTeamInboxIds(sessions: any[]) {
  const next = new Set<string>(sessions.map((x: any) => x._id.toString()));
  const prev = useInboxStore.getState().teamInboxIds;
  if (prev.size === next.size && [...next].every((id) => prev.has(id))) return;
  useInboxStore.setState({ teamInboxIds: next });
}

/**
 * Inbox "team mode" sync. When the user's scope is "team", subscribe to the
 * team-scoped inbox (every team-visible session across the active team) and
 * merge those rows into the SAME never-prune `sessions` cache the personal inbox
 * uses — they're schema-identical (both come from enrichInboxSessionRow), so the
 * card, bucketing, and sort all just work. The reported id set becomes
 * `teamInboxIds`, the active set the panel gates on in team scope.
 *
 * Mirrors the personal inbox's liveness split: the list subscription opts out of
 * heartbeat-derived liveness (include_liveness:false) and a tiny
 * teamSessionsLiveness overlay carries the per-second live status, so team mode
 * is as heartbeat-cheap as the personal inbox.
 *
 * All subscriptions pass "skip" when scope isn't "team", so nothing runs (and no
 * team rows are fetched) until the user actually opens the team board.
 */
export function useSyncTeamInboxSessions() {
  const convex = useConvex();
  const scope = useInboxStore((s) => s.clientState.ui?.inbox_scope ?? "mine");
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const active = scope === "team";
  const teamArgs = active
    ? { activeTeamId: activeTeamId as Id<"teams"> | undefined, include_liveness: false }
    : "skip";

  const teamSessions = useQuery(api.conversations.listTeamInboxSessions, teamArgs as any);
  const teamLiveness = useQuery(
    api.conversations.teamSessionsLiveness,
    active ? { activeTeamId: activeTeamId as Id<"teams"> | undefined } : "skip",
  );

  const syncTable = useInboxStore((s) => s.syncTable);
  const lastSyncRef = useRef(Date.now());
  const lastLivenessRef = useRef(Date.now());

  useConvexSync(teamSessions, useCallback((data: any) => {
    const sessions = data?.sessions ?? [];
    if (!Array.isArray(sessions)) return;
    syncTable("sessions", sessions as unknown as InboxSession[]);
    applyTeamInboxIds(sessions);
    lastSyncRef.current = Date.now();
  }, [syncTable]), { coalesceMs: 300 });

  useConvexSync(teamLiveness, useCallback((data: any) => {
    const liveness = data?.liveness ?? data;
    if (!liveness || typeof liveness !== "object") return;
    useInboxStore.getState().syncOverlay("sessions", liveness as Record<string, Record<string, any>>);
    lastLivenessRef.current = Date.now();
  }, []), { coalesceMs: 300 });

  // Leaving team mode clears the active set (the teammate rows stay in the
  // never-prune cache; the "mine" scope filter is what hides them). This is
  // hygiene, not correctness — filterInboxScope only reads teamInboxIds in team
  // scope — but it keeps the set honest so a later switch back to team can't
  // briefly render another team's stale membership after an active-team change.
  useEffect(() => {
    if (active) return;
    if (useInboxStore.getState().teamInboxIds.size === 0) return;
    useInboxStore.setState({ teamInboxIds: new Set<string>() });
  }, [active]);

  // Recovery: a Convex subscription can silently stall after sleep/reconnect. When
  // team mode is active, probe a novel-token round-trip to re-sync the list and
  // active set (same pattern as the personal inbox recovery poll). The `_probe`
  // arg dodges the stalled live cache. No-op when not in team mode.
  useRecoveryPoll(lastSyncRef, useCallback(async () => {
    if (!active) return;
    const fresh: any = await convex.query(api.conversations.listTeamInboxSessions, {
      activeTeamId: activeTeamId as Id<"teams"> | undefined,
      include_liveness: false,
      _probe: Date.now(),
    });
    const sessions = fresh?.sessions ?? [];
    if (!Array.isArray(sessions)) return;
    syncTable("sessions", sessions as unknown as InboxSession[]);
    applyTeamInboxIds(sessions);
    lastSyncRef.current = Date.now();
  }, [convex, active, activeTeamId, syncTable]), 15_000);

  useRecoveryPoll(lastLivenessRef, useCallback(async () => {
    if (!active) return;
    const fresh: any = await convex.query(api.conversations.teamSessionsLiveness, {
      activeTeamId: activeTeamId as Id<"teams"> | undefined,
      _probe: Date.now(),
    });
    const liveness = fresh?.liveness;
    if (!liveness) return;
    useInboxStore.getState().syncOverlay("sessions", liveness as Record<string, Record<string, any>>);
    lastLivenessRef.current = Date.now();
  }, [convex, active, activeTeamId]), 15_000);

  return teamSessions;
}
