import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { flush, freshDictationHarness, mountComposer, toasts, type FakeHost } from "./fixtures/dictationComposer";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { useInboxStore } from "../../store/inboxStore";
import { DICTATION_CALL_BUSY, DICTATION_RECORDING_BUSY } from "../../lib/dictation/host";
import { _resetCrossWindowForTests, claimMicrophoneAcrossWindows } from "../../lib/dictation/crossWindow";
import { installWindowRoleTracker } from "../../lib/desktop";
import { applyVoiceMirror, getWalkieStatus } from "../../lib/calls/walkie";
import { bindRecorder, getRecorderStatus, startRecording } from "../../lib/calls/recorder";

// Dictation refuses to start while something else holds the microphone, and
// says why on the mic: a live, unmuted call held by the desktop's voice host
// (this window's own call slice is idle there), a huddle or a room recording
// in another window, or a room recording in this one (the phone's rule,
// mobile lib/dictationHost micBusy, in the same words).
// Run: bun test components/__tests__/dictationMicBusy.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

let host: FakeHost;
beforeEach(() => {
  host = freshDictationHarness();
  toasts.length = 0;
});
// Closed after each test, passed or not, so no window answers into the next.
const windows: BroadcastChannel[] = [];
afterEach(() => {
  delete w.__dictationTestHost;
  for (const ch of windows.splice(0)) ch.close();
});

/** Another window of the app on the dictation channel. */
function otherWindow(answer: (m: any, post: (m: unknown) => void) => void = () => {}) {
  const heard: any[] = [];
  const ch = new BroadcastChannel("codecast.dictation");
  windows.push(ch);
  const post = (m: unknown) => ch.postMessage(m);
  ch.onmessage = (e) => {
    heard.push(e.data);
    answer(e.data, post);
  };
  return { heard, post };
}
const settleChannel = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

test("a desktop voice host holding a live, unmuted call refuses dictation here; muted, it starts", async () => {
  let pushRole: ((r: any) => void) | null = null;
  w.__CODECAST_ELECTRON__ = { onWindowRole: (cb: any) => { pushRole = cb; } };
  installWindowRoleTracker();
  const mirror = (muted: boolean) => applyVoiceMirror({ walkie: getWalkieStatus(), call: { roomKey: "room_1", phase: "connected", muted, micDenied: false, camera: false, speaking: [] } });
  try {
    pushRole!({ leader: true, voiceWindow: true });
    mirror(false);
    // This window's own call slice says nothing: the host holds the call.
    expect(useInboxStore.getState().call.phase).toBe("idle");
    const c = await mountComposer();
    await c.press("Dictate");
    expect(host.events).toBeNull();
    expect(toasts).toEqual([`error: ${DICTATION_CALL_BUSY}`]);
    expect(c.button(DICTATION_CALL_BUSY)).not.toBeNull();

    mirror(true);
    await c.press(DICTATION_CALL_BUSY);
    expect(host.events).not.toBeNull();
    expect(c.button("Cancel dictation")).not.toBeNull();
    await c.key("Escape");
    await c.unmount();
  } finally {
    pushRole!({ leader: true, voiceWindow: false });
    delete w.__CODECAST_ELECTRON__;
  }
});

test("a huddle in another window refuses dictation here: what opened is closed, and no window's recording is finished", async () => {
  _resetCrossWindowForTests(200);
  const other = otherWindow((m, post) => { if (m?.ask) post({ answer: m.ask, busy: DICTATION_CALL_BUSY }); });
  const c = await mountComposer();
  await c.press("Dictate");
  await settleChannel();
  await flush();
  expect(host.closed).toBe(1);
  expect(toasts).toEqual([`error: ${DICTATION_CALL_BUSY}`]);
  expect(c.button(DICTATION_CALL_BUSY)).not.toBeNull();
  // A refused start claims nothing: a third window's recording keeps going.
  expect(other.heard.filter((m) => m === "finish")).toEqual([]);
  await c.unmount();
});

test("with no other window answering, the recognizer opens at once and dictation starts once the ask runs out", async () => {
  _resetCrossWindowForTests(120);
  const other = otherWindow();
  const c = await mountComposer();
  await c.press("Dictate");
  // The ask is still out, yet the recognizer is already open (it buffers the
  // microphone from here): no words are lost to the wait.
  expect(other.heard.some((m) => m?.ask)).toBe(true);
  expect(host.events).not.toBeNull();
  expect(host.closed).toBe(0);
  expect(c.button("Cancel dictation")).not.toBeNull();
  // Nothing is claimed from the other windows until the ask settles.
  expect(other.heard.filter((m) => m === "finish")).toEqual([]);
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  expect(other.heard.filter((m) => m === "finish")).toEqual(["finish"]);
  expect(host.closed).toBe(0);
  expect(c.button("Cancel dictation")).not.toBeNull();
  await c.key("Escape");
  await c.unmount();
});

test("this window answers another's ask while its call holds the microphone, and not while muted", async () => {
  _resetCrossWindowForTests(200);
  const before = useInboxStore.getState().call;
  const other = otherWindow();
  try {
    // Joining the call opened this window's side of the channel (callManager).
    claimMicrophoneAcrossWindows();
    useInboxStore.setState({ call: { ...before, phase: "connected", roomKey: "room_1", muted: false } } as any);
    other.post({ ask: "a1" });
    await settleChannel();
    expect(other.heard).toContainEqual({ answer: "a1", busy: DICTATION_CALL_BUSY });
    useInboxStore.setState({ call: { ...before, phase: "connected", roomKey: "room_1", muted: true } } as any);
    other.post({ ask: "a2" });
    await settleChannel();
    expect(other.heard.some((m) => m?.answer === "a2")).toBe(false);
  } finally {
    useInboxStore.setState({ call: before } as any);
    }
});

test("a room recording refuses dictation here and in other windows, in the phone's words", async () => {
  _resetCrossWindowForTests(200);
  let refuseMic: (err: Error) => void = () => {};
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => new Promise((_, reject) => { refuseMic = reject; }) },
  });
  bindRecorder({ mutation: async () => null, action: async () => null, query: async () => null } as any);
  const other = otherWindow();
  try {
    // The recording is opening its microphone.
    void startRecording();
    await flush();
    expect(getRecorderStatus().phase).toBe("starting");
    const c = await mountComposer();
    await c.press("Dictate");
    expect(host.events).toBeNull();
    expect(toasts).toEqual([`error: ${DICTATION_RECORDING_BUSY}`]);
    expect(c.button(DICTATION_RECORDING_BUSY)).not.toBeNull();
    // Another window asking hears the same.
    other.post({ ask: "r1" });
    await settleChannel();
    expect(other.heard).toContainEqual({ answer: "r1", busy: DICTATION_RECORDING_BUSY });
    await c.unmount();
  } finally {
    refuseMic(new Error("denied"));
    await flush();
    }
  expect(getRecorderStatus().phase).toBe("idle");
});
