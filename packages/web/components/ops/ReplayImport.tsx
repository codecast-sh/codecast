// The bulk import of a PostHog or Sentry source's recordings (external-data.md
// X5, convex sources/replayBackfill.ts), as one line: where it stands and the
// control that moves it. The source card on Settings, Integrations and the
// Ops Replays tab both render it; the progress is the source row's
// `replay_backfill`, which every page of the import writes.
import { useState } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  DEFAULT_REPLAY_BACKFILL_WINDOW,
  REPLAY_BACKFILL_WINDOWS,
  replayBackfillLine,
  replayBackfillState,
  type ReplayBackfillWindow,
} from "@codecast/shared/contracts/replay";
import { ProviderIcon } from "./parts";
import type { OpsSource } from "./opsTypes";

const WINDOW_LABEL: Record<ReplayBackfillWindow, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All" };
const STATE_COLOR = { running: "var(--sol-blue)", done: "var(--sol-green)", paused: "var(--sol-yellow)", error: "var(--sol-red)", stalled: "var(--sol-orange)" } as const;

/** Sources whose recordings can be imported in bulk. */
export const hasVendorRecordings = (s: Pick<OpsSource, "provider" | "short_id">) => (s.provider === "posthog" || s.provider === "sentry") && !!s.short_id;

export function ReplayImportLine({ source, showName = false }: { source: OpsSource; showName?: boolean }) {
  const now = useCoarseNow(15_000);
  const b = source.replay_backfill;
  const [window, setWindow] = useState<ReplayBackfillWindow>(b?.window ?? DEFAULT_REPLAY_BACKFILL_WINDOW);
  const store = () => useInboxStore.getState();
  const state = b ? replayBackfillState(b, now) : null;
  const inactive = source.status !== "active";

  return (
    <div className="flex items-center gap-2.5 text-[11.5px] min-w-0" data-ops-replay-import={source.name}>
      {showName && (
        <span className="inline-flex items-center gap-1.5 text-sol-text shrink-0">
          <ProviderIcon provider={source.provider} className="w-3.5 h-3.5" />
          {source.name}
        </span>
      )}
      <span className="flex-1 min-w-0 truncate" title={b ? replayBackfillLine(b, now) : undefined}>
        {b && state ? (
          <>
            <span style={{ color: STATE_COLOR[state] }}>{replayBackfillLine(b, now)}</span>
          </>
        ) : (
          <span className="text-sol-text-muted">Recordings come over when opened. Import them all now to read and search them here.</span>
        )}
      </span>
      {state === "running" ? (
        <button type="button" className="ops-btn shrink-0" onClick={() => store().stopOpsReplayImport(source._id)}>
          Stop
        </button>
      ) : state === "paused" || state === "error" || state === "stalled" ? (
        <button type="button" className="ops-btn shrink-0" disabled={inactive} title={inactive ? "Resume the source first" : undefined} onClick={() => store().startOpsReplayImport(source._id)}>
          Resume import
        </button>
      ) : (
        <>
          <div className="ops-seg shrink-0" role="radiogroup" aria-label="How far back">
            {REPLAY_BACKFILL_WINDOWS.map((w) => (
              <button key={w} type="button" role="radio" aria-checked={window === w} data-on={window === w ? "true" : undefined} onClick={() => setWindow(w)}>
                {WINDOW_LABEL[w]}
              </button>
            ))}
          </div>
          <button type="button" className="ops-btn shrink-0" disabled={inactive} title={inactive ? "Resume the source first" : undefined} onClick={() => store().startOpsReplayImport(source._id, window)}>
            {state === "done" ? "Import again" : "Import recordings"}
          </button>
        </>
      )}
    </div>
  );
}
