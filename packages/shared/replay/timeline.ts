// The text timeline of a replay (docs/architecture/external-data.md X5): what
// `cast replay show` prints and what the replays row caches as timeline_md.
// One line per moment, times relative to the start, a burst of scrolling or
// typing folded into one line, failures in bold, and page outlines cut to a
// glance. It must fit REPLAY_LIMITS.timeline_md_max_chars, and when it does
// not, the lines kept are the ones around the failure an agent is there for.
import { REPLAY_LIMITS, type ReplayEvent } from "../contracts/replay";
import { clip } from "../changes/headline";
import { formatReplayTime, isFailedRequest, primaryFailure, replayCounts, sortReplayEvents, urlPath } from "./events";

export interface TimelineOptions {
  /** Cap on the whole text. Defaults to the cached column's cap. */
  maxChars?: number;
  /** Heading words, e.g. the replay's short id. */
  title?: string;
}

/** How much of a page outline a timeline shows; the full outline stays in the stream. */
const VIEW_PREVIEW_CHARS = 280;
const STACK_LINES = 4;
const MESSAGE_CHARS = 300;

interface Entry {
  text: string;
  failure: boolean;
  /** A view line, the first thing dropped when the timeline is over its cap. */
  view: boolean;
}

const q = (s: string) => JSON.stringify(clip(s, 120));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function target(e: { label: string; role?: string }): string {
  const label = e.label ? q(e.label) : "(unlabeled)";
  return e.role ? `${e.role} ${label}` : label;
}

function abbreviateOutline(outline: string): string {
  const flat = outline.split(/\n+/).map((l) => l.trim()).filter(Boolean).join(" | ");
  if (flat.length <= VIEW_PREVIEW_CHARS) return flat;
  return `${clip(flat, VIEW_PREVIEW_CHARS)} (+${flat.length - VIEW_PREVIEW_CHARS} chars)`;
}

function stackLines(stack: string | undefined): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((l) => l.trim()).filter((l) => l && !/^\w*Error\b.*:/.test(l)).slice(0, STACK_LINES);
  return lines.map((l) => `\n    ${clip(l, 160)}`).join("");
}

/** Consecutive events that read as one moment fold together: a scroll burst, keystrokes into one field, a repeated console line. */
function fold(events: ReplayEvent[]): Array<{ event: ReplayEvent; times: number; from: number }> {
  const out: Array<{ event: ReplayEvent; times: number; from: number }> = [];
  for (const e of events) {
    const last = out[out.length - 1];
    const same =
      last &&
      ((e.type === "scroll" && last.event.type === "scroll") ||
        (e.type === "input" && last.event.type === "input" && last.event.selector === e.selector) ||
        (e.type === "console" && last.event.type === "console" && last.event.message === e.message && last.event.level === e.level));
    if (same) {
      last.event = e;
      last.times++;
    } else out.push({ event: e, times: 1, from: e.t });
  }
  return out;
}

function line(e: ReplayEvent, times: number, from: number): Entry {
  const at = formatReplayTime(from);
  const x = times > 1 ? ` x${times}` : "";
  const entry = (text: string, failure = false, view = false): Entry => ({ text: `- ${at} ${text}`, failure, view });
  switch (e.type) {
    case "nav":
      return entry(`nav ${urlPath(e.url)}${e.title ? ` ${q(e.title)}` : ""}`);
    case "click":
      return entry(`click ${target(e)}${e.text && e.text !== e.label ? ` (text ${q(e.text)})` : ""}`);
    case "input":
      return entry(`type into ${target(e)}: ${plural(e.length, "char")}${x}`);
    case "submit":
      return entry(`submit ${target(e)}`);
    case "key":
      return entry(`key ${e.key}`);
    case "scroll":
      return entry(`scroll${x} to ${Math.round(e.y)}${e.of ? ` of ${Math.round(e.of)}` : ""}`);
    case "console":
      return e.level === "error"
        ? entry(`**console.error${x}** ${clip(e.message, MESSAGE_CHARS)}`, true)
        : entry(`console.warn${x} ${clip(e.message, MESSAGE_CHARS)}`);
    case "network": {
      const req = `${e.method} ${urlPath(e.url)} -> ${e.status || "failed"} (${Math.round(e.ms)} ms)`;
      return isFailedRequest(e) ? entry(`**${req}**`, true) : entry(`slow ${req}`);
    }
    case "error":
      return entry(`**ERROR ${clip(e.message, MESSAGE_CHARS)}**${stackLines(e.stack)}`, true);
    case "view":
      return entry(`view: ${abbreviateOutline(e.outline)}`, false, true);
    case "mark":
      return entry(`mark ${e.name}${e.data ? ` ${clip(JSON.stringify(e.data), 160)}` : ""}`);
  }
}

function header(events: ReplayEvent[], title: string | undefined): string {
  const c = replayCounts(events);
  const duration = events.length ? events[events.length - 1].t - events[0].t : 0;
  const parts = [
    title ? `replay ${title}` : "replay",
    plural(events.length, "event"),
    formatReplayTime(duration),
    plural(c.clicks, "click"),
    plural(c.errors, "error"),
    plural(c.failed_requests, "failed request"),
  ];
  return parts.join(" · ");
}

const size = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);

/**
 * Keep the lines around the anchor (the primary failure, else the end) that
 * fit the budget, twice as many before it as after: what led to a failure
 * explains it, what followed rarely does.
 */
function windowAround(entries: Entry[], anchor: number, budget: number): { from: number; to: number } {
  const cost = (i: number) => entries[i].text.length + 1;
  let from = anchor, to = anchor + 1, used = cost(anchor), backTurns = 0;
  while (from > 0 || to < entries.length) {
    const goBack = from > 0 && (backTurns < 2 || to >= entries.length);
    const i = goBack ? from - 1 : to;
    if (used + cost(i) > budget) break;
    used += cost(i);
    if (goBack) { from--; backTurns++; } else { to++; backTurns = 0; }
  }
  return { from, to };
}

/** The text timeline of a stream. Events need not be sorted. */
export function renderTimeline(input: readonly ReplayEvent[], opts: TimelineOptions = {}): string {
  const max = opts.maxChars ?? REPLAY_LIMITS.timeline_md_max_chars;
  const events = sortReplayEvents(input);
  const start = events[0]?.t ?? 0;
  const head = header(events, opts.title);
  let entries = fold(events).map(({ event, times, from }) => line(event, times, from - start));
  if (size([head, ...entries.map((e) => e.text)]) <= max) return [head, ...entries.map((e) => e.text)].join("\n");

  // Over the cap. Outlines go first, except the one just before a failure,
  // which is what the page showed when it broke.
  entries = entries.filter((e, i) => !e.view || entries.slice(i + 1, i + 3).some((n) => n.failure));
  if (size([head, ...entries.map((e) => e.text)]) <= max) return [head, ...entries.map((e) => e.text)].join("\n");

  const failure = primaryFailure(events);
  let anchor = failure ? entries.findIndex((e) => e.failure) : entries.length - 1;
  if (anchor < 0) anchor = entries.length - 1;
  // An entry longer than the whole budget (a huge stack) is cut to fit.
  const reserve = head.length + 2 * 60;
  const budget = Math.max(0, max - reserve);
  entries = entries.map((e) => (e.text.length + 1 > budget ? { ...e, text: e.text.slice(0, Math.max(0, budget - 2)) + "…" } : e));
  const { from, to } = windowAround(entries, anchor, budget);
  const out = [head];
  if (from > 0) out.push(`- … ${plural(from, "earlier line")} not shown`);
  out.push(...entries.slice(from, to).map((e) => e.text));
  if (to < entries.length) out.push(`- … ${plural(entries.length - to, "later line")} not shown`);
  return out.join("\n").slice(0, max);
}

