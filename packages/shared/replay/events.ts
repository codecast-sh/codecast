// The rules every reader of a replay stream shares (docs/architecture/
// external-data.md X5): what counts as a failure, which failure a repro
// targets, the manifest counts, and how a moment is written. The timeline,
// the repro, the rrweb converter and the Convex assembler all import these,
// so "a failed request" means one thing everywhere.
import { REPLAY_KEYS, REPLAY_LIMITS, type ReplayEvent } from "../contracts/replay";

type NetworkEvent = Extract<ReplayEvent, { type: "network" }>;
type ConsoleEvent = Extract<ReplayEvent, { type: "console" }>;
type ErrorEvent = Extract<ReplayEvent, { type: "error" }>;

/** A request that failed outright (status 0: blocked, offline, CORS) or answered 4xx or 5xx. */
export function isFailedRequest(e: ReplayEvent): e is NetworkEvent {
  return e.type === "network" && (e.status === 0 || e.status >= 400);
}

/** Over the recorder's slow line: recorded even when it succeeded. */
export function isSlowRequest(e: ReplayEvent): e is NetworkEvent {
  return e.type === "network" && e.ms >= REPLAY_LIMITS.network_slow_ms;
}

export type ReplayFailure = ErrorEvent | NetworkEvent | (ConsoleEvent & { level: "error" });

/** Something went wrong here: a page error, a console error, or a failed request. */
export function isFailure(e: ReplayEvent): e is ReplayFailure {
  return e.type === "error" || (e.type === "console" && e.level === "error") || isFailedRequest(e);
}

/**
 * The failure a repro aims at: the first page error when there is one (it is
 * what the person saw break), else the first console error, else the first
 * failed request. A failed request usually precedes the error it causes, so
 * picking by position alone would aim the repro at the symptom's cause and
 * miss the error the group is about.
 */
export function primaryFailure(events: readonly ReplayEvent[]): ReplayFailure | undefined {
  return (
    events.find((e): e is ErrorEvent => e.type === "error") ??
    events.find((e): e is ReplayFailure => e.type === "console" && e.level === "error") ??
    events.find(isFailedRequest)
  );
}

/** The manifest's counts (replays.counts), computed from the stream itself. */
export function replayCounts(events: readonly ReplayEvent[]): { clicks: number; errors: number; failed_requests: number } {
  let clicks = 0, errors = 0, failed = 0;
  for (const e of events) {
    if (e.type === "click") clicks++;
    else if (e.type === "error" || (e.type === "console" && e.level === "error")) errors++;
    else if (isFailedRequest(e)) failed++;
  }
  return { clicks, errors, failed_requests: failed };
}

/** Events in time order. Chunks arrive in order but a merged stream may not be; equal stamps keep their order. */
export function sortReplayEvents(events: readonly ReplayEvent[]): ReplayEvent[] {
  return events.map((e, i) => [e, i] as const).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([e]) => e);
}

const s = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Events from an untrusted chunk (an SDK upload, a vendor recording), checked
 * and clipped to REPLAY_LIMITS. Anything malformed is dropped rather than
 * failing the chunk: one bad event must not cost the recording around it.
 * Accepts the array itself or `{ events: [...] }`.
 */
export function parseReplayEvents(body: unknown): ReplayEvent[] {
  const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as any).events) ? (body as any).events : [];
  const L = REPLAY_LIMITS;
  const out: ReplayEvent[] = [];
  for (const raw of list as any[]) {
    if (!raw || typeof raw !== "object") continue;
    const t = n(raw.t);
    if (t === undefined || t < 0) continue;
    let e: ReplayEvent | undefined;
    switch (raw.type) {
      case "nav": {
        const url = s(raw.url, L.url_max_chars);
        if (url) e = { type: "nav", t, url, ...(s(raw.title, L.label_max_chars) ? { title: s(raw.title, L.label_max_chars) } : {}) };
        break;
      }
      case "click": {
        const role = s(raw.role, 40), text = s(raw.text, L.label_max_chars);
        e = { type: "click", t, label: s(raw.label, L.label_max_chars) ?? "", selector: s(raw.selector, L.selector_max_chars) ?? "", ...(role ? { role } : {}), ...(text ? { text } : {}) };
        break;
      }
      case "input":
        e = { type: "input", t, label: s(raw.label, L.label_max_chars) ?? "", selector: s(raw.selector, L.selector_max_chars) ?? "", length: Math.max(0, Math.round(n(raw.length) ?? 0)), redacted: true };
        break;
      case "submit":
        e = { type: "submit", t, label: s(raw.label, L.label_max_chars) ?? "", selector: s(raw.selector, L.selector_max_chars) ?? "" };
        break;
      case "key":
        if ((REPLAY_KEYS as readonly unknown[]).includes(raw.key)) e = { type: "key", t, key: raw.key };
        break;
      case "scroll": {
        const y = n(raw.y);
        if (y !== undefined) e = { type: "scroll", t, y, of: n(raw.of) ?? 0 };
        break;
      }
      case "console":
        if (raw.level === "warn" || raw.level === "error") e = { type: "console", t, level: raw.level, message: s(raw.message, L.console_message_max_chars) ?? "" };
        break;
      case "network": {
        const url = s(raw.url, L.url_max_chars);
        if (url) e = { type: "network", t, method: (s(raw.method, 16) ?? "GET").toUpperCase(), url, status: n(raw.status) ?? 0, ms: n(raw.ms) ?? 0 };
        break;
      }
      case "error": {
        const message = s(raw.message, L.console_message_max_chars);
        const stack = s(raw.stack, L.error_stack_max_chars);
        if (message) e = { type: "error", t, message, ...(stack ? { stack } : {}) };
        break;
      }
      case "view": {
        const outline = s(raw.outline, L.view_outline_max_chars);
        if (outline) e = { type: "view", t, outline };
        break;
      }
      case "mark": {
        const name = s(raw.name, L.label_max_chars);
        if (!name) break;
        let data: Record<string, unknown> | undefined;
        if (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) {
          try {
            const json = JSON.stringify(raw.data);
            data = json.length <= L.mark_data_max_chars ? JSON.parse(json) : { _truncated: `${json.length} chars` };
          } catch {
            data = undefined;
          }
        }
        e = { type: "mark", t, name, ...(data ? { data } : {}) };
        break;
      }
    }
    if (e) out.push(e);
  }
  return out;
}

/** A moment in the recording as m:ss.s (h:mm:ss past an hour). */
export function formatReplayTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** The path, query and hash of a recorded URL, which is what a repro replays against another origin. */
export function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}
