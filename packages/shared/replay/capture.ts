// A vendor recording read once into what the import stores
// (docs/architecture/external-data.md X5): the semantic stream and the masked
// DOM capture the player plays. A PostHog mobile recording (wireframes, not a
// DOM) is first made into an rrweb capture of a plain page (mobile.ts), and
// its screens' text joins the stream as outlines; a web recording is read as
// it is.
import { REPLAY_LIMITS, type ReplayEvent } from "../contracts/replay";
import { domCapturePlayable, prepareDomCapturePart, type DomScrubState } from "./dom";
import { sortReplayEvents } from "./events";
import { fromMobileWireframes, isMobileCapture } from "./mobile";
import { fromRrwebPart, type RrwebConverterState, type RrwebEvent } from "./rrweb";

export interface VendorCapture {
  format: "web" | "mobile";
  /** The semantic stream, `t` relative to the capture's first event. */
  events: ReplayEvent[];
  /** The masked capture, or null when rrweb could not draw it (no full snapshot of a page). */
  dom: RrwebEvent[] | null;
  /**
   * Where the capture ends on the stream's base (the same `t` the events
   * carry): its last rrweb event. A page left open keeps recording after the
   * last thing a person did, so the recording runs to here, not to the last event.
   */
  end_t: number;
  /** Where this read stopped, for reading the recording's next part on the same clock (a web capture only; null for mobile). */
  carry: CaptureCarry | null;
}

/** The state a long recording's next part is read with (readVendorCapturePart): the converter's and the masking's. */
export interface CaptureCarry {
  converter: RrwebConverterState;
  scrub: DomScrubState;
}

/** The first and last timestamps of a capture, as fromRrweb reads them. */
function captureSpan(events: readonly RrwebEvent[]): { first: number; last: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const e of events) {
    if (!e || typeof e.type !== "number" || typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp)) continue;
    if (e.timestamp < first) first = e.timestamp;
    if (e.timestamp > last) last = e.timestamp;
  }
  return first <= last ? { first, last } : null;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * The recording with every event the vendor sent more than once kept once. A
 * PostHog read hands back some events twice (the same click, console line and
 * request at the same millisecond, 13 of 128 on one Union recording), which
 * doubled rows in the stream and mutations in the player. Two events are the
 * same when their time, type and data are.
 */
export function dedupeRrweb(raw: readonly RrwebEvent[]): RrwebEvent[] {
  const seen = new Set<string>();
  const out: RrwebEvent[] = [];
  for (const e of raw) {
    let key: string;
    try {
      const data = JSON.stringify(e?.data ?? null);
      // A hash, not the text: a page snapshot's JSON runs to megabytes.
      key = `${e?.timestamp}|${e?.type}|${data.length}|${fnv1a(data)}`;
    } catch {
      out.push(e);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Read a vendor's rrweb (or PostHog mobile) recording. The raw events are changed in place by the masking. */
export function readVendorCapture(input: RrwebEvent[]): VendorCapture {
  const raw = dedupeRrweb(input);
  const mobile = isMobileCapture(raw) ? fromMobileWireframes(raw) : null;
  const capture = mobile?.events ?? raw;
  // The stream is read first: the masking below rewrites the events in place.
  const span = captureSpan(capture);
  const converted = fromRrwebPart(capture);
  let events = converted.events;
  if (mobile?.views.length) {
    const t0 = capture.reduce((min, e) => (typeof e?.timestamp === "number" && e.timestamp < min ? e.timestamp : min), Infinity);
    const views: ReplayEvent[] = mobile.views.map((v) => ({ type: "view", t: v.timestamp - t0, outline: v.outline.slice(0, REPLAY_LIMITS.view_outline_max_chars) }));
    // An outline sorts before what happened at the same moment (it was read just before an error or a tap).
    events = sortReplayEvents([...views, ...events]);
  }
  const masked = prepareDomCapturePart(capture);
  const dom = masked.events;
  const carry = !mobile && converted.state ? { converter: converted.state, scrub: masked.state } : null;
  return { format: mobile ? "mobile" : "web", events, dom: domCapturePlayable(dom) ? dom : null, end_t: span ? span.last - span.first : 0, carry };
}

/**
 * A later part of a long web recording, read on the clock and with the page
 * state the part before left (`carry`): its stream events, its masked capture
 * (appended to the stored one as it is, since the player plays the parts in
 * order), where it ends on the clock, and the carry for the part after it.
 */
export function readVendorCapturePart(input: RrwebEvent[], carry: CaptureCarry): { events: ReplayEvent[]; dom: RrwebEvent[]; end_t: number; carry: CaptureCarry } {
  const raw = dedupeRrweb(input);
  const span = captureSpan(raw);
  const converted = fromRrwebPart(raw, carry.converter);
  const masked = prepareDomCapturePart(raw, carry.scrub);
  return {
    events: converted.events,
    dom: masked.events,
    end_t: span ? span.last - carry.converter.t0 : 0,
    carry: { converter: converted.state ?? carry.converter, scrub: masked.state },
  };
}

/**
 * The carry a long recording's next part is read with, rebuilt from the
 * masked capture already stored when the kept one is gone (an R2 object lost,
 * or a copy imported before carries were kept). The converter and the masking
 * only need the page as it stands, so the capture is replayed from its last
 * full snapshot (with the meta event that heads it) to its end, on the
 * recording's clock `t0`. Null when the capture holds no full snapshot.
 */
export function carryFromCapture(dom: readonly RrwebEvent[], t0: number): CaptureCarry | null {
  const events = dom.filter((e) => e && typeof e.type === "number" && typeof e.timestamp === "number" && Number.isFinite(e.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 2) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  // rrweb writes a Meta (4: href, size) just before each full snapshot.
  if (start > 0 && events[start - 1].type === 4) start--;
  const part = events.slice(start);
  const converted = fromRrwebPart(part, { t0, root: null, viewport: 0, last_scroll_at: -1e15 });
  const masked = prepareDomCapturePart(part);
  return converted.state ? { converter: converted.state, scrub: masked.state } : null;
}
