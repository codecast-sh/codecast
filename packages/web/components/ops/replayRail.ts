// The replay player's event rail as pure rules: which events each tab admits,
// how a run of repeats folds, how an event reads, and how the clock steps
// between them. Kept beside replayModel.ts and tested with it.
import { isFailedRequest, isFailure, isRecorderNoise, isSlowRequest, replayIssues, routeOf } from "@codecast/shared/replay";
import type { ReplayEvent } from "@codecast/shared/contracts/replay";
import { pathOf, plural } from "./replayModel";

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
  // Typing into one field records a row per key: the run reads as one row with what the field held at its end.
  if (e.type === "input") return `t|${e.selector || e.label || ""}`;
  return null;
}

/** A folded run's own words where its lead alone would mislead: typing reads as the field at the run's end and how long it took. Null for every other run. */
export function runText(lead: ReplayEvent, last: ReplayEvent): string | null {
  if (lead.type !== "input" || last.type !== "input" || lead.length === 0) return null;
  const s = (last.t - lead.t) / 1000;
  return `${describeEvent(last)} · ${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
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
    // Ids fold to :id as the list and the person card print a page; the raw address stays in the row's tooltip.
    case "nav": return e.title ? `${routeOf(pathOf(e.url))} · ${e.title}` : routeOf(pathOf(e.url));
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
