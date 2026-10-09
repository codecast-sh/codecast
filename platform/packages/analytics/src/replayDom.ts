// The DOM half of the replay recorder (./replay, replayDom option): rrweb's
// record, configured to cost as little as rrweb can, so a replay plays back
// visually in codecast's player. Loaded on demand only when the app turns DOM
// mode on; with it off, nothing here (and no rrweb) reaches the page.
//
// What it leaves out, and why:
// - Mouse movement: the bulk of an rrweb stream, and per-frame work.
// - Mouse interactions other than clicks: focus, blur, up and down add
//   events without adding anything a viewer reads.
// - Scroll every 500 ms at most, media every 800 ms, an input's last value
//   per burst (and every value is masked anyway).
// - Canvas, fonts, inline images and cross-origin iframes: heavy, and none of
//   them are what a person reproducing a bug looks at.
//
// What it hides: every input value is masked; the text of any rich text
// editor is masked, since it is whatever the person typed (the semantic
// recorder treats it the same way); anything inside [data-private] is
// blocked whole (the player shows an empty box its size).
//
// Checkouts (a fresh full snapshot) are what bound the ring buffer: the
// recorder keeps the current segment and the one before, so a recording that
// is never kept holds at most two segments, and the oldest segment it does
// ship opens on a full snapshot the player can start from. The timed ones are
// the recorder's (./replay DOM_CHECKOUT_MS: every half ring until the DOM
// ships, rarely after, which rrweb's fixed checkoutEveryNms cannot do); rrweb
// adds one after DOM_CHECKOUT_EVERY_NTH events.

import { record } from "@rrweb/record";
import type { DomEvent, DomRecording, StartDomRecording } from "./replay";

/** A mutation storm checks out early instead of growing one segment without bound. */
export const DOM_CHECKOUT_EVERY_NTH = 5_000;

const EDITABLE = '[contenteditable]:not([contenteditable="false"])';

export const DOM_RECORD_OPTIONS = {
  checkoutEveryNth: DOM_CHECKOUT_EVERY_NTH,
  maskAllInputs: true,
  maskTextSelector: EDITABLE,
  blockSelector: "[data-private]",
  slimDOMOptions: "all",
  sampling: {
    mousemove: false,
    mouseInteraction: { Click: true, DblClick: true, TouchEnd: true, MouseUp: false, MouseDown: false, ContextMenu: false, Focus: false, Blur: false, TouchStart: false },
    scroll: 500,
    media: 800,
    input: "last",
  },
  recordCanvas: false,
  collectFonts: false,
  inlineImages: false,
  recordCrossOriginIframes: false,
} as const;

/** Start rrweb's record with DOM_RECORD_OPTIONS. Null when rrweb could not start (no document). */
export const startDomRecording: StartDomRecording = (emit) => {
  let stop: (() => void) | undefined;
  try {
    stop = record({
      ...DOM_RECORD_OPTIONS,
      sampling: { ...DOM_RECORD_OPTIONS.sampling, mouseInteraction: { ...DOM_RECORD_OPTIONS.sampling.mouseInteraction } },
      emit: (event, isCheckout) => emit(event as DomEvent, isCheckout === true),
      // rrweb's own failures stay rrweb's: the recorder never breaks the page it watches.
      errorHandler: () => true,
    });
  } catch {
    return null;
  }
  if (!stop) return null;
  const recording: DomRecording = {
    checkout: () => {
      try {
        record.takeFullSnapshot(true);
      } catch {
        // a checkout that fails leaves the segment open; the next timed one tries again
      }
    },
    stop: () => stop?.(),
  };
  return recording;
};
