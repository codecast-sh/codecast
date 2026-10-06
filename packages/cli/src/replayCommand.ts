// `cast replay` (docs/architecture/external-data.md X5, X10): a recording of
// what a person did before something broke, read as text and turned into a
// repro.
//
//   cast replay ls [--source s] [--group eg-N]
//   cast replay show rp-N | <recording id> --source <posthog source>
//   cast replay repro rp-N [--base-url https://app] [--out repro.spec.ts]
//   cast replay import --source <posthog|sentry source> [--since 30d] [--status | --stop]
//
// Routes: /cli/replays/* in http.ts. `show` prints the cached timeline; a
// PostHog or Sentry recording is imported the first time it is read
// (sources/vendorReplay.ts), and a timeline not
// assembled yet is rendered here from the chunks. `repro` always reads the
// chunks: the events are the source, the timeline is only their summary.
// `import` pulls every recording a vendor source still keeps, one page per
// scheduled action on the server (convex sources/replayBackfill.ts); this
// command starts it and follows the progress the source row carries.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, emit, fail, scopedRead, scopedWrite } from "./externalDataCli.js";
import { fenceProductText } from "@codecast/shared/contracts";
import { INGEST_SHORT_ID_PREFIX } from "@codecast/shared/contracts/ingest";
import { REPLAY_BACKFILL_WINDOWS, isReplayBackfillWindow, needsVendorImport, replayBackfillLine, replayBackfillState, type ReplayBackfill, type ReplayEvent } from "@codecast/shared/contracts/replay";
import { parseReplayEvents, renderTimeline, sortReplayEvents, toRepro } from "@codecast/shared/replay";

export interface ReplayRow {
  _id: string;
  short_id: string;
  source_id: string;
  source_name: string | null;
  provider: string;
  external_id: string;
  url: string | null;
  user: { id?: string; email?: string; name?: string } | null;
  started_at: number;
  duration_ms: number | null;
  counts: { clicks?: number; errors?: number; failed_requests?: number };
  has_timeline?: boolean;
  imported_at: number | null;
}

export interface ReplayDetail extends ReplayRow {
  groups: { short_id: string; kind: string; title: string; status: string }[];
  timeline_md: string | null;
  chunk_urls: string[];
}

export interface RecordingRow {
  id: string;
  started_at: number | null;
  duration_ms: number | null;
  url: string | null;
  email: string | null;
  distinct_id: string | null;
  errors: number | null;
  replay: string | null;
  imported: boolean;
}

const isReplayShortId = (ref: string) => ref.startsWith(`${INGEST_SHORT_ID_PREFIX.replay}-`);

function seconds(ms: number | null | undefined): string {
  return ms ? `${Math.round(ms / 1000)}s` : "?";
}

export function formatReplayLine(r: ReplayRow, now: number = Date.now()): string {
  const c = r.counts ?? {};
  const counts = [`${c.clicks ?? 0} clicks`, c.errors ? fmt.error(`${c.errors} errors`) : "", c.failed_requests ? fmt.warning(`${c.failed_requests} failed requests`) : ""].filter(Boolean).join(", ");
  const who = r.user?.email ?? r.user?.id ?? "";
  return [fmt.id(r.short_id), fmt.muted(ago(r.started_at, now)), seconds(r.duration_ms), r.source_name ?? r.provider, r.url ?? "", who, counts].filter(Boolean).join("  ");
}

export function formatReplayList(rows: ReplayRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No replays.";
  return rows.map((r) => formatReplayLine(r, now)).join("\n");
}

export function formatRecordingList(rows: RecordingRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No recordings.";
  return rows
    .map((r) => [r.replay ? fmt.id(r.replay) : fmt.muted("(not imported)"), r.id, r.started_at ? fmt.muted(ago(r.started_at, now)) : "", seconds(r.duration_ms), r.url ?? "", r.email ?? r.distinct_id ?? "", r.errors ? fmt.error(`${r.errors} errors`) : ""].filter(Boolean).join("  "))
    .join("\n");
}

/** One chunk's bytes as events: gzipped JSON (what the SDK and an import upload), or plain JSON. */
export function decodeChunk(bytes: Uint8Array): ReplayEvent[] {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return parseReplayEvents(JSON.parse(Buffer.from(raw).toString("utf8")));
}

/** Every event of a replay, read from its signed chunk URLs, in time order. */
export async function readReplayEvents(urls: string[], fetchImpl: typeof fetch = fetch): Promise<ReplayEvent[]> {
  const events: ReplayEvent[] = [];
  for (const url of urls) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`A chunk answered ${res.status}`);
    events.push(...decodeChunk(new Uint8Array(await res.arrayBuffer())));
  }
  return sortReplayEvents(events);
}

/** The origin a repro runs against: --base-url, else where the recording started. */
export function reproBaseUrl(explicit: string | undefined, recordedUrl: string | null): string {
  if (explicit?.trim()) return explicit.trim().replace(/\/+$/, "");
  if (recordedUrl) {
    try {
      return new URL(recordedUrl).origin;
    } catch {}
  }
  throw new Error("The replay recorded no URL: pass --base-url https://your.app");
}

export function formatReplayDetail(d: ReplayDetail, timeline: string | null, now: number = Date.now()): string {
  const lines = [formatReplayLine(d, now)];
  if (d.groups.length) lines.push(fmt.muted(`  groups: ${d.groups.map((g) => `${g.short_id} ${g.title}`).join("; ")}`));
  // The timeline is the product's page outline, console lines and click
  // labels: fenced under the untrusted-data line like every product text.
  lines.push("", timeline ? fenceProductText(timeline, `replay ${d.short_id}`) : fmt.muted("No events in this replay yet."));
  return lines.join("\n");
}

/** A source's import as `cast replay import --status` prints it. */
export function formatReplayImport(source: { name: string; replay_backfill?: ReplayBackfill }, now: number = Date.now()): string {
  const b = source.replay_backfill;
  if (!b) return `${source.name}: no import yet. Recordings come over when opened; cast replay import --source ${source.name} brings them all.`;
  return `${source.name}: ${replayBackfillLine(b, now)}`;
}

/**
 * Prints the import's line whenever it changes, until it is no longer running.
 * The import runs on the server either way; leaving this only stops watching.
 */
export async function followReplayImport(
  read: () => Promise<{ name: string; replay_backfill?: ReplayBackfill }>,
  print: (line: string) => void,
  opts: { interval_ms?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<ReplayBackfill | undefined> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let last = "";
  for (;;) {
    const source = await read();
    const line = formatReplayImport(source, now());
    if (line !== last) print(line);
    last = line;
    const b = source.replay_backfill;
    if (!b || replayBackfillState(b, now()) !== "running") return b;
    await sleep(opts.interval_ms ?? 5_000);
  }
}

export function registerReplayCommand(program: Command, deps: PublishDeps): void {
  const replay = program.command("replay").description(commandGroup("replay").description);

  /** The replay's detail, importing a PostHog or Sentry recording the first time it is read. */
  const detailFor = async (ref: string, source: string | undefined, team: string | undefined): Promise<ReplayDetail> => {
    let id = ref.trim();
    if (source && !isReplayShortId(id)) {
      const imported = await scopedRead(deps, "/cli/replays/import", { source, recording: id }, team);
      id = imported.short_id;
    }
    let detail: ReplayDetail = await apiPost(deps, "/cli/replays/get", { replay: id }, { read: true });
    if (needsVendorImport(detail)) {
      await apiPost(deps, "/cli/replays/import-linked", { replay: detail.short_id }, { read: true });
      detail = await apiPost(deps, "/cli/replays/get", { replay: detail.short_id }, { read: true });
    }
    return detail;
  };

  replay
    .command("ls")
    .alias("list")
    .description("Recordings, newest first; a PostHog source lists its recordings from PostHog")
    .option("--source <name>", "Only this source")
    .option("--group <eg>", "Only the recordings linked to this group")
    .option("-n, --limit <n>", "How many", (v: string) => parseInt(v, 10))
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (o: { source?: string; group?: string; limit?: number; team?: string; json?: boolean }) => {
      if (o.source) {
        const source = await scopedRead(deps, "/cli/sources/get", { source: o.source }, o.team);
        if (source.provider === "posthog") {
          const res = await scopedRead(deps, "/cli/replays/recordings", { source: o.source, limit: o.limit }, o.team);
          emit(o.json, res.recordings, () => formatRecordingList(res.recordings));
          return;
        }
      }
      let groupId: string | undefined;
      if (o.group) groupId = (await apiPost(deps, "/cli/events/group", { group: o.group }, { read: true })).group._id;
      const res = await scopedRead(deps, "/cli/replays/list", { source: o.source, limit: o.limit, ...(groupId ? { group_id: groupId } : {}) }, o.team);
      emit(o.json, res.replays, () => formatReplayList(res.replays));
    });

  replay
    .command("show")
    .description("The replay as a text timeline: navigation, clicks, typed fields (never values), errors, failed requests")
    .argument("<replay>", "rp-N, or a PostHog recording id with --source")
    .option("--source <name>", "The PostHog source a recording id belongs to (imports it the first time)")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { source?: string; team?: string; json?: boolean }) => {
      const detail = await detailFor(ref, o.source, o.team);
      // An SDK replay whose timeline is not assembled yet still reads: render it here.
      const timeline = detail.timeline_md ?? (detail.chunk_urls.length ? renderTimeline(await readReplayEvents(detail.chunk_urls)) : null);
      const { chunk_urls: _urls, ...shown } = detail;
      emit(o.json, { ...shown, timeline_md: timeline }, () => formatReplayDetail(detail, timeline));
    });

  replay
    .command("import")
    .description("Import every recording a PostHog or Sentry source still keeps, in the background; a stopped import continues where it was")
    .requiredOption("--source <name>", "The PostHog or Sentry source")
    .option("--since <window>", `How far back: ${REPLAY_BACKFILL_WINDOWS.join(", ")} (default 30d, or the stopped import's)`)
    .option("--restart", "Start over instead of continuing a stopped import")
    .option("--status", "Show where the import stands and change nothing")
    .option("--stop", "Stop it; the next import continues from there")
    .option("--detach", "Start it and return without following the progress")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (o: { source: string; since?: string; restart?: boolean; status?: boolean; stop?: boolean; detach?: boolean; team?: string; json?: boolean }) => {
      if (o.since !== undefined && !isReplayBackfillWindow(o.since)) fail(`--since takes ${REPLAY_BACKFILL_WINDOWS.join(", ")}`);
      const read = async () => scopedRead(deps, "/cli/sources/get", { source: o.source }, o.team);
      if (o.status) {
        const source = await read();
        emit(o.json, source.replay_backfill ?? null, () => formatReplayImport(source));
        return;
      }
      if (o.stop) {
        const res = await scopedWrite(deps, "/cli/replays/backfill-stop", { source: o.source }, o.team);
        emit(o.json, res.source.replay_backfill ?? null, () => formatReplayImport(res.source));
        return;
      }
      const res = await scopedWrite(deps, "/cli/replays/backfill", { source: o.source, ...(o.since ? { window: o.since } : {}), ...(o.restart ? { restart: true } : {}) }, o.team);
      if (o.json) {
        emit(true, { started: res.started, resumed: !!res.resumed, ...res.source.replay_backfill }, () => "");
        return;
      }
      console.log(fmt.muted(res.started ? (res.resumed ? "Continuing the stopped import." : "Import started.") : "An import is already running."));
      if (o.detach) {
        console.log(formatReplayImport(res.source));
        console.log(fmt.muted(`It runs on the server; cast replay import --source ${o.source} --status shows where it is.`));
        return;
      }
      console.log(fmt.muted("It runs on the server: leaving this (Ctrl-C) only stops watching."));
      await followReplayImport(read, (line) => console.log(line));
    });

  replay
    .command("repro")
    .description("Write a Playwright test that replays the steps up to the failure and asserts it does not happen")
    .argument("<replay>", "rp-N, or a PostHog recording id with --source")
    .option("--source <name>", "The PostHog source a recording id belongs to")
    .option("--base-url <url>", "Origin the test runs against (default: where the recording started)")
    .option("--out <file>", "Where to write it (default: repro-<rp-N>.spec.ts)")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { source?: string; baseUrl?: string; out?: string; team?: string; json?: boolean }) => {
      const detail = await detailFor(ref, o.source, o.team);
      if (!detail.chunk_urls.length) fail(`${detail.short_id} has no events stored yet`);
      let baseUrl: string;
      try {
        baseUrl = reproBaseUrl(o.baseUrl, detail.url);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const events = await readReplayEvents(detail.chunk_urls);
      const file = path.resolve(process.env.CODECAST_CWD || process.cwd(), o.out ?? `repro-${detail.short_id}.spec.ts`);
      fs.writeFileSync(file, toRepro(events, { baseUrl }));
      emit(o.json, { replay: detail.short_id, file, events: events.length, base_url: baseUrl }, () => `${fmt.success("wrote")} ${file} ${fmt.muted(`(${events.length} events against ${baseUrl}; run with npx playwright test)`)}`);
    });
}
