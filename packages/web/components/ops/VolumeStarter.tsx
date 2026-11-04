// A source with no watches that sends errors, logs or CI runs: the series
// codecast already counts for it (contracts/volumeWatch), each with its value
// now and a spark of the past its counters hold, one press from being
// watched. A new one starts as a plain series polled hourly and opens on its
// page, where a line can be set.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { useOpsGroups } from "../../hooks/useSyncOps";
import { useInboxStore } from "../../store/inboxStore";
import { MetricChart } from "./MetricChart";
import { formatValue, volumeOptions } from "./metricModel";
import { opsHref } from "./opsPaths";
import { ProviderIcon } from "./parts";
import type { OpsSource } from "./opsTypes";

const HOUR = 3600_000;

export function VolumeStarter({ sources, onCustom }: { sources: OpsSource[]; onCustom: (() => void) | null }) {
  const router = useRouter();
  const [sourceId, setSourceId] = useState(sources[0]._id);
  const source = sources.find((s) => s._id === sourceId) ?? sources[0];
  const groups = useOpsGroups();
  const now = useMemo(() => Date.now(), [source._id]); // eslint-disable-line react-hooks/exhaustive-deps -- read once per source
  const options = useMemo(() => volumeOptions(source, groups.filter((g) => g.source_id === source._id), now), [source, groups, now]);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watch = async (query: string, label: string, unit: string | null) => {
    setAdding(query);
    setError(null);
    try {
      const res = await useInboxStore.getState().createOpsWatch({ source: source._id, name: `${label}, ${source.name}`, query_kind: "volume", query, interval_ms: HOUR, ...(unit ? { unit } : {}) });
      if (res?.short_id) router.push(opsHref.metric(res.short_id));
      else setError("The server did not add it");
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "The server did not add it");
    }
    setAdding(null);
  };
  return (
    <div className="mx-starter" data-metrics-empty="volume">
      <div className="mx-starter-head">
        <h2>Start watching</h2>
        {sources.length > 1 ? (
          <span className="mx-seg" role="group" aria-label="Source">
            {sources.map((s) => <button key={s._id} type="button" aria-pressed={s._id === source._id} onClick={() => setSourceId(s._id)}><ProviderIcon provider={s.provider} /> {s.name}</button>)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 ops-dim"><ProviderIcon provider={source.provider} />{source.name}</span>
        )}
      </div>
      <ul className="mx-volume-list">
        {options.map((o) => (
          <li key={o.query} data-volume-starter={o.query}>
            <span className="mx-starter-name">{o.label}</span>
            <span className="mx-volume-spark">
              {o.points.length > 1 && <MetricChart points={o.points} win={{ from: o.points[0].at, to: o.points[o.points.length - 1].at }} interval_ms={o.points[1].at - o.points[0].at} direction="above" height={24} />}
            </span>
            {o.open?.length ? (
              <Link href={o.open.length === 1 ? opsHref.issue(o.open[0]) : opsHref.issues({ source: source.name })} className="ops-num mx-starter-v hover:underline" title={o.open.length === 1 ? o.open[0] : `${o.open.length} open`} data-volume-open={o.open.length}>
                {formatValue(o.value, o.unit ?? undefined)}
              </Link>
            ) : <b className="ops-num mx-starter-v">{formatValue(o.value, o.unit ?? undefined)}</b>}
            <button type="button" className="ops-btn" disabled={!!adding} onClick={() => watch(o.query, o.label, o.unit)} data-volume-watch={o.query}>
              {adding === o.query ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Watch
            </button>
          </li>
        ))}
      </ul>
      <div className="mx-starter-foot">
        {error && <span className="mx-problem" style={{ gridColumn: "auto" }}>{error}</span>}
        <span className="flex-1" />
        {onCustom && <button type="button" className="ops-btn" onClick={onCustom} data-metrics-new>New watch</button>}
      </div>
    </div>
  );
}
