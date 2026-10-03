// `cast replay` (docs/architecture/external-data.md X5, X10): a recording of
// what a person did before something broke, read as text and turned into a
// repro.
//
//   cast replay ls [--source s] [--group eg-N]
//   cast replay show rp-N | <recording id> --source <posthog source>
//   cast replay repro rp-N [--base-url https://app] [--out repro.spec.ts]
//
// Routes: /cli/replays/* in http.ts. `show` prints the cached timeline; a
// PostHog or Sentry recording is imported the first time it is read
// (sources/vendorReplay.ts), and a timeline not
// assembled yet is rendered here from the chunks. `repro` always reads the
// chunks: the events are the source, the timeline is only their summary.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, emit, fail, scopedRead } from "./externalDataCli.js";
import { fenceProductText } from "@codecast/shared/contracts";
import { INGEST_SHORT_ID_PREFIX } from "@codecast/shared/contracts/ingest";
import { needsVendorImport, type ReplayEvent } from "@codecast/shared/contracts/replay";
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
