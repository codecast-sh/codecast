// What the Apps tab shows, worked out from an app's manifest, grants, watch
// state and call audit: its health as one word, a call's outcome as a short
// reason, the audit folded into groups with what still fails first, and how
// each reader has been used. The full text (an error, a description, a route)
// stays on the rows these are built from. Pure: no React, no store.
import { activeGrant, watchKey, type AppManifest, type AppWatch, type JsonSchema } from "@codecast/shared/contracts/appConnector";
import type { OpsAppCall, OpsGrant, WatchState } from "./opsTypes";

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
/** What names the step that failed ahead of the failure itself: a watch's key, or the manifest fetch. */
const STEP_PREFIX = /^(watch [^:\s]+:[^:\s]+|manifest): /;

export function callActor(c: Pick<OpsAppCall, "conversation_id" | "error">): CallActor {
  if (c.conversation_id) return "session";
  return c.error && WATCH_PREFIX.test(c.error) ? "watch" : "cli";
}

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
  if (http) return `HTTP ${http}`;
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
  /** Put right since: a failure answered well later, or a refusal of an action granted later. */
  settled: boolean;
  /** Still wrong: recent, and not put right since. */
  live: boolean;
};

export type CallContext = { grants: readonly OpsGrant[]; watchState: readonly WatchState[]; watches: readonly AppWatch[]; now: number };

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
    if (!g) groups.set(key, (g = { key, kind: c.kind, name: c.name, status: c.status, actor: callActor(c), count: 0, reasons: [], calls: [], latest: c.created_at, oldest: c.created_at, settled: false, live: false }));
    g.count++;
    g.calls.push(c);
    g.oldest = c.created_at;
    if (c.status === "ok") continue;
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
      g.settled = !!st && !st.last_error && st.polled_at > g.latest;
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

export type WatchRow = { key: string; watch: AppWatch; tone: AppTone; label: string; polledAt: number | null; error: string | null; failures: number; lastFailure: number | null };

/**
 * `fresh` says the state is the server's current answer; a cached row painted
 * before the feed answers is old by nature, so it is never called stale.
 */
export function watchRows(watches: readonly AppWatch[], state: readonly WatchState[], calls: readonly OpsAppCall[], now: number, fresh = true): WatchRow[] {
  return watches.map((watch) => {
    const key = watchKey(watch);
    const st = state.find((s) => s.key === key);
    const failed = calls.filter((c) => c.status === "error" && c.error?.startsWith(`watch ${key}: `));
    const base = { key, watch, polledAt: st?.polled_at ?? null, failures: failed.length, lastFailure: failed.length ? Math.max(...failed.map((c) => c.created_at)) : null };
    if (!st) return { ...base, tone: "off" as const, label: "Waiting", error: null };
    if (st.last_error) return { ...base, tone: "bad" as const, label: callReason({ status: "error", error: st.last_error }), error: st.last_error };
    if (fresh && now - st.polled_at > watch.every_ms * STALE_INTERVALS) return { ...base, tone: "warn" as const, label: "Stale", error: null };
    return { ...base, tone: "ok" as const, label: "OK", error: null };
  });
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

/** How many things are wrong right now: the source itself, its failing watches, and failures outside them that nothing has answered since. */
export function failingNow(source: { status: string }, watches: readonly WatchRow[], groups: readonly CallGroup[]): number {
  return (source.status === "error" ? 1 : 0) + watches.filter((w) => w.tone === "bad").length + groups.filter((g) => g.live && g.status === "error" && g.actor !== "watch").length;
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
