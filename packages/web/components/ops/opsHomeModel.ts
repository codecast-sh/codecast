// The Ops home's readings: is anything wrong right now, across every source.
// One ranked list mixes the kinds that can be wrong (a watch alerting, an
// issue that regressed, spiked or is new, a replay that caught errors, a
// source that stopped or is failing), each with the counts the home's filters
// show, the Overview tab wears and the sidebar badge reads. A source's health
// is always the one reading in sourceHealth.ts, never a second rule here. Pure: no React, no store, so every rule here is
// tested on its own.
import { bucketSeries } from "@codecast/shared/contracts/ingest";
import type { SourceProvider } from "@codecast/shared/contracts/ingest";
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";
import type { OpsGroup, OpsReplay, OpsSource, OpsWatch } from "./opsTypes";
import { SOURCE_PROVIDER_LABEL } from "./parts";
import { formatCallTime } from "@codecast/shared/entities";
import { replayTitle } from "./opsModel";
import type { OpsHomeShow } from "./opsPaths";
import type { SourceHealth } from "./sourceHealth";
import { WATCH_STATES, sortWatches, watchHealth, watchRetrying as metricWatchRetrying, watchState, watchStateCounts, type WatchState } from "./metricModel";
import { attentionLane, escalation, foldIssueRows, regressedAt, someoneOnIt, type AttentionLane } from "./issuesModel";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** How recent a transition must be to count as happening now. */
export const ATTENTION_WINDOW_MS = DAY;

// ── A source's health ──

/** Whether a source's one reading (sourceHealth.ts) asks a person to act: stopped, failing, its connection lost. */
export function healthBad(h: Pick<SourceHealth, "tone"> | undefined): boolean {
  return !!h && (h.tone === "bad" || h.tone === "warn");
}

/**
 * Whether a source is down: nothing comes through (stopped, its connection
 * gone, halted on an error). A source still sending whose import, poll or a
 * reader fails is degraded, not down: amber, and it pages nobody.
 */
export function sourceDown(h: Pick<SourceHealth, "tone"> & Partial<Pick<SourceHealth, "level">>, s: Pick<OpsSource, "status">): boolean {
  return h.level ? h.level === "down" : h.tone === "bad" || s.status === "error";
}

// ── The attention list ──

export type AttentionState = "alerting" | "check" | "regressed" | "escalating" | "new" | "firing" | "errors" | "reader" | "erroring" | "source" | "degraded";

/** The part of a task the list reads: whether anyone is on it. */
export type AttentionTask = { short_id?: string; status?: string; assignee?: string | null };

type Base = {
  key: string;
  state: AttentionState;
  /** 3 is a page; 1 is worth a look. */
  severity: 1 | 2 | 3;
  /**
   * When it entered the state it is listed under (the Started column, the
   * order, and the new-since-your-last-visit mark): an alert's start, the
   * regression, the spike's first hour, first seen, a reader's first failure,
   * a source's last event before it stopped. Never its latest event, so an
   * ongoing problem holds one time from load to load.
   */
  at: number;
  /** Other states it holds as well (an alerting watch whose issue regressed): its tiles count it under each, so every tile equals its lane. */
  also?: AttentionState[];
  /** The Issues lane of every issue the row holds, one entry per issue (a folded row holds several): the issue tiles count these, so each equals its lane in the Issues list. */
  lanes?: AttentionLane[];
  /** How many of the issues the row holds nobody is on (someoneOnIt, issue by issue): Nobody on it counts these, as the Issues list's Nobody on it does. */
  unowned?: number;
  /** How much of it there is: an issue's events in the last day. Orders rows inside a severity. */
  volume: number;
  sourceId: string | null;
  /** The task a fix is filed under, when one is. */
  taskId: string | null;
  /** That task as the store holds it, when it does. */
  task: AttentionTask | null;
  /** The session someone started to fix it, when one is. */
  sessionId: string | null;
};

export type AttentionItem =
  | (Base & { kind: "watch"; watch: OpsWatch; group: OpsGroup | null })
  /**
   * One failing reader of a source and every watch it leaves blind, as one
   * row: the cause is listed once (never once per watch, never again as the
   * source), `watches` are the blind ones behind its expander, worst first.
   */
  | (Base & { kind: "reader"; source: OpsSource; health: SourceHealth & { starves: NonNullable<SourceHealth["starves"]> }; watches: OpsWatch[]; blind: number })
  /**
   * An open issue on the list. `variants`, when present, are the issues one
   * root cause produced (same source, kind and release, titles that differ in
   * one parameter): the row is listed once, for all of them, `group` the
   * busiest and first in `variants`.
   */
  | (Base & { kind: "issue"; group: OpsGroup; replay: OpsReplay | null; replays: number; variants?: OpsGroup[] })
  /** Replays from the last day that caught one error: one row per issue they name (or per replay that names none), the newest first in `replays`. */
  | (Base & { kind: "replay"; replay: OpsReplay; replays: OpsReplay[]; group: OpsGroup | null; users: number; /** The device holds only part of the last day's replays: its counts are floors ("1,000+"). */ partial?: boolean })
  | (Base & { kind: "source"; source: OpsSource; health: SourceHealth });

export type AttentionInput = {
  sources: OpsSource[];
  groups: OpsGroup[];
  watches: OpsWatch[];
  replays: OpsReplay[];
  /** A task by _id, from the store. */
  taskOf?: (id: string) => AttentionTask | undefined;
  /** The replay feed came back full: replays older than the oldest held may be missing. */
  replaysCapped?: boolean;
  /** A check or metric's failures in the flap window, as the Issues list counts them (useIssueFailures), so a flapper sits in the same lane on both. */
  failures?: (g: OpsGroup) => number;
};

const LOUD_LEVELS = new Set(["fatal", "error", "critical"]);

/** Whether a watch is alerting now: an active watch past its line. */
export function watchAlerting(w: Pick<OpsWatch, "state" | "status">): boolean {
  return w.state === "alert" && w.status !== "paused";
}

/** What the Metrics tab's count counts: a watch alerting, or one that cannot read. The tab and the palette read this one rule. */
export function watchNeedsLook(w: OpsWatch): boolean {
  return watchAlerting(w) || watchHealth(w) === "error";
}

/** A new issue this size (events, or two people) is worth more than one seen once. */
export const SIZABLE_EVENTS = 10;

const dayVolume = (g: Pick<OpsGroup, "buckets">, now: number) => bucketSeries(g.buckets, now, 24).reduce((a, b) => a + b, 0);

/**
 * Why an open issue is on the list now, or null when it is not: the Issues
 * list's own attention lane (issuesModel attentionLane), so the home's
 * Regressed, Escalating and New tiles count exactly what those lanes hold.
 */
export function issueAttention(g: OpsGroup, now: number, failures?: number): { state: AttentionLane; regressed: boolean; spike: ReturnType<typeof escalation> | null; fresh: boolean } | null {
  const lane = attentionLane(g, now, failures);
  if (!lane) return null;
  return { state: lane, regressed: lane === "regressed", spike: lane === "escalating" ? escalation(g, now) : null, fresh: lane === "new" };
}

/**
 * When an escalating issue began to escalate: the server's spike transition
 * when it named one in the last day, else the first hour of the last day that
 * ran past three times its usual hour. Bucketed by the hour, so it holds from
 * one load to the next.
 */
export function spikeStart(g: Pick<OpsGroup, "buckets" | "last_transition" | "last_transition_at" | "last_seen">, now: number): number {
  if (g.last_transition === "spike" && g.last_transition_at && g.last_transition_at > now - DAY) return g.last_transition_at;
  const hours = bucketSeries(g.buckets, now, 24);
  const usual = escalation(g, now).baseline / 24;
  const i = hours.findIndex((n) => n > 0 && n >= 3 * Math.max(usual, 1 / 24));
  const hourStart = Math.floor(now / HOUR) * HOUR;
  return i < 0 ? g.last_seen : hourStart - (hours.length - 1 - i) * HOUR;
}

/** When a firing issue's current run began: the first hour of the last day it fired in, so it holds from one load to the next. */
export function firingStart(g: Pick<OpsGroup, "buckets" | "last_seen">, now: number): number {
  const hours = bucketSeries(g.buckets, now, 24);
  const i = hours.findIndex((n) => n > 0);
  const hourStart = Math.floor(now / HOUR) * HOUR;
  return i < 0 ? g.last_seen : hourStart - (hours.length - 1 - i) * HOUR;
}

/** When an issue entered the attention state it holds. */
export function issueStarted(g: OpsGroup, state: AttentionLane, now: number): number {
  return state === "regressed" ? regressedAt(g) ?? g.last_seen : state === "escalating" ? spikeStart(g, now) : state === "firing" ? firingStart(g, now) : g.first_seen;
}

/**
 * Everything wrong right now, worst first: alerting watches, issues that
 * regressed, spiked or opened in the last day, replays from the last day that
 * caught errors no listed issue already covers, and sources the one health
 * reading (sourceHealth.ts, passed as `healthOf`) calls stopped or failing.
 * An open check or metric group that reads fine now is not listed, and a
 * metric group is listed through its watch, once. Inside a severity, the
 * watches and sources lead (they are few and each is a page), then issues by
 * their volume, so a live error with hundreds of events sits above a new one
 * seen once.
 */
export function attentionItems(input: AttentionInput, now: number, healthOf: (s: OpsSource) => SourceHealth | undefined): AttentionItem[] {
  const since = now - ATTENTION_WINDOW_MS;
  const groupById = new Map(input.groups.map((g) => [g._id, g]));
  const taskOf = (id: string | null | undefined) => (id ? input.taskOf?.(id) ?? null : null);
  const out: AttentionItem[] = [];
  const watchGroups = new Set<string>();
  const healthById = new Map(input.sources.map((s) => [s._id, { source: s, health: healthOf(s) }]));
  const watchById = new Map(input.watches.map((w) => [w._id, w]));
  // The watches each source's failing reader leaves blind, by source: one row per reader, below.
  const blindBy = new Map<string, OpsWatch[]>();

  for (const w of input.watches) {
    // Only a watch that is a row (or rides its reader's row) lists its issue: one that reads fine leaves its issue to be listed as itself, as the Issues list does.
    if (w.group_id && (watchAlerting(w) || watchHealth(w) === "error")) watchGroups.add(w.group_id);
    const group = w.group_id ? groupById.get(w.group_id) ?? null : null;
    const taskId = group?.signal_task_id ?? null;
    // The issue a watch files is listed through the watch, once; the lane it sits in (regressed, escalating, new) rides along so that tile still counts it.
    const lane = group ? issueAttention(group, now, input.failures?.(group))?.state : undefined;
    if (watchAlerting(w)) {
      out.push({
        kind: "watch", key: `watch:${w._id}`, state: "alerting", severity: 3, volume: Infinity,
        at: group?.last_transition_at ?? group?.first_seen ?? w.last_at ?? w.updated_at,
        ...(lane ? { also: [lane], lanes: [lane] } : {}),
        sourceId: w.source_id, taskId, task: taskOf(taskId), sessionId: group?.fix_conversation_id ?? null, watch: w, group,
      });
    } else if (watchHealth(w) === "error") {
      // A watch that cannot read is blind, not its source down: listed as itself, with its error, under Watch errors.
      // When its source's reader is why, it folds into that reader's one row instead.
      if (healthById.get(w.source_id)?.health?.starves?.watchIds.includes(w._id)) {
        blindBy.set(w.source_id, [...(blindBy.get(w.source_id) ?? []), w]);
        continue;
      }
      out.push({
        kind: "watch", key: `watch-error:${w._id}`, state: "erroring", severity: 2, volume: w.missed ?? 1,
        // Blind since its last good read.
        at: w.last_at ?? w.updated_at,
        ...(lane ? { also: [lane], lanes: [lane] } : {}),
        sourceId: w.source_id, taskId, task: taskOf(taskId), sessionId: group?.fix_conversation_id ?? null, watch: w, group,
      });
    }
  }

  const replaysOf = new Map<string, OpsReplay[]>();
  for (const r of input.replays) for (const gid of r.group_ids) replaysOf.set(gid, [...(replaysOf.get(gid) ?? []), r]);
  for (const g of input.groups) {
    if (watchGroups.has(g._id)) continue;
    const reading = issueAttention(g, now, input.failures?.(g));
    if (!reading) continue;
    const { regressed, spike, fresh } = reading;
    const loud = g.kind !== "log" || LOUD_LEVELS.has(g.level ?? "");
    // A group born today has had every event today, whatever its buckets hold.
    const volume = Math.max(dayVolume(g, now), fresh ? g.count : 0);
    // One event seen once is worth a look; a new issue hitting many times or many people is worth more.
    const sizable = g.count >= SIZABLE_EVENTS || (g.users ?? 0) >= 2;
    const state = reading.state;
    const own = (replaysOf.get(g._id) ?? []).sort((a, b) => b.started_at - a.started_at);
    out.push({
      kind: "issue", key: `issue:${g._id}`, state, lanes: [state], unowned: someoneOnIt(g.fix_conversation_id, taskOf(g.signal_task_id)) ? 0 : 1,
      // A steady flood (firing) is the loudest thing that does not page: it sits with the sizable new issues, above the ones seen once.
      severity: regressed || spike ? 3 : state === "firing" || (loud && sizable) ? 2 : 1,
      at: issueStarted(g, state, now),
      volume,
      sourceId: g.source_id, taskId: g.signal_task_id ?? null, task: taskOf(g.signal_task_id), sessionId: g.fix_conversation_id ?? null,
      group: g, replay: own[0] ?? null, replays: own.length,
    });
  }

  foldVariants(out);

  // One row per root cause: replays naming the same issue fold into one row
  // that says how many replays and people it reached, the newest a click away.
  const signatures = new Map<string, OpsReplay[]>();
  // A full feed whose oldest replay is inside the window has not seen the whole day, so the counts it sums are floors.
  const partial = !!input.replaysCapped && input.replays.length > 0 && Math.min(...input.replays.map((r) => r.started_at)) > since;
  for (const r of input.replays) {
    if (r.started_at < since || r.counts.errors <= 0) continue;
    // A replay naming an issue the store holds is that issue's evidence: on its row when the issue needs a person, on its
    // page when not (ongoing, quiet, settled). A row of its own here would list an issue the Issues list's Needs attention
    // lane leaves out, so the home and that lane would hold two sets under one name.
    if (r.group_ids.some((id) => groupById.has(id))) continue;
    const sig = replaySignature(r, groupById);
    signatures.set(sig, [...(signatures.get(sig) ?? []), r]);
  }
  for (const [sig, rs] of signatures) {
    rs.sort((a, b) => b.started_at - a.started_at);
    const group = sig.startsWith("replays:") ? groupById.get(sig.slice(8)) ?? null : null;
    const users = replayUsers(rs);
    const errors = rs.reduce((n, r) => n + r.counts.errors, 0);
    const taskId = group?.signal_task_id ?? null;
    out.push({
      // The first of these replays in the window: a newer replay of the same error is not a new problem.
      kind: "replay", key: sig, state: "errors", severity: 1, at: rs[rs.length - 1].started_at,
      // Ranked by the people it reached, then by its errors (a fraction, so a person always outweighs an error).
      volume: users + Math.min(errors, 999) / 1000,
      sourceId: rs[0].source_id, taskId, task: taskOf(taskId), sessionId: group?.fix_conversation_id ?? null,
      replay: rs[0], replays: rs, group, users, ...(partial ? { partial } : {}),
    });
  }

  for (const s of input.sources) {
    const health = healthById.get(s._id)?.health;
    if (!health || !healthBad(health)) continue;
    // A failing reader is one row under Reader failing, whether or not a watch it feeds read badly last time: the reader,
    // how it fails, and the watches behind it (the blind ones first). It is the source's whole complaint (sourceHealth
    // names nothing else while it lasts), so the source is not listed again.
    if (health.starves) {
      const blind = blindBy.get(s._id) ?? [];
      const blindIds = new Set(blind.map((w) => w._id));
      const fed = (health.starves.feeds ?? []).map((id) => watchById.get(id)).filter((w): w is OpsWatch => !!w && !blindIds.has(w._id));
      blind.sort((a, b) => (b.missed ?? 0) - (a.missed ?? 0) || a.name.localeCompare(b.name));
      out.push({
        kind: "reader", key: `reader:${s._id}:${health.starves.reader.name}`, state: "reader", severity: 2,
        // When the reader started failing: the oldest failure its log holds, else the blind watches' last good read.
        at: health.since ?? health.starves.reader.since ?? (blind.length ? Math.max(...blind.map((w) => w.last_at ?? w.updated_at)) : s.updated_at),
        volume: blind.length, sourceId: s._id, taskId: null, task: null, sessionId: null,
        source: s, health: health as SourceHealth & { starves: NonNullable<SourceHealth["starves"]> }, watches: [...blind, ...fed], blind: blind.length,
      });
      continue;
    }
    const down = sourceDown(health, s);
    // An app whose own check (a manifest poll) fails pages a person, red wherever it is named (the overview's header and tile,
    // the Apps head), under its own tile: a check is not a metric watch, so Alerting stays the count the band and the Metrics tab give.
    const checkFailing = !down && !!health.problems?.some((p) => p.kind === "check");
    // Since the health reading dates it (the last event before a stop, a poll's last run), else the source row's last change of state.
    out.push({ kind: "source", key: `source:${s._id}`, state: down ? "source" : checkFailing ? "check" : "degraded", severity: down || checkFailing ? 3 : 2, at: health.since ?? s.updated_at, volume: Infinity, sourceId: s._id, taskId: null, task: null, sessionId: null, source: s, health });
  }

  return out.sort((a, b) => b.severity - a.severity || (b.volume === a.volume ? 0 : b.volume > a.volume ? 1 : -1) || b.at - a.at);
}

// ── One row per root cause ──

export { foldedTitle, titleShape } from "./issuesModel";

/**
 * Fold issue rows that are one root cause into one row, in place: the same
 * source, kind and release, titles that differ in one word once their
 * parameters are blanked (titleShape). Sentry fingerprints these as one
 * issue; listing each made one template bug fill half the paging count. The
 * row keeps its busiest issue as `group` and lists every one in `variants`;
 * its volume, replays and severity are the fold's, its start the earliest,
 * and the states the others hold ride along in `also`.
 */
export function foldVariants(items: AttentionItem[]): void {
  const issues = items.filter((it): it is Extract<AttentionItem, { kind: "issue" }> => it.kind === "issue");
  if (issues.length < 2) return;
  const drop = new Set<AttentionItem>();
  // Two causes filed under one problem task are one fix: their rows fold under it as well, heaviest first.
  const clusters: (typeof issues)[] = [];
  const byTask = new Map<string, typeof issues>();
  for (const c of foldIssueRows(issues, (it) => it.group, (it) => it.volume)) {
    const task = c.find((r) => r.taskId)?.taskId;
    const into = task ? byTask.get(task) : undefined;
    if (into) into.push(...c);
    else {
      clusters.push(c);
      if (task) byTask.set(task, c);
    }
  }
  for (const rows of clusters) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => b.volume - a.volume || b.group.count - a.group.count || a.group.title.localeCompare(b.group.title));
    const lead = rows[0];
    const filed = rows.find((r) => r.taskId);
    const states = new Set(rows.flatMap((r) => [r.state, ...(r.also ?? [])]));
    states.delete(lead.state);
    const newest = rows.map((r) => r.replay).filter((r): r is OpsReplay => !!r).sort((a, b) => b.started_at - a.started_at)[0] ?? null;
    const working = rows.find((r) => r.sessionId);
    Object.assign(lead, {
      severity: Math.max(...rows.map((r) => r.severity)) as 1 | 2 | 3,
      volume: rows.reduce((n, r) => n + r.volume, 0),
      at: Math.min(...rows.map((r) => r.at)),
      ...(states.size ? { also: [...states] } : {}),
      lanes: rows.flatMap((r) => r.lanes ?? []),
      unowned: rows.reduce((n, r) => n + (r.unowned ?? 0), 0),
      ...(lead.taskId || !filed ? {} : { taskId: filed.taskId, task: filed.task }),
      replay: newest,
      replays: rows.reduce((n, r) => n + r.replays, 0),
      sessionId: lead.sessionId ?? working?.sessionId ?? null,
      variants: rows.map((r) => r.group),
    });
    for (const r of rows.slice(1)) drop.add(r);
  }
  if (!drop.size) return;
  const kept = items.filter((it) => !drop.has(it));
  items.length = 0;
  items.push(...kept);
}

/**
 * What a replay's error is about: the first issue it names that the store holds, else the first it names at all (the
 * home lists only replays whose issue is not held, so replays of one such issue still fold into one row), else the replay alone.
 */
export function replaySignature(r: Pick<OpsReplay, "_id" | "group_ids">, groups: ReadonlyMap<string, unknown>): string {
  const gid = r.group_ids.find((id) => groups.has(id)) ?? r.group_ids[0];
  return gid ? `replays:${gid}` : `replay:${r._id}`;
}

/** The distinct people across replays; one with nobody named counts as one person. */
export function replayUsers(rs: readonly Pick<OpsReplay, "_id" | "user">[]): number {
  return new Set(rs.map((r) => r.user?.id ?? r.user?.email ?? r.user?.name ?? `anon:${r._id}`)).size;
}

/** Whether someone is on it, by the one rule the Issues list's Nobody on it reads too (issuesModel someoneOnIt). */
export function handled(item: Pick<AttentionItem, "sessionId" | "task">): boolean {
  return someoneOnIt(item.sessionId, item.task);
}

/** Whether an item is something nobody has picked up. Sources and their readers are fixed by a person, not a task; a replay's errors are read first. */
export function unassigned(item: AttentionItem): boolean {
  // A folded row is nobody's while any issue in it is: Nobody on it lists the row and counts those issues.
  if (item.unowned !== undefined) return item.unowned > 0;
  return item.kind !== "source" && item.kind !== "reader" && item.kind !== "replay" && !handled(item);
}

/** Whether an item is listed under a filter: by the state it is listed as, or any other it holds (`also`). */
export function admitsShow(item: AttentionItem, show: OpsHomeShow | null): boolean {
  if (!show) return true;
  if (show === "snoozed") return true;
  if (show === "unassigned") return unassigned(item);
  const state: AttentionState = show === "sources" ? "source" : show;
  return item.state === state || !!item.also?.includes(state);
}

/**
 * The home's filters in order, with the words each count wears. Every item is
 * under exactly one of them but the last. The ones that page a person (red,
 * BADGE_STATES) lead as one group, so the Overview tab's and the sidebar's
 * count is the sum of the strip's first tiles.
 */
export const ATTENTION_FILTERS: { key: OpsHomeShow; label: string; tone: "bad" | "warn" | "calm"; one?: string }[] = [
  { key: "alerting", label: "Alerting", tone: "bad" },
  { key: "check", label: "Checks failing", tone: "bad", one: "Check failing" },
  { key: "regressed", label: "Regressed", tone: "bad" },
  { key: "escalating", label: "Escalating", tone: "bad" },
  { key: "sources", label: "Sources down", tone: "bad", one: "Source down" },
  { key: "new", label: "New issues", tone: "warn", one: "New issue" },
  { key: "firing", label: "Firing", tone: "warn" },
  { key: "errors", label: "Replay errors", tone: "warn", one: "Replay error" },
  { key: "reader", label: "Readers failing", tone: "warn", one: "Reader failing" },
  { key: "erroring", label: "Watch errors", tone: "warn", one: "Watch error" },
  { key: "degraded", label: "Degraded", tone: "warn" },
  { key: "unassigned", label: "Nobody on it", tone: "calm" },
];

/** A filter's words for a count of n: "1 source down", "2 sources down". */
export const filterWords = (f: { label: string; one?: string }, n: number): string => (n === 1 && f.one ? f.one : f.label);

/**
 * Each filter's count: the rows it lists, an item under every state it holds,
 * so each issue tile equals its Issues lane. A failing reader is one row under
 * Reader failing; Watch errors counts watches whose own query fails.
 */
export function attentionCounts(items: AttentionItem[]): Record<OpsHomeShow, number> {
  const out = { snoozed: 0, ...Object.fromEntries(ATTENTION_FILTERS.map((f) => [f.key, 0])) } as Record<OpsHomeShow, number>;
  for (const it of items) {
    for (const f of ATTENTION_FILTERS) {
      const lane = TILE_LANE[f.key];
      // An issue tile counts issues, not rows: a folded row of five regressions is five, as the Issues lane lists them.
      if (lane && it.lanes) out[f.key] += it.lanes.filter((l) => l === lane).length;
      else if (f.key === "unassigned" && it.unowned !== undefined) out[f.key] += it.unowned;
      else if (admitsShow(it, f.key)) out[f.key] += 1;
    }
  }
  return out;
}

/** The Issues lane each issue tile counts the same as (issuesModel attentionLane). */
export const TILE_LANE: Partial<Record<OpsHomeShow, AttentionLane>> = { regressed: "regressed", escalating: "escalating", new: "new", firing: "firing" };

/** What pages a person, out of the list: the Overview's count and its words. */
export const BADGE_STATES: ReadonlySet<AttentionState> = new Set(["alerting", "check", "regressed", "escalating", "source"]);
const BADGE_FILTERS = ATTENTION_FILTERS.filter((f) => BADGE_STATES.has(f.key === "sources" ? "source" : (f.key as AttentionState)));

/** The badge's count is the sum of the red tiles, the same tiles its words name, so the strip, the Overview tab and the palette read one number. */
export function opsBadge(items: AttentionItem[]): { n: number; words: string } {
  const counts = attentionCounts(items);
  const on = BADGE_FILTERS.filter((f) => counts[f.key] > 0);
  return { n: on.reduce((n, f) => n + counts[f.key], 0), words: on.map((f) => `${counts[f.key]} ${filterWords(f, counts[f.key]).toLowerCase()}`).join(" · ") };
}

/** The series a row draws: an issue's last day by hour, a watch's points. */
export function attentionSeries(item: AttentionItem, now: number): number[] {
  if (item.kind === "issue" || (item.kind === "replay" && item.group)) return bucketSeries((item.kind === "issue" ? item.group : item.group!).buckets, now, 24);
  if (item.kind === "watch") return item.watch.points.slice(-48).map((p) => p.value);
  return [];
}

/** An id no person would recognise: a uuid, or a long run of hex or digits. */
const OPAQUE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f-]{16,}$|\d{8,}$)/i;

/** Who a replay was, as a person reads it: their email or name, or an id that reads like a name; never a uuid. */
export const replayWho = (r: Pick<OpsReplay, "user">): string | null => r.user?.email ?? r.user?.name ?? (r.user?.id && !OPAQUE_ID.test(r.user.id) ? r.user.id : null);

/** A replay by where it happened; one with no address by whose session it was, never by its vendor id or a uuid. */
export function replayName(r: Pick<OpsReplay, "url" | "user" | "duration_ms">): string {
  const place = r.url ? replayTitle({ url: r.url }) : undefined;
  if (place) return place;
  const who = replayWho(r);
  return who ? `Session of ${who}` : r.duration_ms ? `Anonymous session, ${formatCallTime(r.duration_ms)}` : "Anonymous session";
}

// ── Since the last visit ──

/** Whether an item entered its state (its Started time) after the person last opened the home; nothing is new on a first visit, and an ongoing problem is new once. */
export function isNewSince(item: Pick<AttentionItem, "at">, seenAt: number | null | undefined): boolean {
  return !!seenAt && item.at > seenAt;
}

// ── The watch band ──

/** The monitor summary's states, worst first: the Metrics chips' own states and words (metricModel WATCH_STATES), paused left out. */
export const BAND_STATES: readonly WatchState[] = WATCH_STATES.filter((s) => s !== "paused");

/** The states a band draws as tiles up front; the rest (Retrying, OK, No line) fold behind their count. */
export const BAND_ATTENTION: ReadonlySet<WatchState> = new Set(["alert", "blind", "error", "warn", "nodata"]);

/**
 * Every watch under its one state (metricModel watchState, the Metrics chips'
 * classifier), worst first and the healthy ones by how close they sit to
 * their line, with the summary counts the band leads with. Paused watches
 * stay out. `attention` is what the band shows as tiles; the rest fold behind
 * their count until opened: one reader timing out is one count (its cause is
 * the source's row), never a tile per watch it feeds.
 */
export function watchBand(watches: readonly OpsWatch[], blind?: ReadonlySet<string>): { counts: Record<WatchState, number>; watches: OpsWatch[]; attention: OpsWatch[]; stateOf: (w: OpsWatch) => WatchState } {
  const live = watches.filter((w) => w.status !== "paused");
  const states = new Map(live.map((w) => [w._id, watchState(w, blind)]));
  const stateOf = (w: OpsWatch) => states.get(w._id) ?? watchState(w, blind);
  const sorted = sortWatches([...live], "state").sort((a, b) => WATCH_STATES.indexOf(stateOf(a)) - WATCH_STATES.indexOf(stateOf(b)));
  return { counts: watchStateCounts(live, blind), watches: sorted, attention: sorted.filter((w) => BAND_ATTENTION.has(stateOf(w))), stateOf };
}

/** A watch whose last read failed while an older value still stands (metricModel watchRetrying, the classifier's Retrying). */
export const watchRetrying = metricWatchRetrying;

// ── A source's last day ──

/**
 * A source's last 24 hours as its own overview charts them: its groups'
 * hourly occurrences plus the replays that started in the window. The Sources
 * table's "24h" reads this, so it equals the source's chart total.
 */
export function sourceLastDay(sourceId: string, groups: readonly Pick<OpsGroup, "source_id" | "buckets">[], replays: readonly Pick<OpsReplay, "source_id" | "started_at">[], now: number): { occurrences: number; replays: number; total: number } {
  let occurrences = 0;
  for (const g of groups) if (g.source_id === sourceId) occurrences += bucketSeries(g.buckets, now, 24).reduce((a, b) => a + b, 0);
  const from = now - DAY;
  let n = 0;
  for (const r of replays) if (r.source_id === sourceId && r.started_at >= from && r.started_at <= now) n++;
  return { occurrences, replays: n, total: occurrences + n };
}

/**
 * Narrow items to one source. Inside it the source's own state (down,
 * degraded, a check failing) is its overview's header, with its acts, so it
 * is never a row and a tile again under it, nor a count on its Overview tab.
 */
export function itemsForSource<T extends { sourceId: string | null; kind?: string }>(items: T[], sourceId: string | null | undefined): T[] {
  return sourceId ? items.filter((it) => it.sourceId === sourceId && it.kind !== "source") : items;
}

// ── Navigation helpers ──

/** A source named by name, `src-N` or row id, as the source row it means. */
export function resolveSource(sources: OpsSource[], ref: string | null): OpsSource | undefined {
  return ref ? sources.find((s) => s.name === ref || s.short_id === ref || s._id === ref) : undefined;
}

/** Sources grouped by provider, groups in a fixed order, sources by name; `q` narrows by name or provider. */
export function groupSources(sources: OpsSource[], q: string): { provider: SourceProvider; sources: OpsSource[] }[] {
  const needle = q.trim().toLowerCase();
  const hit = (s: OpsSource) => !needle || s.name.toLowerCase().includes(needle) || SOURCE_PROVIDER_LABEL[s.provider]?.toLowerCase().includes(needle) || s.short_id?.toLowerCase() === needle;
  const by = new Map<SourceProvider, OpsSource[]>();
  for (const s of sources) if (hit(s)) by.set(s.provider, [...(by.get(s.provider) ?? []), s]);
  const order: SourceProvider[] = ["posthog", "sentry", "app", "github", "sdk", "http"];
  return [...by].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([provider, rows]) => ({ provider, sources: rows.sort((a, b) => a.name.localeCompare(b.name)) }));
}

/**
 * A fix session's review: one session starts, seeded with the item, in the
 * folder its source is attached to. `seeds` are every issue a folded row
 * hands over; `merges` the variants' own open tasks, which fold into the task
 * the session works as its duplicates, so one cause keeps one task.
 */
export function fixLedger(ref: string, title: string, folder: string | undefined, task: string | null = null, more: { seeds?: string[]; merges?: string[]; /** The task is closed (dropped, done): the start reopens it. */ reopens?: boolean } = {}): SwitchLedger {
  const seeds = more.seeds && more.seeds.length > 1 ? more.seeds : null;
  const merges = task && more.merges?.length ? more.merges : null;
  return {
    name: "Fix session",
    subject: `${ref} · ${title}`,
    shift: null,
    figures: [{ value: "1", label: "session starts" }, ...(merges ? [{ value: String(merges.length), label: merges.length === 1 ? "task merged" : "tasks merged" }] : [])],
    rows: [
      { k: "Seeded with", v: seeds ? seeds.join(", ") : ref },
      ...(task ? [{ k: more.reopens ? "Reopens task" : "Works task", v: task }] : []),
      ...(merges ? [{ k: "Merges into it", v: merges.join(", ") }] : []),
      { k: "Folder", v: folder ?? "Your default folder", ...(folder ? {} : { tone: "warn" as const }) },
      { k: "Lands in", v: "Your inbox" },
    ],
    confirm: "Start fix",
  };
}

/**
 * The issues the listed rows hold, in the list's order, once each: a folded
 * row's every variant and an alerting watch's metric issue, narrowed as the
 * filter on narrows the Issues list (a lane tile to that lane, Nobody on it to
 * the issues nobody is on). The Issues list's Needs attention lane lists
 * exactly these, one row each, so the list header's issue count, its link,
 * the tiles and an issue page's "of N" all read one number.
 */
export function listedIssues(items: readonly AttentionItem[], now: number, input: Pick<AttentionInput, "failures" | "taskOf"> = {}, show: OpsHomeShow | null = null): OpsGroup[] {
  const lane = show ? TILE_LANE[show] : undefined;
  const out = new Map<string, OpsGroup>();
  for (const it of items) {
    const gs = it.kind === "issue" ? it.variants ?? [it.group] : it.kind === "watch" && it.group ? [it.group] : [];
    for (const g of gs) {
      const l = out.has(g._id) ? null : attentionLane(g, now, input.failures?.(g));
      if (!l || (lane && l !== lane)) continue;
      if (show === "unassigned" && someoneOnIt(g.fix_conversation_id, g.signal_task_id ? input.taskOf?.(g.signal_task_id) : undefined)) continue;
      out.set(g._id, g);
    }
  }
  return [...out.values()];
}

/** The issues a person walks with j and k after opening one from here (listedIssues), by the ref an issue page reads. */
export function homeIssueRefs(items: readonly AttentionItem[], now: number, input: Pick<AttentionInput, "failures" | "taskOf"> = {}, show: OpsHomeShow | null = null): string[] {
  return listedIssues(items, now, input, show).map((g) => g.short_id || g._id);
}
