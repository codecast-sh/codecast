// The Replays surface's pure rules (the list's address and the player's event
// rail), kept apart from the components so they are tested without a
// browser. Which recordings match a filter and how they sort is shared with
// the server (shared/replay/list.ts); this file only adds what the web shows.
import {
  REPLAY_ACTIVE,
  REPLAY_ACTIVE_DEFAULT,
  REPLAY_DATES,
  REPLAY_DURATIONS,
  REPLAY_ENV_KEYS,
  REPLAY_HAS,
  REPLAY_PEOPLE_SORTS,
  REPLAY_SORTS,
  formatReplayTime,
  isFailedRequest,
  isFailure,
  isRecorderNoise,
  isSlowRequest,
  rageClicksOf,
  replayIssues,
  urlPath,
  type ReplayActive,
  type ReplayDate,
  type ReplayDuration,
  type ReplayEnvKey,
  type ReplayHas,
  type ReplayListFilter,
  type ReplayPeopleSort,
  type ReplaySort,
} from "@codecast/shared/replay";
import { REPLAY_REST, needsRest, needsVendorImport, replayCutAt, type ReplayEvent, type VendorRefreshWhy } from "@codecast/shared/contracts/replay";
import { parseReplayPlayerUrl, replayPlayerUrl } from "@codecast/shared/contracts/replayPlayer";
import { formatCallTime } from "@codecast/shared/entities";
import type { OpsReplay, OpsSource } from "./opsTypes";
import { relTimeShort } from "../../lib/utils";
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";
import { MERGES_NEVER } from "../consequential/lineStartLedger";

// ── The list's address ──

export type ReplayListQuery = ReplayListFilter & {
  group: "person" | null;
  /** The people fold's order; absent means the default for the filter (peopleSortFor). */
  people_sort?: ReplayPeopleSort;
  /** The people fold leaves out people known only by an id. */
  identified?: boolean;
  /** Only recordings that caught this issue, by its short id (eg-N); the list resolves it to the group. */
  issue?: string;
};

/** People most hit first when the list is narrowed to failures (the reason to fold by person), else most recently seen. */
export function peopleSortFor(q: Pick<ReplayListQuery, "people_sort" | "has">): ReplayPeopleSort {
  if (q.people_sort) return q.people_sort;
  return q.has?.some((h) => h === "errors" || h === "failed") ? "failures" : "recent";
}

/** People the fold shows at first; "Show more" adds this many. */
export const PEOPLE_PAGE = 100;

/** Rows a page of the list shows; "Show more" adds this many. */
export const REPLAY_PAGE = 50;

const oneOf = <T extends string>(all: readonly T[], v: string | null): T | undefined => (v && (all as readonly string[]).includes(v) ? (v as T) : undefined);

export function parseReplayQuery(get: (key: string) => string | null): ReplayListQuery {
  const has = (get("has") ?? "").split(",").filter((h): h is ReplayHas => (REPLAY_HAS as readonly string[]).includes(h));
  return {
    q: get("q") ?? "",
    person: get("person") || undefined,
    has: [...new Set(has)],
    dur: oneOf<ReplayDuration>(REPLAY_DURATIONS, get("dur")),
    date: oneOf<ReplayDate>(REPLAY_DATES, get("date")),
    sort: oneOf<ReplaySort>(REPLAY_SORTS, get("sort")) ?? "newest",
    group: get("group") === "person" ? "person" : null,
    people_sort: oneOf<ReplayPeopleSort>(REPLAY_PEOPLE_SORTS, get("psort")),
    identified: get("ident") === "1" || undefined,
    active: oneOf<ReplayActive>(REPLAY_ACTIVE, get("active")),
    issue: get("issue")?.slice(0, 40) || undefined,
    ...Object.fromEntries(REPLAY_ENV_KEYS.map((k) => [k, get(k)?.slice(0, 100) || undefined]).filter(([, v]) => v)),
  };
}

/** The query as URL params: a value to set, or null to remove. The defaults (newest, ungrouped) are left out. */
export function replayQueryParams(q: ReplayListQuery): Record<"q" | "person" | "has" | "dur" | "date" | "sort" | "group" | "psort" | "ident" | "active" | "issue" | ReplayEnvKey, string | null> {
  return {
    q: q.q?.trim() ? q.q : null,
    person: q.person ?? null,
    has: q.has?.length ? q.has.join(",") : null,
    dur: q.dur ?? null,
    date: q.date ?? null,
    sort: q.sort && q.sort !== "newest" ? q.sort : null,
    group: q.group,
    psort: q.people_sort ?? null,
    ident: q.identified ? "1" : null,
    active: q.active && q.active !== REPLAY_ACTIVE_DEFAULT ? q.active : null,
    issue: q.issue ?? null,
    browser: q.browser ?? null,
    os: q.os ?? null,
    device: q.device ?? null,
    country: q.country ?? null,
  };
}

export function isReplayFiltered(q: ReplayListQuery): boolean {
  return !!(q.q?.trim() || q.person || q.has?.length || q.dur || q.date || q.issue || (q.active && q.active !== "any" && q.active !== REPLAY_ACTIVE_DEFAULT) || REPLAY_ENV_KEYS.some((k) => q[k]));
}

export const ENV_LABEL: Record<ReplayEnvKey, string> = { browser: "Browser", os: "OS", device: "Device", country: "Country" };

/** OS names as people say them: PostHog writes "Mac OS X". */
export function osName(os: string): string {
  return os === "Mac OS X" ? "macOS" : os;
}

/** A browser as a list row names it: the vendor's prefix dropped ("Microsoft Edge" reads Edge); the device icon beside it says mobile. */
export function shortBrowser(browser: string): string {
  return browser.replace(/^(Microsoft|Mobile|Google|Mozilla)\s+/i, "") || browser;
}

/** A count in a narrow cell: 1,140 reads 1.1k and 12,400 reads 12k. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  return n < 10_000 ? `${(Math.floor(n / 100) / 10).toString()}k` : `${Math.floor(n / 1000)}k`;
}

export type ReplayFigureKind = "clicks" | "errors" | "failed" | "rage";

/** The counts a recording shows beside it, in order: clicks always, then errors, failed requests and rage clicks when nonzero. */
export function replayFigures(r: Pick<OpsReplay, "counts" | "shape" | "facts">): { kind: ReplayFigureKind; n: number }[] {
  const rage = rageClicksOf(r) ?? 0;
  const out: { kind: ReplayFigureKind; n: number }[] = [{ kind: "clicks", n: r.counts.clicks }];
  if (r.counts.errors > 0) out.push({ kind: "errors", n: r.counts.errors });
  if (r.counts.failed_requests > 0) out.push({ kind: "failed", n: r.counts.failed_requests });
  if (rage > 0) out.push({ kind: "rage", n: rage });
  return out;
}

// The list's figure cell (replays.css .rp-figs at 11.5px mono): an icon and its gap, each digit, and the gap between figures.
const FIG_ICON_PX = 15;
const FIG_CHAR_PX = 7;
const FIG_GAP_PX = 7;
const FIGS_MIN_PX = 84;

/** How wide the list's Events column must be for the widest row on the page, so no count is ever cut. */
export function figuresWidthPx(rows: Pick<OpsReplay, "counts" | "shape" | "facts">[]): number {
  let widest = 0;
  for (const r of rows) {
    const figs = replayFigures(r);
    let w = FIG_GAP_PX * (figs.length - 1);
    for (const f of figs) w += FIG_ICON_PX + FIG_CHAR_PX * compactCount(f.n).length;
    if (w > widest) widest = w;
  }
  return Math.max(FIGS_MIN_PX, Math.ceil(widest) + 4);
}

/**
 * How many recordings the list has, as a phrase: "1,204 recordings", with
 * "at least" when the server stopped at its scan cap and the cap changes the
 * answer. A capped zero is the newest recordings having none, said so.
 */
export function totalText(n: number, capped: boolean, scanned: number, one = "recording", many = `${one}s`): string {
  if (!capped) return plural(n, one, many);
  if (n === 0) return `No ${many} in the newest ${scanned.toLocaleString()}`;
  return `${n.toLocaleString()}+ ${n === 1 ? one : many}`;
}

export const HAS_LABEL: Record<ReplayHas, string> = { errors: "Errors", failed: "Failed requests", rage: "Rage clicks", partial: "Partly imported" };
export const DUR_LABEL: Record<ReplayDuration, string> = { lt30s: "Under 30s", gt1m: "Over 1m", gt5m: "Over 5m", gt30m: "Over 30m" };
export const DATE_LABEL: Record<ReplayDate, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
export const SORT_LABEL: Record<ReplaySort, string> = { newest: "Newest", oldest: "Oldest", longest: "Longest", shortest: "Shortest", errors: "Most failures", clicks: "Most clicks" };
export const ACTIVE_LABEL: Record<ReplayActive, string> = { any: "Any", "5s": "Over 5s", "30s": "Over 30s", "1m": "Over 1m", "5m": "Over 5m" };

/** An hour, so a date filter's instant (and the query's args) moves once an hour, not on every render. */
export const coarseHour = (now: number) => Math.floor(now / 3_600_000) * 3_600_000;

/**
 * A recording's length, or why there is none: a stream still assembling, a
 * vendor recording not imported yet, or a length nobody reported.
 */
export function replayLengthText(r: Pick<OpsReplay, "duration_ms" | "has_timeline" | "chunks" | "provider" | "imported_at" | "converter_version" | "vendor_refresh_after">): { text: string; known: boolean } {
  if (r.duration_ms) return { text: formatReplayTime(r.duration_ms), known: true };
  if (!r.has_timeline && r.chunks > 0) return { text: "assembling", known: false };
  if (needsVendorImport(r)) return { text: "not imported", known: false };
  return { text: "no length", known: false };
}

/** Where an imported copy stops when the recording runs well past it (shared replayCutAt, the server's rule too). */
export const importedUntil = replayCutAt;

/**
 * The player's view of the same. The reach the row stored is the server's
 * reading of the capture, so it decides whenever it is set; the last event can
 * only raise it. Only a row with no stored reach asks the player where its
 * capture ends (`captureEndMs`, 0 while unknown), and a copy with a page
 * capture whose end is not known yet answers null, so a page left open is not
 * marked cut for a beat.
 */
export function playerImportedUntil(r: Pick<OpsReplay, "captured_ms" | "duration_ms" | "dom_chunks" | "provider">, lastEventMs: number, captureEndMs: number): number | null {
  if (r.provider === "sdk") return null;
  if (r.captured_ms) return importedUntil(Math.max(r.captured_ms, lastEventMs), r.duration_ms);
  if ((r.dom_chunks ?? 0) > 0 && captureEndMs <= 0) return null;
  return importedUntil(Math.max(lastEventMs, captureEndMs), r.duration_ms);
}

/** A chain reading a long recording's rest that has not stepped in this long has stopped (shared REPLAY_REST). */
export const REST_STALL_MS = REPLAY_REST.stall_ms;

/**
 * retry_at: when the next part is due after the vendor asked to wait. `share`
 * is how much of the recording's time is imported (captured_ms of
 * duration_ms), never the part of the vendor's blobs read: a recording the
 * vendor is still writing grows blobs as the chain reads them. `caught_up`:
 * every blob the vendor listed is read and the recording still runs past the
 * import, so the vendor is still recording it.
 */
export type RestState = { state: "reading" | "waiting" | "stopped"; share: number; error: string | null; retry_at?: number | null; caught_up?: boolean; since?: number };

/**
 * Where reading the rest of a long recording stands (convex sources/replayRest):
 * reading, waiting out the vendor's rate limit, or stopped (failed, or quiet
 * past REST_STALL_MS). Null when no chain was started.
 */
export function restState(r: Pick<OpsReplay, "import_rest"> & Partial<Pick<OpsReplay, "captured_ms" | "duration_ms">>, now: number): RestState | null {
  const c = r.import_rest;
  if (!c) return null;
  const share = r.duration_ms && r.duration_ms > 0 ? Math.min(1, Math.max(0, (r.captured_ms ?? 0) / r.duration_ms)) : 0;
  const caught = c.blobs > 0 && c.next_blob >= c.blobs && share < 1 ? { caught_up: true } : {};
  if (c.error) return { state: "stopped", share, error: c.error };
  if (c.retry_at && c.retry_at > now) return { state: "waiting", share, error: null, retry_at: c.retry_at };
  if (now - c.updated_at > REST_STALL_MS) return { state: "stopped", share, error: null, since: c.updated_at };
  return { state: "reading", share, error: null, ...caught };
}

/** Whether opening this copy should ask the server to read the rest of its recording: the server's own rule (shared needsRest), so a press is offered only when the server will act on it. */
export function restDue(r: Pick<OpsReplay, "provider" | "captured_ms" | "duration_ms" | "import_rest" | "vendor_refresh_after" | "imported_at">, now: number): boolean {
  return r.provider === "posthog" && needsRest(r, now);
}

/** Why the server is not reading a cut copy's rest now, and when it will ask the vendor again (vendor_refresh_after). */
export type RestHold = { why: VendorRefreshWhy | "unknown"; until: number };

export function restHold(r: Pick<OpsReplay, "vendor_refresh_after" | "vendor_refresh_why">, now: number): RestHold | null {
  if (!r.vendor_refresh_after || r.vendor_refresh_after <= now) return null;
  return { why: r.vendor_refresh_why ?? "unknown", until: r.vendor_refresh_after };
}

/** A hold in a few words, for the cut label and the stage: what stops it, and when it is tried again. */
export function restHoldText(h: RestHold, vendor: string, now: number): string {
  const at = new Date(h.until);
  const soon = h.until - now < 20 * 60 * 60_000;
  const when = soon ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  switch (h.why) {
    case "realtime":
      return `${vendor} is still recording · read at ${when}`;
    case "rate_limit":
      return `${vendor} rate limit · retry ${when}`;
    case "gone":
      return `gone from ${vendor}`;
    case "unsplittable":
      return `can't be read in parts`;
    default:
      return `read failed · retry ${when}`;
  }
}

/**
 * Where reading the rest of a cut copy stands, in the words every surface
 * uses (the page header, the past-the-cut notice, the list row): reading,
 * caught up with a recording the vendor is still writing, waiting on the
 * vendor, held until a retry (and that it stopped, when a chain did), or
 * stopped. How far it reaches is said in time beside it ("33:38 of 58:49");
 * `share` is that time's share, for a meter; `title` the adapter's own error.
 */
export function restLine(rest: RestState | null, hold: RestHold | null, starting: boolean, vendor: string, now: number, queued?: RestQueued): { text: string; tone: "busy" | "held" | "stopped" | "idle"; share: number | null; title?: string } {
  const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (starting) return { text: "starting import", tone: "busy", share: null };
  // Every part the vendor listed is read and the copy is still short: it reads on as the vendor writes more. Never "caught up" while time is missing.
  if (rest?.state === "reading") return rest.caught_up ? { text: `reading · ${vendor} still recording`, tone: "busy", share: rest.share } : { text: "reading now", tone: "busy", share: rest.share };
  if (rest?.state === "waiting") return { text: `${vendor} rate limit · next ${clock(rest.retry_at ?? now)}`, tone: "busy", share: rest.share };
  if (hold) return { text: rest && hold.why !== "gone" ? `stopped · ${restHoldText(hold, vendor, now).replace(/^read failed · /, "")}` : restHoldText(hold, vendor, now), tone: "held", share: rest?.share ?? null, ...(rest?.error ? { title: rest.error } : {}) };
  if (rest && !rest.error && rest.since) return { text: `stalled since ${clock(rest.since)}`, tone: "stopped", share: rest.share, title: "Reading the rest went quiet" };
  if (rest) return { text: "stopped", tone: "stopped", share: rest.share, title: rest.error ?? "Reading the rest went quiet" };
  if (queued) return { text: queued.pos !== null ? `queued · #${queued.pos}` : "queued", tone: "idle", share: null, title: queued.reading ? `Read one at a time; ${queued.reading} is being read now` : "Read one at a time, issue recordings first" };
  return { text: "rest not read in", tone: "idle", share: null };
}

/** Where a cut copy waits for the sweep (convex replayRest tally queue): its place, when the last recount saw it, and the recording read now. */
export type RestQueued = { pos: number | null; reading: string | null };

/**
 * A cut copy the server will read the rest of (restDue) and nothing reads or
 * holds now: its place in the source's queue, else null for "queued" alone.
 * Undefined when it is not waiting on the sweep.
 */
export function restQueued(r: Pick<OpsReplay, "short_id" | "provider" | "captured_ms" | "duration_ms" | "import_rest" | "vendor_refresh_after" | "imported_at">, source: Pick<OpsSource, "replay_rest"> | null | undefined, now: number): RestQueued | undefined {
  if (r.import_rest || !restDue(r, now)) return undefined;
  const q = source?.replay_rest?.queue ?? [];
  const i = q.indexOf(r.short_id);
  return { pos: i >= 0 ? i + 1 : null, reading: source?.replay_rest?.reading ?? null };
}

/**
 * Where the page capture ends on the replay clock, from the player's ready
 * message: its `capture_end_ms` when it says so, else its `duration_ms` only
 * when that is not the row's own length echoed back (the player's clock ends
 * at the row's length whenever the row has one, so that number says nothing
 * about the capture). 0 when unknown.
 */
export function captureEndFrom(msg: { duration_ms: number; capture_end_ms?: number }, rowLengthMs: number | null | undefined): number {
  if (typeof msg.capture_end_ms === "number" && msg.capture_end_ms > 0) return msg.capture_end_ms;
  if (rowLengthMs && Math.abs(msg.duration_ms - rowLengthMs) <= 1000) return 0;
  return Math.max(0, msg.duration_ms);
}

/**
 * The rail row the clock is at: the last of the rows a tab shows (each an
 * event and its index in the stream, oldest first) at or before `t`, as its
 * index; inside a folded run, the run's lead (`leadOf`). -1 before the first.
 */
export function railRowAt(rows: readonly (readonly [{ t: number }, number])[], t: number, leadOf: ReadonlyMap<number, number>): number {
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return -1;
  const i = rows[found][1];
  return leadOf.get(i) ?? i;
}

/** A minted player link that also loads the page's remote images and fonts (shared replayPlayerUrl `assets=remote`); the link as it was when it cannot be read. */
export function withRemoteAssets(url: string): string {
  const p = parseReplayPlayerUrl(url);
  if (!p) return url;
  try {
    return replayPlayerUrl({ ...p, remote_assets: true }, new URL(url).origin);
  } catch {
    return url;
  }
}

/** The vendor's player at a moment of the recording: PostHog and Sentry both take `t` in seconds. */
export function vendorUrlAt(url: string, ms: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set("t", String(Math.max(0, Math.floor(ms / 1000))));
    return u.toString();
  } catch {
    return url;
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A total of time as people say it: "128h 27m", "12m 5s", "40s". */
export function spanText(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600).toLocaleString()}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** A URL as the list shows it: its path, the host being the same on nearly every row. */
export function pathOf(url: string | null | undefined): string {
  if (!url) return "";
  const p = urlPath(url);
  return p || "/";
}

/**
 * The page a recording names it by: where it started, else the first page it
 * visited (its shape keeps the paths), else nothing. Never the recording's own
 * id: a recorder that names no start address says nothing about the page.
 */
export function replayPagePath(r: Pick<OpsReplay, "url" | "shape">): string {
  return pathOf(r.url) || r.shape?.paths?.[0] || "";
}

/** The preview never opens before this (nor past a tenth of the recording): the first frames are the app's own loading splash. */
const PREVIEW_PAST_LOAD_MS = 2_500;

/**
 * Where a row's preview opens: a few seconds before its first failure when it
 * has one (what a person hovering an errored recording wants to see), else
 * the start of the first slice in which the person did something (the shape's
 * strip), and never in the first moments, which are a loading splash. The
 * strip and the marks span the copy's events, so `spanMs` is how far the copy
 * reaches (captured_ms), else the length.
 */
export function previewAt(shape: { strip: string; marks?: readonly number[] } | null | undefined, spanMs: number | null | undefined): number {
  if (!spanMs) return 0;
  const floor = Math.min(PREVIEW_PAST_LOAD_MS, spanMs * 0.1);
  const fail = shape?.marks?.length ? Math.min(...shape.marks) : null;
  if (fail !== null) return Math.round(Math.max(floor, (fail / 1000) * spanMs - 3_000));
  const cell = shape?.strip ? [...shape.strip].findIndex((c) => c !== "0") : -1;
  if (cell <= 0) return Math.round(floor);
  return Math.round(Math.max(floor, (cell / shape!.strip.length) * spanMs - 1_000));
}

// ── The replay clock ──

/**
 * The events on the replay clock: ms since the stream's first event. The
 * player (its manifest t0), the text timeline, the issue times and the row's
 * duration all count from there, while a vendor stream's `t` counts from the
 * capture's first rrweb event, which can sit long before anything happened
 * (rp-5132's first event is at 40:49 on that base). Every time the page
 * shows, seeks or shares is read on this clock.
 */
export function onReplayClock(events: ReplayEvent[]): ReplayEvent[] {
  const zero = events[0]?.t ?? 0;
  return zero === 0 ? events : events.map((e) => ({ ...e, t: e.t - zero }));
}

// ── The player's event rail ──

export const RAIL_TABS = ["all", "clicks", "nav", "console", "network", "errors"] as const;
export type RailTab = (typeof RAIL_TABS)[number];
// The first tab is what a person watching follows (allKindOf), not every event: "Activity", so it never reads as the sum of the tabs after it.
// "Actions" holds clicks, typing, submits and keys, so its count never reads as the header's clicks.
export const RAIL_LABEL: Record<RailTab, string> = { all: "Activity", clicks: "Actions", nav: "Pages", console: "Console", network: "Network", errors: "Errors" };

/**
 * An issue title split for a narrow cell: everything from a path's last "/"
 * on is the tail that stays (`GET /api/users/claim 500` keeps `/claim 500`);
 * a title with no path is all head.
 */
export function issueTitleParts(title: string): { head: string; tail: string } {
  const i = title.lastIndexOf("/");
  if (i <= 0 || title.length - i > 32 || title.length < 24) return { head: title, tail: "" };
  return { head: title.slice(0, i), tail: title.slice(i) };
}

/** A page path split for a narrow cell: `head` gives way, `tail` (from the last "/") stays, so `/book/54333ea0` cut short reads `/bo…/54333ea0`. */
export function pagePathParts(path: string): { head: string; tail: string } {
  const i = path.lastIndexOf("/", path.length - 2);
  return i > 0 ? { head: path.slice(0, i), tail: path.slice(i) } : { head: path, tail: "" };
}

/**
 * A request split so the rail can cut its middle: the method, then `head`
 * (the start of the path) which gives way first, then `tail` (the last
 * segment, two when the last is an id or too short to name anything), so
 * `GET /api/electric/v1/shape/calls` reads `GET /api/el…/shape/calls`.
 */
export function netParts(method: string, url: string): { method: string; head: string; tail: string } {
  const path = netPath(url).split("?")[0];
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2) return { method, head: "", tail: path };
  const idLike = (x: string) => x.length < 4 || /^\d+$/.test(x) || /^[0-9a-f-]{12,}$/i.test(x) || (x.length >= 16 && /\d/.test(x) && /^[A-Za-z0-9_-]+$/.test(x));
  const keep = idLike(segs[segs.length - 1]) && segs.length > 2 ? 2 : 1;
  return { method, head: `/${segs.slice(0, -keep).join("/")}`, tail: `/${segs.slice(-keep).join("/")}` };
}

/** The kinds the All tab can show or hide, each a toggle with its count. */
export const ALL_KINDS = ["actions", "pages", "errors", "warnings", "requests", "marks", "scrolls"] as const;
export type AllKind = (typeof ALL_KINDS)[number];
export const ALL_KIND_LABEL: Record<AllKind, string> = { actions: "Actions", pages: "Pages", errors: "Errors", warnings: "Warnings", requests: "Failed requests", marks: "Marks", scrolls: "Scrolls" };
/** Off until a person turns them on: a scroll every second buries the few things a person did. */
export const ALL_KINDS_HIDDEN_BY_DEFAULT: readonly AllKind[] = ["scrolls"];

/**
 * Which All-tab kind an event is, or null when All never lists it: the page
 * outline, a request that answered (a long-poll every twenty seconds is only
 * in Network), and the recording SDK's own console lines.
 */
export function allKindOf(e: ReplayEvent): AllKind | null {
  if (isRecorderNoise(e)) return null;
  switch (e.type) {
    case "click": case "input": case "submit": case "key": return "actions";
    case "nav": return "pages";
    case "error": return "errors";
    case "console": return e.level === "error" ? "errors" : "warnings";
    case "network": return isFailedRequest(e) ? "requests" : null;
    case "mark": return "marks";
    case "scroll": return "scrolls";
    case "view": return null;
  }
}

/** How many events of each All kind a recording holds. */
export function allKindCounts(events: readonly ReplayEvent[]): Record<AllKind, number> {
  const out = Object.fromEntries(ALL_KINDS.map((k) => [k, 0])) as Record<AllKind, number>;
  for (const e of events) {
    const k = allKindOf(e);
    if (k) out[k]++;
  }
  return out;
}

/** What each tab lists. All is what a person watching cares about (allKindOf), less the kinds they hid there. */
export function railAdmits(tab: RailTab, e: ReplayEvent, hidden: ReadonlySet<AllKind> = new Set()): boolean {
  switch (tab) {
    case "all": {
      const k = allKindOf(e);
      return k !== null && !hidden.has(k);
    }
    case "clicks": return e.type === "click" || e.type === "input" || e.type === "submit" || e.type === "key";
    case "nav": return e.type === "nav";
    case "console": return (e.type === "console" && !isRecorderNoise(e)) || e.type === "error";
    case "network": return e.type === "network";
    case "errors": return isPageError(e);
  }
}

/** An exception or a console error: what the Errors tab lists. A failed request is a Network row (its Failed filter), as in Sentry and PostHog. */
export function isPageError(e: ReplayEvent): boolean {
  return isFailure(e) && e.type !== "network";
}

/** A field a person entered and left without typing (focus, autofill probe): read as a focus, never as "typed 0 chars". */
export const isEmptyInput = (e: ReplayEvent): boolean => e.type === "input" && e.length === 0;

export function railCounts(events: readonly ReplayEvent[], hidden: ReadonlySet<AllKind> = new Set()): Record<RailTab, number> {
  const out = Object.fromEntries(RAIL_TABS.map((t) => [t, 0])) as Record<RailTab, number>;
  for (const e of events) for (const t of RAIL_TABS) if (railAdmits(t, e, hidden)) out[t]++;
  return out;
}

/** A request's grade: failed (no answer, 4xx, 5xx), slow (answered, past the slow line), or fine. */
export function netGrade(e: ReplayEvent): "failed" | "slow" | "ok" {
  if (isFailedRequest(e)) return "failed";
  if (isSlowRequest(e)) return "slow";
  return "ok";
}

/** A URL's path without the query keys that carry no value (cleanUrl blanks every value), so `/shape/calls?cursor=&live=` reads `/shape/calls`. */
export function netPath(url: string): string {
  let path: string;
  let search: URLSearchParams;
  try {
    const u = new URL(url, "http://x");
    path = u.pathname || "/";
    search = u.searchParams;
  } catch {
    return url;
  }
  const kept = [...search.entries()].filter(([, v]) => v !== "");
  return kept.length ? `${path}?${new URLSearchParams(kept).toString()}` : path;
}

/**
 * What makes rows the same for the rail's fold: one request (method, path,
 * outcome), one console line, or clicks on one element with the same text
 * (a rage burst, or someone tapping a button that does nothing). Null for
 * anything else a person did, which is never folded.
 */
export function railRunKey(e: ReplayEvent): string | null {
  if (e.type === "click") return `k|${e.selector || e.label}|${e.text ?? ""}`;
  if (e.type === "network") return `n|${e.method}|${netPath(e.url).split("?")[0]}|${e.status}|${netGrade(e)}`;
  if (e.type === "console") return `c|${e.level}|${e.message}`;
  if (e.type === "error") return `e|${e.message}`;
  // Tabbing through a form touches each field: the run reads as one row that opens to the fields.
  if (isEmptyInput(e)) return "f|";
  return null;
}

/** Repeats further apart than this start a new run. */
export const RAIL_RUN_GAP_MS = 2_000;

/**
 * Consecutive rows that read the same (railRunKey), each no more than
 * RAIL_RUN_GAP_MS after the one before, folded into one run: the first row
 * leads, and the run holds every row it stands for so it can open.
 */
export function foldRail<T extends readonly [ReplayEvent, number]>(rows: readonly T[], gap = RAIL_RUN_GAP_MS): { lead: T; members: T[] }[] {
  const out: { lead: T; members: T[]; key: string | null }[] = [];
  for (const row of rows) {
    const key = railRunKey(row[0]);
    const last = out[out.length - 1];
    if (last && key !== null && last.key === key && row[0].t - last.members[last.members.length - 1][0].t <= gap) last.members.push(row);
    else out.push({ lead: row, members: [row], key });
  }
  return out.map(({ lead, members }) => ({ lead, members }));
}

// Class names a stylesheet utility uses (Tailwind and kin): they say how an element looks, not what it is.
const UTILITY_CLASS = /^(?:-?(?:[mp][xytrbl]?|w|h|size|min|max|gap|space|inset|top|left|right|bottom|z|order|col|row|basis|grow|shrink|flex|grid|items|justify|self|place|content|text|font|leading|tracking|bg|from|via|to|border|rounded|ring|outline|shadow|opacity|transition|duration|ease|delay|animate|transform|translate|scale|rotate|cursor|select|pointer|overflow|whitespace|break|truncate|line|aspect|object|fill|stroke|divide|decoration|underline|sr|not|group|peer|block|inline|hidden|visible|invisible|absolute|relative|fixed|sticky|static|container|isolate|antialiased|uppercase|lowercase|capitalize|italic|appearance|resize|list|align|backdrop|blur|filter|drop|mix|will|touch|snap|scroll|dark|hover|focus|active|disabled|sm|md|lg|xl|2xl)(?:-|$)|\w*\d)/;

const TAG_WORD: Record<string, string> = { a: "link", img: "image", svg: "icon", path: "icon", li: "item", td: "cell", tr: "row", div: "element", span: "element" };

const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim().toLowerCase();

/**
 * An element named by its selector the way a person would: its tag (or role)
 * and whatever names it (a test id, an id, a form name, a class that says
 * what it is). When only utility classes are left, they are what identifies
 * it ("button .flex-shrink-0.p-1"); a bare tag reads as its kind.
 */
export function selectorName(selector: string, role?: string): string {
  const tag = /^([a-z][\w-]*)/i.exec(selector)?.[1]?.toLowerCase();
  const kind = role || (tag && TAG_WORD[tag]) || tag || "element";
  const quoted = /\[(?:data-testid|name)=("(?:[^"\\]|\\.)*"|[^\]]+)\]/.exec(selector)?.[1];
  let hint: string | undefined;
  if (quoted) {
    try {
      hint = JSON.parse(quoted);
    } catch {
      hint = quoted.replace(/^"|"$/g, "");
    }
  }
  hint ??= /#([A-Za-z][\w-]*)/.exec(selector)?.[1];
  hint ??= selector.split(".").slice(1).find((c) => c && !UTILITY_CLASS.test(c));
  if (hint) return `${kind} ${humanize(hint)}`;
  const classes = selector.split(".").slice(1).filter(Boolean).slice(0, 2);
  return classes.length ? `${kind} .${classes.join(".")}` : kind;
}

/** What a control names: its label (and visible text when different), else its text, else its icon and place, else its selector read as words, or "unknown element" when the recorder lost it. */
function clickTarget(e: Extract<ReplayEvent, { type: "click" | "input" | "submit" }>): { name: string; named: boolean } {
  if (e.label) return { name: e.type === "click" && e.text && e.text !== e.label ? `${e.label} (${e.text})` : e.label, named: true };
  if (e.type === "click" && e.text) return { name: e.text, named: true };
  // An icon-only control: what it shows and where it sits, read at import (rrweb.ts clickContext).
  if (e.type === "click" && e.context) return { name: e.context, named: true };
  // The page removed the element before the recording was read: say what kind it was, which the event type tells.
  if (!e.selector || /^\[rrweb-id=/.test(e.selector)) return { name: e.type === "click" ? "an element since removed" : "a field since removed", named: false };
  return { name: selectorName(e.selector, e.type === "click" ? e.role : undefined), named: false };
}

/**
 * The facts behind a person's action, for its expanded row: how it was named,
 * the locator, and where on the page it landed. Only the facts the recording has.
 */
export function actionDetail(e: ReplayEvent): { term: string; value: string; mono?: boolean }[] {
  if (e.type !== "click" && e.type !== "input" && e.type !== "submit") return [];
  const out: { term: string; value: string; mono?: boolean }[] = [];
  if (e.label) out.push({ term: "Label", value: e.label });
  if (e.type === "click" && e.text && e.text !== e.label) out.push({ term: "Text", value: e.text });
  if (e.type === "click" && e.role) out.push({ term: "Role", value: e.role });
  if (e.type === "click" && e.context) out.push({ term: "Context", value: e.context });
  if (e.type === "input") out.push({ term: "Typed", value: e.length === 0 ? "nothing (focus only)" : `${plural(e.length, "char")}, value never recorded` });
  out.push({ term: "Element", value: e.selector && !/^\[rrweb-id=/.test(e.selector) ? e.selector : "not in the capture (removed before it was read)", mono: true });
  if (e.type === "click" && e.x !== undefined && e.y !== undefined) out.push({ term: "At", value: `${Math.round(e.x)}, ${Math.round(e.y)} px`, mono: true });
  return out;
}

/** One line for an event in the rail, the scrubber's tooltips and the share text. */
export function describeEvent(e: ReplayEvent): string {
  switch (e.type) {
    case "nav": return e.title ? `${pathOf(e.url)} · ${e.title}` : pathOf(e.url);
    case "click": {
      const target = clickTarget(e);
      return target.named && e.role ? `${e.role} ${target.name}` : target.name;
    }
    case "input": return e.length === 0 ? clickTarget(e).name : `${clickTarget(e).name}, ${plural(e.length, "char")}`;
    case "submit": return clickTarget(e).name;
    case "key": return e.key;
    case "scroll": return `to ${Math.round(e.y)} of ${Math.round(e.of)}`;
    case "console": return e.message;
    case "network": return `${e.method} ${netPath(e.url)}`;
    case "error": return e.message;
    case "view": return "page outline";
    case "mark": return e.data ? `${e.name} ${JSON.stringify(e.data).slice(0, 120)}` : e.name;
  }
}

/** A request's endpoint as a person names it to hide it: method and path, no query. */
export function endpointOf(e: Extract<ReplayEvent, { type: "network" }>): string {
  return `${e.method} ${netPath(e.url).split("?")[0]}`;
}

/** The kinds n/p and [/] walk through: failures, and what the person did. */
export const isUserAction = (e: ReplayEvent) => e.type === "click" || e.type === "input" || e.type === "submit" || e.type === "nav";

/**
 * The next (dir 1) or previous (dir -1) event after or before `t` that `pick`
 * keeps, more than a frame away so a press always moves; null at the end.
 */
export function stepTo(events: readonly ReplayEvent[], t: number, dir: 1 | -1, pick: (e: ReplayEvent) => boolean): ReplayEvent | null {
  if (dir === 1) return events.find((e) => e.t > t + 50 && pick(e)) ?? null;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].t < t - 50 && pick(events[i])) return events[i];
  return null;
}

/**
 * When each linked issue first happens in this recording, by the group's
 * fingerprint (a replay issue's group ends in its fp), else its title. The
 * events are on the replay clock, so the times are seekable as they are.
 */
export function issueMoments(events: readonly ReplayEvent[], startUrl: string | null, groups: readonly { _id: string; title: string; fingerprint?: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!groups.length || !events.length) return out;
  const found = replayIssues(events, startUrl ?? undefined, 0);
  for (const g of groups) {
    const hit = found.find((i) => g.fingerprint && (g.fingerprint === i.fp || g.fingerprint.endsWith(`:${i.fp}`))) ?? found.find((i) => i.title === g.title);
    if (hit) out.set(g._id, hit.t);
  }
  return out;
}

/** Whether an event's text holds a search, case aside. */
export function eventHas(e: ReplayEvent, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const extra = e.type === "network" ? `${e.url} ${e.status}` : e.type === "error" ? e.stack ?? "" : e.type === "click" || e.type === "input" || e.type === "submit" ? e.selector : "";
  return `${e.type} ${describeEvent(e)} ${extra}`.toLowerCase().includes(needle);
}

/**
 * How busy each of `n` slices of the recording was (0 to 1), counting what
 * the person did: the activity strip under the scrubber.
 */
export function activityBins(events: readonly ReplayEvent[], length: number, n: number): number[] {
  const bins = new Array<number>(n).fill(0);
  if (length <= 0) return bins;
  for (const e of events) {
    if (e.type === "view" || e.type === "console" || e.type === "network" || e.type === "mark") continue;
    bins[Math.min(n - 1, Math.max(0, Math.floor((e.t / length) * n)))]++;
  }
  const peak = Math.max(1, ...bins);
  return bins.map((b) => (b === 0 ? 0 : Math.sqrt(b / peak)));
}

/** Where idle time ends if `t` is inside an idle range, else null: what skip inactivity jumps to. */
export function skipTarget(ranges: readonly { from: number; to: number }[], t: number): number | null {
  for (const r of ranges) if (t >= r.from && t < r.to - 50) return r.to;
  return null;
}

/** A moment as a reference (`rp-12@1:23`): alone on a line in a message, it plays the page there (ReplayMomentEmbed). */
export function momentRef(shortId: string, t: number): string {
  return `${shortId}@${formatCallTime(Math.floor(t / 1000) * 1000)}`;
}

// ── Starting a fix from a recording ──

export type ReplayFixReview = {
  replay: string;
  /** The page it happened on. */
  path: string;
  /** What the fix aims at: the headline issue (its id and title), else the first page error, console error or failed request. */
  failure: string | null;
  /** Linked issues by short id: each records the session once it starts. */
  issues: string[];
  /** The folder the session starts in, as the person knows it. */
  project: string | null;
  /** The folders it may start in instead (names), the chosen one among them; empty when there is no choice. */
  folders?: string[];
  /** Whether the folder is the one the recording's source is attached to, rather than a fallback. */
  fromSource?: boolean;
  /** The problem task the first issue was filed as. */
  task: string | null;
  /** Fix sessions already running on its issues. */
  running: number;
  prompt: string;
  showPrompt: boolean;
  togglePrompt: () => void;
};

/** The consequential review for "Start fix" on a replay (components/consequential): it starts an agent. */
export function replayFixLedger(r: ReplayFixReview): SwitchLedger {
  const lines = r.prompt.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    name: "Start a fix session",
    subject: `${r.replay} · ${r.path || "recording"}`,
    shift: null,
    ...(r.running ? { alert: r.running === 1 ? "A fix is already running on its issue" : `${r.running} of its issues already have a fix running` } : {}),
    figures: [{ value: "1", label: "session starts now" }],
    rows: [
      ...((r.folders?.length ?? 0) > 1 ? [] : [{ k: "Folder", v: r.project ?? "Where a new session starts", ...(r.project && r.fromSource !== false ? {} : { tone: "warn" as const }) }]),
      ...((r.folders?.length ?? 0) > 1 && r.fromSource === false ? [{ k: "Source", v: "No folder mapped", tone: "warn" as const }] : []),
      ...(r.failure ? [{ k: "Aims at", v: r.failure.length > 90 ? `${r.failure.slice(0, 90)}…` : r.failure, tone: "warn" as const }] : []),
      { k: "Works on", v: r.task ?? "No problem task yet" },
      { k: "Seeded with", v: "Replay, repro command, issues", list: r.showPrompt ? Array.from(new Set(lines)) : undefined, act: { label: r.showPrompt ? "Hide the prompt" : "Show the prompt", press: r.togglePrompt } },
      { k: "Recorded on", v: r.issues.length ? r.issues.join(", ") : "Nothing: no linked issue", ...(r.issues.length ? {} : { tone: "warn" as const }) },
      { k: "Merges", v: MERGES_NEVER, tone: "ok" },
    ],
    ...((r.folders?.length ?? 0) > 1 && r.project ? { pick: { k: "Folder", options: r.folders!, value: r.project } } : {}),
    stop: "Stop from its session",
    confirm: "Start the session",
    keep: "Not now",
  };
}

/** Why the page capture could not be shown, as a cause a person can act on rather than the player's own wording. */
export function stageProblemText(problem: string): string {
  if (/larger than a capture may be|too large/i.test(problem)) return "This stretch is too large to load";
  if (/expired/i.test(problem)) return "The player link expired";
  if (/no full snapshot|nothing to draw|cannot draw|stored before its screens/i.test(problem)) return "Nothing in this capture can be drawn";
  if (/missing|answered 40[34]/i.test(problem)) return "Part of the capture is missing";
  if (/could not be read/i.test(problem)) return "The capture could not be read";
  if (/not available/i.test(problem)) return "This replay is not available to you";
  return problem.replace(/[.\s]+$/, "");
}

/** Where the vendor shows one recording, when the source says enough to build the address (Sentry's org, PostHog's web URL). */
export function vendorRecordingUrl(provider: string, externalId: string, source: { config?: { org?: string } | null; vendor_web_url?: string | null } | undefined): string | null {
  if (provider === "sentry" && source?.config?.org) return `https://${encodeURIComponent(source.config.org)}.sentry.io/replays/${encodeURIComponent(externalId)}/`;
  if (provider === "posthog" && source?.vendor_web_url) return `${source.vendor_web_url}/replay/${encodeURIComponent(externalId)}`;
  return null;
}

/** A run's failures folded by reason: one shared reason is said once, above the ids. */
export function failureReasons(failures: readonly { id: string; error: string }[]): { error: string; ids: string[] }[] {
  const by = new Map<string, string[]>();
  for (const f of failures) by.set(f.error, [...(by.get(f.error) ?? []), f.id]);
  return [...by.entries()].map(([error, ids]) => ({ error, ids })).sort((a, b) => b.ids.length - a.ids.length);
}

/** How the backlog moved since the recount before the last: "−12 in 1h 5m", or null when there is no earlier recount. */
export function restTrend(r: NonNullable<OpsSource["replay_rest"]>, now: number): { text: string; tone: "down" | "up" | "flat" } | null {
  if (!r.prev) return null;
  const d = r.cut - r.prev.cut;
  const span = relTimeShort(r.prev.at, now);
  return { text: d === 0 ? `no change in ${span}` : `${d < 0 ? "−" : "+"}${Math.abs(d).toLocaleString()} in ${span}`, tone: d < 0 ? "down" : d > 0 ? "up" : "flat" };
}
