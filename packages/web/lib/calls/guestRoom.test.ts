import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { Track } from "livekit-client";
import { GuestCall, GuestPreview } from "./guestRoom";

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

// ── Devices never outlive their owner ────────────────────────────────────────
//
// A camera light that stays on after the guest left is the worst thing this
// page can do. Every track the browser hands over has to end up stopped, on
// every path, whatever order the answers arrive in.

type FakeTrack = { kind: Track.Kind; stopped: number; stop: () => void };
const fakeTrack = (kind: Track.Kind): FakeTrack => {
  const t: FakeTrack = { kind, stopped: 0, stop: () => void t.stopped++ };
  return t;
};
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const denied = () => Object.assign(new Error("denied"), { name: "NotAllowedError" });
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a switch pressed while the permission prompt is up never leaves a second camera open", async () => {
  const made: FakeTrack[] = [];
  const make = (kind: Track.Kind) => {
    const t = fakeTrack(kind);
    made.push(t);
    return t as any;
  };
  const prompt = deferred<any[]>();
  const preview = new GuestPreview({}, {
    both: () => prompt.promise,
    camera: async () => make(Track.Kind.Video),
    mic: async () => make(Track.Kind.Audio),
  } as any);
  const started = preview.start({ mic: true, camera: true });
  // The prompt is up; the guest presses both switches.
  const cam = preview.setCamera(true);
  const mic = preview.setMic(true);
  await tick();
  // Nothing was asked for behind the prompt's back.
  expect(made).toHaveLength(0);
  prompt.resolve([make(Track.Kind.Audio), make(Track.Kind.Video)]);
  await Promise.all([started, cam, mic]);
  // One of each, the snapshot's, and nothing else alive.
  expect(made).toHaveLength(2);
  preview.dispose();
  expect(made.every((t) => t.stopped > 0)).toBe(true);
});

test("a prompt answered no is not asked again, one device at a time", async () => {
  let singles = 0;
  const preview = new GuestPreview({}, {
    both: async () => {
      throw denied();
    },
    camera: async () => (singles++, fakeTrack(Track.Kind.Video) as any),
    mic: async () => (singles++, fakeTrack(Track.Kind.Audio) as any),
  } as any);
  await preview.start({ mic: true, camera: true });
  const snap = preview.getSnapshot();
  expect(singles).toBe(0);
  expect(snap).toMatchObject({ micDenied: true, cameraDenied: true, asking: false, video: null, audio: null });
  expect(snap.micError).toBeTruthy();
  expect(snap.cameraError).toBeTruthy();
  preview.dispose();
});

test("a missing camera still gets the microphone, and is not called a refusal", async () => {
  const preview = new GuestPreview({}, {
    both: async () => {
      throw Object.assign(new Error("none"), { name: "NotFoundError" });
    },
    camera: async () => {
      throw Object.assign(new Error("none"), { name: "NotFoundError" });
    },
    mic: async () => fakeTrack(Track.Kind.Audio) as any,
  } as any);
  await preview.start({ mic: true, camera: true });
  const snap = preview.getSnapshot();
  expect(snap.audio).toBeTruthy();
  expect(snap).toMatchObject({ cameraError: "No camera found", cameraDenied: false, micError: null });
  preview.dispose();
});

test("a call left before its token arrives stops the lobby's tracks and never connects", async () => {
  const video = fakeTrack(Track.Kind.Video);
  const audio = fakeTrack(Track.Kind.Audio);
  const call = new GuestCall({}, { mic: true, camera: true }, { video, audio } as any);
  let connects = 0;
  (call.room as any).connect = async () => void connects++;
  await call.leave();
  await call.connect({ url: "wss://x", token: "t" });
  expect(connects).toBe(0);
  expect(video.stopped).toBeGreaterThan(0);
  expect(audio.stopped).toBeGreaterThan(0);
});

test("a call left while it is connecting hangs up the connection it just made", async () => {
  const video = fakeTrack(Track.Kind.Video);
  const call = new GuestCall({}, { mic: false, camera: true }, { video, audio: null } as any);
  const gate = deferred<void>();
  let disconnects = 0;
  let published = 0;
  (call.room as any).connect = () => gate.promise;
  (call.room as any).disconnect = async () => void disconnects++;
  (call.room.localParticipant as any).publishTrack = async () => void published++;
  const connecting = call.connect({ url: "wss://x", token: "t" });
  await call.leave();
  expect(disconnects).toBe(1);
  gate.resolve();
  await connecting;
  // The first hang-up ran against a room that was not connected yet.
  expect(disconnects).toBe(2);
  expect(published).toBe(0);
  expect(video.stopped).toBeGreaterThan(0);
});
