// A job's failures split by what they said, and one row per root cause.
// No React, no store.
import { bucketSeries } from "@codecast/shared/contracts/ingest";
import { dropRequestIds, failureMessageKey } from "@codecast/shared/contracts/signalFingerprint";
import { routeOf } from "@codecast/shared/replay";
import type { OpsGroup, OpsSample } from "./opsTypes";
import { DAY, HOUR } from "./issueState";

// ── A job's failures, split by what they said ──

/** The sample filter key a failure split's row sets (sampleTag). */
export const FAILURE_KEY = "failure";

export type FailurePart = { key: string; label: string; n: number; share: number; first: number; last: number };
export type FailureSplit = {
  rows: FailurePart[];
  /** What the rows count: every failure since `since` (the server's tally), or only the kept samples. */
  from: "tally" | "kept";
  total: number;
  since: number | null;
};

/**
 * A job's failures by what each said, biggest first: the server's tally
 * (event_groups.messages) when the group holds one, else its kept samples
 * split the same way (failureMessageKey). Each row's label drops the lead
 * every row shares ("Agent run failed: broker: "), so the rows read by what
 * differs. Null when there is nothing to split.
 */
export function jobFailureSplit(g: Pick<OpsGroup, "kind" | "messages">, samples: Pick<OpsSample, "message" | "at">[]): FailureSplit | null {
  if (g.kind !== "job") return null;
  let from: FailureSplit["from"] = "tally";
  let parts = (g.messages ?? []).map((m) => ({ key: m.key, n: m.count, first: m.first_seen, last: m.last_seen }));
  if (!parts.length) {
    from = "kept";
    const by = new Map<string, { key: string; n: number; first: number; last: number }>();
    for (const s of samples) {
      const key = failureMessageKey(s.message) || "(no message)";
      const hit = by.get(key);
      if (hit) {
        hit.n++;
        hit.first = Math.min(hit.first, s.at);
        hit.last = Math.max(hit.last, s.at);
      } else by.set(key, { key, n: 1, first: s.at, last: s.at });
    }
    parts = [...by.values()];
  }
  if (!parts.length) return null;
  parts.sort((a, b) => b.n - a.n || b.last - a.last);
  const total = parts.reduce((a, p) => a + p.n, 0);
  const lead = parts.length > 1 ? sharedLead(parts.map((p) => p.key)) : "";
  return {
    rows: parts.map((p) => ({ ...p, label: p.key.slice(lead.length) || p.key, share: total ? p.n / total : 0 })),
    from,
    total,
    since: Math.min(...parts.map((p) => p.first)),
  };
}

/**
 * Rows whose titles open the same way as another shown row (up to a ": "):
 * the length of the lead they share, so a row can dim it and lead with the
 * part that tells it apart. Rows with no twin are absent.
 */
export function sharedTitleLeads(rows: Pick<OpsGroup, "_id" | "title">[]): Map<string, number> {
  const byLead = new Map<string, Pick<OpsGroup, "_id" | "title">[]>();
  for (const r of rows) {
    const i = r.title.indexOf(": ");
    if (i <= 0 || i > 80) continue;
    const lead = r.title.slice(0, i + 2);
    byLead.set(lead, [...(byLead.get(lead) ?? []), r]);
  }
  const out = new Map<string, number>();
  for (const twins of byLead.values()) {
    if (twins.length < 2) continue;
    const lead = sharedLead(twins.map((t) => t.title));
    for (const t of twins) if (lead && t.title.length > lead.length) out.set(t._id, lead.length);
  }
  return out;
}

/** The lead every key shares, cut at its last ": " so a row never starts mid-word. */
export function sharedLead(keys: string[]): string {
  if (!keys.length) return "";
  let lead = keys[0];
  for (const k of keys) while (!k.startsWith(lead)) lead = lead.slice(0, -1);
  const cut = lead.lastIndexOf(": ");
  return cut > 0 ? lead.slice(0, cut + 2) : "";
}

const NOISE: { re: RegExp; label: string }[] = [
  { re: /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i, label: "browser noise" },
  { re: /^(Uncaught |Error: )?Script error\.?$/i, label: "browser noise" },
  { re: /\b(chrome|moz|safari(-web)?)-extension:\/\//i, label: "extension" },
  { re: /ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i, label: "stale chunk" },
];

/**
 * Whether a message is known noise, and which: a harmless browser warning,
 * an extension's own error, or a stale chunk after a deploy. Its cure is to
 * leave it out of what is counted, not a fix session.
 */
export function noiseOf(text: string | null | undefined): string | null {
  if (!text) return null;
  return NOISE.find((n) => n.re.test(text))?.label ?? null;
}

/**
 * A job that has stopped failing: none for well past its usual gap between
 * failures (its count over its life), and at least six hours. A job reports
 * only its failures, so this is as close to "passing" as it can say; a quiet
 * job reads quiet with its last failure, never "failing" days later.
 */
export function jobQuiet(g: Pick<OpsGroup, "kind" | "count" | "first_seen" | "last_seen">, now: number): boolean {
  if (g.kind !== "job") return false;
  const usual = g.count > 1 ? (g.last_seen - g.first_seen) / (g.count - 1) : DAY;
  return now - g.last_seen > Math.max(6 * HOUR, Math.min(7 * DAY, 4 * usual));
}

// ── One row per root cause ──
// Issues one template bug produced (the same message with one parameter
// changed) are one cause: the Ops home, a source's overview and the Issues
// list fold them into one row with the same rule, so each says the same count
// and offers one fix for all of them.

/** Titles this short fold on nothing: one word of five is too much of the message to call a parameter. */
const SHAPE_MIN_TOKENS = 5;

/**
 * A title as words with its parameters blanked: a `(key=value, …)` list, ids
 * (uuids, long hex) and numbers. Two titles whose words then differ in at
 * most one place are one message with one parameter.
 */
export function titleShape(title: string): string[] {
  return dropRequestIds(title)
    .replace(/\([^()]*=[^()]*\)/g, "(…)")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}\b/gi, "#")
    .replace(/\b[0-9a-f]{12,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .split(/\s+/)
    .filter(Boolean);
}

/** The keys a title's shape matches under: the shape itself, and the shape with each word in turn blanked. A short title has none: it folds with nothing. */
function shapeKeys(shape: string[]): string[] {
  // A short title that names where it failed (a Convex function) folds with the same title exactly: only its ids differed.
  if (shape.length < SHAPE_MIN_TOKENS) return shape.some((w) => NAMES_CAUSE.test(w)) ? [shape.join(" ")] : [];
  return [shape.join(" "), ...shape.flatMap((w0, i) => (NAMES_CAUSE.test(w0) ? [] : [shape.map((w, j) => (i === j ? "\u0000" : w)).join(" ")]))];
}

/** A word that names where the error is, never a parameter of it: a Convex function (`M(dispatch:dispatch)]`). Two titles that differ there are two causes. */
const NAMES_CAUSE = /^\[?[QMA]\([\w./-]+:[\w./-]+\)\]?$/;

/**
 * A title with every path in it read as its route (routeOf: ids, phone
 * numbers and emails to `:id`), or null when it names no path. Two short
 * titles that fold to the same route are one endpoint's failure whatever the
 * record (`GET /api/contacts/by-phone/:id answers 404`), so they fold however
 * few their words.
 */
export function routeTitle(title: string): string | null {
  const words = title.split(/\s+/).filter(Boolean);
  if (!words.some((w) => w.startsWith("/"))) return null;
  return words.map((w) => (w.startsWith("/") ? routeOf(w) : w)).join(" ");
}

/** What the variants' titles share, the part that differs written "…": "budget context missing: … — wrap the origin in withBudget(...)". */
export function foldedTitle(raw: readonly string[]): string {
  // A request id differs on every call: it is no part of what the variants say.
  const titles = raw.map(dropRequestIds);
  if (titles.length < 2 || titles.every((t) => t === titles[0])) return titles[0] ?? "";
  // One endpoint's failure across records reads as its route, never as "GET … answers 404".
  const routes = titles.map(routeTitle);
  if (routes[0] && routes.every((r) => r === routes[0])) return routes[0];
  const words = titles.map((t) => t.split(/\s+/).filter(Boolean));
  const min = Math.min(...words.map((w) => w.length));
  // "status:" and "status" are one word: a title that goes on after a colon shares the words before it.
  const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.replace(/:$/, "") === b.replace(/:$/, "");
  let pre = 0;
  while (pre < min && words.every((w) => same(w[pre], words[0][pre]))) pre++;
  let suf = 0;
  while (suf < min - pre && words.every((w) => w[w.length - 1 - suf] === words[0][words[0].length - 1 - suf])) suf++;
  const head = words[0].slice(0, pre).join(" ");
  // When only some titles go on after a colon there, the shared words end without it.
  const cut = pre > 0 && !words.every((w) => w[pre - 1] === words[0][pre - 1]) ? head.replace(/:$/, "") : head;
  const tail = words[0].slice(words[0].length - suf).join(" ");
  return [cut, "…", tail].filter(Boolean).join(" ");
}

/** What a fold compares: the issue's source, kind, release and title. */
export type FoldGroup = Pick<OpsGroup, "source_id" | "kind" | "last_release" | "title" | "count">;

/**
 * Rows grouped by root cause: the same source, kind and release, titles that
 * differ in one word once their parameters are blanked (titleShape). Sentry
 * fingerprints these as one issue. Each cluster is heaviest first (`weight`,
 * then events, then title), so its lead is the same row on every surface; the
 * clusters keep the order their first row had. A row with no twin is a
 * cluster of one.
 */
export function foldIssueRows<T>(rows: readonly T[], groupOf: (r: T) => FoldGroup, weight: (r: T) => number): T[][] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstBy = new Map<string, number>();
  rows.forEach((r, i) => {
    const g = groupOf(r);
    const scope = `${g.source_id}|${g.kind}|${g.last_release ?? ""}|`;
    const route = routeTitle(g.title);
    for (const k of [...shapeKeys(titleShape(g.title)), ...(route ? [`route:${route}`] : [])]) {
      const key = scope + k;
      const j = firstBy.get(key);
      if (j === undefined) firstBy.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  const clusters = new Map<number, T[]>();
  rows.forEach((r, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), r]));
  return [...clusters.values()].map((c) => c.sort((a, b) => weight(b) - weight(a) || groupOf(b).count - groupOf(a).count || groupOf(a).title.localeCompare(groupOf(b).title)));
}

/** A group's weight in a fold off the home: its events in the last day (all of them for one born today), as the home weighs its rows. */
export function foldWeight(g: Pick<OpsGroup, "buckets" | "count" | "first_seen">, now: number): number {
  const day = bucketSeries(g.buckets, now, 24).reduce((a, b) => a + b, 0);
  return Math.max(day, now - g.first_seen < DAY ? g.count : 0);
}
