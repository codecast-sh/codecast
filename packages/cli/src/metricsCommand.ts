// `cast metrics` (docs/architecture/external-data.md X7, X10): watched
// numbers. A watch names one number a source answers (a PostHog HogQL query
// or saved insight, or an app's metric reader), and optionally a line and a
// direction; crossing the line is a metric_alert transition like any other
// group's. A watch with no line is a plain series, the live number a goal or
// project reads (`cast initiative set --metric "Name=target@mw-N"`). `query`
// passes a HogQL query through and stores nothing.
//
//   cast metrics ls [--source s] | show mw-N | rm mw-N
//   cast metrics backfill [mw-N] [--source s] [--days 30]
//   cast metrics add <name> --source s --hogql "<q>"|--insight <id>|--reader <name> [--args '{}'] [--above N|--below N] [--unit $] [--every 1h]
//   cast metrics query "<hogql>" --source s
//
// Routes: /cli/metrics/* in http.ts (metrics.ts, sources/posthog.ts).
import type { Command } from "commander";
import type { PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, emit, fail, postOrFail, scopedRead, scopedWrite, shortRef, sparkline } from "./externalDataCli.js";
import { stdinText } from "./sendBody.js";
import { formatDuration, parseDuration } from "@codecast/shared/time";
import type { WatchDirection, WatchKind } from "@codecast/shared/contracts/ingest";
import { formatSeriesValue } from "@codecast/shared/contracts/initiative";

export interface WatchRow {
  _id: string;
  short_id: string;
  name: string;
  query_kind: WatchKind;
  query: string;
  threshold?: number;
  direction: WatchDirection;
  unit?: string;
  interval_ms: number;
  status: "active" | "paused";
  state?: string;
  last_error?: string;
  history?: { at: number; added: number; note?: string; reading?: boolean };
  points: { at: number; value: number }[];
  source_points?: { at: number; value: number }[];
  version?: string;
  version_at?: number;
  version_since?: number;
  version_note?: string;
  point_removals?: { at: number; value: number; reason?: string; removed_at: number }[];
  last_value: number | null;
  last_at: number | null;
  source_name: string | null;
}

export interface MetricAddOptions {
  source?: string;
  hogql?: string;
  insight?: string;
  reader?: string;
  args?: string;
  above?: string;
  below?: string;
  unit?: string;
  every?: string;
}

/** The wire body for `cast metrics add`, or the one line that says what is wrong. */
export function metricAddBody(name: string, o: MetricAddOptions): Record<string, unknown> {
  if (!o.source?.trim()) throw new Error("cast metrics add needs --source <name>: a posthog or app source from cast sources ls");
  if ([o.hogql, o.insight, o.reader].filter(Boolean).length !== 1) throw new Error("Pass exactly one of --hogql \"<query>\", --insight <id> or --reader <name>");
  if (o.args && !o.reader) throw new Error("--args goes with --reader");
  if (o.above !== undefined && o.below !== undefined) throw new Error("Pass at most one of --above <n> or --below <n>");
  const raw = o.above ?? o.below;
  const threshold = raw === undefined ? undefined : Number(raw);
  if (raw !== undefined && (raw.trim() === "" || !Number.isFinite(threshold))) throw new Error(`"${raw}" is not a number`);
  if (o.args) {
    try {
      const parsed = JSON.parse(o.args);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    } catch {
      throw new Error("--args is a JSON object, like '{\"key\":\"dollars_per_intro\"}'");
    }
  }
  const query = o.reader ? `${o.reader.trim()}${o.args ? ` ${o.args.trim()}` : ""}` : (o.hogql ?? o.insight)!.trim();
  return {
    source: o.source.trim(),
    name: name.trim(),
    query_kind: o.reader ? "reader" : o.hogql ? "hogql" : "insight",
    query,
    ...(threshold !== undefined ? { threshold, direction: o.above !== undefined ? "above" : "below" } : {}),
    ...(o.unit?.trim() ? { unit: o.unit.trim() } : {}),
    ...(o.every ? { interval_ms: parseDuration(o.every) } : {}),
  };
}

export function formatWatchLine(w: WatchRow, now: number = Date.now()): string {
  const value = w.last_value === null ? fmt.muted("no value yet") : formatSeriesValue(w.last_value, w.unit);
  const alert = w.state && w.state !== "ok" ? fmt.error(w.state) : "";
  const status = w.status === "paused" ? fmt.warning("paused") : "";
  const line = w.threshold === undefined || w.threshold === null ? fmt.muted("(series)") : fmt.muted(`(alert ${w.direction === "above" ? ">" : "<"} ${w.threshold})`);
  return [fmt.id(w.short_id), w.name, value, line, alert, status, fmt.muted(`${w.source_name ?? "?"} · ${ago(w.last_at, now)}`), sparkline(w.points.map((p) => p.value))].filter(Boolean).join("  ");
}

export function formatWatchList(rows: WatchRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No metric watches. Add one: cast metrics add <name> --source <posthog source> --hogql \"<query>\" --above <n>";
  return rows.map((w) => formatWatchLine(w, now)).join("\n");
}

/** Where a watch's history stands: read, reading, or why there is none. Null before the first read. */
export function formatHistoryLine(w: Pick<WatchRow, "history">, now: number = Date.now()): string | null {
  const h = w.history;
  if (!h) return null;
  if (h.reading) return "history: reading from the source";
  if (h.added === 0 && h.note) return `history: none (${h.note})`;
  const read = `history: ${h.added} past value${h.added === 1 ? "" : "s"} read ${ago(h.at, now)}`;
  return h.note ? `${read} (${h.note})` : read;
}

/** What `cast metrics backfill` started, and the watches it could not. */
export function formatHistoryStart(res: { scheduled: string[]; skipped: { watch: string; reason: string }[] }): string {
  const lines: string[] = [];
  if (res.scheduled.length) lines.push(`${fmt.success("reading")} ${res.scheduled.join(", ")}: their past values land in a few seconds (cast metrics ls)`);
  for (const s of res.skipped) lines.push(`${fmt.muted("skipped")} ${s.watch}: ${s.reason}`);
  return lines.length ? lines.join("\n") : "No metric watches to read.";
}

/** A passthrough answer as tab-separated rows under its column names. */
export function formatQueryResult(res: { columns: unknown[]; results: unknown[]; rows: number; truncated: boolean }): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const lines = [res.columns.map(cell).join("\t")];
  for (const row of res.results) lines.push((Array.isArray(row) ? row : [row]).map(cell).join("\t"));
  if (res.truncated) lines.push(fmt.muted(`(cut at ${res.results.length} of ${res.rows} rows)`));
  return lines.join("\n");
}

/**
 * A point's time as a person types it: an ISO time read as UTC unless it
 * names a zone, covering the minute it names when it names no seconds, the
 * second when it names no fraction. A bare day is too wide to remove by.
 */
export function parsePointTime(text: string): { from: number; to: number } | { error: string } {
  const t = text.trim();
  const m = t.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return { error: `--at takes an ISO time to the minute or finer, like 2026-11-11T12:31 (UTC unless it names a zone), not "${text}"` };
  const at = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ":00"}${m[5] ?? "Z"}`);
  if (!Number.isFinite(at)) return { error: `"${text}" is not a time` };
  const width = !m[3] ? 60_000 : !m[4] ? 1_000 : 1;
  return { from: at, to: at + width - 1 };
}

/** What a removal answered: each value removed, at its time. */
export function formatPointRemoval(res: { watch: string; removed: Array<{ at: number; value: number }> }): string {
  return [`${fmt.success("removed")} ${res.removed.length} value${res.removed.length === 1 ? "" : "s"} from ${res.watch}`, ...res.removed.map((p) => fmt.muted(`  ${new Date(p.at).toISOString()} ${p.value}`))].join("\n");
}

export function registerMetricsCommand(program: Command, deps: PublishDeps): void {
  const metrics = program.command("metrics").description(commandGroup("metrics").description);

  metrics
    .command("ls")
    .alias("list")
    .description("Watched metrics with their latest value")
    .option("--source <name>", "Only this source's watches")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (o: { source?: string; team?: string; json?: boolean }) => {
      const rows: WatchRow[] = await scopedRead(deps, "/cli/metrics/list", { source: o.source }, o.team);
      emit(o.json, rows, () => formatWatchList(rows));
    });

  metrics
    .command("add")
    .alias("watch")
    .description("Watch a number: crossing its line is a metric_alert, coming back a metric_recovered; with no line it is a series a goal can read")
    .argument("<name>", "What the number is")
    .option("--source <name>", "The source that answers it: a posthog or app source's name from cast sources ls")
    .option("--hogql <query>", stdinText("A HogQL query whose first cell is the number"))
    .option("--insight <id>", "A saved insight id")
    .option("--reader <name>", "An app's metric reader, answering { value, unit?, points? }")
    .option("--args <json>", "With --reader: the args it takes, as a JSON object")
    .option("--above <n>", "Alert when the value goes above this")
    .option("--below <n>", "Alert when the value goes below this")
    .option("--unit <unit>", "How a value reads: $ leads it, anything else (%, /day) follows it")
    .option("--every <duration>", "How often to look (default 1h)")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (name: string, o: MetricAddOptions & { team?: string; json?: boolean }) => {
      let body: Record<string, unknown>;
      try {
        body = metricAddBody(name, o);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const res = await scopedWrite(deps, "/cli/metrics/create", body, o.team);
      emit(o.json, res, () => formatWatchLine(res.watch));
    });

  metrics
    .command("show")
    .description("One watch: its query, its last values, and the group its alerts land in")
    .argument("<watch>", "mw-N")
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { json?: boolean }) => {
      const res = await postOrFail(deps, "/cli/metrics/get", { watch: shortRef("mw", ref) }, { read: true });
      emit(o.json, res, () => {
        const w: WatchRow = res.watch;
        const lines = [formatWatchLine(w), fmt.muted(`  ${w.query_kind}: ${w.query}`), fmt.muted(`  every ${formatDuration(w.interval_ms)}`)];
        if (w.last_error) lines.push(fmt.error(`  ${w.last_error}`));
        const history = formatHistoryLine(w);
        if (history) lines.push(fmt.muted(`  ${history}`));
        if (res.group) lines.push(fmt.muted(`  group ${res.group.short_id} ${res.group.status}${res.group.last_transition ? `, last ${res.group.last_transition} ${ago(res.group.last_transition_at)}` : ""}`));
        if (w.version) lines.push(fmt.muted(`  definition ${w.version}, values read from ${new Date(w.version_since ?? w.version_at ?? 0).toISOString().slice(0, 16)}Z${w.version_note ? `: ${w.version_note}` : ""}; older values are kept and left out`));
        if (w.source_points?.length) lines.push(fmt.muted(`  ${w.source_points.length} periods dated by the source, newest ${new Date(w.source_points[w.source_points.length - 1]!.at).toISOString().slice(0, 10)}`));
        for (const r of (w.point_removals ?? []).slice(-3)) lines.push(fmt.muted(`  removed ${new Date(r.at).toISOString()} ${r.value}${r.reason ? `: ${r.reason}` : ""} (${ago(r.removed_at)})`));
        return lines.join("\n");
      });
    });

  metrics
    .command("rm")
    .alias("remove")
    .description("Stop watching; the group and its history stay")
    .argument("<watch>", "mw-N")
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { json?: boolean }) => {
      const res = await postOrFail(deps, "/cli/metrics/remove", { watch: shortRef("mw", ref) });
      emit(o.json, res, () => `${fmt.success("removed")} ${res.removed}`);
    });

  const points = metrics.command("points").description("A watch's stored values");
  points
    .command("rm")
    .alias("remove")
    .description("Remove a watch's stored value at one time (a stale or wrong read), from its history, its chart and every window that reads it; logged on the watch. Its creator or a team admin only")
    .argument("<watch>", "mw-N")
    .requiredOption("--at <time>", "When it was read: an ISO time to the minute or finer, UTC unless it names a zone (2026-11-11T12:31)")
    .option("--reason <text>", "Why it goes, kept in the watch's log")
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { at: string; reason?: string; json?: boolean }) => {
      const span = parsePointTime(o.at);
      if ("error" in span) fail(span.error);
      const { from, to } = span as { from: number; to: number };
      const res = await postOrFail(deps, "/cli/metrics/points-rm", { watch: shortRef("mw", ref), at: from, to, ...(o.reason ? { reason: o.reason } : {}) });
      emit(o.json, res, () => formatPointRemoval(res));
    });

  metrics
    .command("redefine")
    .description("Declare that the watch's values read before a time were under an older definition: they stay stored, and windows, bands and the chart leave them out. For a source that sends no version of its own. Its creator or a team admin only")
    .argument("<watch>", "mw-N")
    .requiredOption("--since <time>", "When the current definition began: an ISO time, UTC unless it names a zone (2026-11-13T00:00)")
    .option("--name <version>", "What to call the definition (default: since <time>)")
    .option("--reason <text>", "Why, shown on the watch")
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { since: string; name?: string; reason?: string; json?: boolean }) => {
      const span = parsePointTime(o.since);
      if ("error" in span) fail(span.error.replace("--at", "--since"));
      const res = await postOrFail(deps, "/cli/metrics/redefine", { watch: shortRef("mw", ref), since: (span as { from: number }).from, ...(o.name ? { name: o.name } : {}), ...(o.reason ? { reason: o.reason } : {}) });
      emit(o.json, res, () => `${fmt.success("redefined")} ${res.watch} as ${res.version}: values read before ${new Date(res.since).toISOString().slice(0, 16)}Z are left out of windows, bands and the chart (kept, not deleted)`);
    });

  metrics
    .command("backfill")
    .description("Fill a watch's chart with its past values now, instead of one per poll: an insight's own series, or a HogQL query read again with now() bound to past instants (one per day for a window of a day or more, else one per interval). Past values never alert.")
    .argument("[watch]", "mw-N; default every watch in the workspace")
    .option("--source <name>", "Only this source's watches")
    .option("--days <n>", "How far back to read (default 30)")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string | undefined, o: { source?: string; days?: string; team?: string; json?: boolean }) => {
      const days = o.days === undefined ? undefined : Number(o.days);
      if (days !== undefined && !(days > 0)) fail("--days takes a positive number of days, like --days 30");
      const res = await scopedWrite(deps, "/cli/metrics/backfill", { ...(ref ? { watch: shortRef("mw", ref) } : {}), ...(o.source ? { source: o.source } : {}), ...(days !== undefined ? { days } : {}) }, o.team);
      emit(o.json, res, () => formatHistoryStart(res));
    });

  metrics
    .command("query")
    .description("Run a HogQL query against a PostHog source and print the rows; nothing is stored")
    .argument("<hogql>", stdinText("The query"))
    .option("--source <name>", "The posthog source's name, from cast sources ls")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (hogql: string, o: { source?: string; team?: string; json?: boolean }) => {
      if (!o.source?.trim()) fail("cast metrics query needs --source <name>: a posthog source from cast sources ls");
      const res = await scopedRead(deps, "/cli/metrics/query", { source: o.source, query: hogql }, o.team);
      emit(o.json, res, () => formatQueryResult(res));
    });
}
