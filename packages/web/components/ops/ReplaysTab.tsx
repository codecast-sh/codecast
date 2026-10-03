// The Replays tab: the workspace's recordings, newest first, with what each
// one holds (clicks, errors, failed requests) and the issues it is linked to.
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsGroups, useOpsReplays } from "../../hooks/useSyncOps";
import { relTimeShort } from "../../lib/utils";
import { formatReplayTime, urlPath } from "@codecast/shared/replay";
import { opsHref } from "./opsPaths";
import { OpsEmpty, ProviderIcon } from "./parts";

export function ReplaysTab({ source }: { source: string | null }) {
  const all = useOpsReplays();
  const groups = useOpsGroups();
  const now = useCoarseNow(60_000);
  const router = useRouter();
  const replays = useMemo(() => (source ? all.filter((r) => r.source_name === source) : all), [all, source]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g._id, g])), [groups]);

  if (replays.length === 0) {
    return (
      <OpsEmpty title="No replays">
        The SDK recorder uploads the last minute before an error, and a sampled share of sessions when its
        replay rate is above zero. PostHog and Sentry recordings appear once read with <span className="ops-mono">cast replay show</span>.
      </OpsEmpty>
    );
  }

  return (
    <div className="ops-pad">
      <table className="ops-table">
        <thead>
          <tr>
            <th>Recording</th>
            <th style={{ width: 80 }}>Length</th>
            <th style={{ width: 170 }}>Activity</th>
            <th style={{ width: 200 }}>Issues</th>
            <th style={{ width: 120 }}>Source</th>
            <th style={{ width: 70 }}>Started</th>
          </tr>
        </thead>
        <tbody>
          {replays.map((r) => (
            <tr key={r._id} data-row onClick={() => router.push(opsHref.replay(r.short_id || r._id))}>
              <td className="min-w-0">
                <div className="text-sol-text truncate max-w-[460px]" title={r.url ?? undefined}>{r.url ? urlPath(r.url) : r.external_id}</div>
                <div className="ops-dim text-[11px] truncate max-w-[460px]">
                  <span className="ops-mono">{r.short_id}</span>
                  {r.user?.email || r.user?.name || r.user?.id ? <span> · {r.user.email ?? r.user.name ?? r.user.id}</span> : null}
                  {!r.has_timeline && r.chunks > 0 ? <span> · assembling</span> : null}
                </div>
              </td>
              <td className="ops-num ops-quiet">{r.duration_ms ? formatReplayTime(r.duration_ms) : "?"}</td>
              <td className="ops-num text-[11.5px]">
                <span className="ops-quiet">{r.counts.clicks} clicks</span>
                {r.counts.errors > 0 && <span style={{ color: "var(--sol-red)" }}> · {r.counts.errors} err</span>}
                {r.counts.failed_requests > 0 && <span style={{ color: "var(--sol-orange)" }}> · {r.counts.failed_requests} failed</span>}
              </td>
              <td className="text-[11.5px] truncate max-w-[200px]">
                {r.group_ids.length === 0 ? (
                  <span className="ops-dim">none</span>
                ) : (
                  r.group_ids.map((id) => groupById.get(id)?.short_id ?? "").filter(Boolean).join(", ") || `${r.group_ids.length} linked`
                )}
              </td>
              <td className="text-[11.5px]">
                <span className="inline-flex items-center gap-1.5 ops-quiet"><ProviderIcon provider={r.provider} />{r.source_name ?? r.provider}</span>
              </td>
              <td className="ops-num ops-quiet" title={new Date(r.started_at).toLocaleString()}>{relTimeShort(r.started_at, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
