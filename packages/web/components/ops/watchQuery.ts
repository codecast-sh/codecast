// A watch's query and source as data: the scope a source's reads run under,
// the kinds of watch it hosts, one read of a query (the new-watch preview and
// the query editor), and what deleting a watch does.
import { useRef, useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { readMetricAnswer, parseReaderQuery, WATCH_KINDS_BY_PROVIDER, type WatchKind } from "@codecast/shared/contracts/ingest";
import { useOpsGroups } from "../../hooks/useSyncOps";
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";
import { hogqlFirstCell, spanLabel, volumePreview, type Pt } from "./metricModel";
import type { OpsSource, OpsWatch } from "./opsTypes";

const api = _api as any;

/** The scope args a source's own workspace key names, for the reads the CLI makes as its caller. */
export function scopeOfSource(source: Pick<OpsSource, "workspace">): { workspace: "team"; team_id: string } | { workspace: "personal" } {
  return source.workspace?.startsWith("team:") ? { workspace: "team", team_id: source.workspace.slice(5) } : { workspace: "personal" };
}

/** Whether a source can host watches, and which kinds. */
export function watchKindsOf(provider: OpsSource["provider"] | undefined): readonly WatchKind[] {
  return (provider && WATCH_KINDS_BY_PROVIDER[provider]) || [];
}

/** One read of a query. A value carries `at`, when it was read: the newest point a preview draws. */
export type QueryRun = { state: "idle" } | { state: "reading" } | { state: "value"; value: number; unit: string | null; points: Pt[]; at?: number } | { state: "error"; error: string };

/** Read a query once through the source (HogQL now, or a reader with its own series), as a new watch's preview and the query editor do. */
export function useQueryRun(source: OpsSource | undefined) {
  const runHogql = useAction(api.sources.posthog.query);
  const runReader = useAction(api.sources.app.read);
  const [run, setRun_] = useState<QueryRun>({ state: "idle" });
  const groups = useOpsGroups();
  // Only the newest read lands: an older answer arriving late never replaces it.
  const seq = useRef(0);
  const read = async (kind: WatchKind, query: string): Promise<QueryRun> => {
    let out: QueryRun = { state: "idle" };
    const mine = ++seq.current;
    const setRun = (r: QueryRun) => {
      out = r.state === "value" && r.at === undefined ? { ...r, at: Date.now() } : r;
      if (mine === seq.current) setRun_(out);
    };
    if (!source) return out;
    if (kind === "volume") {
      // Codecast's own counters, already on this device: the answer the poll will read.
      const v = volumePreview(query, source, groups.filter((g) => g.source_id === source._id), Date.now());
      setRun(v ? { state: "value", value: v.value, unit: v.unit, points: v.points } : { state: "error", error: "Pick a series" });
      return out;
    }
    setRun({ state: "reading" });
    try {
      if (kind === "hogql") {
        const v = hogqlFirstCell(await runHogql({ ...scopeOfSource(source), source: source._id, query }));
        setRun(v === null ? { state: "error", error: "No number in the first cell" } : { state: "value", value: v, unit: null, points: [] });
        return out;
      }
      const parsed = parseReaderQuery(query);
      if ("error" in parsed) {
        setRun({ state: "error", error: parsed.error });
        return out;
      }
      const res = await runReader({ ...scopeOfSource(source), source: source._id, reader: parsed.reader, args_json: JSON.stringify(parsed.args) });
      if (!res?.ok) {
        setRun({ state: "error", error: `${parsed.reader}: ${res?.error ?? "did not answer"}` });
        return out;
      }
      let body: unknown = null;
      try { body = JSON.parse(res.text ?? "null"); } catch { body = null; }
      const answer = readMetricAnswer(body);
      setRun(answer.value === null ? { state: "error", error: `${parsed.reader} answered no value` } : { state: "value", value: answer.value, unit: answer.unit, points: answer.points });
    } catch (e) {
      setRun({ state: "error", error: e instanceof Error ? (e.message.split("Uncaught Error:").pop() ?? e.message).trim().split("\n")[0] : "The read failed" });
    }
    return out;
  };
  return { run, read, reset: () => { seq.current++; setRun_({ state: "idle" }); } };
}

/** What deleting a watch does, as the confirm review shows it. */
export function removeWatchLedger(watch: OpsWatch, issue: string | null): SwitchLedger {
  return {
    name: "Delete watch",
    subject: `${watch.name} · ${watch.short_id}`,
    shift: null,
    figures: [{ value: watch.last_at ? spanLabel(Date.now() - Math.min(...watch.points.map((p) => p.at))) + "+" : "0", label: "of history, deleted" }],
    rows: [
      { k: "Polling", v: "Stops now" },
      { k: "History", v: "Every stored value goes", tone: "warn" },
      { k: "Issue", v: issue ? `${issue} stays, closes no more` : "None filed" },
      { k: "Timeline", v: "Past transitions stay" },
      { k: "Undo", v: "None: add it again", tone: "warn" },
    ],
    confirm: "Delete watch",
    keep: "Keep it",
  };
}
