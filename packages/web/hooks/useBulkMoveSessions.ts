/**
 * Move sessions to a device from a menu: batch what the migration rail takes,
 * re-home the rest, and say what happened. One toast, however many sessions.
 */
import { useCallback } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { deviceDisplayName, useDevices, useMoveSessionToDevice, type Device } from "../components/DeviceBadge";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { planBulkMove } from "../lib/bulkMovePlan";

const api = _api as any;

export function useBulkMoveSessions() {
  const { devices } = useDevices();
  const createBatch = useMutation(api.sessionMigrations.createBatch);
  const moveOne = useMoveSessionToDevice();
  return useCallback(async (sessions: any[], device: Device) => {
    const store = useInboxStore.getState();
    const plan = planBulkMove(sessions, device, devices);
    const name = deviceDisplayName(device);
    const ids = plan.batch.map((s) => store.getConvexId(s._id) ?? s._id).filter((id) => isConvexId(id));
    let batched = 0;
    let batchId: string | null = null;
    let batchSkipped: string[] = [];
    if (ids.length) {
      try {
        const res = await createBatch({ conversation_ids: ids, to_device_id: device.device_id });
        batched = res.rows.length;
        batchId = res.batch_id;
        batchSkipped = res.skipped.map((s: any) => `${s.short_id ?? s.conversation_id.slice(0, 8)}: ${s.reason}`);
      } catch (e: any) {
        toast.error(e?.message ?? `Could not start the move to ${name}`);
        return;
      }
    }
    for (const s of plan.reassign) moveOne(s._id, { device_id: device.device_id, is_remote: device.is_remote, label: name });
    const moved = batched + plan.reassign.length;
    const skipped = [...plan.skipped.map((x) => `${x.session.short_id ?? String(x.session._id).slice(0, 8)}: ${x.reason}`), ...batchSkipped];
    if (moved === 0) {
      toast.error(skipped.length ? `Nothing moved — ${skipped[0]}${skipped.length > 1 ? ` (+${skipped.length - 1} more)` : ""}` : `Nothing to move to ${name}`);
      return;
    }
    toast.success(`Moving ${moved} session${moved === 1 ? "" : "s"} to ${name}${skipped.length ? ` · ${skipped.length} skipped` : ""}`, {
      description: skipped.slice(0, 3).join("\n") || undefined,
      ...(batchId ? { action: { label: "Progress", onClick: () => useInboxStore.getState().openSettingsModal("migrate") } } : {}),
    });
  }, [devices, createBatch, moveOne]);
}

