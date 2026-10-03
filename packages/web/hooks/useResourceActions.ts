// What the resource monitor can do on live data. Park and resume ride the
// existing session command paths; preflight is a read-only dry run of
// resourceOffload.start whose checks tighten the planner's readiness for this
// view; start, retry and cancel are the store's local-first actions.
import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { ResourceOffloadIntent } from "@codecast/shared/contracts/resourceOffloadIntent";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { captureError } from "../lib/analytics";
import type { MigrationBatch } from "../lib/migrationPlan";
import { useHibernationCommands } from "./useHibernationCommands";
import type { OffloadPlan, OffloadSelection, ResourceActions, ResourceSession } from "../components/resources/types";

const api = _api as any;

type Check = { session_id: string; destination_id: string; blockers: string[]; pending: string[]; passed: string[]; unconfirmed: string[] };
type Preflight = { at: number; checks: Check[] };

/** A dry run is evidence for a few minutes; after that the planner's view stands alone. */
const PREFLIGHT_TTL_MS = 5 * 60_000;
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

/**
 * Overlay a server dry run on the latest plan. Conservative both ways: a
 * blocker or pending item from either side stays, so a newer planner blocker
 * is never hidden by an older preflight.
 */
export function applyPreflight(plan: OffloadPlan, pre: Preflight | undefined, now: number): OffloadPlan {
  if (!pre || now - pre.at > PREFLIGHT_TTL_MS || !pre.checks.length) return plan;
  return {
    ...plan,
    candidates: plan.candidates.map((c) => {
      const mine = pre.checks.filter((k) => k.session_id === c.sessionId && c.perDestination[k.destination_id]);
      if (!mine.length) return c;
      const perDestination = { ...c.perDestination };
      for (const k of mine) {
        const was = perDestination[k.destination_id];
        const blockers = union(was.blockers, k.blockers);
        const pending = union(was.pending, k.pending);
        perDestination[k.destination_id] = {
          ...was,
          readiness: blockers.length ? "blocked" : pending.length ? "preflight_required" : "ready",
          blockers, pending,
          passed: union(was.passed ?? [], k.passed).filter((p) => !pending.includes(p)),
        };
      }
      return { ...c, perDestination };
    }),
  };
}

function report(surface: string) {
  return (e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    captureError(err, { surface });
    toast.error(err.message);
  };
}

const clientBatchId = () => `rb_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

export function useResourceActions(sessions: ResourceSession[], plans: OffloadPlan[], batches: MigrationBatch[], now: number) {
  const router = useRouter();
  const { request: requestPark } = useHibernationCommands();
  const dryRun = useMutation(api.resourceOffload.start);
  const [preflight, setPreflight] = useState<Record<string, Preflight>>({});
  const byId = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);

  const toServer = (sel: OffloadSelection[]) => sel.flatMap((s) => {
    const conv = byId.get(s.sessionId)?.conversationId;
    return conv ? [{ conversation_id: conv, session_id: s.sessionId, destination_id: s.destinationId, attested: s.attested }] : [];
  });
  const sourceOf = (sel: OffloadSelection[]) => byId.get(sel[0]?.sessionId)?.deviceId;
  const start = (intent: ResourceOffloadIntent) => {
    useInboxStore.getState().startResourceOffload(intent)
      .then((res: { error?: string } | undefined) => { if (res?.error) toast.error(res.error); })
      .catch(report("resources.start"));
  };

  const actions: ResourceActions = {
    onOpenSession: (id) => { const c = byId.get(id)?.conversationId; if (c) router.push(`/conversation/${c}`); },
    onPark: (ids) => {
      for (const id of ids) {
        const s = byId.get(id);
        if (s?.conversationId && s.deviceId) requestPark(s.conversationId, s.sessionId, s.deviceId);
      }
      toast(`Asked to park ${ids.length} session${ids.length === 1 ? "" : "s"}; each machine checks it is safe first`);
    },
    onResume: (ids) => {
      for (const id of ids) {
        const c = byId.get(id)?.conversationId;
        if (c) useInboxStore.getState().resumeSession(c).catch(report("resources.resume"));
      }
    },
    onDismissPlan: (deviceId, until) => {
      const st = useInboxStore.getState();
      st.updateClientUI({ resource_plan_dismissed: { ...(st.clientState.ui?.resource_plan_dismissed ?? {}), [deviceId]: until } });
    },
    onPreflight: (sel) => {
      const source = sourceOf(sel);
      if (!source) return;
      dryRun({ source_device_id: source, selections: toServer(sel), wait_for_idle_ms: 10 * 60_000, dry_run: true })
        .then((res: { checks: Check[] }) => setPreflight((m) => ({ ...m, [source]: { at: Date.now(), checks: res.checks } })))
        .catch(report("resources.preflight"));
    },
    onStartOffload: (sel, { waitForTurnMs }) => {
      const source = sourceOf(sel);
      if (source) start({ client_batch_id: clientBatchId(), source_device_id: source, selections: toServer(sel), wait_for_idle_ms: waitForTurnMs });
    },
    onRetry: (batchId, sessionId) => {
      const intent = batches.find((b) => b.batch_id === batchId)?.resource_offload;
      const selections = intent?.selections.filter((s) => s.session_id === sessionId || s.conversation_id === sessionId) ?? [];
      if (!intent || !selections.length) { toast.error("This move was not started from Resources; retry it from Settings → Migration"); return; }
      start({ ...intent, client_batch_id: clientBatchId(), selections });
    },
    onCancel: (batchId) => { useInboxStore.getState().cancelResourceOffload(batchId).catch(report("resources.cancel")); },
  };

  const checkedPlans = useMemo(() => plans.map((p) => applyPreflight(p, preflight[p.deviceId], now)), [plans, preflight, now]);
  return { actions, plans: checkedPlans };
}
