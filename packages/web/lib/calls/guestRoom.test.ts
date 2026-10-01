import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { GuestCall } from "./guestRoom";

// A call parks its audio elements in the page, so it needs a document.
let dom: any;
beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true, writable: true });
});
afterAll(() => closeDomWindow(dom));

// The guest's device intent: what they set their microphone and camera to is
// what the page keeps and what a reconnect opens with, never "back on". The
// publish itself can fail here (no devices under test); the intent cannot.

test("muting in the call is remembered as the guest's choice, before the media answers", async () => {
  const call = new GuestCall({}, { mic: true, camera: true });
  const seen: Array<{ mic: boolean; camera: boolean }> = [];
  call.subscribe(() => seen.push(call.getSnapshot().wants));
  await call.setMic(false);
  await call.setCamera(false);
  expect(call.getSnapshot().wants).toEqual({ mic: false, camera: false });
  // The first thing a subscriber (the page's remembered prefs) hears is the choice.
  expect(seen[0]).toEqual({ mic: false, camera: true });
  await call.leave();
});

test("a call starts from the intent it was handed, not from what is published", () => {
  const call = new GuestCall({}, { mic: false, camera: true });
  expect(call.getSnapshot()).toMatchObject({ mic: false, camera: false, wants: { mic: false, camera: true }, ended: null });
  void call.leave();
});
