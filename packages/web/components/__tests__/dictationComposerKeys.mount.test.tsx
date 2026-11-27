import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { fakeHost, flush, freshDictationHarness, mountComposer, sayTo, toasts, type FakeHost } from "./fixtures/dictationComposer";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// The keys a recording holds in the composer (every Enter chord but a new
// line, replayed once the last words are in, and never into a picker), and the
// rules that reach past one window: one recording at a time across windows,
// and no recording beside a live, unmuted call.
// Run: bun test components/__tests__/dictationComposerKeys.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

let host: FakeHost;

beforeEach(() => {
  host = freshDictationHarness();
});

afterEach(() => {
  delete w.__dictationTestHost;
});

const say = sayTo(() => host);

test("every Enter chord but a new line waits for the last words, then does what it does with them", async () => {
  let dismissed = 0;
  const chords: [string, Record<string, unknown>][] = [
    ["Cmd+Enter", { metaKey: true }],
    ["Cmd+Shift+Enter (fork and send)", { metaKey: true, shiftKey: true }],
    ["Alt+Shift+Enter (send and dismiss)", { altKey: true, shiftKey: true }],
    ["Ctrl+Shift+Alt+Enter", { ctrlKey: true, shiftKey: true, altKey: true }],
  ];
  for (const [name, init] of chords) {
    host = fakeHost();
    w.__dictationTestHost = host.host;
    const c = await mountComposer({ props: { onForkTail: async () => null, onSendAndDismiss: () => { dismissed++; } } });
    await act(async () => { c.textarea().focus(); });
    await c.press("Dictate");
    await say((e) => e.onPartial("ship it"));
    await c.key("Enter", init);
    expect({ name, finishing: host.finishing, sent: c.sent }).toEqual({ name, finishing: true, sent: [] });
    await say((e) => e.onUtterance({ text: "ship it now." }));
    await act(async () => { host.endFinish!(); });
    await flush();
    await flush();
    expect({ name, sent: c.sent }).toEqual({ name, sent: ["ship it now."] });
    await c.unmount();
  }
  // The two send-and-dismiss chords dismissed once their send went out.
  expect(dismissed).toBe(2);
});

test("Shift+Enter while dictating is a new line, not a send", async () => {
  const c = await mountComposer();
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  await say((e) => e.onPartial("ship it"));
  await c.key("Enter", { shiftKey: true });
  expect(host.finishing).toBe(false);
  expect(c.sent).toEqual([]);
  expect(c.button("Finish dictation")).not.toBeNull();
  await c.key("Escape");
  await c.unmount();
});

test("dictated words open no picker, and an Enter held through the finish sends rather than picks", async () => {
  const skills = [{ name: "ship", description: "Ship the change" }];
  const c = await mountComposer({ props: { skills } });
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  // The sentence in progress rewrites itself, as speech does.
  await say((e) => e.onPartial("run /s"));
  await say((e) => e.onPartial("run /sh"));
  await say((e) => e.onPartial("run /shi"));
  await c.key("Enter");
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
  expect(c.sent).toEqual(["run /shi"]);
  await c.unmount();
});

test("a picker opened by typing during the finish does not take the held Enter", async () => {
  const skills = [{ name: "ship", description: "Ship the change" }];
  const c = await mountComposer({ props: { skills } });
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  await say((e) => e.onPartial("please"));
  await c.key("Enter");
  expect(host.finishing).toBe(true);
  // The person types " /sh" while the last words are on their way.
  const ta = c.textarea();
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(ta, "please /sh");
    ta.setSelectionRange(10, 10);
    const propsKey = Object.keys(ta).find((k) => k.startsWith("__reactProps"))!;
    (ta as any)[propsKey].onChange({ target: ta, currentTarget: ta, nativeEvent: new w.Event("input") });
  });
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
  expect(c.sent).toEqual(["please /sh"]);
  await c.unmount();
});

// ── Across windows, and beside a call ─────────────────────────────────────

/** Another window of the app, as the dictation channel sees it. */
function otherWindow() {
  const heard: unknown[] = [];
  const ch = new BroadcastChannel("codecast.dictation");
  ch.onmessage = (e) => { heard.push(e.data); };
  return { heard, post: (m: unknown) => ch.postMessage(m), close: () => ch.close() };
}
const settleChannel = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

test("a recording starting here finishes the other windows' recordings, and theirs finishes this one", async () => {
  const other = otherWindow();
  const c = await mountComposer();
  await c.press("Dictate");
  await settleChannel();
  expect(other.heard.length).toBe(1);
  await say((e) => e.onPartial("half a thought"));
  // The other window starts dictating (or joins a call): this one keeps its words and stops.
  other.post("finish");
  await settleChannel();
  expect(host.finishing).toBe(true);
  await act(async () => { host.endFinish!(); });
  await flush();
  expect(c.textarea().value).toBe("half a thought");
  expect(c.button("Dictate")).not.toBeNull();
  // A call path here tells the other windows too.
  const { finishDictationEverywhere } = await import("../../lib/dictation/crossWindow");
  await act(async () => { await finishDictationEverywhere(); });
  await settleChannel();
  expect(other.heard.length).toBe(2);
  other.close();
  await c.unmount();
});

test("a live, unmuted call in this window refuses to start dictation and says why; a muted one does not", async () => {
  const before = useInboxStore.getState().call;
  toasts.length = 0;
  try {
    useInboxStore.setState({ call: { ...before, phase: "connected", roomKey: "room_1", muted: false } } as any);
    const c = await mountComposer();
    await c.press("Dictate");
    expect(host.events).toBeNull();
    expect(toasts).toEqual(["error: Leave the huddle first — a call is using the microphone."]);
    expect(c.button("Leave the huddle first — a call is using the microphone.")).not.toBeNull();

    useInboxStore.setState({ call: { ...before, phase: "connected", roomKey: "room_1", muted: true } } as any);
    await c.press("Leave the huddle first — a call is using the microphone.");
    expect(host.events).not.toBeNull();
    expect(c.button("Finish dictation")).not.toBeNull();
    await c.key("Escape");
    await c.unmount();
  } finally {
    useInboxStore.setState({ call: before } as any);
  }
});
