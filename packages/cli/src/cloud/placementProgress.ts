/**
 * The `cast cloud start` child's live report of where its placement stands
 * (contracts/cloudPlacementProgress), written onto the conversation so the
 * session's placement strip shows the host, the step and the log as they
 * happen. A step change is sent at once; log lines ride along, at most one
 * write per LINE_FLUSH_MS. A failed write is dropped: the report is for a
 * person watching, and must never slow or fail the placement itself.
 */

import {
  CLOUD_PLACEMENT_LINE_CHARS,
  CLOUD_PLACEMENT_LINES_MAX,
  type CloudPlacementProgress,
  type CloudPlacementStep,
} from "@codecast/shared/contracts";

const LINE_FLUSH_MS = 5_000;

export interface PlacementReporter {
  host(hostId: string, hostDeviceId?: string, movedFrom?: CloudPlacementProgress["moved_from"]): void;
  step(step: CloudPlacementStep): void;
  line(text: string): void;
  /** Send whatever is unsent and stop the timer. */
  flush(): Promise<void>;
}

export function placementReporter(
  token: string | undefined,
  send: (progress: CloudPlacementProgress) => Promise<unknown>,
  now = Date.now,
): PlacementReporter {
  const started = now();
  let record: CloudPlacementProgress | null = null;
  const pendingLines: string[] = [];
  const pendingSteps: CloudPlacementProgress["steps"] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const push = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!token || !record) return;
    record = {
      ...record,
      steps: [...record.steps, ...pendingSteps.splice(0)],
      lines: [...record.lines, ...pendingLines.splice(0)].slice(-CLOUD_PLACEMENT_LINES_MAX),
      at: now(),
    };
    const snapshot = record;
    inflight = inflight.then(() => send(snapshot).then(() => {}, () => {}));
  };

  return {
    host(hostId, hostDeviceId, movedFrom) {
      // A new host replaces the old one whole: its device and why it was chosen go with it.
      const { host_device_id: _device, moved_from: _moved, ...kept } = record ?? { steps: [], lines: [], started_at: started, at: started };
      record = {
        ...kept,
        token: token ?? "",
        host_id: hostId,
        ...(hostDeviceId ? { host_device_id: hostDeviceId } : {}),
        ...(movedFrom ? { moved_from: movedFrom } : {}),
      };
      push();
    },
    step(step) {
      const last = pendingSteps.at(-1)?.step ?? record?.steps.at(-1)?.step;
      if (last === step) return;
      pendingSteps.push({ step, at: now() });
      push();
    },
    line(text) {
      const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!clean) return;
      pendingLines.push(clean.slice(0, CLOUD_PLACEMENT_LINE_CHARS));
      if (pendingLines.length > CLOUD_PLACEMENT_LINES_MAX) pendingLines.splice(0, pendingLines.length - CLOUD_PLACEMENT_LINES_MAX);
      if (!timer && record) timer = setTimeout(push, LINE_FLUSH_MS);
    },
    async flush() {
      if (pendingLines.length || pendingSteps.length) push();
      if (timer) { clearTimeout(timer); timer = null; }
      await inflight;
    },
  };
}
