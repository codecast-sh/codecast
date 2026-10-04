// `cast metrics` (docs/architecture/external-data.md X7, X10): watched
// numbers. A watch names one number a source answers (a PostHog HogQL query
// or saved insight), a line and a direction; crossing the line is a
// metric_alert transition like any other group's. `query` passes a HogQL
// query through and stores nothing.
//
//   cast metrics ls [--source s] | show mw-N | rm mw-N
//   cast metrics add <name> --source s --hogql "<q>"|--insight <id> --above N|--below N [--every 1h]
//   cast metrics query "<hogql>" --source s
//
// Routes: /cli/metrics/* in http.ts (metrics.ts, sources/posthog.ts).
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, emit, fail, scopedRead, scopedWrite, sparkline } from "./externalDataCli.js";
import { stdinText } from "./sendBody.js";
import { formatDuration, parseDuration } from "@codecast/shared/time";
import type { WatchDirection, WatchKind } from "@codecast/shared/contracts/ingest";

export interface WatchRow {
  _id: string;
  short_id: string;
  name: string;
  query_kind: WatchKind;
  query: string;
  threshold: number;
  direction: WatchDirection;
  interval_ms: number;
  status: "active" | "paused";
  state?: string;
  last_error?: string;
  points: { at: number; value: number }[];
  last_value: number | null;
  last_at: number | null;
  source_name: string | null;
}

export interface MetricAddOptions {
  source?: string;
  hogql?: string;
  insight?: string;
  above?: string;
  below?: string;
  every?: string;
}

/** The wire body for `cast metrics add`, or the one line that says what is wrong. */
export function metricAddBody(name: string, o: MetricAddOptions): Record<string, unknown> {
  if (!o.source?.trim()) throw new Error("cast metrics add needs --source <name>");
  if (!!o.hogql === !!o.insight) throw new Error("Pass exactly one of --hogql \"<query>\" or --insight <id>");
  if ((o.above === undefined) === (o.below === undefined)) throw new Error("Pass exactly one of --above <n> or --below <n>");
  const raw = (o.above ?? o.below)!;
  const threshold = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(threshold)) throw new Error(`"${raw}" is not a number`);
  return {
    source: o.source.trim(),
    name: name.trim(),
    query_kind: o.hogql ? "hogql" : "insight",
    query: (o.hogql ?? o.insight)!.trim(),
    threshold,
    direction: o.above !== undefined ? "above" : "below",
    ...(o.every ? { interval_ms: parseDuration(o.every) } : {}),
  };
}

export function formatWatchLine(w: WatchRow, now: number = Date.now()): string {
  const value = w.last_value === null ? fmt.muted("no value yet") : String(w.last_value);
  const alert = w.state && w.state !== "ok" ? fmt.error(w.state) : "";
  const status = w.status === "paused" ? fmt.warning("paused") : "";
  const line = `${w.direction === "above" ? ">" : "<"} ${w.threshold}`;
  return [fmt.id(w.short_id), w.name, value, fmt.muted(`(alert ${line})`), alert, status, fmt.muted(`${w.source_name ?? "?"} · ${ago(w.last_at, now)}`), sparkline(w.points.map((p) => p.value))].filter(Boolean).join("  ");
}

export function formatWatchList(rows: WatchRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No metric watches. Add one: cast metrics add <name> --source <posthog source> --hogql \"<query>\" --above <n>";
  return rows.map((w) => formatWatchLine(w, now)).join("\n");
}

/** A passthrough answer as tab-separated rows under its column names. */
export function formatQueryResult(res: { columns: unknown[]; results: unknown[]; rows: number; truncated: boolean }): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const lines = [res.columns.map(cell).join("\t")];
  for (const row of res.results) lines.push((Array.isArray(row) ? row : [row]).map(cell).join("\t"));
  if (res.truncated) lines.push(fmt.muted(`(cut at ${res.results.length} of ${res.rows} rows)`));
  return lines.join("\n");
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
    .description("Watch a number: crossing the line is a metric_alert, coming back a metric_recovered")
    .argument("<name>", "What the number is")
    .option("--source <name>", "The source that answers it (PostHog)")
    .option("--hogql <query>", stdinText("A HogQL query whose first cell is the number"))
    .option("--insight <id>", "A saved insight id")
    .option("--above <n>", "Alert when the value goes above this")
    .option("--below <n>", "Alert when the value goes below this")
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
      const res = await apiPost(deps, "/cli/metrics/get", { watch: ref }, { read: true });
      emit(o.json, res, () => {
        const w: WatchRow = res.watch;
        const lines = [formatWatchLine(w), fmt.muted(`  ${w.query_kind}: ${w.query}`), fmt.muted(`  every ${formatDuration(w.interval_ms)}`)];
        if (w.last_error) lines.push(fmt.error(`  ${w.last_error}`));
        if (res.group) lines.push(fmt.muted(`  group ${res.group.short_id} ${res.group.status}${res.group.last_transition ? `, last ${res.group.last_transition} ${ago(res.group.last_transition_at)}` : ""}`));
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
      const res = await apiPost(deps, "/cli/metrics/remove", { watch: ref });
      emit(o.json, res, () => `${fmt.success("removed")} ${res.removed}`);
    });

  metrics
    .command("query")
    .description("Run a HogQL query against a PostHog source and print the rows; nothing is stored")
    .argument("<hogql>", stdinText("The query"))
    .option("--source <name>", "The PostHog source")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (hogql: string, o: { source?: string; team?: string; json?: boolean }) => {
      if (!o.source?.trim()) fail("cast metrics query needs --source <posthog source>");
      const res = await scopedRead(deps, "/cli/metrics/query", { source: o.source, query: hogql }, o.team);
      emit(o.json, res, () => formatQueryResult(res));
    });
}
