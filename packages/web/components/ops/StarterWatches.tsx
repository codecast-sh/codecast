// A workspace's first watches, one press from a connected PostHog project:
// active people, rage clicks and exceptions over the last day, each read
// once from the project before it is added so the person sees the number it
// will watch. Every one starts as a plain series polled hourly; its page sets
// a line, with how often that line would have crossed.
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { formatValue } from "./metricModel";
import { ProviderIcon } from "./parts";
import { useQueryRun } from "./watchQuery";
import type { OpsSource } from "./opsTypes";

const HOUR = 3600_000;

/** The starter set: what most PostHog projects can answer, as HogQL. */
const STARTER_WATCHES = [
  { key: "active", name: "Active people, 24h", query: "SELECT count(DISTINCT person_id) FROM events WHERE timestamp > now() - INTERVAL 1 DAY" },
  { key: "rage", name: "Rage clicks, 24h", query: "SELECT count() FROM events WHERE event = '$rageclick' AND timestamp > now() - INTERVAL 1 DAY" },
  { key: "exceptions", name: "Exceptions, 24h", query: "SELECT count() FROM events WHERE event = '$exception' AND timestamp > now() - INTERVAL 1 DAY" },
] as const;

export function StarterWatches({ sources, onCustom }: { sources: OpsSource[]; onCustom: (() => void) | null }) {
  const [sourceId, setSourceId] = useState(sources[0]._id);
  const source = sources.find((s) => s._id === sourceId) ?? sources[0];
  const [picked, setPicked] = useState<Set<string>>(() => new Set(STARTER_WATCHES.map((w) => w.key)));
  const [adding, setAdding] = useState<string | null>(null);
  const add = async () => {
    setAdding("adding");
    try {
      for (const w of STARTER_WATCHES.filter((x) => picked.has(x.key))) {
        await useInboxStore.getState().createOpsWatch({ source: source._id, name: w.name, query_kind: "hogql", query: w.query, interval_ms: HOUR });
      }
      setAdding(null);
    } catch (e) {
      setAdding(e instanceof Error ? e.message.split("\n")[0] : "The server did not add them");
    }
  };
  return (
    <div className="mx-starter" data-metrics-empty="starter">
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
      <ul className="mx-starter-list">
        {STARTER_WATCHES.map((w) => (
          <StarterRow key={`${source._id}:${w.key}`} source={source} watch={w} on={picked.has(w.key)} onToggle={() => setPicked((p) => {
            const next = new Set(p);
            if (next.has(w.key)) next.delete(w.key);
            else next.add(w.key);
            return next;
          })} />
        ))}
      </ul>
      <div className="mx-starter-foot">
        {adding && adding !== "adding" && <span className="mx-problem" style={{ gridColumn: "auto" }}>{adding}</span>}
        <span className="flex-1" />
        {onCustom && <button type="button" className="ops-btn" onClick={onCustom} data-metrics-new>Write your own</button>}
        <button type="button" className="ops-btn" data-tone="primary" disabled={!picked.size || adding === "adding"} onClick={add} data-starter-add>
          {adding === "adding" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Add {picked.size} {picked.size === 1 ? "watch" : "watches"}
        </button>
      </div>
    </div>
  );
}

/** One starter: its name, its query, and its value now, read from the project when it shows. */
function StarterRow({ source, watch, on, onToggle }: { source: OpsSource; watch: (typeof STARTER_WATCHES)[number]; on: boolean; onToggle: () => void }) {
  const { run, read } = useQueryRun(source);
  useWatchEffect(() => { void read("hogql", watch.query); }, [source._id]);
  return (
    <li data-starter={watch.key} data-on={on ? "" : undefined}>
      <label>
        <input type="checkbox" checked={on} onChange={onToggle} />
        <span className="mx-starter-name">{watch.name}</span>
        <code className="mx-starter-q" title={watch.query}>{watch.query}</code>
        <span className="mx-starter-v ops-num" data-state={run.state}>
          {run.state === "reading" || run.state === "idle" ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="Reading" />
            : run.state === "value" ? formatValue(run.value)
            : <span title={run.error}>no answer</span>}
        </span>
      </label>
    </li>
  );
}
