// What went wrong for the person in a recording (docs/architecture/
// external-data.md X5, "Replay issues"): the moments a replay shows someone
// hitting a wall, each keyed by what failed and where it lives, so a hundred
// recordings of one breakage make one group, not a hundred.
//
//   error       a page error or console error, keyed by its normalized first
//               line. Not by page: an error thrown by a layout or a provider
//               shows on every page under it, and is one problem. One failure
//               is often written by several sites at once (an SDK, then the
//               provider wrapping it): errors within ECHO_MS of each other are
//               one failure, keyed by the line among them that sorts first, so
//               the key does not depend on which site wrote first. An error
//               that names a request which just failed is that request's.
//   request     a request to the product's own site that failed, keyed by
//               method, endpoint (ids folded) and status: any 4xx or 5xx, or
//               a write (not GET or HEAD) that got no answer. A GET with no
//               answer is left out (a navigation, an unmount or a long poll
//               cancels those all the time), and so is Cloudflare's own
//               /cdn-cgi/ traffic. A gateway status (502, 503, 504, 520 to
//               524) says the service behind the endpoint did not answer, so
//               it is keyed by that service, not the endpoint: one outage is
//               one issue however many of its endpoints a page called. A 500
//               is the endpoint's own handler failing and keeps its endpoint.
//   rage_click  RAGE_CLICK_COUNT clicks inside RAGE_CLICK_MS on one button
//               or link, keyed by page and target. Text, fields, radios and
//               checkboxes are clicked repeatedly on purpose (selecting a
//               word, moving the caret, changing a choice), so they never are.
//
// The route an issue was first seen on rides along as its culprit and sample.
// Pure, so the assembler, the vendor import and a regroup pass all read a
// stream the same way.
import type { ReplayEvent } from "../contracts/replay";
import { normalizeErrorMessage, replayIssueFingerprint } from "../contracts/signalFingerprint";
import { isFailedRequest } from "./events";

export const REPLAY_ISSUE_KINDS = ["error", "request", "rage_click"] as const;
export type ReplayIssueKind = (typeof REPLAY_ISSUE_KINDS)[number];

export interface ReplayIssue {
  kind: ReplayIssueKind;
  /** replayIssueFingerprint(kind, failure): the group's own fingerprint. */
  fp: string;
  title: string;
  /** The page's path with ids folded (`/book/:id`), where it happened. */
  route: string;
  /** What the fingerprint reads: the error line, the request, or a rage click's page and target. */
  failure: string;
  /** ms after the recording's clock zero (`t0`), of its first occurrence in this recording. */
  t: number;
  /** What the sample keeps: the full message, or the request with its status. */
  message: string;
  /** The page's full url at the moment. */
  url?: string;
}

/** Clicks on one button or link this close together, this many, are a rage click. */
export const RAGE_CLICK_MS = 1000;
export const RAGE_CLICK_COUNT = 3;
const PRESSABLE_ROLES = new Set(["button", "link", "menuitem", "tab"]);
/**
 * Errors this close together are one failure written by several sites. Echoes
 * on Union's recordings land within 56 ms of each other; distinct failures in
 * one recording, seconds apart (2026-10-20, 717 recordings).
 */
export const ECHO_MS = 100;
/** Statuses that say the service behind an endpoint did not answer: an outage, not the endpoint's bug. */
const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
/** Issues one recording contributes; past it the earliest are kept. */
export const REPLAY_ISSUES_MAX = 20;

const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=.*\d)[0-9a-f]{8,}$/i,
  // A random token: long, letters and digits mixed (`K6DuuR5T0jm7mXWD...`).
  /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{16,}$/,
];

/** A path with the segments that name one record folded to `:id`, so every record's page is one route. */
export function routeOf(path: string): string {
  const clean = path.split(/[?#]/)[0] || "/";
  const segments = clean.split("/").map((s) => (s && ID_SEGMENT.some((re) => re.test(s)) ? ":id" : s));
  const out = segments.join("/").replace(/\/+$/, "");
  return out || "/";
}

function parse(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The registrable part of a host, roughly: the last two labels, three under a short second-level label (co.uk). */
function siteOf(host: string): string {
  const labels = host.toLowerCase().split(".");
  if (labels.length <= 2) return labels.join(".");
  const take = labels[labels.length - 2].length <= 3 && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** The request went to the product itself (its own host or a sibling like api.<site>), not a vendor's. */
export function sameSite(requestUrl: string, pageUrl: string | undefined): boolean {
  const req = parse(requestUrl);
  const page = parse(pageUrl);
  if (!req) return requestUrl.startsWith("/");
  if (!page) return false;
  return siteOf(req.hostname) === siteOf(page.hostname);
}

/** An error message's first line, without the stack a console error carries inline (V8's `at f (url)`, Safari's `f@url:1:2`). */
export function errorLine(message: string): string {
  const first = message.split("\n")[0];
  return first
    .replace(/\s+at\s+(?:[\w$.<>\[\]]+\s+)?\(?(?:https?:|file:|webpack:|\/|<anonymous>).*$/, "")
    .replace(/\s*[\w$.<>]*@(?:https?:|file:|webpack:)\S*:\d+:\d+.*$/, "")
    .replace(/[\s:]+$/, "")
    .trim();
}

/** The service an endpoint belongs to: `/api/<service>` under an api prefix, else the first segment. */
export function serviceOf(route: string): string {
  const segs = route.split("/").filter(Boolean);
  if (!segs.length) return "/";
  return segs[0] === "api" && segs[1] && segs[1] !== ":id" ? `/api/${segs[1]}` : `/${segs[0]}`;
}

type ErrorEvent = Extract<ReplayEvent, { type: "error" | "console" }>;
const isErrorEvent = (e: ReplayEvent): e is ErrorEvent => e.type === "error" || (e.type === "console" && e.level === "error");

/**
 * Each error event's failure: errors within ECHO_MS of the one before are one
 * failure, and every member takes the line that sorts first among them. An
 * error whose line names a request that failed within ECHO_MS before it is
 * that request's echo and files nothing of its own (null).
 */
function errorFailures(events: readonly ReplayEvent[]): Map<ReplayEvent, string | null> {
  const out = new Map<ReplayEvent, string | null>();
  let cluster: ErrorEvent[] = [];
  const close = () => {
    const lines = cluster.map((e) => normalizeErrorMessage(errorLine(e.message)).slice(0, 300)).filter(Boolean);
    const key = lines.length ? [...lines].sort()[0] : null;
    for (const e of cluster) if (!out.has(e)) out.set(e, key);
    cluster = [];
  };
  let lastFailedRequest: Extract<ReplayEvent, { type: "network" }> | null = null;
  for (const e of events) {
    if (e.type === "network" && isFailedRequest(e)) lastFailedRequest = e;
    if (!isErrorEvent(e)) continue;
    const path = lastFailedRequest ? parse(lastFailedRequest.url)?.pathname : undefined;
    if (lastFailedRequest && path && path !== "/" && e.t - lastFailedRequest.t <= ECHO_MS && e.message.includes(path)) {
      out.set(e, null);
      continue;
    }
    if (cluster.length && e.t - cluster[cluster.length - 1].t > ECHO_MS) close();
    cluster.push(e);
  }
  close();
  return out;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A click on something that should answer a press: a button or a link, by role or tag. */
function pressable(e: Extract<ReplayEvent, { type: "click" }>): boolean {
  if (e.role) return PRESSABLE_ROLES.has(e.role);
  return /^(button|a)(?=$|[.#\[:\s>])/i.test(e.selector) || /^input\[type=(submit|button)\]/i.test(e.selector);
}

/** A click's target as a person would name it. */
function targetName(e: Extract<ReplayEvent, { type: "click" }>): string {
  const label = e.label?.trim();
  if (label) return `${e.role ? `${e.role} ` : ""}"${clip(label, 60)}"`;
  if (e.role) return `${e.role} ${e.selector ? clip(e.selector, 60) : "(unlabeled)"}`;
  return e.selector ? clip(e.selector, 80) : "(unlabeled)";
}

/**
 * The walls one recording shows, one per fingerprint, earliest first.
 * `startUrl` is the page the recording opened on, for events before its
 * first navigation. `t0` is the stream time of the recording's start: our
 * recorder counts from it (0), a vendor stream from some clock of its own, so
 * its first event stands in.
 */
export function replayIssues(events: readonly ReplayEvent[], startUrl?: string, t0: number = events[0]?.t ?? 0): ReplayIssue[] {
  const out = new Map<string, ReplayIssue>();
  let page = startUrl;
  const route = () => routeOf(parse(page)?.pathname ?? "/");
  const add = (kind: ReplayIssueKind, failure: string, title: string, t: number, message: string) => {
    const fp = replayIssueFingerprint(kind, failure);
    if (!out.has(fp)) out.set(fp, { kind, fp, title: clip(title, 200), route: route(), failure, t: Math.max(0, t - t0), message: clip(message, 2000), ...(page ? { url: page } : {}) });
  };
  // Recent clicks per element, for the rage rule.
  const clicks = new Map<string, number[]>();
  const failures = errorFailures(events);

  for (const e of events) {
    switch (e.type) {
      case "nav":
        page = e.url;
        clicks.clear();
        break;
      case "error":
      case "console": {
        if (e.type === "console" && e.level !== "error") break;
        const line = errorLine(e.message);
        const failure = failures.get(e);
        if (!line || !failure) break;
        // The title is the line its failure is keyed by, so every recording names one failure alike.
        const title = failure === normalizeErrorMessage(line).slice(0, 300) ? line : failure;
        add("error", failure, clip(title, 120), e.t, e.type === "error" && e.stack ? `${e.message}\n${e.stack}` : e.message);
        break;
      }
      case "network": {
        if (!isFailedRequest(e) || !sameSite(e.url, page)) break;
        const method = e.method.toUpperCase();
        if (e.status === 0 && (method === "GET" || method === "HEAD")) break;
        const req = parse(e.url);
        if (req?.pathname.startsWith("/cdn-cgi/")) break;
        const pageHost = parse(page)?.hostname;
        const host = req && req.hostname !== pageHost ? req.hostname : "";
        const route = routeOf(req?.pathname ?? e.url);
        const where = `${host}${route}`;
        const status = e.status === 0 ? "no response" : String(e.status);
        if (GATEWAY_STATUSES.has(e.status)) {
          const service = `${host}${serviceOf(route)}`;
          add("request", `${service} unavailable`, `${service} does not answer (${status} on ${where})`, e.t, `${method} ${e.url} -> ${status} (${e.ms} ms)`);
          break;
        }
        add("request", `${method} ${where} ${status}`, `${method} ${where} answers ${status}`, e.t, `${method} ${e.url} -> ${status} (${e.ms} ms)`);
        break;
      }
      case "click": {
        if (!pressable(e)) break;
        const key = e.selector || `${e.role ?? ""}|${e.label}`;
        const times = (clicks.get(key) ?? []).filter((t) => e.t - t <= RAGE_CLICK_MS);
        times.push(e.t);
        clicks.set(key, times);
        if (times.length === RAGE_CLICK_COUNT) {
          const name = targetName(e);
          add("rage_click", `${route()} ${key}`, `Rage click on ${name} on ${route()}`, times[0], `${times.length} clicks on ${name} within ${e.t - times[0]} ms`);
        }
        break;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t).slice(0, REPLAY_ISSUES_MAX);
}
