// Editing a watch from the app: its settings card on the watch page (line,
// side, warning level with how often each would have alerted over the
// chart's values before it is saved, reads in a row, missing data, unit,
// interval, name, pause, delete), the query editor (HogQL or a reader picked
// from the app's manifest, run before it is saved) and the sheet that makes a new one on a source that
// can host watches: a reader picked from the app's manifest with typed
// arguments, an insight picked from the PostHog project, or HogQL, with the
// query's current value (and a reader's own series) read before it is saved.
// Every write goes through the store (opsSlice updateOpsWatch,
// removeOpsWatch, createOpsWatch), so the page moves at once.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { Loader2, Pause, Pencil, Play, PlayCircle, Trash2, X } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { watchProblem, type WatchKind } from "@codecast/shared/contracts/ingest";
import { monitorProblem, type AlertNotifyInput, type AlertRoute } from "@codecast/shared/contracts/metricMonitor";
import { parseAppManifest, type AppReader } from "@codecast/shared/contracts/appConnector";
import { useOpsApp, useOpsGroups, useOpsWatches, useSyncOpsApp } from "../../hooks/useSyncOps";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { MetricChart } from "./MetricChart";
import { AlertRouting, NotifyRows, OnAlertRow } from "./WatchRouting";
import { lastUsedRoutes } from "./alertRouting";
import {
  EVAL_READS, EVENTS_HOGQL, HOGQL_AGGS, HOGQL_WINDOWS, INTERVALS, KIND_LABEL, NO_DATA_AFTER, argFields, argOptions, argSourceReader, duplicateWatch, eventRows, formatValue, hogqlOfPick, intervalLabel, nameOfPick, parseThreshold,
  lineSuggestions, readerAnswersNumber, readerQueryText, readerQueryValues, spanLabel, suggestDirection, volumeOptions, wouldCross,
  type ArgField, type ArgOption, type HogqlPick, type Pt,
} from "./metricModel";
import { opsHref } from "./opsPaths";
import { ProviderIcon } from "./parts";
import { scopeOfSource, useQueryRun, watchKindsOf } from "./watchQuery";
import type { OpsSource, OpsWatch } from "./opsTypes";

const api = _api as any;

// ── The watch's settings ──

/**
 * `history` is what the chart shows and `within` names its window: a line or warning
 * level being typed says how often it would have crossed over them, and is
 * handed to `onDraft` so the chart draws it before it is saved.
 */
export function WatchSettings({ watch, source, removeLedger, history, within, onDraft }: { watch: OpsWatch; source?: OpsSource; removeLedger: SwitchLedger; history: readonly Pt[]; /** The chart's window as a sentence names it: "in 30d", "since Oct 5". */ within: string; onDraft?: (line: number | undefined) => void }) {
  const router = useRouter();
  const update = useInboxStore((s) => s.updateOpsWatch);
  const [line, setLine_] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const lineText = line ?? (watch.threshold === undefined ? "" : String(watch.threshold));
  const parsed = parseThreshold(lineText);
  const paused = watch.status === "paused";
  const setLine = (text: string | null) => {
    setLine_(text);
    const v = text === null ? undefined : parseThreshold(text);
    onDraft?.(v === null ? undefined : v);
  };
  const [warnText, setWarnText] = useState<string | null>(null);
  const warnShown = warnText ?? (watch.warn === undefined ? "" : String(watch.warn));
  const warnParsed = parseThreshold(warnShown);
  const warnProblem = warnText === null ? null : warnParsed === null ? "Not a number" : monitorProblem({ threshold: watch.threshold, direction: watch.direction, warn: warnParsed });
  const commitWarn = () => {
    if (warnText === null || warnProblem) return;
    const next = warnParsed ?? null;
    if (next !== (watch.warn ?? null)) update(watch._id, { warn: next });
    setWarnText(null);
  };
  const hasLine = watch.threshold !== undefined;
  const lineDirty = line !== null && parsed !== null && (parsed ?? null) !== (watch.threshold ?? null);
  const warnDirty = warnText !== null && !warnProblem && (warnParsed ?? null) !== (watch.warn ?? null);

  const commitLine = () => {
    if (line === null || parsed === null) return;
    const next = parsed === undefined ? null : parsed;
    if (next !== (watch.threshold ?? null)) update(watch._id, { threshold: next });
    setLine(null);
  };
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

          <div className="mx-form-sub" data-watch-section="when">Alert when</div>
          <label htmlFor="mx-line">Alert</label>
          <div className="mx-form-row">
            <span className="mx-seg" role="group" aria-label="Alerting side">
              {(["above", "below"] as const).map((d) => (
                <button key={d} type="button" aria-pressed={hasLine && watch.direction === d} disabled={!hasLine} onClick={() => watch.direction !== d && update(watch._id, { direction: d })} data-watch-direction={d}>
                  {d}
                </button>
              ))}
            </span>
            <input
              id="mx-line"
              className="mx-input ops-num"
              inputMode="decimal"
              placeholder="no line"
              aria-invalid={parsed === null}
              value={lineText}
              onChange={(e) => setLine(e.target.value)}
              onKeyDown={enter(commitLine, () => setLine(null))}
              data-watch-threshold
            />
          </div>
          {parsed === null && <div className="mx-problem">Not a number</div>}
          {lineDirty && (
            <DraftRow
              label={parsed === undefined ? "No line: the watch becomes a series" : <CrossCount history={history} within={within} now={watch.threshold} next={parsed!} direction={watch.direction} />}
              onSave={commitLine}
              onDiscard={() => setLine(null)}
            />
          )}

          {hasLine && (
            <>
              <label htmlFor="mx-warn">Warn</label>
              <input
                id="mx-warn"
                className="mx-input ops-num"
                inputMode="decimal"
                placeholder="none"
                aria-invalid={!!warnProblem}
                value={warnShown}
                onChange={(e) => setWarnText(e.target.value)}
                onKeyDown={enter(commitWarn, () => setWarnText(null))}
                data-watch-warn
              />
              {warnProblem && <div className="mx-problem">{warnProblem}</div>}
              {warnDirty && (
                <DraftRow
                  label={warnParsed === undefined ? "No warning level" : <CrossCount history={history} within={within} now={watch.warn} next={warnParsed!} direction={watch.direction} />}
                  onSave={commitWarn}
                  onDiscard={() => setWarnText(null)}
                />
              )}

              <label htmlFor="mx-after">After</label>
              <div className="mx-form-row">
                <select id="mx-after" className="mx-select" value={watch.eval_reads ?? 1} onChange={(e) => update(watch._id, { eval_reads: Number(e.target.value) })} data-watch-eval>
                  {EVAL_READS.map((n) => <option key={n} value={n}>{n === 1 ? "1 read" : `${n} reads in a row`}</option>)}
                </select>
                <span className="ops-dim ops-num">{spanLabel((watch.eval_reads ?? 1) * watch.interval_ms)}</span>
              </div>

              <label htmlFor="mx-nodata">No data</label>
              <select id="mx-nodata" className="mx-select" value={watch.no_data_after ?? 0} onChange={(e) => update(watch._id, { no_data_after: Number(e.target.value) || null })} data-watch-nodata>
                <option value={0}>Ignore</option>
                {NO_DATA_AFTER.map((n) => <option key={n} value={n}>Alert after {n} missed</option>)}
              </select>
            </>
          )}

          <label htmlFor="mx-unit">Unit</label>
          <input id="mx-unit" className="mx-input" maxLength={12} placeholder="none" value={unit ?? watch.unit ?? ""} onChange={(e) => setUnit(e.target.value)} onBlur={commitUnit} onKeyDown={enter(commitUnit, () => setUnit(null))} />

          <label htmlFor="mx-every">Every</label>
          <select id="mx-every" className="mx-select" value={INTERVALS.some((i) => i.ms === watch.interval_ms) ? watch.interval_ms : "custom"} onChange={(e) => update(watch._id, { interval_ms: Number(e.target.value) })}>
            {INTERVALS.map((i) => <option key={i.ms} value={i.ms}>{i.label}</option>)}
            {!INTERVALS.some((i) => i.ms === watch.interval_ms) && <option value="custom" disabled>{intervalLabel(watch.interval_ms)}</option>}
          </select>

          {hasLine && (
            <>
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

/** A typed level not saved yet: what it would have done, Save and Discard. */
function DraftRow({ label, onSave, onDiscard }: { label: React.ReactNode; onSave: () => void; onDiscard: () => void }) {
  return (
    <div className="mx-draft" data-watch-draft>
      <span className="flex-1 min-w-0">{label}</span>
      <button type="button" className="ops-btn" onClick={onDiscard}>Discard</button>
      <button type="button" className="ops-btn" data-tone="primary" onClick={onSave} data-watch-draft-save>Save</button>
    </div>
  );
}

/** How often a level would have been crossed over the chart's values, beside how often the saved one was: "3x → 9x in 30d". */
function CrossCount({ history, within, now, next, direction }: { history: readonly Pt[]; within: string; now: number | undefined; next: number; direction: "above" | "below" }) {
  const after = wouldCross(history, next, direction);
  const before = now === undefined ? null : wouldCross(history, now, direction);
  return (
    <span className="ops-num" data-would-cross={after}>
      {before !== null && before !== after && <><s className="ops-dim">{before}×</s> → </>}
      <b>{after}×</b> {within}
    </span>
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
  // The reader's own syntax is the picker's job: an unfinished pick reads as what is left to pick.
  const queryProblem = !source || !k ? null : !query.trim() ? (k === "reader" || k === "volume" ? "Pick a number" : k === "insight" ? "Pick an insight" : "Write the query") : watchProblem(source.provider, k, query, threshold ?? undefined);
  const problem = !source ? "Pick a source" : !k ? "This source cannot host watches" : queryProblem ?? (!name.trim() ? "Name it" : threshold === null ? "The line is not a number" : null);
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
  const series = preview.state === "value" ? preview.points : [];
  // The number in the Now row, on the chart at the time it was read: the newest point, the axis ending at it.
  const livePt = preview.state === "value" && series.length > 1 && preview.at && preview.at > series[series.length - 1].at ? { at: preview.at, value: preview.value } : null;
  const seriesSpan = series.length > 1 ? (livePt?.at ?? series[series.length - 1].at) - series[0].at : 0;
  // Counted over what the chart draws, the value read now included: a Now past the line is never "never past it".
  const crossesN = series.length > 1 && typeof threshold === "number" ? wouldCross(livePt ? [...series, livePt] : series, threshold, direction) : null;
  // The lines the preview's own history suggests (the page's Add alert line, read the same way): on the side typed, or the side the values stray to.
  const suggestSide = threshold === undefined ? suggestDirection(series) : direction;
  const suggestions = useMemo(() => (series.length >= 3 ? lineSuggestions(series, suggestSide) : []), [series, suggestSide]);
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
        ...(threshold !== undefined && threshold !== null ? { threshold, direction } : {}),
        ...(unit.trim() ? { unit: unit.trim() } : {}),
        ...(evalReads > 1 && threshold !== undefined && threshold !== null ? { eval_reads: evalReads } : {}),
        interval_ms: interval,
      });
      if (res?.short_id) {
        // Routing rides one patch right after the create, the same write the settings card makes.
        const routed = !!(tellShown.users?.length || tellShown.roles?.length || tellShown.channel || tellShown.fix);
        const routing = { ...(routed ? { notify: tellShown } : {}), ...(onAlert ? { on_alert: onAlert } : {}) };
        if (typeof threshold === "number" && Object.keys(routing).length) useInboxStore.getState().updateOpsWatch(res.watch_id, routing);
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
                  threshold={typeof threshold === "number" ? threshold : undefined}
                  direction={direction}
                  unit={unit.trim() || (preview.state === "value" ? preview.unit : null) || undefined}
                  height={120}
                  full
                  label="What the query answers, with the line"
                />
              </div>
            )}
            <label htmlFor="mx-new-line">Alert</label>
            <div className="mx-form-row">
              <span className="mx-seg" role="group" aria-label="Alerting side">
                {(["above", "below"] as const).map((d) => <button key={d} type="button" aria-pressed={direction === d} disabled={threshold === undefined} onClick={() => setDirection(d)}>{d}</button>)}
              </span>
              <input id="mx-new-line" className="mx-input ops-num" inputMode="decimal" placeholder="none" aria-invalid={threshold === null} value={line} onChange={(e) => setLine(e.target.value)} />
              <select className="mx-select" value={evalReads} onChange={(e) => setEvalReads(Number(e.target.value))} aria-label="Reads in a row before it alerts" disabled={threshold === undefined || threshold === null}>
                {EVAL_READS.map((n) => <option key={n} value={n}>{n === 1 ? "1 read" : `${n} in a row`}</option>)}
              </select>
            </div>
            {suggestions.length > 0 && (
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
            <label htmlFor="mx-new-unit">Unit</label>
            <div className="mx-form-row">
              <input id="mx-new-unit" className="mx-input" style={{ maxWidth: 110 }} maxLength={12} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="%, ms, $" />
              <span className="ops-dim" style={{ marginLeft: 8 }}>every</span>
              <select className="mx-select" value={interval} onChange={(e) => setInterval_(Number(e.target.value))} aria-label="Poll interval">
                {INTERVALS.map((i) => <option key={i.ms} value={i.ms}>{i.label}</option>)}
              </select>
            </div>
            {typeof threshold === "number" && source && (
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
          <button type="button" className="ops-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ops-btn" data-tone="primary" disabled={!dup && (!!problem || saving === "saving")} onClick={save} data-watch-create={dup ? "open" : "add"}>
            {dup ? `Open ${dup.short_id}` : saving === "saving" ? "Adding…" : "Add watch"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pickers ──

/** The series codecast counts for a source, each with its value now and a spark of the past its counters hold. */
function VolumePicker({ source, query, onQuery }: { source: OpsSource; query: string; onQuery: (query: string, title: string) => void }) {
  const groups = useOpsGroups();
  const options = useMemo(() => volumeOptions(source, groups.filter((g) => g.source_id === source._id), Date.now()), [source, groups]);
  return (
    <div className="mx-insights mx-volume-pick" role="listbox" aria-label="Series" data-volume-picker>
      {options.map((o) => (
        <button key={o.query} type="button" role="option" aria-selected={query === o.query} onClick={() => onQuery(o.query, `${o.label}, ${source.name}`)} data-volume-option={o.query}>
          <span className="mx-name">{o.label}</span>
          <span className="mx-volume-spark">{o.points.length > 1 && <MetricChart points={o.points} win={{ from: o.points[0].at, to: o.points[o.points.length - 1].at }} interval_ms={o.points[1].at - o.points[0].at} direction="above" height={20} />}</span>
          <b className="ops-num">{formatValue(o.value, o.unit)}</b>
        </button>
      ))}
    </div>
  );
}

/**
 * HogQL from a pick, PostHog's insight builder in one row: an event from the
 * project's last week (busiest first, with its count), counted or as
 * distinct people, per hour or per day. The query it writes stays editable
 * in the box under it.
 */
function HogqlBuilder({ source, onQuery }: { source: OpsSource; onQuery: (query: string, title: string) => void }) {
  const run = useAction(api.sources.posthog.query);
  const [events, setEvents] = useState<{ s: "loading" } | { s: "ok"; rows: { event: string; count: number }[] } | { s: "error"; error: string }>({ s: "loading" });
  const [pickState, setPick] = useState<HogqlPick>({ event: "", agg: "count", window: "1h" });
  useWatchEffect(() => {
    let live = true;
    setEvents({ s: "loading" });
    run({ ...scopeOfSource(source), source: source._id, query: EVENTS_HOGQL })
      .then((body: { results?: unknown[] }) => live && setEvents({ s: "ok", rows: eventRows(body) }))
      .catch((e: unknown) => live && setEvents({ s: "error", error: e instanceof Error ? (e.message.split("Uncaught Error:").pop() ?? e.message).trim().split("\n")[0] : "PostHog did not answer" }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per source
  }, [source._id]);
  const set = (patch: Partial<HogqlPick>) => {
    const next = { ...pickState, ...patch };
    setPick(next);
    if (next.event) onQuery(hogqlOfPick(next), nameOfPick(next));
  };
  return (
    <div className="mx-form-row flex-wrap" data-hogql-builder>
      {events.s === "ok" && events.rows.length ? (
        <select className="mx-select" value={pickState.event} onChange={(e) => set({ event: e.target.value })} aria-label="Event" data-hogql-event>
          <option value="" disabled>Pick an event</option>
          {events.rows.map((r) => <option key={r.event} value={r.event}>{r.event} · {formatValue(r.count)}</option>)}
        </select>
      ) : (
        <input className="mx-input ops-mono" value={pickState.event} onChange={(e) => set({ event: e.target.value.trim() })} placeholder={events.s === "loading" ? "Loading events…" : "event name"} title={events.s === "error" ? events.error : undefined} aria-label="Event" />
      )}
      <span className="mx-seg" role="group" aria-label="Aggregate">
        {HOGQL_AGGS.map((a) => <button key={a.key} type="button" aria-pressed={pickState.agg === a.key} onClick={() => set({ agg: a.key })}>{a.label}</button>)}
      </span>
      <span className="mx-seg" role="group" aria-label="Window">
        {HOGQL_WINDOWS.map((w) => <button key={w.key} type="button" aria-pressed={pickState.window === w.key} onClick={() => set({ window: w.key })}>{w.label}</button>)}
      </span>
    </div>
  );
}

/**
 * A reader picked from the app's manifest, only those that answer a number
 * or a dated series (by their output hint); its arguments as typed fields,
 * and an argument that names another reader as its list ("the key from
 * metrics.list") as a picker filled from that reader's answer, each choice
 * with its name and its value now. The query is built from them (`name
 * {json}`); the title handed up is the picked choice's name, else the
 * reader's. With no manifest yet, the plain text box.
 */
export function ReaderPicker({ source, query, onQuery, fallback }: { source: OpsSource; query: string; onQuery: (query: string, title: string) => void; fallback: React.ReactNode }) {
  useSyncOpsApp(source._id);
  const app = useOpsApp(source._id);
  const all = useMemo<AppReader[]>(() => {
    if (!app?.manifest_json) return [];
    try {
      const parsed = parseAppManifest(JSON.parse(app.manifest_json));
      return parsed.ok ? parsed.manifest.readers : [];
    } catch {
      return [];
    }
  }, [app?.manifest_json]);
  const saved = readerQueryValues(query);
  // Readers that answer a number; when none declares its answer, every reader that does not say otherwise.
  const readers = useMemo(() => {
    const numeric = all.filter((r) => readerAnswersNumber(r) === true);
    const list = numeric.length ? numeric : all.filter((r) => readerAnswersNumber(r) !== false);
    const kept = saved?.reader && !list.some((r) => r.name === saved.reader) ? all.filter((r) => r.name === saved.reader) : [];
    return [...list, ...kept];
  }, [all, saved?.reader]);
  const [name, setName] = useState(saved?.reader ?? "");
  const [values, setValues] = useState<Record<string, string>>(saved?.values ?? {});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const reader = readers.find((r) => r.name === name);
  const fields = useMemo(() => argFields(reader?.input), [reader]);
  // A lone reader is picked for the person.
  useWatchEffect(() => {
    if (!name && readers.length === 1) choose(readers[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the list is known
  }, [readers.length]);
  if (!all.length) return <>{fallback}</>;
  const emit = (r: AppReader | undefined, v: Record<string, string>, l: Record<string, string>) => {
    if (!r) return onQuery("", "");
    const out = readerQueryText(r.name, argFields(r.input), v);
    const picked = argFields(r.input).map((f) => l[f.key]).find(Boolean);
    onQuery("query" in out ? out.query : "", picked ?? r.title);
  };
  function choose(r: AppReader | undefined) {
    const v = Object.fromEntries(argFields(r?.input).filter((f) => f.dflt !== undefined).map((f) => [f.key, f.dflt!]));
    setName(r?.name ?? "");
    setValues(v);
    setLabels({});
    emit(r, v, {});
  }
  const set = (key: string, value: string, label?: string) => {
    const v = { ...values, [key]: value };
    const l = { ...labels, [key]: label ?? "" };
    setValues(v);
    setLabels(l);
    emit(reader, v, l);
  };
  const built = reader ? readerQueryText(reader.name, fields, values) : null;
  const missing = built && "error" in built ? fields.find((f) => f.required && !(values[f.key] ?? "").trim()) : null;
  return (
    <div className="mx-picker" data-reader-picker>
      <select className="mx-select" value={name} onChange={(e) => choose(readers.find((x) => x.name === e.target.value))} aria-label="Reader" data-reader-select>
        <option value="" disabled>Pick a number</option>
        {readers.map((r) => <option key={r.name} value={r.name}>{r.title}</option>)}
      </select>
      {fields.map((f) => {
        const from = argSourceReader(f.description, all, reader?.name ?? "");
        const fromReader = from ? all.find((r) => r.name === from) : undefined;
        return (
          <label key={f.key} className="mx-arg" title={f.description}>
            <span>{fieldLabel(f)}</span>
            {fromReader && !argFields(fromReader.input).some((x) => x.required) ? (
              <ArgChoice source={source} reader={fromReader.name} field={f} value={values[f.key] ?? ""} onPick={(o) => set(f.key, o?.value ?? "", o?.label)} />
            ) : f.type === "enum" || f.type === "boolean" ? (
              <select className="mx-select" value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">{f.required ? "pick" : "default"}</option>
                {(f.type === "boolean" ? ["true", "false"] : f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                className="mx-input ops-num"
                inputMode={f.type === "number" ? "decimal" : undefined}
                value={values[f.key] ?? ""}
                placeholder={f.dflt ?? (f.required ? "required" : "default")}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
          </label>
        );
      })}
      {built && "error" in built && !missing && <div className="mx-problem">{built.error}</div>}
    </div>
  );
}

/** An argument's name as a label: `invariantId` reads "invariant id". */
function fieldLabel(f: ArgField): string {
  return f.key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}

/** The choices for one argument, read once from the reader that lists them, each with its name and value now. */
function ArgChoice({ source, reader, field, value, onPick }: { source: OpsSource; reader: string; field: ArgField; value: string; onPick: (o: ArgOption | null) => void }) {
  const runReader = useAction(api.sources.app.read);
  const [state, setState] = useState<{ s: "loading" } | { s: "ok"; options: ArgOption[] } | { s: "error"; error: string }>({ s: "loading" });
  useWatchEffect(() => {
    let live = true;
    setState({ s: "loading" });
    runReader({ ...scopeOfSource(source), source: source._id, reader, args_json: "{}" })
      .then((res: { ok?: boolean; text?: string; error?: string } | null) => {
        if (!live) return;
        if (!res?.ok) return setState({ s: "error", error: res?.error ?? `${reader} did not answer` });
        let body: unknown = null;
        try { body = JSON.parse(res.text ?? "null"); } catch { body = null; }
        setState({ s: "ok", options: argOptions(body, field.key) });
      })
      .catch((e: unknown) => live && setState({ s: "error", error: e instanceof Error ? e.message.split("\n")[0] : `${reader} did not answer` }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per source and reader
  }, [source._id, reader, field.key]);
  if (state.s === "error" || (state.s === "ok" && state.options.length === 0)) {
    return <input className="mx-input" value={value} placeholder={state.s === "error" ? "type it" : "required"} onChange={(e) => onPick(e.target.value ? { value: e.target.value, label: "", current: null, unit: null } : null)} title={state.s === "error" ? state.error : undefined} />;
  }
  const options = state.s === "ok" ? state.options : [];
  return (
    <select className="mx-select" value={value} disabled={state.s === "loading"} onChange={(e) => onPick(options.find((o) => o.value === e.target.value) ?? null)} data-arg-choice={field.key}>
      <option value="" disabled>{state.s === "loading" ? "Loading…" : field.required ? "Pick one" : "default"}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}{o.current !== null ? ` · ${formatValue(o.current, o.unit)}` : ""}</option>
      ))}
    </select>
  );
}

type InsightRow = { id: number; short_id: string; name: string; kind: string | null };

/** An insight picked from the project's saved insights (sources.posthog.listInsights), or typed by id. */
function InsightPicker({ source, query, onQuery, placeholder }: { source: OpsSource; query: string; onQuery: (query: string, title: string) => void; placeholder: string }) {
  const list = useAction(api.sources.posthog.listInsights);
  const [state, setState] = useState<{ s: "idle" } | { s: "loading" } | { s: "ok"; rows: InsightRow[] } | { s: "error"; error: string }>({ s: "idle" });
  const [filter, setFilter] = useState("");
  const load = async () => {
    setState({ s: "loading" });
    try {
      const res = await list({ ...scopeOfSource(source), source: source._id });
      setState({ s: "ok", rows: res?.insights ?? [] });
    } catch (e) {
      setState({ s: "error", error: e instanceof Error ? (e.message.split("Uncaught Error:").pop() ?? e.message).trim().split("\n")[0] : "PostHog did not answer" });
    }
  };
  const rows = state.s === "ok" ? state.rows.filter((r) => !filter.trim() || r.name.toLowerCase().includes(filter.trim().toLowerCase()) || r.short_id.includes(filter.trim())) : [];
  return (
    <div className="mx-picker" data-insight-picker>
      <div className="mx-form-row">
        <input className="mx-input ops-mono" value={query} onChange={(e) => onQuery(e.target.value, "")} placeholder={placeholder} aria-label="Insight id" />
        {state.s !== "ok" && (
          <button type="button" className="ops-btn" onClick={load} disabled={state.s === "loading"} data-insight-load>{state.s === "loading" ? "Loading…" : "Browse"}</button>
        )}
      </div>
      {state.s === "error" && <div className="mx-problem">{state.error}</div>}
      {state.s === "ok" && (
        <>
          <input className="mx-input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${state.rows.length} insights`} aria-label="Filter insights" />
          <div className="mx-insights" role="listbox" aria-label="Insights">
            {rows.slice(0, 60).map((r) => (
              <button key={r.id} type="button" role="option" aria-selected={query === r.short_id} onClick={() => onQuery(r.short_id, r.name)}>
                <span className="mx-name">{r.name}</span>
                {r.kind && <span className="ops-dim">{r.kind}</span>}
                <span className="ops-mono ops-dim">{r.short_id}</span>
              </button>
            ))}
            {rows.length === 0 && <span className="ops-dim text-[12px] px-2 py-1.5">None match</span>}
          </div>
        </>
      )}
    </div>
  );
}
