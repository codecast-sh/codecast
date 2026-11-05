// Editing a watch from the app: its settings card on the watch page
// (missing data, unit, interval, name, who hears, pause, delete; the alert
// rule itself is AlertRule, under the chart), the query editor (HogQL or a reader picked
// from the app's manifest, run before it is saved) and the sheet that makes a new one on a source that
// can host watches: a reader picked from the app's manifest with typed
// arguments, an insight picked from the PostHog project, or HogQL, with the
// query's current value (and a reader's own series) read before it is saved.
// Every write goes through the store (opsSlice updateOpsWatch,
// removeOpsWatch, createOpsWatch), so the page moves at once.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Pencil, Play, PlayCircle, Trash2, X } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { watchProblem, type WatchKind } from "@codecast/shared/contracts/ingest";
import { monitorProblem, type AlertNotifyInput, type AlertRoute } from "@codecast/shared/contracts/metricMonitor";
import { useOpsWatches } from "../../hooks/useSyncOps";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { MetricChart } from "./MetricChart";
import { AlertRouting, NotifyRows, OnAlertRow } from "./WatchRouting";
import { lastUsedRoutes } from "./alertRouting";
import { KIND_LABEL, crosses, formatValue, spanLabel, type Pt } from "./metricModel";
import { lineSuggestions, suggestDirection, wouldCross } from "./metricEvents";
import { EVAL_READS, INTERVALS, NO_DATA_AFTER, duplicateWatch, intervalLabel, parseThreshold } from "./metricEditing";
import { opsHref } from "./opsPaths";
import { ProviderIcon } from "./parts";
import { useQueryRun, watchKindsOf } from "./watchQuery";
import type { OpsSource, OpsWatch } from "./opsTypes";
import { HogqlBuilder, InsightPicker, ReaderPicker, VolumePicker } from "./WatchPickers";

const api = _api as any;

// ── The watch's settings ──

/** Everything about a watch but its alert rule, which sits under the chart (AlertRule). */
export function WatchSettings({ watch, source, removeLedger }: { watch: OpsWatch; source?: OpsSource; removeLedger: SwitchLedger }) {
  const router = useRouter();
  const update = useInboxStore((s) => s.updateOpsWatch);
  const [name, setName] = useState<string | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const paused = watch.status === "paused";
  const hasLine = watch.threshold !== undefined;
  const commitName = () => {
    if (name !== null && name.trim() && name.trim() !== watch.name) update(watch._id, { name: name.trim() });
    setName(null);
  };
  const commitUnit = () => {
    if (unit !== null && unit.trim() !== (watch.unit ?? "")) update(watch._id, { unit: unit.trim() || null });
    setUnit(null);
  };
  const enter = (commit: () => void, reset: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLElement).blur(); }
    if (e.key === "Escape") { reset(); (e.target as HTMLElement).blur(); }
  };

  return (
    <div className="ops-card" data-watch-settings>
      <div className="ops-card-head">
        <span>Settings</span>
        <button type="button" className="ops-btn" onClick={() => update(watch._id, { status: paused ? "active" : "paused" })} data-watch-pause aria-pressed={paused}>
          {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
      <div className="ops-card-body">
        <div className="mx-form">
          <label htmlFor="mx-name">Name</label>
          <input id="mx-name" className="mx-input" value={name ?? watch.name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={enter(commitName, () => setName(null))} />

          <label htmlFor="mx-unit">Unit</label>
          <input id="mx-unit" className="mx-input" maxLength={12} placeholder="none" value={unit ?? watch.unit ?? ""} onChange={(e) => setUnit(e.target.value)} onBlur={commitUnit} onKeyDown={enter(commitUnit, () => setUnit(null))} />

          <label htmlFor="mx-every">Every</label>
          <select id="mx-every" className="mx-select" value={INTERVALS.some((i) => i.ms === watch.interval_ms) ? watch.interval_ms : "custom"} onChange={(e) => update(watch._id, { interval_ms: Number(e.target.value) })}>
            {INTERVALS.map((i) => <option key={i.ms} value={i.ms}>{i.label}</option>)}
            {!INTERVALS.some((i) => i.ms === watch.interval_ms) && <option value="custom" disabled>{intervalLabel(watch.interval_ms)}</option>}
          </select>

          {hasLine && (
            <>
              <label htmlFor="mx-nodata">No data</label>
              <NoDataSelect id="mx-nodata" value={watch.no_data_after ?? 0} onChange={(n) => update(watch._id, { no_data_after: n || null })} />
              <div className="mx-form-sub" data-watch-section="notify">Notify</div>
              <OnAlertRow value={watch.on_alert} source={source} onChange={(r) => update(watch._id, { on_alert: r })} />
              <AlertRouting watch={watch} source={source} />
            </>
          )}

        </div>
        <div className="flex mt-3">
          <button type="button" className="ops-btn" style={{ color: "var(--sol-red)" }} aria-haspopup="dialog" onClick={() => setRemoving(true)} data-watch-delete>
            <Trash2 className="w-3.5 h-3.5" />Delete watch…
          </button>
        </div>
      </div>
      {removing && (
        <SwitchReview
          ledger={removeLedger}
          onClose={() => setRemoving(false)}
          onConfirm={() => {
            setRemoving(false);
            useInboxStore.getState().removeOpsWatch(watch._id);
            router.push(opsHref.tab("metrics", { source: watch.source_name }));
          }}
        />
      )}
    </div>
  );
}

/** What missing reads do once a watch has a line. */
function NoDataSelect({ id, value, onChange }: { id: string; value: number; onChange: (n: number) => void }) {
  return (
    <select id={id} className="mx-select" value={value} onChange={(e) => onChange(Number(e.target.value))} data-watch-nodata>
      <option value={0}>Ignore</option>
      {NO_DATA_AFTER.map((n) => <option key={n} value={n}>Alert after {n} missed</option>)}
    </select>
  );
}

/**
 * The "Alert when" rows, one form for the settings card and the New watch
 * sheet (as Datadog's monitor form keeps its thresholds and no-data policy in
 * one place): the side and the line, then once there is a line the warning
 * level, how many reads in a row, and what missing data does. The inputs are
 * the caller's (the card commits on Enter, the sheet on Add); `afterLine` and
 * `afterWarn` sit under their input.
 */
function AlertWhenRows({ ids, direction, onDirection, hasLine, lineText, onLineText, lineInvalid, lineKeys, afterLine, warnText, onWarnText, warnProblem, warnKeys, afterWarn, evalReads, onEvalReads, interval_ms, noData, onNoData }: {
  ids: string; direction: "above" | "below"; onDirection: (d: "above" | "below") => void; hasLine: boolean;
  lineText: string; onLineText: (t: string) => void; lineInvalid: boolean; lineKeys?: (e: React.KeyboardEvent) => void; afterLine?: React.ReactNode;
  warnText: string; onWarnText: (t: string) => void; warnProblem: string | null; warnKeys?: (e: React.KeyboardEvent) => void; afterWarn?: React.ReactNode;
  evalReads: number; onEvalReads: (n: number) => void; interval_ms: number; noData: number; onNoData: (n: number) => void;
}) {
  return (
    <>
      <div className="mx-form-sub" data-watch-section="when">Alert when</div>
      <label htmlFor={`${ids}-line`}>Alert</label>
      <div className="mx-form-row">
        <span className="mx-seg" role="group" aria-label="Alerting side">
          {(["above", "below"] as const).map((d) => (
            <button key={d} type="button" aria-pressed={hasLine && direction === d} disabled={!hasLine} onClick={() => onDirection(d)} data-watch-direction={d}>
              {d}
            </button>
          ))}
        </span>
        <input
          id={`${ids}-line`}
          className="mx-input ops-num"
          inputMode="decimal"
          placeholder="no line"
          aria-invalid={lineInvalid}
          value={lineText}
          onChange={(e) => onLineText(e.target.value)}
          onKeyDown={lineKeys}
          data-watch-threshold
        />
      </div>
      {lineInvalid && <div className="mx-problem">Not a number</div>}
      {afterLine}
      {hasLine && (
        <>
          <label htmlFor={`${ids}-warn`}>Warn</label>
          <input
            id={`${ids}-warn`}
            className="mx-input ops-num"
            inputMode="decimal"
            placeholder="none"
            aria-invalid={!!warnProblem}
            value={warnText}
            onChange={(e) => onWarnText(e.target.value)}
            onKeyDown={warnKeys}
            data-watch-warn
          />
          {warnProblem && <div className="mx-problem">{warnProblem}</div>}
          {afterWarn}

          <label htmlFor={`${ids}-after`}>After</label>
          <div className="mx-form-row">
            <select id={`${ids}-after`} className="mx-select" value={evalReads} onChange={(e) => onEvalReads(Number(e.target.value))} data-watch-eval>
              {EVAL_READS.map((n) => <option key={n} value={n}>{n === 1 ? "1 read" : `${n} reads in a row`}</option>)}
            </select>
            <span className="ops-dim ops-num">{spanLabel(evalReads * interval_ms)}</span>
          </div>

          <label htmlFor={`${ids}-nodata`}>No data</label>
          <NoDataSelect id={`${ids}-nodata`} value={noData} onChange={onNoData} />
        </>
      )}
    </>
  );
}

// ── The query ──

/**
 * The watch's query, full width under the chart: HogQL in an editor as tall
 * as the query, a reader as the manifest's picker with typed arguments, an
 * insight by id. Run reads it once and hands the answer to the chart
 * (`onPreview`); Save writes it.
 */
export function QueryEditor({ watch, source, onPreview, highlight }: { watch: OpsWatch; source: OpsSource | undefined; onPreview: (points: Pt[] | null) => void; highlight: (sql: string) => React.ReactNode }) {
  const update = useInboxStore((s) => s.updateOpsWatch);
  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const { run, read, reset } = useQueryRun(source);
  const text = draft ?? watch.query;
  const dirty = draft !== null && draft.trim() !== watch.query.trim();
  const problem = source && dirty ? watchProblem(source.provider, watch.query_kind, text, undefined) : null;
  const canRun = !!source && watch.query_kind !== "insight" && !(source && watchProblem(source.provider, watch.query_kind, text, undefined));
  const reader = watch.query_kind === "reader" ? /^(\S+)\s*([\s\S]*)$/.exec(text.trim()) : null;
  const close = () => { setDraft(null); setEditing(false); reset(); onPreview(null); };
  const edit = (q: string) => { setDraft(q); reset(); onPreview(null); };
  // The answer goes to the chart: a reader's series as a line, HogQL's one value as a point now.
  const doRun = async () => {
    const r = await read(watch.query_kind, text);
    onPreview(r.state === "value" ? (r.points.length ? r.points : [{ at: Date.now(), value: r.value }]) : null);
  };
  const title = watch.query_kind === "hogql" ? "HogQL" : watch.query_kind === "insight" ? "PostHog insight" : watch.query_kind === "volume" ? "Codecast's count" : "App reader";
  return (
    <div className="ops-card mt-3.5" data-watch-query data-editing={editing ? "" : undefined}>
      <div className="ops-card-head">
        <span className="inline-flex items-center gap-2 min-w-0">{title}{reader && !editing && <span className="ops-mono ops-dim text-[11px] font-normal truncate">{reader[1]}</span>}</span>
        <span className="inline-flex items-center gap-1.5">
          {watch.query_kind !== "insight" && (
            <button type="button" className="ops-btn" disabled={!canRun || run.state === "reading"} onClick={doRun} data-watch-query-run>
              {run.state === "reading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}Run
            </button>
          )}
          {!editing && <button type="button" className="ops-btn" onClick={() => setEditing(true)} data-watch-query-edit><Pencil className="w-3.5 h-3.5" />Edit</button>}
        </span>
      </div>
      {editing ? (
        <div className="mx-query-edit">
          {watch.query_kind === "reader" && source ? (
            <ReaderPicker source={source} query={text} onQuery={(q) => edit(q)} fallback={
              <textarea className="mx-textarea mx-query-text" value={text} onChange={(e) => edit(e.target.value)} spellCheck={false} aria-label="Reader query" />
            } />
          ) : (
            <textarea
              className="mx-textarea mx-query-text"
              value={text}
              rows={Math.min(18, Math.max(4, text.split("\n").length + 1))}
              onChange={(e) => edit(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canRun) { e.preventDefault(); void doRun(); } if (e.key === "Escape") close(); }}
              spellCheck={false}
              autoFocus
              aria-label={title}
              data-watch-query-text
            />
          )}
        </div>
      ) : (
        <pre className="mx-code">{watch.query_kind === "hogql" ? highlight(watch.query) : reader ? (reader[2] || reader[1]) : watch.query}</pre>
      )}
      {(run.state === "value" || run.state === "error" || editing) && (
        <div className="mx-query-foot">
          {run.state === "value" && <span className="mx-query-answer" data-watch-query-value><b className="ops-num">{formatValue(run.value, watch.unit ?? run.unit)}</b>{run.points.length > 1 && <span className="ops-dim ops-num">{run.points.length} values on the chart</span>}</span>}
          {run.state === "error" && <span style={{ color: "var(--sol-red)" }}>{run.error}</span>}
          {problem && <span className="mx-problem">{problem}</span>}
          <span className="flex-1" />
          {editing && <button type="button" className="ops-btn" onClick={close}>{dirty ? "Discard" : "Done"}</button>}
          {editing && dirty && (
            <button type="button" className="ops-btn" data-tone="primary" disabled={!!problem} onClick={() => { update(watch._id, { query: text.trim() }); close(); }} data-watch-query-save>Save query</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── A new watch ──


export function NewWatchSheet({ sources, initialSource, onClose }: { sources: OpsSource[]; initialSource: string | null; onClose: () => void }) {
  const router = useRouter();
  const hosts = useMemo(() => sources.filter((s) => watchKindsOf(s.provider).length > 0), [sources]);
  const [sourceId, setSourceId] = useState(() => hosts.find((s) => s.name === initialSource)?._id ?? hosts[0]?._id ?? "");
  const source = hosts.find((s) => s._id === sourceId);
  const kinds = watchKindsOf(source?.provider);
  const [kind, setKind] = useState<WatchKind | null>(null);
  const k: WatchKind | undefined = kind && kinds.includes(kind) ? kind : kinds[0];
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [line, setLine] = useState("");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [unit, setUnit] = useState("");
  const [interval, setInterval_] = useState<number>(INTERVALS[1].ms);
  const [evalReads, setEvalReads] = useState(1);
  const [warnText, setWarnText] = useState("");
  const [noData, setNoData] = useState(0);
  // Who hears about it once it has a line, in the same form as the threshold (as Datadog's monitor form does): the routes this workspace last set, else the creator.
  const me = useInboxStore((s) => (s as any).currentUser?._id as string | undefined);
  const [tell, setTell] = useState<AlertNotifyInput | null>(null);
  // The watch's own route for its alerts; unset follows the source's rule, as on the settings card.
  const [onAlert, setOnAlert] = useState<AlertRoute | null>(null);
  const watches = useOpsWatches();
  const lastRoutes = useMemo(() => (source ? lastUsedRoutes(watches, source.workspace, me) : {}), [watches, source, me]);
  const tellShown: AlertNotifyInput = tell ?? lastRoutes;
  const { run: preview, read, reset: resetPreview } = useQueryRun(source);
  const [saving, setSaving] = useState<string | null>(null);
  const [autoName, setAutoName] = useState("");
  const [autoUnit, setAutoUnit] = useState("");
  // A query belongs to its source and kind: switching either starts the query over, with the name and unit it filled in.
  const startOver = () => {
    setQuery("");
    resetPreview();
    if (!name.trim() || name === autoName) { setName(""); setAutoName(""); }
    if (unit === autoUnit) { setUnit(""); setAutoUnit(""); }
  };
  const dup = source && k ? duplicateWatch(watches, source._id, k, query) : null;

  const threshold = parseThreshold(line);
  const hasLine = typeof threshold === "number";
  const warn = parseThreshold(warnText);
  const warnProblem = !hasLine || !warnText.trim() ? null : warn === null ? "Not a number" : monitorProblem({ threshold, direction, warn: warn ?? undefined });
  // The reader's own syntax is the picker's job: an unfinished pick reads as what is left to pick.
  const queryProblem = !source || !k ? null : !query.trim() ? (k === "reader" || k === "volume" ? "Pick a number" : k === "insight" ? "Pick an insight" : "Write the query") : watchProblem(source.provider, k, query, threshold ?? undefined);
  const problem = !source ? "Pick a source" : !k ? "This source cannot host watches" : queryProblem ?? (!name.trim() ? "Name it" : threshold === null ? "The line is not a number" : warnProblem ? `Warn: ${warnProblem}` : null);
  // A pick not made yet is what the unselected list and the disabled button already say: the footer names only what is wrong.
  const footProblem = !source || !k || !query.trim() ? null : problem;
  const canPreview = !!source && (k === "hogql" || k === "reader" || k === "volume") && !!query.trim() && !(k && watchProblem(source.provider, k, query, undefined));

  const readNow = async () => {
    if (!k) return;
    const r = await read(k, query);
    if (r.state === "value" && !unit.trim() && r.unit) { setUnit(r.unit); setAutoUnit(r.unit); }
  };
  // A reader is cheap to ask, and a volume series is already here: the answer follows the pick. HogQL runs on Run.
  useWatchEffect(() => {
    if ((k !== "reader" && k !== "volume") || !canPreview) return;
    const id = setTimeout(() => void readNow(), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the query
  }, [k, query, sourceId, canPreview]);
  const series = useMemo(() => (preview.state === "value" ? preview.points : []), [preview]);
  // The number in the Now row, on the chart at the time it was read: the newest point, the axis ending at it.
  const livePt = useMemo(() => (preview.state === "value" && series.length > 1 && preview.at && preview.at > series[series.length - 1].at ? { at: preview.at, value: preview.value } : null), [preview, series]);
  const seriesSpan = series.length > 1 ? (livePt?.at ?? series[series.length - 1].at) - series[0].at : 0;
  // Every count in the sheet is over what the chart draws, the value read now included: the Now row and each suggested line say the same number.
  const drawnPts = useMemo(() => (livePt ? [...series, livePt] : series), [series, livePt]);
  const crossesN = series.length > 1 && hasLine ? wouldCross(drawnPts, threshold, direction) : null;
  // The lines the preview's own history suggests (the page's Add alert line, read the same way): on the side typed, or the side the values stray to.
  const suggestSide = threshold === undefined ? suggestDirection(series) : direction;
  const suggestions = useMemo(() => (series.length >= 3 ? lineSuggestions(series, suggestSide, drawnPts) : []), [series, suggestSide, drawnPts]);
  // A value read now past the line opens an alert on the watch's first poll (one read is enough), and tells whoever the Notify rows name.
  const firesOnAdd = hasLine && preview.state === "value" && evalReads === 1 && crosses(preview.value, threshold, direction);
  const save = async () => {
    if (dup) {
      onClose();
      router.push(opsHref.metric(dup.short_id));
      return;
    }
    if (problem || !source || !k) return;
    setSaving("saving");
    try {
      const res = await useInboxStore.getState().createOpsWatch({
        source: source._id, name: name.trim(), query_kind: k, query: query.trim(),
        ...(hasLine ? { threshold, direction } : {}),
        ...(unit.trim() ? { unit: unit.trim() } : {}),
        ...(evalReads > 1 && hasLine ? { eval_reads: evalReads } : {}),
        ...(hasLine && typeof warn === "number" ? { warn } : {}),
        ...(hasLine && noData ? { no_data_after: noData } : {}),
        interval_ms: interval,
      });
      if (res?.short_id) {
        // Routing rides one patch right after the create, the same write the settings card makes.
        const routed = !!(tellShown.users?.length || tellShown.roles?.length || tellShown.channel || tellShown.fix);
        const routing = { ...(routed ? { notify: tellShown } : {}), ...(onAlert ? { on_alert: onAlert } : {}) };
        if (hasLine && Object.keys(routing).length) useInboxStore.getState().updateOpsWatch(res.watch_id, routing);
        onClose();
        router.push(opsHref.metric(res.short_id));
      } else setSaving("The server did not make it");
    } catch (e) {
      setSaving(e instanceof Error ? e.message.split("\n")[0] : "The server did not make it");
    }
  };

  const placeholder = k === "hogql" ? "SELECT count() FROM events WHERE event = '$exception' AND timestamp > now() - INTERVAL 1 DAY" : k === "insight" ? "insight id or short id" : "reader_name {\"days\": 7}";
  const pick = (q: string, title: string) => {
    setQuery(q);
    resetPreview();
    if (!name.trim() || name === autoName) {
      setName(title);
      setAutoName(title);
    }
  };

  return (
    <div className="mx-sheet-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }} role="presentation">
      <div className="mx-sheet" role="dialog" aria-modal="true" aria-label="New watch" data-new-watch>
        <div className="mx-sheet-head">
          <span className="flex-1">New watch</span>
          <button type="button" className="ops-btn" aria-label="Close" onClick={onClose}><X className="w-3.5 h-3.5" /></button>
        </div>
        <div className="mx-sheet-body">
          <div className="mx-form">
            <label>Source</label>
            <div className="mx-form-row flex-wrap">
              {hosts.map((s) => (
                <button key={s._id} type="button" className="mx-state" aria-pressed={s._id === sourceId} style={{ ["--ink" as string]: "var(--sol-cyan)" }} onClick={() => { if (s._id !== sourceId) { setSourceId(s._id); setKind(null); startOver(); } }} data-new-watch-source={s.name}>
                  <ProviderIcon provider={s.provider} />{s.name}
                </button>
              ))}
            </div>
            <label>Kind</label>
            {kinds.length > 1 ? (
              <span className="mx-seg" role="group" aria-label="Kind">
                {kinds.map((x) => <button key={x} type="button" aria-pressed={x === k} onClick={() => { if (x !== k) { setKind(x); startOver(); } }} data-new-watch-kind={x}>{KIND_LABEL[x] ?? x}</button>)}
              </span>
            ) : <span className="mx-static" data-new-watch-kind={k}>{k ? KIND_LABEL[k] ?? k : "–"}</span>}
            <label htmlFor="mx-new-name">Name</label>
            <input id="mx-new-name" className="mx-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
            <label htmlFor="mx-new-query" style={{ alignSelf: "start", paddingTop: 6 }}>{k === "insight" ? "Insight" : k === "reader" ? "Reader" : k === "volume" ? "Series" : "Query"}</label>
            {k === "reader" && source ? (
              <ReaderPicker key={source._id} source={source} query={query} onQuery={pick} fallback={
                <textarea id="mx-new-query" className="mx-textarea" value={query} onChange={(e) => { setQuery(e.target.value); resetPreview(); }} placeholder={placeholder} spellCheck={false} />
              } />
            ) : k === "insight" && source ? (
              <InsightPicker key={source._id} source={source} query={query} onQuery={pick} placeholder={placeholder} />
            ) : k === "volume" && source ? (
              <VolumePicker key={source._id} source={source} query={query} onQuery={(q, title) => { pick(q, title); if (interval === INTERVALS[1].ms) setInterval_(3600_000); }} />
            ) : k === "hogql" && source ? (
              <div className="mx-picker">
                <HogqlBuilder key={source._id} source={source} onQuery={pick} />
                <textarea id="mx-new-query" className="mx-textarea" value={query} onChange={(e) => { setQuery(e.target.value); resetPreview(); }} placeholder={placeholder} spellCheck={false} data-new-watch-query />
              </div>
            ) : (
              <textarea id="mx-new-query" className="mx-textarea" value={query} onChange={(e) => { setQuery(e.target.value); resetPreview(); }} placeholder={placeholder} spellCheck={false} />
            )}
            {dup && (
              <div className="mx-dup" style={{ gridColumn: "2 / -1" }} data-new-watch-dup={dup.short_id}>
                Watched as <Link href={opsHref.metric(dup.short_id)} className="ops-mono hover:underline" onClick={onClose}>{dup.short_id}</Link>
                <span className="ops-dim mx-dup-name">{dup.name}</span>
              </div>
            )}
            <label>Now</label>
            <div className="mx-preview">
              {k === "insight" ? <span className="ops-dim">read on the first poll</span> : (
                <>
                  {k === "hogql" && (
                    <button type="button" className="ops-btn" disabled={!canPreview || preview.state === "reading"} onClick={readNow} data-watch-preview>
                      {preview.state === "reading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}Run
                    </button>
                  )}
                  {k === "reader" && preview.state === "reading" && <Loader2 className="w-3.5 h-3.5 animate-spin self-center" aria-label="Reading" />}
                  {(k === "reader" || k === "volume") && preview.state === "idle" && <span className="ops-dim">–</span>}
                  {preview.state === "value" && <b data-watch-preview-value>{formatValue(preview.value, unit.trim() || preview.unit)}</b>}
                  {firesOnAdd && <FiresOnAdd />}
                  {crossesN !== null && (
                    <span className="ops-num" data-would-cross={crossesN} style={{ color: crossesN ? "var(--sol-red)" : "var(--sol-text-dim)" }}>
                      {crossesN ? `crossed ${crossesN}× in ${spanLabel(seriesSpan)}` : `never past it in ${spanLabel(seriesSpan)}`}
                    </span>
                  )}
                  {preview.state === "error" && <span style={{ color: "var(--sol-red)" }}>{preview.error}</span>}
                </>
              )}
            </div>
            {series.length > 1 && (
              <div style={{ gridColumn: "1 / -1" }} data-watch-preview-chart>
                <MetricChart
                  points={series}
                  win={{ from: series[0].at, to: Math.max(series[series.length - 1].at, livePt?.at ?? 0) }}
                  live={livePt}
                  interval_ms={Math.max(interval, seriesSpan / Math.max(1, series.length - 1))}
                  threshold={hasLine ? threshold : undefined}
                  direction={direction}
                  unit={unit.trim() || (preview.state === "value" ? preview.unit : null) || undefined}
                  height={120}
                  full
                  label="What the query answers, with the line"
                />
              </div>
            )}
            <AlertWhenRows
              ids="mx-new"
              direction={direction}
              onDirection={setDirection}
              hasLine={hasLine}
              lineText={line}
              onLineText={setLine}
              lineInvalid={threshold === null}
              afterLine={suggestions.length > 0 && (
                <div className="mx-form-row mx-suggest-chips" style={{ gridColumn: "2 / -1" }} data-new-watch-suggest>
                  {suggestions.map((sg) => (
                    <button
                      key={sg.key}
                      type="button"
                      className="mx-state"
                      aria-pressed={threshold === sg.value && direction === suggestSide}
                      style={{ ["--ink" as string]: sg.crossings ? "var(--sol-red)" : "var(--sol-text-muted)" }}
                      onClick={() => { setDirection(suggestSide); setLine(String(sg.value)); }}
                      data-new-watch-suggest-line={sg.key}
                    >
                      {sg.label} {suggestSide === "above" ? ">" : "<"} {formatValue(sg.value, unit.trim() || (preview.state === "value" ? preview.unit : null))}<b>{sg.crossings}×</b>
                    </button>
                  ))}
                </div>
              )}
              warnText={warnText}
              onWarnText={setWarnText}
              warnProblem={warnProblem}
              evalReads={evalReads}
              onEvalReads={setEvalReads}
              interval_ms={interval}
              noData={noData}
              onNoData={setNoData}
            />
            <label htmlFor="mx-new-unit">Unit</label>
            <input id="mx-new-unit" className="mx-input" style={{ maxWidth: 110 }} maxLength={12} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="%, ms, $" />
            <label htmlFor="mx-new-every">Every</label>
            <select id="mx-new-every" className="mx-select" style={{ justifySelf: "start" }} value={interval} onChange={(e) => setInterval_(Number(e.target.value))}>
              {INTERVALS.map((i) => <option key={i.ms} value={i.ms}>{i.label}</option>)}
            </select>
            {hasLine && source && (
              <>
                <div className="mx-form-sub" data-watch-section="notify">Notify</div>
                <OnAlertRow value={onAlert ?? undefined} source={source} onChange={setOnAlert} />
                <NotifyRows subject={{ name: name.trim(), direction, threshold }} workspace={source.workspace} source={source} value={tellShown} onChange={setTell} />
              </>
            )}
          </div>
        </div>
        <div className="mx-sheet-foot">
          <span className="flex-1 text-[11.5px]" style={{ color: saving && saving !== "saving" ? "var(--sol-red)" : "var(--sol-text-dim)" }} data-watch-problem>
            {saving && saving !== "saving" ? saving : dup ? "" : footProblem ?? ""}
          </span>
          {firesOnAdd && !dup && <FiresOnAdd />}
          <button type="button" className="ops-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ops-btn" data-tone="primary" disabled={!dup && (!!problem || saving === "saving")} onClick={save} data-watch-create={dup ? "open" : "add"}>
            {dup ? `Open ${dup.short_id}` : saving === "saving" ? "Adding…" : "Add watch"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The value read now is past the line: adding the watch opens an alert on its first poll (Datadog's "would trigger now"). */
function FiresOnAdd() {
  return <span className="mx-health" style={{ ["--ink" as string]: "var(--sol-red)" }} data-health="alert" data-fires-on-add>Alerts on add</span>;
}
