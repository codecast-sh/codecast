import type { ResourceOffloadIntent, ResourceOffloadBatchId } from "@codecast/shared/contracts/resourceOffloadIntent";
import type { MigrationBatch } from "../lib/migrationPlan";

export function resourceOffloadStubs(intent: ResourceOffloadIntent, ids: ResourceOffloadBatchId[], now: number, sessions: Record<string, { title?: string; short_id?: string }>): MigrationBatch[] {
  return ids.map(({ batch_id, destination_id }) => {
    const selections = intent.selections.filter(s => s.destination_id === destination_id);
    return {
      batch_id, resource_offload: intent, to_device_id: destination_id, created_at: now, updated_at: now,
      cancelled_at: null, wait_for_idle_ms: intent.wait_for_idle_ms, concurrency: 0, executor_device_ids: [],
      total: selections.length, queued: selections.length, active: 0, done: 0, failed: 0, cancelled: 0, state: "running",
      rows: selections.map(s => ({ migration_id: `${batch_id}:${s.session_id}`, conversation_id: s.conversation_id,
        title: sessions[s.conversation_id]?.title ?? null, short_id: sessions[s.conversation_id]?.short_id ?? null,
        direction: "to_cloud", from_device_id: intent.source_device_id, to_device_id: destination_id,
        executor_device_id: intent.source_device_id, status: "queued", stage: "checking again before moving", error: null,
        attempt: 0, started_at: null, finished_at: null, updated_at: now, destination_path: null, verification: null })),
    };
  });
}

export function cancelResourceBatch(batch: MigrationBatch, now: number) {
  batch.cancelled_at = now;
  for (const row of batch.rows) {
    if (row.status !== "queued") continue;
    row.status = "cancelled";
    row.stage = null;
    batch.cancelled++;
    batch.queued--;
  }
  if (batch.rows.every(r => r.status === "cancelled")) batch.state = "cancelled";
}
