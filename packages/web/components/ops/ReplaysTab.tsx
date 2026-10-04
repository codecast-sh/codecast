// The Replays tab: the workspace's recordings, newest first, with what each
// one holds (clicks, errors, failed requests) and the issues it is linked to.
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsGroups, useOpsReplays } from "../../hooks/useSyncOps";
import { relTimeShort } from "../../lib/utils";
import { formatReplayTime } from "@codecast/shared/replay";
import { replayPlace } from "./opsModel";
import { opsHref } from "./opsPaths";
import { OpsFeedEmpty, ProviderIcon, pressable, useOpsFeed } from "./parts";
import type { OpsGroup } from "./opsTypes";

export function ReplaysTab({ source }: { source: string | null }) {
  const all = useOpsReplays();
  const feed = useOpsFeed("replays");
  const groups = useOpsGroups();
  const now = useCoarseNow(60_000);
  const router = useRouter();
  const replays = useMemo(() => (source ? all.filter((r) => r.source_name === source) : all), [all, source]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g._id, g])), [groups]);

  if (replays.length === 0) {
    return (
      <OpsFeedEmpty feeds={[feed]} what="replays" title="No replays">
        The SDK recorder uploads the last minute before an error, and a sampled share of sessions when its
        replay rate is above zero. PostHog and Sentry recordings appear once read with <span className="ops-mono">cast replay show</span>.
      </OpsFeedEmpty>
    );
  }

  return (
    <div className="ops-pad">
      <table className="ops-table ops-table-fixed">
        <thead>
          <tr>
            <th>Recording</th>
            <th style={{ width: 80 }}>Length</th>
            <th style={{ width: 220 }}>Activity</th>
            <th style={{ width: "30%" }}>Issues</th>
            <th style={{ width: 140 }}>Source</th>
            <th style={{ width: 70 }}>Started</th>
          </tr>
        </thead>
        <tbody>
          {replays.map((r) => (
            <tr key={r._id} data-row aria-label={`${r.short_id} ${replayPlace(r.url) ?? r.external_id}`} {...pressable(() => router.push(opsHref.replay(r.short_id || r._id)), "link")}>
              <td className="min-w-0">
                <div className="text-sol-text truncate" title={r.url ?? undefined}>{replayPlace(r.url) ?? r.external_id}</div>
                <div className="ops-dim text-[11px] truncate">
                  <span className="ops-mono">{r.short_id}</span>
                  {r.user?.email || r.user?.name || r.user?.id ? <span> · {r.user.email ?? r.user.name ?? r.user.id}</span> : null}
                  {!r.has_timeline && r.chunks > 0 ? <span> · assembling</span> : null}
                </div>
              </td>
              <td className="ops-num ops-quiet">{r.duration_ms ? formatReplayTime(r.duration_ms) : "?"}</td>
              <td className="ops-num text-[11.5px] whitespace-nowrap">
                <span className="ops-quiet">{r.counts.clicks} clicks</span>
                {r.counts.errors > 0 && <span style={{ color: "var(--sol-red)" }}> · {r.counts.errors} err</span>}
                {r.counts.failed_requests > 0 && <span style={{ color: "var(--sol-orange)" }}> · {r.counts.failed_requests} failed</span>}
              </td>
              <td className="text-[11.5px]">
                <ReplayIssues ids={r.group_ids} groupById={groupById} />
              </td>
              <td className="text-[11.5px]">
                <span className="inline-flex items-center gap-1.5 ops-quiet max-w-full truncate"><ProviderIcon provider={r.provider} />{r.source_name ?? r.provider}</span>
              </td>
              <td className="ops-num ops-quiet" title={new Date(r.started_at).toLocaleString()}>{relTimeShort(r.started_at, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The issues a recording caught: the first by its title, the rest counted. */
function ReplayIssues({ ids, groupById }: { ids: string[]; groupById: Map<string, OpsGroup> }) {
  const known = ids.map((id) => groupById.get(id)).filter((g): g is OpsGroup => !!g);
  if (ids.length === 0) return <span className="ops-dim">none</span>;
  if (known.length === 0) return <span className="ops-quiet">{ids.length} linked</span>;
  const first = known[0];
  return (
    <div className="truncate" title={known.map((g) => `${g.short_id} ${g.title}`).join("\n")}>
      <span className="ops-mono" style={{ color: first.status === "open" ? "var(--sol-red)" : "var(--sol-text-muted)" }}>{first.short_id}</span>{" "}
      <span className="text-sol-text">{first.title}</span>
      {ids.length > 1 && <span className="ops-dim">, +{ids.length - 1}</span>}
    </div>
  );
}
