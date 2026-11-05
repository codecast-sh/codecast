// What the Apps tab shows, worked out from an app's manifest, grants, watch
// state and call audit: its health as one word, a call's outcome as a short
// reason, the audit folded into groups with what still fails first, and how
// each reader has been used. The full text (an error, a description, a route)
// stays on the rows these are built from. Pure: no React, no store.
import { activeGrant, watchKey, type AppManifest, type AppWatch, type JsonSchema } from "@codecast/shared/contracts/appConnector";
import { parseReaderQuery } from "@codecast/shared/contracts/ingest";
import { relTimeShort } from "@codecast/shared/time";
import { watchHealth } from "./metricModel";
import type { OpsAppCall, OpsGrant, OpsWatch, WatchState } from "./opsTypes";

export type AppTone = "ok" | "warn" | "bad" | "off";

const DAY_MS = 24 * 3600_000;
/** A failure nobody has seen answered since stops counting as failing now once it is this old. */
const LIVE_MS = DAY_MS;
/** A watch that has missed this many of its own intervals is stale. */
const STALE_INTERVALS = 3;

// ── A call's outcome ──

/** Who made a call: a session, the app's own watch poll, or a person at a terminal. */
export type CallActor = "session" | "watch" | "cli";

const WATCH_PREFIX = /^watch [^:\s]+:[^:\s]+: /;
/** A metric watch's poll through a reader (sources/appMetrics.ts): `metric <reader>: <failure>`. */
const METRIC_PREFIX = /^metric [^:\s]+: /;
/** What names the step that failed ahead of the failure itself: a watch's key, a metric watch's reader, or the manifest fetch. */
const STEP_PREFIX = /^(watch [^:\s]+:[^:\s]+|metric [^:\s]+|manifest): /;

export function callActor(c: Pick<OpsAppCall, "conversation_id" | "error">): CallActor {
  if (c.conversation_id) return "session";
  return c.error && (WATCH_PREFIX.test(c.error) || METRIC_PREFIX.test(c.error)) ? "watch" : "cli";
}

/** A manifest watch's own poll: its watch state already speaks for it, so the failure is never counted twice. */
const manifestWatchCall = (c: Pick<OpsAppCall, "error">) => !!c.error && WATCH_PREFIX.test(c.error);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A call's outcome in a word or two. The full error stays on the call. */
export function callReason(c: Pick<OpsAppCall, "status" | "http_status" | "error">): string {
  if (c.status === "ok") return "OK";
  if (c.status === "denied") return "Denied";
  const text = (c.error ?? "").replace(STEP_PREFIX, "").trim();
  if (/^no answer in/i.test(text)) return "Timed out";
  if (/^could not reach/i.test(text)) return "Unreachable";
  const http = c.http_status ?? Number(/^answered (\d{3})/.exec(text)?.[1]);
  // A 2xx the app sent is not the failure (an answer too large, the wrong shape): the text names it.
  if (http && (http >= 300 || !text)) return `HTTP ${http}`;
  if (/not JSON/i.test(text)) return "Bad answer";
  if (/is paused$/i.test(text)) return "Paused";
  if (!text) return "Failed";
  const head = text.split(/[:(\n]|\. /)[0].trim();
  return clip(head.charAt(0).toUpperCase() + head.slice(1), 28);
}

// ── The audit, folded ──

export type CallGroup = {
  key: string;
  kind: OpsAppCall["kind"];
  name: string;
  /** How the newest call went: the group stands where its last call left it. */
  status: OpsAppCall["status"];
  /** Who made the newest call. */
  actor: CallActor;
  count: number;
  /** What went wrong across the calls, most frequent first, each with its newest full error. */
  reasons: { reason: string; count: number; error: string | null }[];
  /** Newest first. */
  calls: OpsAppCall[];
  latest: number;
  oldest: number;
  /** The oldest failed call the log holds for it: where its failure count starts. */
  firstFailed: number | null;
  /** Its newest call is a manifest watch's poll (watchRows names that failure). */
  manifestWatch: boolean;
  /** Put right since: a failure answered well later, or a refusal of an action granted later. */
  settled: boolean;
  /** Still wrong: recent, and not put right since. */
  live: boolean;
};

/** A metric watch that may read through one of the app's readers: its last clean read says the reader answered. */
export type ReaderWatch = Pick<OpsWatch, "query_kind" | "query" | "last_error" | "last_at"> & Partial<Pick<OpsWatch, "updated_at">>;

export type CallContext = { grants: readonly OpsGrant[]; watchState: readonly WatchState[]; watches: readonly AppWatch[]; now: number; metricWatches?: readonly ReaderWatch[] };

/**
 * When a reader last answered a metric watch cleanly: the newest read of a
 * watch on that reader whose last read did not fail. A clean read stamps
 * updated_at (convex metrics.ts), and a series reader's last point can be
 * older than the read itself, so the later of the two counts.
 */
export function readerAnsweredAt(reader: string, watches: readonly ReaderWatch[]): number {
  let at = 0;
  for (const w of watches) {
    if (w.query_kind !== "reader" || w.last_error) continue;
    const read = Math.max(w.last_at ?? 0, w.updated_at ?? 0);
    if (read <= at) continue;
    const q = parseReaderQuery(w.query);
    if ("reader" in q && q.reader === reader) at = read;
  }
  return at;
}

/**
 * The audit as one group per reader or action, newest first, standing where
 * its last call left it; the errors and refusals among its calls are its
 * reasons. Groups that are still wrong lead (failures, then refusals).
 */
export function groupCalls(calls: readonly OpsAppCall[], ctx: CallContext): CallGroup[] {
  const groups = new Map<string, CallGroup>();
  for (const c of [...calls].sort((a, b) => b.created_at - a.created_at)) {
    const key = `${c.kind}:${c.name}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, kind: c.kind, name: c.name, status: c.status, actor: callActor(c), count: 0, reasons: [], calls: [], latest: c.created_at, oldest: c.created_at, firstFailed: null, manifestWatch: manifestWatchCall(c), settled: false, live: false }));
    g.count++;
    g.calls.push(c);
    g.oldest = c.created_at;
    if (c.status === "ok") continue;
    if (c.status === "error") g.firstFailed = c.created_at;
    const reason = callReason(c);
    const r = g.reasons.find((x) => x.reason === reason);
    if (r) r.count++;
    else g.reasons.push({ reason, count: 1, error: c.error ?? null });
  }
  for (const g of groups.values()) {
    g.reasons.sort((a, b) => b.count - a.count);
    if (g.status === "error") {
      // A watch polls without leaving an ok row, so its own state says when its reader last answered well.
      const watch = g.kind === "read" ? ctx.watches.find((w) => w.reader === g.name) : undefined;
      const st = watch && ctx.watchState.find((s) => s.key === watchKey(watch));
      // A metric watch reading through the reader counts too: its clean read after the failure is the reader answering well.
      g.settled = (!!st && !st.last_error && st.polled_at > g.latest) || (g.kind === "read" && readerAnsweredAt(g.name, ctx.metricWatches ?? []) > g.latest);
    } else if (g.status === "denied") g.settled = !!activeGrant(ctx.grants, g.name, ctx.now);
    g.live = g.status !== "ok" && !g.settled && ctx.now - g.latest < LIVE_MS;
  }
  const rank = (g: CallGroup) => (!g.live ? 2 : g.status === "error" ? 0 : 1);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.latest - a.latest);
}

/** Where a group stands now, in a word. */
export function groupState(g: Pick<CallGroup, "status" | "live" | "settled">): string {
  if (g.status === "ok") return "OK";
  if (g.status === "denied") return g.settled ? "Granted" : "Denied";
  return g.live ? "Failing" : g.settled ? "Recovered" : "Failed";
}

export const CALL_TONE: Record<OpsAppCall["status"], AppTone> = { ok: "ok", denied: "warn", error: "bad" };

/** A group's ink: what is still wrong keeps its color, what has passed goes quiet. */
export function groupTone(g: Pick<CallGroup, "status" | "live" | "settled">): AppTone {
  return g.status === "ok" || (g.status === "denied" && g.settled) ? "ok" : g.live ? CALL_TONE[g.status] : "off";
}

// ── Watches ──

export type WatchRow = { key: string; watch: AppWatch; tone: AppTone; label: string; polledAt: number | null; error: string | null; failures: number; lastFailure: number | null; paused: boolean; nextAt: number | null };

/**
 * `fresh` says the state is the server's current answer; a cached row painted
 * before the feed answers is old by nature, so it is never called stale.
 */
export function watchRows(watches: readonly AppWatch[], state: readonly WatchState[], calls: readonly OpsAppCall[], now: number, fresh = true): WatchRow[] {
  return watches.map((watch) => {
    const key = watchKey(watch);
    const st = state.find((s) => s.key === key);
    const failed = calls.filter((c) => c.status === "error" && c.error?.startsWith(`watch ${key}: `));
    const polledAt = st?.polled_at || null;
    const paused = !!st?.paused;
    const base = { key, watch, polledAt, failures: failed.length, lastFailure: failed.length ? Math.max(...failed.map((c) => c.created_at)) : null, paused, nextAt: paused ? null : polledAt ? polledAt + watch.every_ms : now };
    if (paused) return { ...base, tone: "off" as const, label: "Paused", error: st?.last_error ?? null };
    if (!st || !polledAt) return { ...base, tone: "off" as const, label: "Waiting", error: null };
    if (st.last_error) return { ...base, tone: "bad" as const, label: callReason({ status: "error", error: st.last_error }), error: st.last_error };
    if (fresh && now - st.polled_at > watch.every_ms * STALE_INTERVALS) return { ...base, tone: "warn" as const, label: "Stale", error: null };
    return { ...base, tone: "ok" as const, label: "OK", error: null };
  });
}

// ── Watches, one reading for every count and dot ──

/**
 * Where a metric watch stands, in the order a person fixes them: alerting
 * (over its line), failing (its reads keep failing: the home's Watch errors),
 * retrying (its last read failed, an older value still stands), waiting for a
 * first read, ok, paused. The overview's tile, its Watches panel, the Apps
 * board and the home's strip all read this, so their numbers add up.
 */
export type WatchVerdict = "alerting" | "failing" | "retrying" | "waiting" | "ok" | "paused";

export const VERDICT_RANK: Record<WatchVerdict, number> = { alerting: 0, failing: 1, retrying: 2, waiting: 3, ok: 4, paused: 5 };
export const VERDICT_TONE: Record<WatchVerdict, "bad" | "warn" | "ok" | "off"> = { alerting: "bad", failing: "bad", retrying: "warn", waiting: "off", ok: "ok", paused: "off" };

type VerdictFields = Pick<OpsWatch, "status" | "state" | "last_error" | "last_value" | "threshold"> & Partial<Pick<OpsWatch, "missed" | "last_at" | "warn" | "direction">>;

export function watchVerdict(w: VerdictFields): WatchVerdict {
  if (w.status === "paused") return "paused";
  if (w.state === "alert") return "alerting";
  if (w.last_error) return watchHealth(w) === "error" ? "failing" : "retrying";
  if (w.last_value == null && !w.last_at) return "waiting";
  return "ok";
}

/** Not ok is anything a person may need to look at: alerting, failing or retrying. */
export const verdictNotOk = (v: WatchVerdict) => v === "alerting" || v === "failing" || v === "retrying";

/** An app connector's own watch (its manifest's poll) in the same words: a failing poll is failing, a paused one paused. */
export function appWatchVerdict(w: { paused?: boolean; last_error?: string; polled_at?: number }): WatchVerdict {
  if (w.paused) return "paused";
  if (w.last_error) return "failing";
  return w.polled_at ? "ok" : "waiting";
}

export type VerdictCounts = Record<WatchVerdict, number> & { total: number; notOk: number };

export function verdictCounts(verdicts: readonly WatchVerdict[]): VerdictCounts {
  const out = { alerting: 0, failing: 0, retrying: 0, waiting: 0, ok: 0, paused: 0, total: verdicts.length, notOk: 0 };
  for (const v of verdicts) {
    out[v]++;
    if (verdictNotOk(v)) out.notOk++;
  }
  return out;
}

/** The tile's breakdown: "2 alerting · 3 retrying", the parts that are not ok, worst first. */
export function verdictBreakdown(c: VerdictCounts): string {
  return (["alerting", "failing", "retrying"] as const).filter((k) => c[k]).map((k) => `${c[k].toLocaleString()} ${k}`).join(" · ");
}

/**
 * A watch whose reads fail, named by the cause in the words the Apps board's
 * pill uses ("timed out", "HTTP 502"), so the overview, the tile and the board
 * say the same thing. Null for a watch whose reads do not fail.
 */
export function watchFailWord(verdict: WatchVerdict, error: string | null | undefined): string | null {
  if (verdict !== "failing" && verdict !== "retrying") return null;
  const reason = error ? callReason({ status: "error", error }) : "Failed";
  return /^HTTP /.test(reason) ? reason : reason.charAt(0).toLowerCase() + reason.slice(1);
}

/** The not-ok watches counted by what is wrong, worst first: "2 alerting · 3 timed out". */
export function watchWordBreakdown(rows: readonly { verdict: WatchVerdict; error?: string | null }[]): string {
  const counts = new Map<string, number>();
  const add = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const r of rows) if (r.verdict === "alerting") add("alerting");
  for (const r of rows) {
    const word = watchFailWord(r.verdict, r.error);
    if (word) add(word);
  }
  return [...counts].map(([k, n]) => `${n.toLocaleString()} ${k}`).join(" · ");
}

/**
 * A source's watches in one reading, the same on every surface that counts
 * them (the overview's header and tile, the Apps board's head, the Settings
 * row). `text` is the sentence a header says, led by the bad ones. A tile's
 * big number (`value` of `total`, labelled `label`) is always the watches ok,
 * whatever else is true, with the bad ones and the unjudged (reading fine, no
 * line to judge by) named in `sub`. When every watch is unjudged there is
 * nothing to count ok: `unjudged`, and the tile reads "11 watches · no lines".
 */
export type WatchTally = { bad: number; total: number; ok: number; noLine: number; value: number; word: string; tone: "bad" | "warn" | "ok" | "off"; text: string; sub: string; /** The tile's label beside value/total. */ label: string; /** Every watch reads fine with no line: nothing is judged yet. */ unjudged: boolean };

export function watchTally(verdicts: readonly WatchVerdict[], opts: { noLine?: number } = {}): WatchTally {
  const c = verdictCounts(verdicts);
  const failing = c.failing + c.retrying;
  const noLine = Math.min(opts.noLine ?? 0, c.ok);
  const ok = c.total - c.notOk - noLine;
  const word = c.alerting && failing ? "alerting or failing" : c.alerting ? "alerting" : failing ? "failing" : "ok";
  const tone = c.alerting || c.failing ? "bad" : c.retrying ? "warn" : !ok && noLine ? "off" : "ok";
  const n = (x: number) => x.toLocaleString();
  const noun = (x: number) => (x === 1 ? "watch" : "watches");
  const noLineWord = noLine ? `${n(noLine)} no line` : "";
  const sub = [c.notOk ? verdictBreakdown(c) : "", noLineWord].filter(Boolean).join(" · ");
  const text = c.notOk ? `${n(c.notOk)} of ${n(c.total)} ${noun(c.total)} ${word}` : noLine ? `${n(ok)} of ${n(c.total)} ${noun(c.total)} ok · ${noLineWord}` : `${n(c.total)} ${noun(c.total)} ok`;
  const unjudged = c.total > 0 && noLine === c.total;
  return { bad: c.notOk, total: c.total, ok, noLine, value: ok, word, tone, text: unjudged ? `${n(c.total)} ${noun(c.total)} · no lines` : text, sub: unjudged ? "" : sub, label: unjudged ? `${noun(c.total)} · no lines` : "watches ok", unjudged };
}

/** An app's own watch row (watchRows) under the one reading, so the board counts what the overview counts. */
export function watchRowVerdict(w: Pick<WatchRow, "paused" | "error" | "polledAt">): WatchVerdict {
  return appWatchVerdict({ paused: w.paused, last_error: w.error ?? undefined, polled_at: w.polledAt ?? undefined });
}

// ── Metric watches that read through the app ──

export type MetricWatchRow = { id: string; ref: string; name: string; verdict: WatchVerdict; tone: AppTone; label: string; /** Reading fine with no line to judge it by. */ noLine: boolean; value: number | null; unit?: string; at: number | null; error: string | null; reader: string | null; paused: boolean; /** Its last read failed: the value shown is older than its last try. */ stale: boolean };

/**
 * A metric watch as the board lists it, under the one reading (watchVerdict):
 * alerting, failing to read, its last read failed (retrying), waiting, OK or
 * paused, with its last value and why it failed.
 */
export function metricWatchRow(w: Pick<OpsWatch, "_id" | "short_id" | "name" | "status" | "state" | "last_error" | "last_value" | "last_at" | "unit" | "query_kind" | "query" | "threshold"> & Partial<Pick<OpsWatch, "missed" | "warn" | "direction">>): MetricWatchRow {
  const verdict = watchVerdict(w);
  const reason = w.last_error ? callReason({ status: "error", error: w.last_error }) : null;
  // A watch reading fine with no line is unjudged: "No line", the word the band and the Metrics filter give it, never OK.
  const noLine = verdict === "ok" && w.threshold === undefined;
  const label = verdict === "paused" ? "Paused" : verdict === "alerting" ? "Alert" : verdict === "waiting" ? "Waiting" : noLine ? "No line" : verdict === "ok" ? "OK" : reason ?? "Failed";
  return {
    id: w._id, ref: w.short_id || w._id, name: w.name, verdict, tone: noLine ? "off" : VERDICT_TONE[verdict], label, noLine,
    value: w.last_value, unit: w.unit, at: w.last_at, error: verdict === "paused" ? null : w.last_error ?? null,
    reader: w.query_kind === "reader" ? w.query.trim().split(/\s+/)[0] || null : null,
    paused: verdict === "paused", stale: verdict === "failing" || verdict === "retrying",
  };
}

/** The shared health tone (sourceHealth.ts) in the board's inks: a quiet source is not a fault. */
export function healthTone(t: "ok" | "calm" | "warn" | "bad" | "off"): AppTone {
  return t === "calm" ? "off" : t;
}

// ── Health ──

export type AppHealth = { tone: AppTone; label: string; detail: string | null };

/** The connection in one word: the source's own state first, then what its watches and recent calls say. */
export function appHealth(source: { status: string; last_error?: string }, watches: readonly WatchRow[], groups: readonly CallGroup[]): AppHealth {
  if (source.status === "error") return { tone: "bad", label: "Error", detail: source.last_error ?? null };
  if (source.status === "paused") return { tone: "off", label: "Paused", detail: null };
  const failing = watches.filter((w) => w.tone === "bad");
  if (failing.length) return { tone: "bad", label: "Failing", detail: failing[0].error };
  const live = groups.filter((g) => g.live && g.status === "error");
  if (live.length) return { tone: "warn", label: "Degraded", detail: live[0].calls[0].error ?? null };
  if (watches.some((w) => w.tone === "warn")) return { tone: "warn", label: "Stale", detail: null };
  return { tone: "ok", label: "Healthy", detail: null };
}

/**
 * The board's "calls failing": every read, action and watch poll failing
 * right now, exactly the rows Recent calls lists under Failing now, so the
 * number over the list is the length of the list.
 */
export function callsFailing(groups: readonly Pick<CallGroup, "live" | "status">[]): number {
  return groups.filter((g) => g.live && g.status === "error").length;
}

/**
 * The readers and actions failing right now outside the watches (whose own
 * state already speaks for them): what failingNow counts, named, for the
 * source's one health reading (sourceHealth AppFailure).
 */
export type LiveFailure = {
  kind: OpsAppCall["kind"];
  name: string;
  /** The most frequent reason, in a word or two ("HTTP 502"). */
  reason: string;
  /** Every reason with its count, most frequent first. */
  reasons: { reason: string; count: number }[];
  /** Failed calls the log holds, since `since`. */
  count: number;
  /** The oldest of those failures: the window the count covers. */
  since: number | null;
};

export function liveFailures(calls: readonly OpsAppCall[], ctx: CallContext): LiveFailure[] {
  return groupCalls(calls, ctx)
    .filter((g) => g.live && g.status === "error" && !g.manifestWatch)
    .map((g) => {
      const reasons = g.reasons.map((r) => ({ reason: r.reason, count: r.count }));
      return { kind: g.kind, name: g.name, reason: reasons[0]?.reason ?? "Failed", reasons, count: reasons.reduce((n, r) => n + r.count, 0), since: g.firstFailed };
    });
}

/** A reason as what the reader or action does: "returns HTTP 502", "times out". */
export function failVerb(reason: string): string {
  if (/^HTTP \d{3}$/.test(reason)) return `returns ${reason}`;
  if (reason === "Timed out") return "times out";
  if (reason === "Unreachable") return "cannot be reached";
  if (reason === "Bad answer") return "answers with something that is not JSON";
  if (reason === "Denied") return "is refused";
  if (reason === "Paused") return "is paused";
  return `fails (${reason})`;
}

/**
 * One failing reader or action as a sentence, with its count and the window
 * the count covers: "metrics.read returns HTTP 502 or times out, 95× in the
 * last 3h". The Apps board and every health line read the same aggregate.
 */
export function failureLine(f: Pick<LiveFailure, "name" | "reason" | "count"> & Partial<Pick<LiveFailure, "reasons" | "since">>, now: number): string {
  const reasons = (f.reasons?.length ? f.reasons.map((r) => r.reason) : [f.reason]).slice(0, 2);
  const span = f.since ? relTimeShort(f.since, now) : null;
  const window = !span ? "" : span === "now" ? " just now" : ` in the last ${span}`;
  return `${f.name} ${reasons.map(failVerb).join(" or ")}, ${f.count.toLocaleString()}×${window}`;
}

/** When anything last failed, whoever called. */
export function lastFailure(calls: readonly OpsAppCall[]): number | null {
  let at = 0;
  for (const c of calls) if (c.status === "error" && c.created_at > at) at = c.created_at;
  return at || null;
}

/** When the app last answered well: a good call, or a watch poll that came back clean. */
export function lastAnswered(calls: readonly OpsAppCall[], watchState: readonly WatchState[]): number | null {
  let at = 0;
  for (const c of calls) if (c.status === "ok" && c.created_at > at) at = c.created_at;
  for (const w of watchState) if (!w.last_error && w.polled_at > at) at = w.polled_at;
  return at || null;
}

// ── Use ──

export type Usage = { count: number; failed: number; last: number | null };

/** How each reader or action has been called, by `kind:name`. */
export function usageByName(calls: readonly OpsAppCall[]): Map<string, Usage> {
  const out = new Map<string, Usage>();
  for (const c of calls) {
    const k = `${c.kind}:${c.name}`;
    const u = out.get(k) ?? { count: 0, failed: 0, last: null };
    u.count++;
    if (c.status === "error") u.failed++;
    u.last = Math.max(u.last ?? 0, c.created_at);
    out.set(k, u);
  }
  return out;
}

// ── A manifest entry's arguments ──

export type Param = { name: string; type: string; required: boolean; description: string | null };

export function schemaParams(input: JsonSchema | undefined): Param[] {
  const required = new Set(input?.required ?? []);
  return Object.entries(input?.properties ?? {}).map(([name, p]) => ({
    name,
    type: p.enum ? p.enum.map(String).join(" | ") : Array.isArray(p.type) ? p.type.join(" | ") : p.type ?? "any",
    required: required.has(name),
    description: p.description ?? null,
  }));
}

/** The human title a call's name stands for, from the manifest that declares it. */
export function titleLookup(manifest: Pick<AppManifest, "readers" | "actions"> | null, extra: readonly { name: string; title: string }[] = []): (kind: OpsAppCall["kind"], name: string) => string {
  const titles = new Map<string, string>();
  for (const r of manifest?.readers ?? []) titles.set(`read:${r.name}`, r.title);
  for (const a of [...(manifest?.actions ?? []), ...extra]) titles.set(`do:${a.name}`, a.title);
  return (kind, name) => titles.get(`${kind}:${name}`) ?? name;
}

// ── Grants ──

/** What a high-risk grant hands over, for the shared confirm flow (components/consequential). */
export function grantLedger(a: { name: string; title: string; risk?: string; idempotent?: boolean; method?: string; path?: string }, source: { name: string }, usage: { count: number; failed: number } | undefined) {
  return {
    name: a.title,
    subject: source.name,
    shift: ["Off", "Granted"] as [string, string],
    alert: a.risk === "high" ? "High risk" : undefined,
    figures: [
      { value: a.idempotent ? "Safe" : "Repeats", label: a.idempotent ? "to run twice" : "each call runs again", ...(a.idempotent ? {} : { tone: "warn" as const }) },
      { value: String(usage?.count ?? 0), label: "calls so far" },
    ],
    rows: [
      { k: "Action", v: a.name },
      ...(a.path ? [{ k: "Route", v: `${a.method ?? "POST"} ${a.path}` }] : []),
      { k: "Who can call it", v: "Any agent session in this workspace" },
      { k: "Each call", v: "Signed and logged under Recent calls" },
    ],
    stop: "Turn the switch off",
    confirm: "Grant",
  };
}

/** The call log's filters: outcome and who called. */
export type CallFilter = { status: OpsAppCall["status"] | null; actor: CallActor | null };

export function filterCalls(calls: readonly OpsAppCall[], f: CallFilter): OpsAppCall[] {
  return calls.filter((c) => (!f.status || c.status === f.status) && (!f.actor || callActor(c) === f.actor));
}

// ── Fixing a failing call ──

/** The fix session's facts for a reader or action that keeps failing: what failed, how often, since when, with the newest full error. */
export function callFixFacts(source: { name: string; short_id: string }, g: Pick<CallGroup, "kind" | "name" | "reasons" | "count" | "oldest" | "latest">): { ref: string; title: string; failure: string } {
  const what = g.kind === "read" ? "reader" : "action";
  const failed = g.reasons.reduce((n, r) => n + r.count, 0);
  const reasons = g.reasons.slice(0, 3).map((r) => `${r.reason} (${r.count}x)`).join("; ");
  const newest = g.reasons.find((r) => r.error)?.error;
  return {
    ref: `${source.short_id || source.name} ${g.name}`,
    title: `The ${what} ${g.name} on the ${source.name} app keeps failing`,
    failure: [`${failed} of the last ${g.count} calls failed between ${new Date(g.oldest).toISOString()} and ${new Date(g.latest).toISOString()}: ${reasons}`, newest ? `Newest error: ${newest.slice(0, 600)}` : null].filter(Boolean).join("\n"),
  };
}
