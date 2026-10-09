// A vendor recording read once into what the import stores
// (docs/architecture/external-data.md X5): the semantic stream and the masked
// DOM capture the player plays. A PostHog mobile recording (wireframes, not a
// DOM) is first made into an rrweb capture of a plain page (mobile.ts), and
// its screens' text joins the stream as outlines; a web recording is read as
// it is.
import { REPLAY_LIMITS, type ReplayEvent } from "../contracts/replay";
import { domCapturePlayable, prepareDomCapture } from "./dom";
import { sortReplayEvents } from "./events";
import { fromMobileWireframes, isMobileCapture } from "./mobile";
import { fromRrweb, type RrwebEvent } from "./rrweb";

export interface VendorCapture {
  format: "web" | "mobile";
  /** The semantic stream, `t` relative to the capture's first event. */
  events: ReplayEvent[];
  /** The masked capture, or null when rrweb could not draw it (no full snapshot of a page). */
  dom: RrwebEvent[] | null;
}

/** Read a vendor's rrweb (or PostHog mobile) recording. The raw events are changed in place by the masking. */
export function readVendorCapture(raw: RrwebEvent[]): VendorCapture {
  const mobile = isMobileCapture(raw) ? fromMobileWireframes(raw) : null;
  const capture = mobile?.events ?? raw;
  // The stream is read first: the masking below rewrites the events in place.
  let events = fromRrweb(capture);
  if (mobile?.views.length) {
    const t0 = capture.reduce((min, e) => (typeof e?.timestamp === "number" && e.timestamp < min ? e.timestamp : min), Infinity);
    const views: ReplayEvent[] = mobile.views.map((v) => ({ type: "view", t: v.timestamp - t0, outline: v.outline.slice(0, REPLAY_LIMITS.view_outline_max_chars) }));
    // An outline sorts before what happened at the same moment (it was read just before an error or a tap).
    events = sortReplayEvents([...views, ...events]);
  }
  const dom = prepareDomCapture(capture);
  return { format: mobile ? "mobile" : "web", events, dom: domCapturePlayable(dom) ? dom : null };
}
