// The Issues list's query as the address carries it, its filters, sort,
// facets and counts. No React, no store.
import { bucketSeries, GROUP_RULES, type GroupKind } from "@codecast/shared/contracts/ingest";
import type { OpsEvent, OpsGroup, OpsSource } from "./opsTypes";
import { DAY, HOUR, issueState } from "./issueState";
import { asTask, creditedTask, FIX_STAGES, fixStage, type FixStage, type FixTask, someoneOnIt } from "./issueFixStage";
import { escalation, isFlapping, issueLane, type IssueLane, LANE_FILTERS, laneAdmits, type LaneFilter, partitionLane, QUIET_DAYS, storedFailures } from "./issueLanes";
import { dailySeries } from "./issueChart";

/** Open groups as the list's Open counts them (open, regressed, and checks currently fine), narrowed to a source: the Issues badge. */
export function openIssueCount(rows: OpsGroup[], sourceId: string | null): number {
  let n = 0;
  for (const g of rows) if ((!sourceId || g.source_id === sourceId) && statusAdmits("open", g)) n++;
  return n;
}

/** Whether the open feeder came back full, so the store may not hold every open group: the one test every open count passes `issueTotals`. */
export const openFeederFull = (rows: readonly Pick<OpsGroup, "status">[], limit: number): boolean => rows.filter((g) => g.status === "open").length >= limit;

/** The list's totals per status: exact where the server counted them, else what the store holds. */
export type IssueTotals = { open: number; resolved: number; ignored: number; all: number; /** False when Open is only what the store holds past a full open feeder. */ exact: boolean };

/**
 * The workspace's (or one source's) issues per status, for the Issues
 * badge and the list's status segment. The store's rows are exact while the
 * open feeder is not full (`capped` false) and paint a person's triage at
 * once. Past it, the sources' own counts take over: each source's open count
 * moves with every ingest and triage and is recounted on the server, and its
 * settled counts come from that recount. A source not counted yet leaves the
 * totals as the store's, with Open marked as a floor.
 */
export function issueTotals(rows: OpsGroup[], sources: Pick<OpsSource, "_id" | "groups_open" | "group_counts">[], sourceId: string | null, capped: boolean): IssueTotals {
  const local = { open: 0, resolved: 0, ignored: 0 };
  for (const g of rows) {
    if (sourceId && g.source_id !== sourceId) continue;
    const s = issueState(g);
    if (s === "resolved") local.resolved++;
    else if (s === "ignored") local.ignored++;
    else local.open++;
  }
  const scoped = sourceId ? sources.filter((s) => s._id === sourceId) : sources;
  const counted = scoped.length > 0 && scoped.every((s) => !!s.group_counts);
  if (!counted) return { ...local, all: local.open + local.resolved + local.ignored, exact: !capped };
  // Open is taken source by source and summed, so the workspace's total is always the sum of the per-source counts (the
  // source filter, the Sources table): each source's held rows, and past a full feeder the larger of those and its counter.
  const heldOpen = new Map<string, number>();
  for (const g of rows) if (issueState(g) !== "resolved" && issueState(g) !== "ignored") heldOpen.set(g.source_id, (heldOpen.get(g.source_id) ?? 0) + 1);
  let open = 0;
  let resolved = 0;
  let ignored = 0;
  for (const s of scoped) {
    const held = heldOpen.get(s._id) ?? 0;
    open += capped ? Math.max(held, s.groups_open ?? s.group_counts!.open) : held;
    resolved += s.group_counts!.resolved;
    ignored += s.group_counts!.ignored;
  }
  const out = { open, resolved: Math.max(local.resolved, resolved), ignored: Math.max(local.ignored, ignored) };
  return { ...out, all: out.open + out.resolved + out.ignored, exact: true };
}

/**
 * Status and lane counts with the open issues the store does not hold
 * folded in. The open feeder holds the most recently seen, so the ones past
 * it are the least recently seen: quiet, when even the oldest one held is.
 * Only an unfiltered list takes the totals; a search or facet counts what
 * matched.
 */
export function withTotals(counts: IssueCounts, totals: IssueTotals, oldestOpenSeen: number | null, now: number): IssueCounts {
  const extra = Math.max(0, totals.open - counts.open);
  const out = { ...counts, open: counts.open + extra, resolved: totals.resolved, ignored: totals.ignored, all: totals.all };
  if (extra && oldestOpenSeen !== null && now - oldestOpenSeen > QUIET_DAYS * DAY) out.quiet += extra;
  return out;
}

/**
 * What a group's count counts, in the words every surface uses for it: an
 * error's events, a check's failed readings, a metric's readings over its
 * line, a job's failed runs. `short` is the list cell's unit (none for events,
 * the column's own word).
 */
export function countWords(kind: OpsGroup["kind"], n: number): { long: string; short: string | null; /** The unit a narrow count cell keeps ("rd", "run"), so a reading never passes for an event. */ tiny: string | null } {
  const one = n === 1;
  if (kind === "check") return { long: one ? "failed reading" : "failed readings", short: one ? "reading" : "readings", tiny: "rd" };
  if (kind === "metric") return { long: one ? "reading over the line" : "readings over the line", short: one ? "reading" : "readings", tiny: "rd" };
  if (kind === "job") return { long: one ? "failed run" : "failed runs", short: one ? "run" : "runs", tiny: one ? "run" : "runs" };
  return { long: one ? "event" : "events", short: null, tiny: null };
}

/**
 * When a group last went wrong, which is what the list's Seen means. A check
 * or metric that recovered keeps reading after it passes, so its last_seen
 * is a passing reading: its last failure ran up to the recovery.
 */
export function lastFailedAt(g: Pick<OpsGroup, "kind" | "last_seen"> & Partial<Pick<OpsGroup, "resolved_at" | "meta" | "status">>): number {
  if ((g.kind === "check" || g.kind === "metric") && g.meta?.ok === true && g.resolved_at !== undefined) return Math.min(g.last_seen, g.resolved_at);
  return g.last_seen;
}

/** What a group's count counts, as one key: rows of one unit rank together under the Count sort. */
export type CountUnit = "events" | "runs" | "failed readings" | "readings over the line";
export function countUnit(kind: OpsGroup["kind"]): CountUnit {
  return kind === "job" ? "runs" : kind === "check" ? "failed readings" : kind === "metric" ? "readings over the line" : "events";
}
const COUNT_UNIT_RANK: Record<CountUnit, number> = { events: 0, runs: 1, "failed readings": 2, "readings over the line": 3 };

/** The list's count column named for what its rows count: Events, Readings or Runs, and Count when the rows count different things. */
export function countColumnLabel(rows: Pick<OpsGroup, "kind">[]): string {
  const words = new Set(rows.map((r) => countWords(r.kind, 2).short ?? "events"));
  if (words.size !== 1) return rows.length ? "Count" : "Events";
  const w = [...words][0];
  return w[0].toUpperCase() + w.slice(1);
}

/**
 * How many people an issue hit, and whether that is a floor: a count that
 * began after the issue opened (users_since) is at least that many. Every
 * surface writes it the one way usersText does.
 */
export function usersOf(g: Pick<OpsGroup, "users" | "users_since" | "first_seen">): { n: number; floor: boolean } | null {
  return g.users ? { n: g.users, floor: !!g.users_since && g.users_since > g.first_seen } : null;
}

/** A people count in words: "2 users" when exact, "≥2 users" when a floor; `unit` false drops the word for a column cell. */
export function usersText(u: { n: number; floor: boolean }, unit = true, fmtN: (n: number) => string = (n) => n.toLocaleString()): string {
  return `${u.floor ? "≥" : ""}${fmtN(u.n)}${unit ? ` ${u.n === 1 ? "user" : "users"}` : ""}`;
}

/** Whether any of the rows counts people: when none does, a Users column is a column of dashes and its sort does nothing. */
export function usersCounted(rows: Pick<OpsGroup, "users">[]): boolean {
  return rows.some((g) => (g.users ?? 0) > 0);
}

// ── The list's query, as the address carries it ──

export type StatusFilter = "open" | "regressed" | "resolved" | "ignored" | "all";
/** The status segment. Regressed is a lane of Open; `status=regressed` in an old link still reads as that lane. */
export const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
  { key: "ignored", label: "Ignored" },
  { key: "all", label: "All" },
];

/** Placeholders an SDK sends when it has no release; they name nothing, so they render as no release at all. */
const NO_RELEASE = new Set(["unknown", "undefined", "null", "none", "n/a", "-"]);

/** A release worth naming, or undefined for none or a placeholder like "unknown". */
export function knownRelease(r: string | null | undefined): string | undefined {
  const v = r?.trim();
  return v && !NO_RELEASE.has(v.toLowerCase()) ? v : undefined;
}

export type IssueSort = "urgency" | "last" | "first" | "events" | "users" | "trend";
export const ISSUE_SORTS: { key: IssueSort; label: string }[] = [
  { key: "urgency", label: "Urgency" },
  { key: "last", label: "Last seen" },
  { key: "first", label: "First seen" },
  { key: "events", label: "Count" },
  { key: "users", label: "Users" },
  { key: "trend", label: "Trend" },
];

/** The spark window: hourly over what the server keeps hourly (GROUP_RULES.bucket_hours), daily over 30 days. */
export type SparkRange = "24h" | "72h" | "30d";
export const SPARK_RANGES: SparkRange[] = ["24h", "72h", "30d"];
export const SPARK_HOURS: Record<SparkRange, number> = { "24h": 24, "72h": GROUP_RULES.bucket_hours, "30d": 30 * 24 };

/** A row's spark values for a window: hourly counts, or daily ones past the hourly window. */
export function sparkSeries(g: Pick<OpsGroup, "buckets" | "days" | "first_seen">, now: number, range: SparkRange): number[] {
  const hours = SPARK_HOURS[range];
  return hours > GROUP_RULES.bucket_hours ? dailySeries(g, now, hours / 24).map((b) => b.count) : bucketSeries(g.buckets, now, hours);
}

export type FacetKey = "level" | "type" | "release" | "fix";
export type IssueQuery = {
  status: StatusFilter;
  /** Inside Open only: which lane. */
  lane: LaneFilter;
  kind: GroupKind | null;
  q: string;
  sort: IssueSort;
  range: SparkRange;
  facets: Partial<Record<FacetKey, string>>;
  /** Only issues whose problem task the viewer answers for. */
  mine: boolean;
  /** Only issues nobody is on (someoneOnIt): the Overview's Nobody on it, as a list. */
  nobody?: boolean;
};

export const DEFAULT_QUERY: IssueQuery = { status: "open", lane: "attention", kind: null, q: "", sort: "urgency", range: "72h", facets: {}, mine: false };

const FACET_KEYS: FacetKey[] = ["level", "type", "release", "fix"];

/** Severities, the only values the Level facet offers. Anything else a source sends as a level (request, rage_click) is a type. */
const SEVERITIES = ["fatal", "critical", "error", "warning", "warn", "info", "log", "debug"];
export function isSeverity(level: string | undefined): boolean {
  return !!level && SEVERITIES.includes(level.toLowerCase());
}
const oneOf = <T extends string>(v: string | null, all: readonly T[], fallback: T): T => (v && (all as readonly string[]).includes(v) ? (v as T) : fallback);

/**
 * The query from the address's keys the flows workspace already carries
 * (lib/line/lineWorkspaceUrl): status, kind, q, sort, win, and `show` for
 * the facets as `level:error,release:1.2` (and `mine:1` for the Mine filter).
 */
export function parseIssueQuery(get: (key: string) => string | null): IssueQuery {
  const facets: IssueQuery["facets"] = {};
  for (const part of (get("show") ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const k = part.slice(0, i) as FacetKey;
    if (!FACET_KEYS.includes(k)) continue;
    try {
      facets[k] = decodeURIComponent(part.slice(i + 1));
    } catch {
      /* a mangled value filters nothing */
    }
  }
  const rawStatus = get("status");
  const legacyRegressed = rawStatus === "regressed";
  return {
    status: legacyRegressed ? "open" : oneOf(rawStatus, STATUS_FILTERS.map((f) => f.key), DEFAULT_QUERY.status),
    lane: legacyRegressed ? "regressed" : oneOf(get("lane"), LANE_FILTERS.map((f) => f.key), DEFAULT_QUERY.lane),
    kind: (get("kind") || null) as GroupKind | null,
    q: get("q") ?? "",
    sort: oneOf(get("sort"), ISSUE_SORTS.map((s) => s.key), DEFAULT_QUERY.sort),
    range: oneOf(get("win"), SPARK_RANGES, DEFAULT_QUERY.range),
    facets,
    mine: (get("show") ?? "").split(",").includes("mine:1"),
    ...((get("show") ?? "").split(",").includes("nobody:1") ? { nobody: true } : {}),
  };
}

/** The address keys for a query; a default writes nothing, so a clean list has a clean address. */
export function issueQueryParams(q: IssueQuery): Record<"status" | "lane" | "kind" | "q" | "sort" | "win" | "show", string | null> {
  const show = [...FACET_KEYS.filter((k) => q.facets[k]).map((k) => `${k}:${encodeURIComponent(q.facets[k]!)}`), ...(q.mine ? ["mine:1"] : []), ...(q.nobody ? ["nobody:1"] : [])].join(",");
  return {
    status: q.status === DEFAULT_QUERY.status ? null : q.status,
    lane: q.status !== "open" || q.lane === DEFAULT_QUERY.lane ? null : q.lane,
    kind: q.kind,
    q: q.q.trim() || null,
    sort: q.sort === DEFAULT_QUERY.sort ? null : q.sort,
    win: q.range === DEFAULT_QUERY.range ? null : q.range,
    show: show || null,
  };
}

export function statusAdmits(status: StatusFilter, g: OpsGroup): boolean {
  if (status === "all") return true;
  const s = issueState(g);
  if (status === "open") return s === "open" || s === "regressed" || s === "ok";
  return s === status;
}

/** The status and, inside Open, the lane. */
export function queryAdmits(q: Pick<IssueQuery, "status" | "lane">, g: OpsGroup, now: number, ctx?: Pick<IssueCtx, "failures">): boolean {
  // Flapping holds every flapper, the ones that read resolved between flips too.
  if (q.status === "open" && q.lane === "flapping") return isFlapping(g, flapsOf(g, now, ctx));
  if (!statusAdmits(q.status, g)) return false;
  return q.status !== "open" || laneAdmits(q.lane, partitionLane(g, laneOf(g, now, ctx), now));
}

/** Every word of the search must appear in the title, culprit, id, release or level. */
export function searchAdmits(q: string, g: OpsGroup): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [g.title, g.culprit, g.short_id, g.last_release, g.first_release, g.level].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * `taskStatus` answers a problem task's facts (or its status category alone)
 * as this device holds them. `failures` counts a check or metric's flips to
 * failing over the events at hand (failuresIn); without it a lane reads the
 * server's list alone. `latestRelease` is what the Release facet's "latest"
 * names.
 */
export type IssueCtx = { sourceId?: string; taskStatus: (taskId: string) => FixTask | string | undefined; failures?: (g: OpsGroup) => number; latestRelease?: string | null; me?: string | null };

/** A group's flips to failing under a context: over its events when it has them, else the server's list. */
export function flapsOf(g: OpsGroup, now: number, ctx?: Pick<IssueCtx, "failures">): number {
  return ctx?.failures ? ctx.failures(g) : storedFailures(g, now);
}

/**
 * Who answers for a group: its problem task's assignee, as this device holds
 * the task, and only when that task was filed for this issue (creditedTask).
 * A task filed for another title owns nothing here. The list's face, its Mine
 * filter and the page's header all read this one rule.
 */
export function issueOwner(g: Pick<OpsGroup, "signal_task_id" | "title">, ctx: Pick<IssueCtx, "taskStatus">): string | null {
  const t = g.signal_task_id ? asTask(ctx.taskStatus(g.signal_task_id)) : undefined;
  return taskOwner(g, t);
}

/** The owner a problem task gives an issue: its assignee when the task is credited with the issue, else nobody. */
export function taskOwner(g: Pick<OpsGroup, "title">, task: FixTask | null | undefined): string | null {
  return creditedTask(g, task)?.assignee ?? null;
}

/** A group's lane under a context: its flips counted over the context's events when it has them. */
export function laneOf(g: OpsGroup, now: number, ctx?: Pick<IssueCtx, "failures">): IssueLane | null {
  return issueLane(g, now, ctx?.failures ? ctx.failures(g) : undefined);
}

/** The Release facet's value for the newest release, resolved against the context. */
export const LATEST_RELEASE = "latest";

/** Whether someone is on a group under a context (someoneOnIt over its problem task as this device holds it). */
export function issueOnIt(g: Pick<OpsGroup, "signal_task_id" | "fix_conversation_id">, ctx: Pick<IssueCtx, "taskStatus">): boolean {
  return someoneOnIt(g.fix_conversation_id, g.signal_task_id ? ctx.taskStatus(g.signal_task_id) : undefined);
}

export function issueFixStage(g: OpsGroup, ctx: Pick<IssueCtx, "taskStatus">): FixStage {
  return taskFixStage(g, g.signal_task_id ? ctx.taskStatus(g.signal_task_id) : undefined);
}

/**
 * Where an issue's fix stands, read with its problem task as stored. A task
 * filed for another title (creditedTask) says nothing about this issue's fix,
 * and nothing is waiting on it either: the issue reads "other", unless a fix
 * session started on the issue itself. Every surface reads the stage here.
 */
export function taskFixStage(g: Pick<OpsGroup, "title"> & Parameters<typeof fixStage>[0], task: FixTask | string | undefined): FixStage {
  if (typeof task === "string" || !task) return fixStage(g, task);
  const credited = creditedTask(g, task);
  if (credited) return fixStage(g, credited);
  const own = fixStage(g, undefined);
  return own === "filed" ? "other" : own;
}

/** Everything but the status: what the status segment's counts are taken over. */
export function admitsBesidesStatus(q: IssueQuery, g: OpsGroup, ctx: IssueCtx): boolean {
  if (ctx.sourceId && g.source_id !== ctx.sourceId) return false;
  if (q.kind && g.kind !== q.kind) return false;
  if (q.facets.level && g.level !== q.facets.level) return false;
  if (q.facets.type && g.level !== q.facets.type) return false;
  if (q.facets.release) {
    const rel = q.facets.release === LATEST_RELEASE ? ctx.latestRelease : q.facets.release;
    if (!rel || (g.last_release !== rel && g.first_release !== rel)) return false;
  }
  if (q.facets.fix && issueFixStage(g, ctx) !== q.facets.fix) return false;
  if (q.mine && (!ctx.me || issueOwner(g, ctx) !== ctx.me)) return false;
  if (q.nobody && issueOnIt(g, ctx)) return false;
  return searchAdmits(q.q, g);
}

/** Change over the last 24 hours against the 24 before: what "Trend" sorts by. */
export function trendOf(g: Pick<OpsGroup, "buckets">, now: number): { recent: number; prior: number; delta: number } {
  const s = bucketSeries(g.buckets, now, 48);
  const prior = s.slice(0, 24).reduce((a, b) => a + b, 0);
  const recent = s.slice(24).reduce((a, b) => a + b, 0);
  return { recent, prior, delta: recent - prior };
}

const SORT_KEY: Record<IssueSort, (g: OpsGroup, now: number) => number> = {
  urgency: (g) => g.last_seen,
  last: (g) => lastFailedAt(g),
  first: (g) => g.first_seen,
  events: (g) => g.count,
  users: (g) => g.users ?? 0,
  trend: (g, now) => trendOf(g, now).delta,
};

const LANE_PIN: Record<IssueLane, number> = { regressed: 3, escalating: 2, new: 1, firing: 0, flapping: 0, ongoing: 0, quiet: 0 };

const SEVERITY_WEIGHT: Record<string, number> = { fatal: 4, critical: 4, error: 3, warning: 1.5, warn: 1.5 };

/**
 * How urgent an issue in Needs attention is: its lane's weight, its
 * severity, how many it hit lately, and how recently, the last halving its
 * score every 12 hours of quiet. A loud fatal from an hour ago leads; a
 * warning that came back once two days ago sinks.
 */
export function attentionScore(g: OpsGroup, now: number, lane: IssueLane | null): number {
  const laneW = lane === "regressed" ? 1.5 : lane === "escalating" ? 1.4 : 1;
  const sev = g.kind === "check" || g.kind === "metric" || g.kind === "job" ? 2.5 : SEVERITY_WEIGHT[(g.level ?? "").toLowerCase()] ?? 1;
  const volume = 1 + Math.log10(1 + escalation(g, now).recent);
  const recency = 0.5 ** (Math.max(0, now - g.last_seen) / (12 * HOUR));
  return laneW * sev * volume * recency;
}

/**
 * The list in the chosen order, highest first, ties newest first. Urgency is
 * the only order that pins lanes: on it regressed issues lead (a fix that did
 * not hold is the first thing to see), then escalating, then new, and Needs
 * attention orders by attentionScore. A column sort (Events, Users, Trend,
 * first or last seen) orders the whole list strictly by its key.
 */
export function sortIssues(rows: OpsGroup[], sort: IssueSort, now: number, pinLanes: boolean, ctx?: Pick<IssueCtx, "failures">, byAttention = false): OpsGroup[] {
  const key = SORT_KEY[sort];
  const keyed = rows.map((g) => {
    const lane = pinLanes || byAttention ? laneOf(g, now, ctx) : null;
    // By urgency a regression still leads: a fix that did not hold is the first thing to see in any open list.
    if (byAttention) return { g, k: attentionScore(g, now, lane), pin: lane === "regressed" ? 1 : 0 };
    // A count is ranked against counts of the same thing: events, then failed runs, then readings, each by its own number.
    if (sort === "events") return { g, k: key(g, now), pin: -COUNT_UNIT_RANK[countUnit(g.kind)] };
    return { g, k: key(g, now), pin: lane ? LANE_PIN[lane] : 0 };
  });
  keyed.sort((a, b) => b.pin - a.pin || b.k - a.k || b.g.last_seen - a.g.last_seen);
  return keyed.map((x) => x.g);
}

export function filterIssues(rows: OpsGroup[], q: IssueQuery, ctx: IssueCtx, now: number): OpsGroup[] {
  const kept = rows.filter((g) => queryAdmits(q, g, now, ctx) && admitsBesidesStatus(q, g, ctx));
  const sort = effectiveSort(q);
  return sortIssues(kept, sort, now, q.sort === "urgency" && (q.status === "open" || q.status === "all"), ctx, sort === "urgency");
}

/** The order a list is in: Urgency ranks open issues only; a settled list reads it as last seen. */
export function effectiveSort(q: Pick<IssueQuery, "sort" | "status">): IssueSort {
  return q.sort === "urgency" && q.status !== "open" ? "last" : q.sort;
}

export type IssueCounts = Record<StatusFilter, number> & Record<LaneFilter, number>;

/** A segment's count. The "all" lane is every open issue, never every status. */
export function laneCount(counts: IssueCounts, lane: LaneFilter): number {
  return lane === "all" ? counts.open : counts[lane];
}

/** Each status and each open lane's count, over everything but the status and lane. */
export function statusCounts(rows: OpsGroup[], q: IssueQuery, ctx: IssueCtx, now: number = Date.now()): IssueCounts {
  const out: IssueCounts = { open: 0, regressed: 0, resolved: 0, ignored: 0, all: 0, attention: 0, escalating: 0, new: 0, firing: 0, flapping: 0, ongoing: 0, quiet: 0 };
  for (const g of rows) {
    if (!admitsBesidesStatus(q, g, ctx)) continue;
    out.all++;
    const s = issueState(g);
    if (s === "resolved") out.resolved++;
    if (s === "ignored") out.ignored++;
    if (isFlapping(g, flapsOf(g, now, ctx))) out.flapping++;
    const lane = partitionLane(g, laneOf(g, now, ctx), now);
    if (!lane) continue;
    out.open++;
    out[lane]++;
    if (laneAdmits("attention", lane)) out.attention++;
  }
  return out;
}

/**
 * The rows a facet counts over: everything the list's query admits with that
 * one facet let go, so each option's count is how many rows picking it would
 * show. "kind" lets go of the kind, "source" of the source.
 */
export function facetRows(rows: OpsGroup[], q: IssueQuery, ctx: IssueCtx, now: number, key: FacetKey | "kind" | "source"): OpsGroup[] {
  const facets = { ...q.facets };
  if (key !== "kind" && key !== "source") delete facets[key];
  const q2: IssueQuery = { ...q, facets, kind: key === "kind" ? null : q.kind };
  const ctx2 = key === "source" ? { ...ctx, sourceId: undefined } : ctx;
  return rows.filter((g) => queryAdmits(q2, g, now, ctx2) && admitsBesidesStatus(q2, g, ctx2));
}

/** A facet's values over the rows, most common first: the dropdown's options with their counts. */
export function facetOptions(rows: OpsGroup[], key: FacetKey, ctx: IssueCtx): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const g of rows) {
    const v =
      key === "level" ? (isSeverity(g.level) ? g.level : undefined)
      : key === "type" ? (g.level && !isSeverity(g.level) && g.level !== "none" ? g.level : undefined)
      : key === "release" ? g.last_release
      : issueFixStage(g, ctx);
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const out = [...counts].map(([value, count]) => ({ value, count }));
  return key === "fix" ? out.sort((a, b) => FIX_STAGES.indexOf(a.value as FixStage) - FIX_STAGES.indexOf(b.value as FixStage)) : out.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** A picked value stays among the options at a count of zero, so the select still names what filters the list. */
export function withPicked<T extends { value: string; count: number }>(options: T[], picked: string | undefined, make: (value: string) => T): T[] {
  return !picked || options.some((o) => o.value === picked) ? options : [make(picked), ...options];
}

/**
 * When each release appeared: its first deploy this device holds, else the
 * first time any group was seen in it. Newest first is the order the Release
 * facet offers them in.
 */
export function releaseTimes(groups: Pick<OpsGroup, "source_id" | "first_seen" | "last_seen" | "first_release" | "last_release">[], events: OpsEvent[], sourceId?: string): Map<string, number> {
  const out = new Map<string, number>();
  const take = (rel: string | undefined, at: number) => {
    if (rel && (!out.has(rel) || at < out.get(rel)!)) out.set(rel, at);
  };
  for (const e of events) if (e.kind === "deploy" && (!sourceId || e.source_id === sourceId)) take(e.data?.release, e.created_at);
  const deployed = new Set(out.keys());
  for (const g of groups) {
    if (sourceId && g.source_id !== sourceId) continue;
    if (g.first_release && !deployed.has(g.first_release)) take(g.first_release, g.first_seen);
    if (g.last_release && !deployed.has(g.last_release) && g.last_release !== g.first_release) take(g.last_release, g.last_seen);
  }
  return out;
}

/** Release options newest first, each with when it appeared. */
export function releaseOptions(options: { value: string; count: number }[], times: Map<string, number>): { value: string; count: number; at: number | null }[] {
  return options.map((o) => ({ ...o, at: times.get(o.value) ?? null })).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.count - a.count);
}

/** The newest release over the rows' own releases, by releaseTimes. */
export function latestRelease(times: Map<string, number>, among: Iterable<string>): string | null {
  let best: string | null = null;
  for (const r of among) if (times.has(r) && (best === null || times.get(r)! > times.get(best)!)) best = r;
  return best;
}

/** The rows a shift-click selects: every row between the anchor and the target, inclusive, in list order. */
export function rangeIds(order: string[], anchor: string | null, target: string): string[] {
  const b = order.indexOf(target);
  const a = anchor ? order.indexOf(anchor) : -1;
  if (a < 0 || b < 0) return [target];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}
