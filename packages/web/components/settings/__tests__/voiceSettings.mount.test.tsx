// Settings › Voice: turning recognition on goes through the consequential
// review; turning it off with samples arms first, and a press anywhere else
// disarms (Safari never focuses a pressed button, so blur alone would not);
// with no samples off is one press. Mounted in jsdom.
// Run: bun test --timeout 120000 components/settings/__tests__/voiceSettings.mount.test.tsx
import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import { replaceGlobals } from "../../../test-helpers/globals";
import { assertGlance } from "../../consequential/__tests__/glance";
import { voiceIdLedger } from "../voiceIdLedger";

test("the review reads at a glance, and as plain lines on the phone", async () => {
  assertGlance(voiceIdLedger());
  const { ledgerLines } = await import("../../consequential/roleOnline");
  const lines = ledgerLines(voiceIdLedger());
  assert.deepEqual(lines, [
    "Keeps: up to 50 voice samples",
    "From: recordings you're named in",
    "Sees them: only you",
    "Others see: your name, suggested",
    "To stop: turn off, which deletes every sample",
  ]);
  for (const l of lines) assert.equal(l.split(":").length, 2, `one colon per line: ${l}`);
});

async function mount(enabled: boolean, count: number) {
  const { JSDOM } = await import("jsdom");
  const d = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/", pretendToBeVisual: true });
  const w = d.window as any;
  const restore = replaceGlobals({
    window: w, document: w.document, navigator: w.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: w.HTMLElement, HTMLButtonElement: w.HTMLButtonElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
    DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event, CustomEvent: w.CustomEvent, NodeFilter: w.NodeFilter,
    localStorage: w.localStorage, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useInboxStore } = await import("../../../store/inboxStore");
  const real = { ...(await import("../../../hooks/useSyncCalls")) };
  mock.module("../../../hooks/useSyncCalls", () => ({ ...real, useMyVoiceprint: () => useInboxStore((s: any) => s.myVoiceprint ?? undefined) }));
  const { VoiceSettings } = await import("../VoiceSettings");
  const calls: Array<[string, ...unknown[]]> = [];
  useInboxStore.setState({
    currentUser: { ...(useInboxStore.getState().currentUser ?? {}), _id: "u-me", voice_id_enabled: enabled },
    myVoiceprint: { count, seconds: count * 5, last_added_at: count ? Date.now() - 86_400_000 : null },
    setVoiceIdEnabled: (on: boolean) => (calls.push(["set", on]), Promise.resolve()),
    deleteMyVoiceprints: () => (calls.push(["delete"]), Promise.resolve()),
  } as any);
  const root = createRoot(w.document.getElementById("root"));
  await React.act(async () => root.render(<VoiceSettings />));
  const q = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
  const del = () => [...w.document.querySelectorAll("button")].find((b: any) => /Delete|Turn off/.test(b.textContent)) as HTMLElement;
  const toggle = () => q('button[aria-label="Recognize my voice in recordings"]')!;
  const press = (el: HTMLElement) => React.act(async () => el.click());
  const pointerdown = (el: Element) => React.act(async () => void el.dispatchEvent(new w.Event("pointerdown", { bubbles: true })));
  const done = async () => { await React.act(async () => root.unmount()); await React.act(async () => { await new Promise((r) => setTimeout(r, 10)); }); restore(); };
  return { q, del, toggle, press, pointerdown, calls, done, w };
}

test("on goes through the review; only its confirm turns recognition on", async () => {
  const m = await mount(false, 0);
  try {
    await m.press(m.toggle());
    assert.deepEqual(m.calls, [], "the switch alone writes nothing");
    assert.ok(m.q("[data-switch-review]"), "the review opens");
    assert.match(m.q('[data-switch-row="Keeps"]')!.textContent!, /up to 50 voice samples/);
    assert.match(m.q('[data-switch-row="Sees them"]')!.textContent!, /only you/);
    await m.press(m.q("[data-switch-confirm]")!);
    assert.deepEqual(m.calls, [["set", true]]);
  } finally {
    await m.done();
  }
});

test("off with samples arms first; a press elsewhere disarms; the armed button turns it off", async () => {
  const m = await mount(true, 12);
  try {
    await m.press(m.toggle());
    assert.deepEqual(m.calls, []);
    assert.equal(m.del().textContent?.trim(), "Turn off · delete 12");
    assert.equal(m.w.document.activeElement, m.del());
    await m.pointerdown(m.w.document.body);
    assert.equal(m.del().textContent?.trim(), "Delete samples");
    await m.press(m.toggle());
    await m.press(m.del());
    assert.deepEqual(m.calls, [["set", false]]);
  } finally {
    await m.done();
  }
});

test("Delete arms, then deletes; off with no samples is one press", async () => {
  const m = await mount(true, 3);
  try {
    await m.press(m.del());
    assert.equal(m.del().textContent?.trim(), "Delete 3");
    await m.press(m.del());
    assert.deepEqual(m.calls, [["delete"]]);
  } finally {
    await m.done();
  }
  const n = await mount(true, 0);
  try {
    await n.press(n.toggle());
    assert.deepEqual(n.calls, [["set", false]]);
  } finally {
    await n.done();
  }
});

test("Dictation is a plain switch above recognition: one press turns it on, one turns it off", async () => {
  const m = await mount(false, 0);
  try {
    const { useInboxStore } = await import("../../../store/inboxStore");
    const writes: boolean[] = [];
    useInboxStore.setState({
      setDictationEnabled: (on: boolean) => {
        writes.push(on);
        useInboxStore.setState({ currentUser: { ...useInboxStore.getState().currentUser, dictation_enabled: on } } as any);
        return Promise.resolve();
      },
    } as any);
    const sw = () => m.q('button[aria-label="Dictation"]')!;
    assert.ok(sw(), "the row is there");
    const order = [...m.w.document.querySelectorAll('button[role="switch"]')].map((b: any) => b.getAttribute("aria-label"));
    assert.deepEqual(order.slice(0, 2), ["Dictation", "Recognize my voice in recordings"]);
    assert.equal(sw().getAttribute("aria-checked"), "false");
    await m.press(sw());
    assert.deepEqual(writes, [true]);
    assert.equal(m.q("[data-switch-review]"), null, "no review: on only shows a mic");
    assert.equal(sw().getAttribute("aria-checked"), "true");
    await m.press(sw());
    assert.deepEqual(writes, [true, false]);
  } finally {
    await m.done();
  }
});
