// `cast replay` (docs/architecture/external-data.md X5, X10): a recording of
// what a person did before something broke, read as text and turned into a
// repro.
//
//   cast replay ls [--url /book/intro] [--user a@b.c] [--since 30d] [--until 2026-11-01] [--errors] [--min-active 5] [--source s] [--group eg-N] [--live]
//   cast replay show rp-N | <PostHog session id or Sentry replay id> [--at 1:23]
//   cast replay snap rp-N@1:23 | rp-N@1:00-2:30 [--every 10s] [--out file.png]
//   cast replay repro rp-N [--base-url https://app] [--out repro.spec.ts]
//   cast replay import --source <posthog|sentry source> [--since 30d] [--status | --stop]
//
// `ls` reads the imported store page by page (/cli/replays/search) until every
// recording in scope has been looked at, so its count of matches is exact;
// only --live asks the vendor, for recordings the store does not hold yet.
// A vendor's own recording id stands for its replay in show, snap and repro
// (/cli/replays/resolve), imported on first use if the store lacks it.
//
// Routes: /cli/replays/* in http.ts. `show` prints the cached timeline; a
// PostHog or Sentry recording is imported the first time it is read
// (sources/vendorReplay.ts), and a timeline not
// assembled yet is rendered here from the chunks. `repro` always reads the
// chunks: the events are the source, the timeline is only their summary.
// `import` pulls every recording a vendor source still keeps, one page per
// scheduled action on the server (convex sources/replayBackfill.ts); this
// command starts it and follows the progress the source row carries.
//
// `snap` is what the page looked like at a moment, for an agent to Read, the
// way `cast call snap` is for a call (contracts/replayPlayer.ts). The frame
// is rendered server side: Convex mints a capability for the replay
// (/cli/replays/player-link) and the replay player worker draws the page in
// Cloudflare's browser (POST <frame_url>), so a cloud host sees exactly what
// a laptop sees and no local browser is involved. The PNG lands in the CLI's
// owner-only scratch directory and is remembered (callFrameRefs) so it syncs
// as `Frame of the replay: rp-N@m:ss`, never as the picture. Beside it the
// command prints the moment as text: the page's address, its visible text,
// what the person did just before, and the console and network around it
// (shared/replay/moment.ts). A replay with no page capture prints that text
// alone. `show --at` prints the same text with no frame.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, emit, fail, postOrFail, scopedRead, scopedWrite, shortRef } from "./externalDataCli.js";
import { fenceProductText } from "@codecast/shared/contracts";
import { INGEST_SHORT_ID_PREFIX } from "@codecast/shared/contracts/ingest";
import { REPLAY_BACKFILL_WINDOWS, isReplayBackfillWindow, needsVendorImport, replayBackfillFollows, replayBackfillLine, replayBackfillState, type ReplayBackfill, type ReplayEvent } from "@codecast/shared/contracts/replay";
import { formatReplayMoment, parseReplayEvents, renderTimeline, replayClockDuration, replayClockStart, replayMoment, replayUrlMatches, replayUserMatches, sortReplayEvents, toRepro } from "@codecast/shared/replay";
import { parseCallTime } from "@codecast/shared/contracts";
import { parseDuration } from "@codecast/shared/time";
import { REPLAY_FRAME_LIMITS, parseReplayRef, replayFrameTimes, replayRefId, type ReplayFrame, type ReplayFrameResponse, type ReplayPlayerLink } from "@codecast/shared/contracts/replayPlayer";
import { agentTempPath, secureTempFile } from "./tempFiles.js";
import { rememberCallFrames } from "./callFrameRefs.js";
import { scopeFor } from "./lineScope.js";

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
  converter_version?: number | null;
  vendor_refresh_after?: number | null;
  /** Chunks of the page capture the player plays; 0 when the replay reads as text only. */
  dom_chunks?: number;
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

/** The keys every `cast replay ls --json` row carries, whether the rows are imported replays or a PostHog source's recordings. */
export type ReplayListJsonRow = {
  short_id: string | null;
  external_id: string;
  provider: string;
  url: string | null;
  user: { id?: string; email?: string } | null;
  started_at: number | null;
  duration_ms: number | null;
  counts: { clicks?: number; errors?: number; failed_requests?: number };
  imported: boolean;
};

/** A PostHog recording under the replay row's keys: short_id is its replay once imported, else null. */
export function recordingJsonRow(r: RecordingRow): ReplayListJsonRow & { recording: RecordingRow } {
  return {
    short_id: r.replay,
    external_id: r.id,
    provider: "posthog",
    url: r.url,
    user: r.email || r.distinct_id ? { ...(r.distinct_id ? { id: r.distinct_id } : {}), ...(r.email ? { email: r.email } : {}) } : null,
    started_at: r.started_at,
    duration_ms: r.duration_ms,
    counts: r.errors !== null ? { errors: r.errors } : {},
    imported: r.imported,
    recording: r,
  };
}

const isReplayShortId = (ref: string) => ref.startsWith(`${INGEST_SHORT_ID_PREFIX.replay}-`);

/** Whether a reference is ours (rp-N, or a bare N) rather than a vendor's recording id. */
export const isOwnReplayRef = (ref: string): boolean => isReplayShortId(ref.trim().toLowerCase()) || /^\d+$/.test(ref.trim());

/**
 * A reference with its moment split off: `<id>@1:23` keeps `@1:23` apart so
 * a vendor id can be resolved to rp-N and the moment put back. Vendor ids
 * hold no `@`.
 */
export function splitReplayRef(text: string): { id: string; moment: string } {
  const t = text.trim();
  const at = t.indexOf("@");
  return at < 0 ? { id: t, moment: "" } : { id: t.slice(0, at), moment: t.slice(at) };
}

/** --since/--until: a span back from now (30d, 12h) or a date (2026-11-01, an ISO time). */
export function parseWhen(text: string, now: number = Date.now()): number {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const at = Date.parse(t);
    if (Number.isFinite(at)) return at;
  }
  try {
    return now - parseDuration(t);
  } catch {
    throw new Error(`"${text}" is neither a span back from now (30d, 12h) nor a date (2026-11-01)`);
  }
}

/** The store's search filter, as /cli/replays/search takes it. */
export interface ReplaySearchArgs {
  source?: string;
  group_id?: string;
  url?: string;
  user?: string;
  since?: number;
  until?: number;
  failing?: boolean;
  active_min_ms?: number;
}

export interface ReplaySearchPage {
  rows: ReplayRow[];
  scanned: number;
  cursor: string;
  done: boolean;
}

/** Every match in the store: pages are read until the store says done, so nothing is left out. */
export async function searchAllReplays(page: (cursor: string | null) => Promise<ReplaySearchPage>): Promise<{ rows: ReplayRow[]; scanned: number }> {
  const rows: ReplayRow[] = [];
  let scanned = 0;
  let cursor: string | null = null;
  for (;;) {
    const res = await page(cursor);
    rows.push(...res.rows);
    scanned += res.scanned;
    if (res.done || !res.cursor || res.cursor === cursor) break;
    cursor = res.cursor;
  }
  return { rows, scanned };
}

/** A vendor's listed recording kept by the same --url and --user the store search applies. */
export function recordingMatches(r: RecordingRow, f: Pick<ReplaySearchArgs, "url" | "user" | "since" | "until" | "failing">): boolean {
  if (f.url && !replayUrlMatches({ url: r.url, shape: null }, f.url)) return false;
  if (f.user && !replayUserMatches({ ...(r.email ? { email: r.email } : {}), ...(r.distinct_id ? { id: r.distinct_id } : {}) }, f.user)) return false;
  if (f.since !== undefined && (r.started_at ?? 0) < f.since) return false;
  if (f.until !== undefined && (r.started_at ?? 0) >= f.until) return false;
  if (f.failing && !(r.errors && r.errors > 0)) return false;
  return true;
}

/** How far before the newest stored recording `ls --live` asks the vendor from: recordings it lists late. */
const LIVE_OVERLAP_MS = 2 * 3600_000;

/** The count line under `cast replay ls`: how many matched, how many are shown, and what was looked through. */
export function formatSearchFooter(total: number, shown: number, scanned: number): string {
  const head = `${total} matched among ${scanned} stored recording${scanned === 1 ? "" : "s"}`;
  return shown < total ? `${head}; showing the newest ${shown} (-n 0 lists all ${total})` : head;
}

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
  if (d.dom_chunks) lines.push(fmt.muted(`  page capture kept: cast replay snap ${d.short_id}@m:ss shows the page at a moment`));
  // The timeline is the product's page outline, console lines and click
  // labels: fenced under the untrusted-data line like every product text.
  lines.push("", timeline ? fenceProductText(timeline, `replay ${d.short_id}`) : fmt.muted("No events in this replay yet."));
  return lines.join("\n");
}

/** A source's import as `cast replay import` prints it while following. */
export function formatReplayImport(source: { name: string; replay_backfill?: ReplayBackfill }, now: number = Date.now()): string {
  const b = source.replay_backfill;
  if (!b) return `${source.name}: no import yet. Recordings come over when opened; cast replay import --source ${source.name} brings them all.`;
  return `${source.name}: ${replayBackfillLine(b, now)}`;
}

export interface ReplayStored {
  /** Null when the source's tallies are not counted yet. */
  count: number | null;
  oldest_at: number | null;
  newest_at: number | null;
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * `cast replay import --status`: what the store holds (count and date
 * range), what the last run did and over which span, and each recording it
 * could not import with the vendor's reason.
 */
export function formatReplayImportStatus(source: { name: string; replay_backfill?: ReplayBackfill }, stored: ReplayStored, now: number = Date.now()): string {
  const lines: string[] = [];
  const count = stored.count === null ? "recordings (not counted yet)" : `${stored.count} recording${stored.count === 1 ? "" : "s"}`;
  lines.push(stored.oldest_at === null ? `${source.name}: nothing stored yet` : `${source.name}: ${count} stored, recorded ${day(stored.oldest_at)} to ${day(stored.newest_at ?? stored.oldest_at)}`);
  const b = source.replay_backfill;
  if (!b) {
    lines.push(`  no import yet; cast replay import --source ${source.name} brings every recording over`);
    return lines.join("\n");
  }
  const when = b.finished_at ?? b.updated_at;
  lines.push(`  last run (${replayBackfillFollows(b) ? "follow-up" : `started ${ago(b.started_at, now)}`}, ${replayBackfillState(b, now) === "running" ? "updated" : "ended"} ${ago(when, now)}): ${replayBackfillLine(b, now)}`);
  if (b.failed) {
    const kept = b.failures ?? [];
    lines.push(`  failed${kept.length < b.failed ? ` (the last ${kept.length} of ${b.failed} kept)` : ""}:`);
    for (const f of kept) {
      const about = [f.at ? day(f.at) : "", f.person ?? "", f.url ?? ""].filter(Boolean).join("  ");
      lines.push(`    ${f.id}  ${f.error.replace(/\s+/g, " ").trim()}${about ? fmt.muted(`  (${about})`) : ""}`);
    }
    lines.push(fmt.muted(`  a new run retries them: cast replay import --source ${source.name}`));
  }
  return lines.join("\n");
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

/** Frames are named by the whole second they show, in the scratch directory. */
export function replayFramePath(shortId: string, tMs: number): string {
  return agentTempPath("replays", `${shortId}-${Math.floor(tMs / 1000)}s-${process.pid}-${Date.now().toString(36)}.png`);
}

/** The frames a snap draws, and where it stopped when the stretch held more than REPLAY_FRAME_LIMITS.max_frames. */
export interface SnapPlan {
  times: number[];
  /** Set when frames were dropped: the stretch went on past `last_ms`, and `wanted` frames would have covered it. */
  truncated: { last_ms: number; wanted: number } | null;
}

/**
 * The moments a snap draws: the one named, a stretch every `--every`, or with
 * `--every` and no stretch, the whole recording. Held to the recording, and
 * to REPLAY_FRAME_LIMITS.max_frames, saying so when a stretch is cut short.
 * A lone moment with `--every` is refused: the person meant a stretch.
 */
export function snapTimes(ref: { replay?: string; at_ms?: number; range?: { from_ms: number; to_ms: number } }, everyMs: number | null, durationMs: number): SnapPlan {
  const hold = (t: number) => Math.min(Math.max(0, t), Math.max(0, durationMs));
  if (ref.at_ms !== undefined && everyMs !== null) {
    const name = ref.replay ?? "rp-N";
    throw new Error(`--every samples a stretch: name one, ${name}@1:00-2:30 --every 10s, or leave the moment off for the whole replay`);
  }
  if (ref.at_ms !== undefined) return { times: [hold(ref.at_ms)], truncated: null };
  const range = ref.range ? { from_ms: hold(ref.range.from_ms), to_ms: hold(ref.range.to_ms) } : { from_ms: 0, to_ms: Math.max(0, durationMs) };
  const all = [...new Set(replayFrameTimes(range, everyMs ?? 10_000, Number.POSITIVE_INFINITY).map(hold))];
  const times = all.slice(0, REPLAY_FRAME_LIMITS.max_frames);
  return { times, truncated: all.length > times.length ? { last_ms: times[times.length - 1], wanted: all.length } : null };
}

/**
 * Ask the replay player worker for frames, a batch per request. A busy
 * browser pool (429) is waited out once. A capability that lapses partway
 * (404, a long snap outlives its ten minutes) is minted again through
 * `remint` once per batch. A batch that still fails after earlier ones drew
 * keeps what was drawn: its times and the rest come back as frames with the
 * error. Only a snap that drew nothing fails with the worker's words.
 */
export async function fetchReplayFrames(
  link: Pick<ReplayPlayerLink, "cap" | "frame_url">,
  times: number[],
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; remint?: () => Promise<Pick<ReplayPlayerLink, "cap" | "frame_url">> } = {},
): Promise<ReplayFrame[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out: ReplayFrame[] = [];
  let current = link;
  for (let i = 0; i < times.length; i += REPLAY_FRAME_LIMITS.max_frames_per_request) {
    const batch = times.slice(i, i + REPLAY_FRAME_LIMITS.max_frames_per_request);
    let waited = false;
    let reminted = false;
    for (;;) {
      const res = await doFetch(current.frame_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cap: current.cap, times_ms: batch }),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status === 429 && !waited) {
        waited = true;
        await sleep(Math.min(120, Number(res.headers.get("Retry-After")) || 30) * 1000);
        continue;
      }
      if (res.status === 404 && !reminted && opts.remint) {
        reminted = true;
        current = await opts.remint();
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as Partial<ReplayFrameResponse> & { error?: string };
      if (!res.ok) {
        const error = body.error ?? `the frame renderer answered ${res.status}`;
        if (!out.length) throw new Error(error);
        return [...out, ...times.slice(i).map((t) => ({ t_ms: t, url: null, outline: "", width: 0, height: 0, error }))];
      }
      out.push(...(body.frames ?? []));
      break;
    }
  }
  return out;
}

/** Parse --every: `10s`, `1:00`, or plain seconds. */
export function parseEvery(text: string | undefined): number | null {
  if (text === undefined) return null;
  const s = text.trim();
  const ms = /^\d+$/.test(s) ? Number(s) * 1000 : parseCallTime(s);
  if (ms === null || ms < 1000) throw new Error("--every takes a time of at least 1s: 10s, 30s, 1:00");
  return ms;
}

export function registerReplayCommand(program: Command, deps: PublishDeps): void {
  const replay = program.command("replay").description(commandGroup("replay").description);

  /**
   * rp-N for a reference: ours as it is, a vendor's recording id (a PostHog
   * session id, a Sentry replay id) through the store, imported from the
   * workspace's vendor sources the first time. With --source, that source only.
   */
  const resolveRef = async (ref: string, source: string | undefined, team: string | undefined): Promise<string> => {
    if (isOwnReplayRef(ref)) return shortRef("rp", ref.trim().toLowerCase());
    if (source) return (await scopedRead(deps, "/cli/replays/import", { source, recording: ref.trim() }, team)).short_id;
    const res = await scopedRead(deps, "/cli/replays/resolve", { recording: ref.trim() }, team);
    if (res.imported) console.error(fmt.muted(`Imported ${ref.trim()} from ${res.source} as ${res.short_id}.`));
    return res.short_id;
  };

  /** The replay's detail, importing a PostHog or Sentry recording the first time it is read. */
  const detailFor = async (ref: string, source: string | undefined, team: string | undefined): Promise<ReplayDetail> => {
    const id = await resolveRef(ref, source, team);
    let detail: ReplayDetail = await postOrFail(deps, "/cli/replays/get", { replay: id }, { read: true });
    if (needsVendorImport(detail)) {
      await apiPost(deps, "/cli/replays/import-linked", { replay: detail.short_id }, { read: true });
      detail = await apiPost(deps, "/cli/replays/get", { replay: detail.short_id }, { read: true });
    }
    return detail;
  };

  /** A moment reference with a vendor id resolved: `<session id>@1:23` reads as `rp-N@1:23`. */
  const resolveMomentRef = async (text: string, source: string | undefined, team: string | undefined): Promise<string> => {
    const { id, moment } = splitReplayRef(text);
    if (isOwnReplayRef(id)) return text;
    return `${await resolveRef(id, source, team)}${moment}`;
  };

  replay
    .command("ls")
    .alias("list")
    .description("Imported recordings that match, newest first, with the total that matched: find a page's or a person's recordings here, then show and snap them")
    .option("--url <text>", "Was on this page: a substring of the first URL or any visited path, or a glob with * (*/book/intro/*)")
    .option("--user <email|id>", "One person: their email, or the vendor's distinct id")
    .option("--since <when>", "Started after: a span back (30d, 12h) or a date (2026-11-01)")
    .option("--until <when>", "Started before: a span back or a date")
    .option("--errors", "Had a console error or a failed request")
    .option("--min-active <s>", "At least this many seconds of activity", (v: string) => Number(v))
    .option("--source <name>", "Only this source")
    .option("--group <eg>", "Only the recordings linked to this group")
    .option("--live", "Also ask the vendor (PostHog) for matching recordings the store does not hold yet; needs --source")
    .option("-n, --limit <n>", "How many to print (default 100; 0 prints every match)", (v: string) => parseInt(v, 10))
    .option(...TEAM_OPTION)
    .option("--json", "Machine-readable output: [{short_id (null until imported), external_id, provider, url, user, started_at, duration_ms, counts, imported}]")
    .action(async (o: { url?: string; user?: string; since?: string; until?: string; errors?: boolean; minActive?: number; source?: string; group?: string; live?: boolean; limit?: number; team?: string; json?: boolean }) => {
      const now = Date.now();
      let filter: ReplaySearchArgs;
      try {
        filter = {
          ...(o.source ? { source: o.source } : {}),
          ...(o.url?.trim() ? { url: o.url.trim() } : {}),
          ...(o.user?.trim() ? { user: o.user.trim() } : {}),
          ...(o.since ? { since: parseWhen(o.since, now) } : {}),
          ...(o.until ? { until: parseWhen(o.until, now) } : {}),
          ...(o.errors ? { failing: true } : {}),
        };
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      if (o.minActive !== undefined) {
        if (!Number.isFinite(o.minActive) || o.minActive < 0) fail("--min-active takes seconds: 5, 30");
        filter!.active_min_ms = Math.round(o.minActive * 1000);
      }
      if (o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 0)) fail("-n takes a count, or 0 for every match");
      if (o.live && !o.source) fail("--live asks one vendor source: name it with --source");
      if (o.group) filter!.group_id = (await postOrFail(deps, "/cli/events/group", { group: shortRef("eg", o.group) }, { read: true })).group._id;

      const found = await searchAllReplays((cursor) => scopedRead(deps, "/cli/replays/search", { ...filter, cursor }, o.team));
      const limit = o.limit === undefined ? 100 : o.limit;
      const shown = limit === 0 ? found.rows : found.rows.slice(0, limit);

      // The vendor is asked only on --live, and only for what the store lacks.
      let live: { rows: RecordingRow[]; note: string } | null = null;
      if (o.live) {
        const status = await scopedRead(deps, "/cli/replays/import-status", { source: o.source }, o.team);
        if (status.source.provider !== "posthog") fail(`--live lists PostHog recordings; ${o.source} is a ${status.source.provider} source`);
        // From a little before the newest stored recording: what the store holds is never asked for again.
        const from = Math.max(filter!.since ?? 0, status.stored.newest_at ? status.stored.newest_at - LIVE_OVERLAP_MS : 0);
        try {
          const res = await apiPost(
            deps,
            "/cli/replays/recordings",
            { source: o.source, limit: 100, ...(await scopeFor(deps, o.team, false)), ...(from ? { date_from: new Date(from).toISOString() } : {}), ...(filter!.until !== undefined ? { date_to: new Date(filter!.until).toISOString() } : {}) },
            { read: true, exitOnError: false },
          );
          const missing = (res.recordings as RecordingRow[]).filter((r) => !r.imported && recordingMatches(r, filter!));
          const span = from ? `since ${new Date(from).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
          live = { rows: missing, note: `Asked PostHog live for recordings${span ? ` ${span}` : ""}: ${res.recordings.length} listed, ${missing.length} matching and not imported yet.` };
        } catch (err) {
          live = { rows: [], note: `Asked PostHog live and it failed: ${(err instanceof Error ? err.message : String(err)).replace(/\.+$/, "")}. The list above is the imported store alone.` };
        }
      }

      if (o.json) {
        const rows = [...shown.map((r) => ({ ...r, imported: true })), ...(live?.rows.map(recordingJsonRow) ?? [])];
        emit(true, rows, () => "");
        console.error(formatSearchFooter(found.rows.length, shown.length, found.scanned) + (live ? `\n${live.note}` : ""));
        return;
      }
      const out = [formatReplayList(shown, now), "", fmt.muted(formatSearchFooter(found.rows.length, shown.length, found.scanned))];
      if (live) {
        if (live.rows.length) out.push("", formatRecordingList(live.rows, now));
        out.push(fmt.warning(live.note));
        if (live.rows.length) out.push(fmt.muted("cast replay show <id> imports one of these and opens it."));
      } else if (found.rows.length) {
        out.push(fmt.muted(`Next: cast replay show ${found.rows[0].short_id}, then cast replay snap ${found.rows[0].short_id}@m:ss to see the page.`));
      }
      console.log(out.join("\n"));
    });

  replay
    .command("show")
    .description("The replay as a text timeline: navigation, clicks, typed fields (never values), errors, failed requests")
    .argument("<replay>", "rp-N, or the vendor's recording id (PostHog session id, Sentry replay id); @1:23 reads that moment")
    .option("--source <name>", "Look the recording id up in this source only (imported the first time)")
    .option("--at <time>", "Only the moment at this time (1:23, 83s): the page, its outline, what came before, console and network around it")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (refText: string, o: { source?: string; at?: string; team?: string; json?: boolean }) => {
      const ref = await resolveMomentRef(refText, o.source, o.team);
      const parsed = parseReplayRef(ref);
      if (!parsed && ref.includes("@")) fail(`"${ref}" names no moment. Write rp-12@1:23 (minutes:seconds), or rp-12 with --at 83s`);
      if (o.at !== undefined || parsed?.at_ms !== undefined) {
        const atMs = o.at !== undefined ? parseCallTime(o.at) : parsed!.at_ms!;
        if (atMs === null) fail("--at takes a time into the replay: 1:23, 83s, 1:02:03");
        const detail = await detailFor(parsed?.replay ?? ref, undefined, o.team);
        const events = detail.chunk_urls.length ? await readReplayEvents(detail.chunk_urls) : [];
        const moment = replayMoment(events, atMs!);
        const text = formatReplayMoment(moment, replayClockStart(events));
        const momentRef = replayRefId(detail.short_id, moment.at_ms);
        emit(o.json, { replay: detail.short_id, ref: momentRef, ...moment, has_dom: !!detail.dom_chunks }, () =>
          [
            formatReplayLine(detail),
            events.length ? fenceProductText(text, `replay ${momentRef}`) : fmt.muted("No events in this replay yet."),
            detail.dom_chunks ? fmt.muted(`cast replay snap ${momentRef} shows the page itself.`) : "",
          ].filter(Boolean).join("\n"),
        );
        return;
      }
      const detail = await detailFor(parsed?.replay ?? ref, undefined, o.team);
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
        const res = await scopedRead(deps, "/cli/replays/import-status", { source: o.source }, o.team);
        emit(o.json, { stored: res.stored, last_run: res.source.replay_backfill ?? null }, () => formatReplayImportStatus(res.source, res.stored));
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
      const done = await scopedRead(deps, "/cli/replays/import-status", { source: o.source }, o.team);
      console.log(formatReplayImportStatus(done.source, done.stored));
    });

  replay
    .command("snap")
    .description("What the page looked like at a moment, rendered server side: a PNG to Read, plus the URL, visible text, what came before, console and network")
    .argument("<moment>", "rp-N@1:23, or a stretch rp-N@1:00-2:30 (frames every --every); a vendor's recording id works in place of rp-N")
    .option("--every <time>", "A frame this often across the stretch, or across the whole replay when no stretch is named (10s, 30s, 1:00)")
    .option("-o, --out <file>", "Write the frame here instead of the scratch directory (one frame only)")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (refText: string, o: { every?: string; out?: string; team?: string; json?: boolean }) => {
      const ref = parseReplayRef(await resolveMomentRef(refText, undefined, o.team));
      if (!ref) fail(`Name a moment of a replay: rp-12@1:23, or a stretch rp-12@1:00-2:30 with --every 10s`);
      let every: number | null;
      try {
        every = parseEvery(o.every);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      if (ref!.at_ms === undefined && !ref!.range && every! === null) fail(`Name the moment: ${ref!.replay}@1:23, or pass --every 10s for frames across the whole replay`);
      const detail = await detailFor(ref!.replay, undefined, o.team);
      const events = detail.chunk_urls.length ? await readReplayEvents(detail.chunk_urls) : [];
      const start = replayClockStart(events);
      const duration = Math.max(replayClockDuration(events), detail.duration_ms ?? 0);
      let plan: SnapPlan;
      try {
        plan = snapTimes(ref!, every!, duration);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const { times, truncated } = plan!;
      if (o.out && times.length > 1) fail("--out writes one frame; a stretch writes its frames to the scratch directory");

      const mintLink = async (): Promise<ReplayPlayerLink> => apiPost(deps, "/cli/replays/player-link", { replay: detail.short_id, mode: "frame" }, { read: true });
      const link = await mintLink();
      let frames: ReplayFrame[] = [];
      if (link.has_dom && link.cap) {
        try {
          frames = await fetchReplayFrames(link, times, { remint: mintLink });
        } catch (err) {
          fail(`${detail.short_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const shots = times.map((t, i) => {
        const frame = frames[i];
        const moment = replayMoment(events, frame?.t_ms ?? t);
        const momentRef = replayRefId(detail.short_id, moment.at_ms);
        let file: string | null = null;
        if (frame?.png_base64) {
          file = o.out ? path.resolve(process.env.CODECAST_CWD || process.cwd(), o.out) : replayFramePath(detail.short_id, moment.at_ms);
          fs.writeFileSync(file, Buffer.from(frame.png_base64, "base64"), { mode: 0o600 });
          if (!o.out) secureTempFile(file);
        }
        return { ref: momentRef, t_ms: moment.at_ms, file, frame, moment };
      });
      try {
        rememberCallFrames(shots.filter((s) => s.file).map((s) => ({ path: s.file!, ref: s.ref, recording_id: detail._id, width: s.frame?.width ?? null, height: s.frame?.height ?? null })));
      } catch {
        // Best effort: an unremembered frame syncs as a picture, the snap still stands.
      }
      const cutShort = truncated
        ? `Stopped at ${replayRefId(detail.short_id, truncated.last_ms)}: a snap draws at most ${REPLAY_FRAME_LIMITS.max_frames} frames and this stretch wanted ${truncated.wanted}. Name a later stretch from there, or a longer --every.`
        : null;
      const noCapture = !link.has_dom
        ? `${detail.short_id} keeps no page capture (it was recorded as events only, or imported before captures were kept), so there is no frame: here is what the stream says.`
        : null;
      emit(
        o.json,
        {
          replay: detail.short_id,
          has_dom: link.has_dom,
          truncated: truncated ? { last_ref: replayRefId(detail.short_id, truncated.last_ms), last_t_ms: truncated.last_ms, wanted: truncated.wanted, max_frames: REPLAY_FRAME_LIMITS.max_frames } : null,
          frames: shots.map((s) => ({ ref: s.ref, t_ms: s.t_ms, path: s.file, url: s.frame?.url ?? s.moment.url, visible_text: s.frame?.outline ?? null, error: s.frame?.error ?? null, moment: s.moment })),
        },
        () => {
          const out: string[] = [];
          if (noCapture) out.push(fmt.muted(noCapture));
          for (const s of shots) {
            out.push("");
            if (s.file) out.push(`${fmt.success("frame")} ${s.ref}  ${s.file}  ${fmt.muted(`${s.frame!.width}x${s.frame!.height}; Read it to see the page`)}`);
            else if (s.frame?.error) out.push(`${fmt.warning("no frame")} ${s.ref}: ${s.frame.error}`);
            else out.push(fmt.id(s.ref));
            const text = formatReplayMoment(s.moment, start, { visible: s.frame?.outline ?? null, frame_url: s.frame?.url ?? null });
            out.push(events.length || s.frame?.outline ? fenceProductText(text, `replay ${s.ref}`) : fmt.muted("No events in this replay yet."));
          }
          if (cutShort) out.push("", fmt.warning(cutShort));
          return out.join("\n").trim();
        },
      );
    });

  replay
    .command("repro")
    .description("Write a Playwright test that replays the steps up to the failure and asserts it does not happen")
    .argument("<replay>", "rp-N, or the vendor's recording id (PostHog session id, Sentry replay id)")
    .option("--source <name>", "Look the recording id up in this source only")
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
