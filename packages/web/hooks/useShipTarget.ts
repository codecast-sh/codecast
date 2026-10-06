// One Ship control (docs/architecture/ship.md): the shipTargets row for one
// target (the plan a press runs, the latest run), plus the rows its progress
// reads, the ship session and its pull request. Feeders only; the control
// paints from the store.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { ShipPlan, ShipTargetKind } from "@codecast/shared/contracts/shipPlan";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

export type ShipTargetRef = { kind: ShipTargetKind; id: string };

export type ShipRun = {
  id: string;
  client_key: string | null;
  procedure: ShipPlan["procedure"] | null;
  conversation_id: string | null;
  short_id: string | null;
  decision_id: string | null;
  workflow_run_id: string | null;
  created_at: number;
};

export type ShipTargetRow = {
  _id: string;
  target: ShipTargetRef;
  plan: ShipPlan | null;
  pr_id: string | null;
  run: ShipRun | null;
  line: {
    status: string;
    ship: { status: string; outcome: string | null; preview: string | null } | null;
    merge: { branch: string; into: string; pr_url: string | null } | null;
    fail_reason: string | null;
  } | null;
};

export const shipTargetKey = (t: ShipTargetRef) => `${t.kind}:${t.id}`;

const one = (row: unknown) => (row ? [row] : []);
const sessions = (data: any) => data?.sessions ?? [];

export function useShipTarget(target: ShipTargetRef | null): ShipTargetRow | undefined {
  const args = useMemo(() => (target ? { target: { kind: target.kind, id: target.id } } : "skip"), [target?.kind, target?.id]);
  useSyncCollection("shipTargets", api.ship.forTarget, args, { select: one });
  const key = target ? shipTargetKey(target) : null;
  const row = useInboxStore((s) => (key ? ((s as any).shipTargets?.[key] as ShipTargetRow | undefined) : undefined));
  // The ship session's row (its pinned state, its PR) and that PR's checks.
  const convId = row?.run?.conversation_id ?? null;
  useSyncCollection("sessions", api.conversations.getInboxSessionsByIds, convId ? { ids: [convId] } : "skip", { select: sessions });
  // The PR open before the press, else the one the ship session opened.
  const prId = useInboxStore((s) => row?.pr_id ?? (convId ? ((s as any).sessions?.[convId]?.pr_status?.pr_id as string | undefined) : undefined) ?? null);
  useSyncCollection("pullRequests", api.pull_requests.webGet, prId ? { id: prId } : "skip", { select: one });
  return row;
}
