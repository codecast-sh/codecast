// What an issue page shows as evidence: its activity, the CI runs and suspect
// commit, a check or metric's readings, and the error groups behind a metric
// alert. No React, no store.
import type { OpsEvent, OpsGroup, OpsSample } from "./opsTypes";
import { type FixTask, occurrencesSince } from "./issueFixStage";
import { DAY, HOUR, type Resolver, resolverOf } from "./issueState";
import { parseTags } from "./issueSamples";

// ── Activity: every change to an issue on one list ──

export type ActivityItem = {
  at: number;
  /** What happened, as a verb phrase. */
  what: string;
  tone: "bad" | "good" | "fix" | "quiet";
  release?: string;
  sha?: string;
  session?: string;
  task?: string;
  /** Who or what did it, on a resolve: a person, a recovery, the vendor. */
  resolver?: Resolver;
  /** The same step repeated back to back, folded into one line. */
  n?: number;
};

const TRANSITION_WORDS: Record<string, { what: string; tone: ActivityItem["tone"] }> = {
  new: { what: "first seen", tone: "bad" },
  regressed: { what: "regressed", tone: "bad" },
  spike: { what: "spiked", tone: "bad" },
  resolved: { what: "resolved", tone: "good" },
  check_failed: { what: "check failed", tone: "bad" },
  check_recovered: { what: "check recovered", tone: "good" },
  metric_alert: { what: "crossed its line", tone: "bad" },
  metric_recovered: { what: "back within its line", tone: "good" },
  job_failed: { what: "job failed", tone: "bad" },
};

/**
 * The issue's transitions and its fix chain as one list, newest first:
 * every flip the server announced, the resolve a regression implies (which
 * the transitions alone may not carry), the fix session started from the
 * issue, and how its problem task closed. The same step repeated back to
 * back (two deliveries of one spike) folds into one line with a count, and
 * the latest resolve names who or what did it.
 */
export function issueActivity(
  g: Pick<OpsGroup, "_id" | "short_id" | "first_seen" | "first_release" | "resolved_at" | "resolved_in" | "fix_conversation_id" | "fix_started_at"> &
    Partial<Pick<OpsGroup, "kind" | "resolved_via" | "resolved_by" | "external" | "last_transition" | "last_transition_at">>,
  events: OpsEvent[],
  task: (FixTask & { short_id?: string }) | null,
): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const e of events) {
    if (e.group_id !== g._id && e.data?.group_short_id !== g.short_id) continue;
    const t = e.data?.transition ?? (e.kind === "error_new" ? "new" : e.kind === "error_regressed" ? "regressed" : e.kind);
    const w = TRANSITION_WORDS[t] ?? { what: t.replace(/_/g, " "), tone: "quiet" as const };
    out.push({ at: e.created_at, what: w.what, tone: w.tone, release: e.data?.release });
  }
  const near = (at: number, what: string) => out.some((i) => i.what === what && Math.abs(i.at - at) < 5 * 60_000);
  if (!out.some((i) => i.what === "first seen")) out.push({ at: g.first_seen, what: "first seen", tone: "bad", release: g.first_release });
  if (g.resolved_at !== undefined && !near(g.resolved_at, "resolved") && !near(g.resolved_at, "check recovered") && !near(g.resolved_at, "back within its line")) {
    out.push({ at: g.resolved_at, what: "resolved", tone: "good", release: g.resolved_in });
  }
  if (g.fix_conversation_id && g.fix_started_at) out.push({ at: g.fix_started_at, what: "fix session started", tone: "fix", session: g.fix_conversation_id });
  if (task?.landed) out.push({ at: task.landed.at, what: "fix landed", tone: "fix", sha: task.landed.sha, task: task.short_id });
  else if (task?.cause?.dissolved) out.push({ at: task.cause.dissolved.at, what: "problem dissolved", tone: "quiet", task: task.short_id });
  else if (task?.closed_at && (task.status === "done" || task.status === "dropped")) out.push({ at: task.closed_at, what: task.status === "done" ? "problem closed" : "problem dropped", tone: task.status === "done" ? "fix" : "quiet", task: task.short_id });
  out.sort((a, b) => b.at - a.at);
  // The resolve the group's stamps describe names its resolver; an older vendor resolve names the vendor.
  const latest = g.resolved_at !== undefined ? out.find((i) => i.what === "resolved" && Math.abs(i.at - g.resolved_at!) < 5 * 60_000) : undefined;
  if (latest) latest.resolver = resolverOf(g, events);
  for (const i of out) if (i.what === "resolved" && !i.resolver && g.external) i.resolver = { via: "vendor" };
  const folded: ActivityItem[] = [];
  const same = (a: ActivityItem, b: ActivityItem) => a.what === b.what && a.release === b.release && a.sha === b.sha && a.task === b.task && a.session === b.session && !a.resolver && !b.resolver;
  for (const i of out) {
    const prev = folded[folded.length - 1];
    if (prev && same(prev, i)) prev.n = (prev.n ?? 1) + 1;
    else folded.push(i);
  }
  return folded;
}

// ── What broke it: CI runs and the suspect commit ──

export type CiRunRow = { at: number; sha: string | null; ok: boolean; conclusion: string; url?: string; run_id?: string; branch?: string };

const PASSING_CONCLUSIONS = new Set(["success"]);

/**
 * A check's kept runs, newest first, each with its commit, branch and how it
 * ended. A CI run's sample carries the sha, branch and run in its context
 * and the conclusion as the message's word before "at" (ingest.recordCiRun).
 */
export function ciRuns(samples: Pick<OpsSample, "at" | "message" | "url" | "context_json">[]): CiRunRow[] {
  const out: CiRunRow[] = [];
  for (const s of samples) {
    const ctx = parseTags(s.context_json);
    const m = /\s(\w+)(?: at [0-9a-f]{7,40})?$/.exec(s.message ?? "");
    // Only a run: its context names the commit or run, or its message ends "at <sha>". A check's own words are not a conclusion.
    if (!(ctx && (ctx.sha || ctx.run_id)) && !/ at [0-9a-f]{7,40}$/.test(s.message ?? "")) continue;
    const conclusion = m?.[1] ?? "unknown";
    const sha = typeof ctx?.sha === "string" ? ctx.sha.toLowerCase() : null;
    out.push({
      at: s.at,
      sha,
      ok: PASSING_CONCLUSIONS.has(conclusion),
      conclusion,
      url: s.url,
      ...(typeof ctx?.run_id === "string" ? { run_id: ctx.run_id } : {}),
      ...(typeof ctx?.branch === "string" ? { branch: ctx.branch } : {}),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The last time a check was green: when, and for a CI run the commit it passed at. */
export type GreenMark = { at: number; sha: string | null; url?: string };

/**
 * Where the current red streak began, on the branch the newest run is on:
 * the run that broke it and the last green before it. The commits between
 * the two hold the break; the first red one is the suspect.
 *
 * The first red run is found three ways, in order: a kept passing run with
 * failures after it; the kept run whose time is the flip to failing
 * (`failingSince`, the check_failed transition, stamped at the run); or the
 * oldest kept failure after the last recorded pass (`lastOk`) when the kept
 * runs reach back past that pass. Otherwise the boundary was not kept and
 * `firstFail` is null: an older sample is never offered in its place.
 * Null when the newest run passed.
 */
export function ciBreak(runs: CiRunRow[], opts: { failingSince?: number | null; lastOk?: { at: number; sha?: string | null; branch?: string | null } | null } = {}): { firstFail: CiRunRow | null; lastPass: GreenMark | null; branch: string | null } | null {
  if (!runs.length || runs[0].ok) return null;
  const branch = runs[0].branch ?? null;
  const own = runs.filter((r) => (r.branch ?? null) === branch);
  const okOnBranch = opts.lastOk && (!opts.lastOk.branch || !branch || opts.lastOk.branch === branch) ? opts.lastOk : null;
  const recorded: GreenMark | null = okOnBranch ? { at: okOnBranch.at, sha: okOnBranch.sha ?? null } : null;
  let firstFail: CiRunRow | null = null;
  for (const r of own) {
    if (r.ok) return { firstFail, lastPass: { at: r.at, sha: r.sha, url: r.url }, branch };
    firstFail = r;
  }
  const since = opts.failingSince;
  const flip = since != null ? own.find((r) => !r.ok && Math.abs(r.at - since) < 60_000) : undefined;
  if (flip) return { firstFail: flip, lastPass: recorded, branch };
  if (recorded && own.some((r) => r.at <= recorded.at)) {
    const after = own.filter((r) => !r.ok && r.at > recorded.at);
    if (after.length) return { firstFail: after[after.length - 1], lastPass: recorded, branch };
  }
  return { firstFail: null, lastPass: recorded, branch };
}

const HEX = /^[0-9a-f]{7,40}$/i;

/**
 * The commit an error issue is tied to, when releases are commits: the
 * release it came back in when it regressed (a suspect: the code changed and
 * it returned), else the release it was first seen in. A first-seen release
 * only says which build was running, so `why: "first"` is shown as the
 * release, never as the commit that broke it. Null when releases are not
 * commits.
 */
export function suspectSha(g: Pick<OpsGroup, "first_release"> & Partial<Pick<OpsGroup, "regressed_in" | "regressed_at" | "resolved_at" | "status">>): { sha: string; why: "regressed" | "first" } | null {
  const back = g.status === "open" && g.regressed_at !== undefined && g.regressed_at >= (g.resolved_at ?? 0) ? g.regressed_in : undefined;
  if (back && HEX.test(back.trim())) return { sha: back.trim().toLowerCase(), why: "regressed" };
  if (g.first_release && HEX.test(g.first_release.trim())) return { sha: g.first_release.trim().toLowerCase(), why: "first" };
  return null;
}

export type MessagePart = { t: "text"; v: string } | { t: "task"; v: string } | { t: "pr"; n: number };

/** A commit message's first line, its task ids (ct-123) and pull request numbers (#45) split out to render as live references. */
const SQUASH_PR = /\s*\(#(\d+)\)\s*$/;

/** The pull request a squash merge's subject ends with ("… (#123)"), which its commit card names on a line of its own. */
export function squashPr(message: string | undefined): number | null {
  const m = String(message ?? "").split("\n")[0].match(SQUASH_PR);
  return m ? Number(m[1]) : null;
}

export function commitMessageParts(message: string | undefined): MessagePart[] {
  // A squash merge's trailing "(#123)" is its pull request, which the card names beside the subject (squashPr): dropped, never a pill inside the subject's own parentheses.
  const line = String(message ?? "").split("\n")[0].replace(SQUASH_PR, "");
  const out: MessagePart[] = [];
  let at = 0;
  for (const m of line.matchAll(/\b(ct-\d+)\b|#(\d+)\b/gi)) {
    if (m.index! > at) out.push({ t: "text", v: line.slice(at, m.index) });
    out.push(m[1] ? { t: "task", v: m[1].toLowerCase() } : { t: "pr", n: Number(m[2]) });
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push({ t: "text", v: line.slice(at) });
  return out;
}

// ── Readings: what a check or metric reported, one row per kept sample ──

export type ReadingRow = {
  id: string;
  at: number;
  /** The reading's own words: an app check's message, a metric's sample line. */
  text: string;
  /** A metric's value at the reading, when the line carries one. */
  value: number | null;
  /** Whether the reading was past the line (metric) or red (check); null when unknown. */
  failing: boolean | null;
  /** A CI run's commit, branch, conclusion and link. */
  run?: CiRunRow;
};

const METRIC_VALUE = /=\s*(-?\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?)/i;

/**
 * A check's or metric's kept samples as readings, newest first. A metric's
 * value is read from its sample line ("Name = 112 (alerts above 15)") and
 * judged against the line; a CI run carries its commit; any other check
 * reading is its message, kept whole. Only failures are kept for a check, so
 * each of its readings is red.
 */
export function readingRows(
  g: Pick<OpsGroup, "kind" | "title">,
  samples: Pick<OpsSample, "_id" | "at" | "message" | "url" | "context_json">[],
  line?: { threshold?: number; direction?: "above" | "below" } | null,
): ReadingRow[] {
  const runs = new Map(ciRuns(samples).map((r) => [`${r.at}|${r.url ?? ""}`, r]));
  return [...samples]
    .sort((a, b) => b.at - a.at)
    .map((s) => {
      const run = runs.get(`${s.at}|${s.url ?? ""}`);
      if (g.kind === "metric") {
        const m = METRIC_VALUE.exec(s.message ?? "");
        const value = m ? Number(m[1].replace(/,/g, "")) : null;
        const failing = value === null || line?.threshold === undefined ? null : line.direction === "below" ? value < line.threshold : value > line.threshold;
        return { id: s._id, at: s.at, text: s.message ?? "", value: Number.isFinite(value) ? value : null, failing };
      }
      return { id: s._id, at: s.at, text: s.message ?? "", value: null, failing: run ? !run.ok : true, ...(run ? { run } : {}) };
    });
}

/** Readings whose words repeat back to back fold into one row with a count, the newest of them kept. */
export function foldReadings(rows: ReadingRow[]): (ReadingRow & { n: number; oldest: number })[] {
  const out: (ReadingRow & { n: number; oldest: number })[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    const same = prev && !r.run && !prev.run && prev.failing === r.failing && (r.value !== null ? r.value === prev.value : r.text === prev.text);
    if (same) {
      prev.n++;
      prev.oldest = r.at;
    } else out.push({ ...r, n: 1, oldest: r.at });
  }
  return out;
}

// ── What drives a metric alert: the error groups behind it ──

export type Contributor = { group: OpsGroup; n: number; share: number; exact: boolean };

/**
 * The error groups that fired inside a metric alert's window, ranked by
 * their events there. Only the alert's own source can say what drove its
 * number: those rows carry a share of their total. Other sources' errors in
 * the same window are context (`others`), with no share, since they are not
 * what the metric counted.
 */
/**
 * Where "the last 24 hours" begins: the start of the hour 23 hours before
 * this one, the same 24 hourly buckets escalation() counts. A window cut
 * mid-hour would leave a partial bucket and a "+" on a count the issue's own
 * page states exactly.
 */
export function lastDayStart(now: number): number {
  return Math.floor(now / HOUR) * HOUR - 23 * HOUR;
}

export function metricContributors(alert: Pick<OpsGroup, "_id" | "source_id">, groups: OpsGroup[], since: number, now: number, max = 6): { rows: Contributor[]; total: number; others: Contributor[] } {
  const fired = (g: OpsGroup) => {
    if (g._id === alert._id || (g.kind !== "error" && g.kind !== "log") || g.last_seen <= since || g.status === "ignored" || g.status === "muted") return null;
    const c = occurrencesSince(g, since, now);
    return c.n ? { group: g, n: c.n, exact: c.exact } : null;
  };
  const all = groups.map(fired).filter((x): x is { group: OpsGroup; n: number; exact: boolean } => x !== null);
  const rank = (a: { n: number; group: OpsGroup }, b: { n: number; group: OpsGroup }) => b.n - a.n || b.group.last_seen - a.group.last_seen;
  const own = all.filter((x) => x.group.source_id === alert.source_id);
  const total = own.reduce((a, x) => a + x.n, 0);
  const rows = own.sort(rank).slice(0, max).map((x) => ({ ...x, share: total ? x.n / total : 0 }));
  const others = all.filter((x) => x.group.source_id !== alert.source_id).sort(rank).slice(0, max).map((x) => ({ ...x, share: 0 }));
  return { rows, total, others };
}

/** An exception's type and message as one string: what a breakdown groups by, and what leaving one out compares. */
const EXCEPTION_KEY = "concat(coalesce(JSONExtractString(properties.$exception_types, 1), properties.$exception_type, 'Error'), ': ', coalesce(JSONExtractString(properties.$exception_values, 1), properties.$exception_message, ''))";
const COUNT_WHERE = /^(\s*select\s+count\s*\(\s*\*?\s*\)\s+from\s+events\s+where\s+)([\s\S]+?)(\s*;?\s*)$/i;

/**
 * A HogQL count watch with one of its breakdown's parts left out (known
 * browser noise such as a ResizeObserver loop): the same filter, and not
 * that part, compared the way the breakdown keyed it. Null for a query
 * hogqlBreakdown cannot split.
 */
export function hogqlExclude(query: string, key: string): string | null {
  const m = COUNT_WHERE.exec(query);
  if (!m || !hogqlBreakdown(query)) return null;
  const expr = /\$exception\b/.test(m[2]) ? EXCEPTION_KEY : "event";
  const lit = `'${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return `${m[1]}(${m[2]}) and ${expr} != ${lit}${m[3]}`;
}

/**
 * The query that splits a HogQL count watch into what it counted: the same
 * filter grouped by what each event was (an exception's type and message,
 * else the event's name), biggest first. Null when the watch is not one plain
 * count over events, which has no honest split.
 */
export function hogqlBreakdown(query: string, limit = 8): string | null {
  const m = /^\s*select\s+count\s*\(\s*\*?\s*\)\s+from\s+events\s+where\s+([\s\S]+?)\s*;?\s*$/i.exec(query);
  if (!m || /\b(group\s+by|order\s+by|limit|union|join|having)\b/i.test(m[1])) return null;
  const key = /\$exception\b/.test(m[1]) ? EXCEPTION_KEY : "event";
  return `select ${key} as k, count() as n from events where ${m[1]} group by k order by n desc limit ${limit}`;
}

/** One part of a metric's value: what it counted, how many, its share, and the codecast issue that names it when one does. */
export type BreakdownRow = { key: string; n: number; share: number; group: OpsGroup | null };

/**
 * A breakdown's rows (`[key, n]` pairs, as HogQL answers) with each share
 * taken of their sum, and each matched to the open or resolved error issue
 * whose title carries its message, when one does.
 */
export function breakdownRows(results: unknown, groups: OpsGroup[]): BreakdownRow[] {
  const pairs = (Array.isArray(results) ? results : []).flatMap((r) => (Array.isArray(r) && typeof r[0] === "string" && Number.isFinite(Number(r[1])) ? [[r[0], Number(r[1])] as const] : []));
  const total = pairs.reduce((a, [, n]) => a + n, 0);
  const errors = groups.filter((g) => g.kind === "error" || g.kind === "log");
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  return pairs.map(([key, n]) => {
    const message = norm(key.replace(/^[^:]{1,60}:\s*/, ""));
    const group = message.length >= 8 ? errors.find((g) => norm(g.title).includes(message) || (norm(g.title).length >= 12 && message.includes(norm(g.title)))) ?? null : null;
    return { key, n, share: total ? n / total : 0, group };
  });
}

/** A metric alert's failure for a fix prompt: its latest reading and the biggest parts of what it counted. */
export function metricFailure(reading: string | undefined, parts: Pick<BreakdownRow, "key" | "n" | "share">[]): string | undefined {
  const lines = [reading?.trim(), ...parts.slice(0, 3).map((p) => `${Math.round(p.share * 100)}% (${p.n}) ${p.key}`)].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

// ── An app check's readings as numbers ──

/** A number in a reading's words: an optional currency sign, the figure, and a unit glued to it (%, /day, /h). */
const READING_NUMBER = /(\$|€|£)?(-?\d[\d,]*(?:\.\d+)?)(%|\/day|\/h|\/hr|\/min|\/s)?/g;
const STOP_WORDS = new Set(["at", "of", "in", "on", "the", "a", "an", "to", "by", "is", "and", "or", "for", "with", "past", "over", "under", "about"]);

export type ReadingColumn = { label: string; pre: string; post: string };
export type ReadingTemplate = {
  /** The newest reading's words: said once, as what the check reports. */
  text: string;
  /** The figures each reading is judged by, each a column: the fields that make it fail, or the ones that move. */
  cols: ReadingColumn[];
  /** Each reading's figures, by its id, in column order. */
  values: Map<string, number[]>;
  /** A figure that never changes and the check names as its level (or "past ... level"): what the first column is held against. */
  line: number | null;
  /** The column the trend draws first: the first that moves, else the first. */
  charted: number;
};

/** A figure the check's own words mark as not counting toward its verdict. */
const INFORMATIONAL = /^[^,;]*\b(informational|info only|for info)\b/i;
/** A fixed figure named as the level a figure is held to. */
const LEVEL_AFTER = /^\s*(level|threshold|limit|line|floor|minimum|maximum|target)\b/i;
const LEVEL_BEFORE = /(below|under|above|threshold|limit|minimum|maximum|target|floor|[<>≤≥])\s*$/i;

/**
 * An app check's readings, when they are one sentence whose figures change
 * (a balance, days left, a rate) or a list of fields (`1 stale, 3
 * no-response, 19 replied (informational)`): the sentence once, and its
 * figures as columns, each named by the words that follow it up to the next
 * comma, its rate unit, or the word before it. A list that marks some fields
 * informational is judged by the others, so those are the columns and the
 * informational ones are left out. Null when the readings do not share one
 * shape, or nothing in them is a field or moves.
 */
export function readingTemplate(rows: Pick<ReadingRow, "id" | "text">[]): ReadingTemplate | null {
  const parse = (t: string) => {
    const nums: { pre: string; n: number; post: string; before: string; after: string }[] = [];
    const skeleton = t.replace(READING_NUMBER, (m, pre: string | undefined, num: string, post: string | undefined, off: number) => {
      nums.push({ pre: pre ?? "", n: Number(num.replace(/,/g, "")), post: post ?? "", before: t.slice(0, off), after: t.slice(off + m.length) });
      return "#";
    });
    return { skeleton, nums };
  };
  const withText = rows.filter((r) => r.text);
  if (withText.length < 2) return null;
  const head = parse(withText[0].text);
  if (!head.nums.length) return null;
  const same = withText.map((r) => ({ r, p: parse(r.text) })).filter((x) => x.p.skeleton === head.skeleton);
  if (same.length < 2) return null;
  const moving = head.nums.map((_, i) => same.some((x) => x.p.nums[i].n !== head.nums[i].n));
  const info = head.nums.map((x) => INFORMATIONAL.test(x.after));
  // A field list judged by some of its fields: those are the columns, moving or not.
  const fields = info.some(Boolean) ? head.nums.flatMap((_, i) => (info[i] ? [] : [i])) : [];
  const idx = fields.length ? fields : moving.flatMap((m, i) => (m ? [i] : []));
  if (!idx.length) return null;
  const label = (x: (typeof head.nums)[number], i: number) => {
    const phrase = /^\s+([A-Za-z][A-Za-z-]{1,20}(?:\s+[A-Za-z][A-Za-z-]{1,20}){0,2})(?=\s*(?:[,;(.:]|$))/.exec(x.after)?.[1];
    if (phrase && !STOP_WORDS.has(phrase.split(/\s+/)[0].toLowerCase())) return phrase.toLowerCase();
    const next = /^\s+([A-Za-z][A-Za-z-]{1,20})/.exec(x.after)?.[1];
    if (next && !STOP_WORDS.has(next.toLowerCase())) return next.toLowerCase();
    if (x.post.startsWith("/")) return `per ${x.post.slice(1)}`;
    const prev = /([A-Za-z][A-Za-z-]{1,20})\W*$/.exec(x.before)?.[1];
    if (prev && !STOP_WORDS.has(prev.toLowerCase())) return prev.toLowerCase();
    return `#${i + 1}`;
  };
  const cols = idx.map((i, k) => ({ label: label(head.nums[i], k), pre: head.nums[i].pre, post: head.nums[i].post.startsWith("/") || head.nums[i].post === "%" ? head.nums[i].post : "" }));
  const values = new Map(same.map((x) => [x.r.id, idx.map((i) => x.p.nums[i].n)]));
  const first = head.nums[idx[0]];
  // Only a figure the words name as a level is a line; a field that holds still (1 stale) is not one.
  const level = head.nums.find((x, i) => !moving[i] && !idx.includes(i) && x.pre === first.pre && x.post === first.post && x.n !== 0 && (LEVEL_AFTER.test(x.after) || LEVEL_BEFORE.test(x.before)));
  const charted = Math.max(0, idx.findIndex((i) => moving[i]));
  return { text: withText[0].text, cols, values, line: level ? level.n : null, charted };
}

/**
 * When a falling figure reaches zero at the rate its readings fell since it
 * last rose: a least-squares line over those readings (time, value). Null
 * unless it is falling and still above zero.
 */
export function projectZero(all: { at: number; v: number }[]): number | null {
  // Only the stretch since the figure last rose (a top-up starts a new run).
  const sorted = [...all].sort((a, b) => a.at - b.at);
  let from = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].v > sorted[i - 1].v) from = i;
  const points = sorted.slice(from);
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.at, 0) / n;
  const my = points.reduce((a, p) => a + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.at - mx) * (p.v - my);
    den += (p.at - mx) ** 2;
  }
  if (!den) return null;
  const slope = num / den;
  const last = points.reduce((a, p) => (p.at > a.at ? p : a));
  if (slope >= 0 || last.v <= 0) return null;
  return last.at + last.v / -slope;
}

/** A column that is the check's own runway: days left at its current rate. */
const RUNWAY_LABEL = /^days?\b/;

/**
 * When a template's charted figure reaches zero. A check that reports its own
 * runway (2.2 days) says so itself: its newest reading plus that, the same
 * date its newest row reads. Else the fall of the readings projects it.
 */
export function trendZero(template: Pick<ReadingTemplate, "cols" | "values">, rows: Pick<ReadingRow, "id" | "at">[], at: number): number | null {
  const held = rows.filter((r) => template.values.get(r.id)).sort((a, b) => a.at - b.at);
  if (!held.length) return null;
  const newest = held[held.length - 1];
  const runway = template.cols.findIndex((c) => RUNWAY_LABEL.test(c.label));
  if (runway >= 0 && runway !== at) {
    const v = template.values.get(newest.id)!;
    const days = v[runway];
    if (Number.isFinite(days) && days >= 0 && v[at] > 0) return newest.at + days * DAY;
  }
  return projectZero(held.map((r) => ({ at: r.at, v: template.values.get(r.id)![at] })));
}
