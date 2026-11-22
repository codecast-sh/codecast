// Every device's checkouts of a team's repositories into the store
// (contracts/checkouts.ts, ct-98780): one feed, convex checkouts.forTeam, one
// row per device and path under its Convex id. The surface mounts the feeder
// once; the readers only read the store. Session titles are not on the row
// (a private session's title must not ride a team row): read them from the
// sessions the viewer holds, by conversation_id.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;

/** Feeder: a team's checkouts. `ready` once the server answered, failed or refused; `error` says why it failed. */
export function useSyncCheckouts(teamId: string | null | undefined): { ready: boolean; error: Error | null; refused: boolean } {
  const workspace = teamId ? `team:${teamId}` : null;
  const r = useSyncCollection("checkouts", api.checkouts.forTeam, teamId ? { team_id: teamId } : "skip", {
    // Each answer is the team's whole set: a checkout its device stopped reporting leaves this window's store.
    dropAbsent: useCallback((row: CheckoutRow) => row?.workspace === workspace, [workspace]),
  });
  return useMemo(() => ({ ready: r.ready || !!r.error || r.refused, error: r.error ?? null, refused: r.refused }), [r.ready, r.error, r.refused]);
}

const checkoutSig = (c: CheckoutRow) => `${c._id}|${c.reported_at}`;

/** Reader: a team's checkouts from the store, one repository's (`owner/name`, any case) or all, by device then path. */
export function useCheckouts(teamId: string | null | undefined, repository?: string | null): CheckoutRow[] {
  const rows = useWorkspaceCollection<CheckoutRow>("checkouts", checkoutSig, teamId ? `team:${teamId}` : null);
  const key = repository?.toLowerCase() ?? null;
  return useMemo(() => rows.filter((c) => !key || c.repository === key).sort((a, b) => a.device_id.localeCompare(b.device_id) || a.path.localeCompare(b.path)), [rows, key]);
}
