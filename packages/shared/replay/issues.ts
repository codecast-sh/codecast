// What went wrong for the person in a recording (docs/architecture/
// external-data.md X5, "Replay issues"): the moments a replay shows someone
// hitting a wall, each keyed by where it happened (the route) and what failed,
// so a hundred recordings of one broken page make one group, not a hundred.
//
//   error       a page error or console error, by its normalized first line
//   request     a request to the product's own site that failed: any 4xx or
//               5xx, or a write (not GET or HEAD) that got no answer. A GET
//               with no answer is left out: a navigation, an unmount or a
//               long poll cancels those all the time.
//   rage_click  three or more clicks on one element inside RAGE_CLICK_MS
//
// Pure, so the assembler, the vendor import and a regroup pass all read a
// stream the same way.
import type { ReplayEvent } from "../contracts/replay";
import { normalizeErrorMessage, replayIssueFingerprint } from "../contracts/signalFingerprint";
import { isFailedRequest } from "./events";

export const REPLAY_ISSUE_KINDS = ["error", "request", "rage_click"] as const;
export type ReplayIssueKind = (typeof REPLAY_ISSUE_KINDS)[number];

export interface ReplayIssue {
  kind: ReplayIssueKind;
  /** replayIssueFingerprint(kind, route, failure): the group's own fingerprint. */
  fp: string;
  title: string;
  /** The page's path with ids folded (`/book/:id`), where it happened. */
  route: string;
  /** The failure without its route, as the fingerprint reads it. */
  failure: string;
  /** ms after the recording's clock zero (`t0`), of its first occurrence in this recording. */
  t: number;
  /** What the sample keeps: the full message, or the request with its status. */
  message: string;
  /** The page's full url at the moment. */
  url?: string;
}

/** Clicks on one element this close together, three or more, are a rage click. */
export const RAGE_CLICK_MS = 1500;
export const RAGE_CLICK_COUNT = 3;
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

/** An error message's first line, without the stack a console error carries inline. */
export function errorLine(message: string): string {
  const first = message.split("\n")[0];
  return first.replace(/\s+at\s+(?:[\w$.<>\[\]]+\s+)?\(?(?:https?:|file:|webpack:|\/|<anonymous>).*$/, "").trim();
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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
  const add = (kind: ReplayIssueKind, failure: string, title: string, t: number, message: string) => {
    const route = routeOf(parse(page)?.pathname ?? "/");
    const fp = replayIssueFingerprint(kind, route, failure);
    if (!out.has(fp)) out.set(fp, { kind, fp, title: clip(`${title} on ${route}`, 200), route, failure, t: Math.max(0, t - t0), message: clip(message, 2000), ...(page ? { url: page } : {}) });
  };
  // Recent clicks per element, for the rage rule.
  const clicks = new Map<string, number[]>();

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
        if (!line) break;
        const norm = normalizeErrorMessage(line).slice(0, 300);
        add("error", norm, clip(line, 120), e.t, e.type === "error" && e.stack ? `${e.message}\n${e.stack}` : e.message);
        break;
      }
      case "network": {
        if (!isFailedRequest(e) || !sameSite(e.url, page)) break;
        const method = e.method.toUpperCase();
        if (e.status === 0 && (method === "GET" || method === "HEAD")) break;
        const req = parse(e.url);
        const pageHost = parse(page)?.hostname;
        const where = `${req && req.hostname !== pageHost ? req.hostname : ""}${routeOf(req?.pathname ?? e.url)}`;
        const status = e.status === 0 ? "no response" : String(e.status);
        add("request", `${method} ${where} ${status}`, `${method} ${where} ${status}`, e.t, `${method} ${e.url} -> ${status} (${e.ms} ms)`);
        break;
      }
      case "click": {
        const key = e.selector || `${e.role ?? ""}|${e.label}`;
        const times = (clicks.get(key) ?? []).filter((t) => e.t - t <= RAGE_CLICK_MS);
        times.push(e.t);
        clicks.set(key, times);
        if (times.length === RAGE_CLICK_COUNT) {
          const name = targetName(e);
          add("rage_click", key, `Rage click on ${name}`, times[0], `${times.length} clicks on ${name} within ${e.t - times[0]} ms`);
        }
        break;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t).slice(0, REPLAY_ISSUES_MAX);
}
