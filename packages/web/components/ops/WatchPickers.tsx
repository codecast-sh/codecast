// The new watch sheet's query pickers: the volume series codecast counts, the
// HogQL builder, a reader from the app's manifest with typed arguments, and
// a PostHog insight.
import { useMemo, useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { parseAppManifest, type AppReader } from "@codecast/shared/contracts/appConnector";
import { useOpsApp, useOpsGroups, useSyncOpsApp } from "../../hooks/useSyncOps";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { MetricChart } from "./MetricChart";
import { formatValue } from "./metricModel";
import { EVENTS_HOGQL, HOGQL_AGGS, HOGQL_WINDOWS, argFields, argOptions, argSourceReader, eventRows, hogqlOfPick, nameOfPick, readerAnswersNumber, readerQueryText, readerQueryValues, volumeOptions, type ArgField, type ArgOption, type HogqlPick } from "./metricEditing";
import { scopeOfSource } from "./watchQuery";
import type { OpsSource } from "./opsTypes";

const api = _api as any;

/** The series codecast counts for a source, each with its value now and a spark of the past its counters hold. */
export function VolumePicker({ source, query, onQuery }: { source: OpsSource; query: string; onQuery: (query: string, title: string) => void }) {
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
export function HogqlBuilder({ source, onQuery }: { source: OpsSource; onQuery: (query: string, title: string) => void }) {
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
export function InsightPicker({ source, query, onQuery, placeholder }: { source: OpsSource; query: string; onQuery: (query: string, title: string) => void; placeholder: string }) {
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
