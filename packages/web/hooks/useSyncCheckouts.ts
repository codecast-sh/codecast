// Every device's checkouts of a workspace's repositories into the store
// (contracts/checkouts.ts, ct-98780): one feed, convex checkouts.forTeam, one
// row per device and path under its Convex id. The surface mounts the feeder
// once; the readers only read the store. Session titles are not on the row
// (a private session's title must not ride a team row): read them from the
// sessions the viewer holds, by conversation_id.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toldOf, type CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { deployScopeArgs, type StrictWorkspaceKey } from "../lib/workspaceScope";

const api = _api as any;

/** Feeder: a workspace's checkouts. `ready` once the server answered, failed or refused; `error` says why it failed. */
export function useSyncCheckouts(workspace: StrictWorkspaceKey | null | undefined): { ready: boolean; error: Error | null; refused: boolean } {
  const r = useSyncCollection("checkouts", api.checkouts.forTeam, workspace ? deployScopeArgs(workspace) : "skip", {
    // Each answer is the workspace's whole set: a checkout its device stopped reporting leaves this window's store.
    dropAbsent: useCallback((row: CheckoutRow) => row?.workspace === workspace, [workspace]),
  });
  return useMemo(() => ({ ready: r.ready || !!r.error || r.refused, error: r.error ?? null, refused: r.refused }), [r.ready, r.error, r.refused]);
}

// Who a stuck level has told changes without a new report (a person's ask from the page), so it is in the signature.
const checkoutSig = (c: CheckoutRow) => `${c._id}|${c.reported_at}|${c.level.state === "stuck" ? toldOf(c.level).length : ""}`;

/** Reader: a workspace's checkouts from the store, one repository's (`owner/name`, any case) or all, by device then path. */
export function useCheckouts(workspace: StrictWorkspaceKey | null | undefined, repository?: string | null): CheckoutRow[] {
  const rows = useWorkspaceCollection<CheckoutRow>("checkouts", checkoutSig, workspace ?? null);
  const key = repository?.toLowerCase() ?? null;
  return useMemo(() => rows.filter((c) => !key || c.repository === key).sort((a, b) => a.device_id.localeCompare(b.device_id) || a.path.localeCompare(b.path)), [rows, key]);
}
