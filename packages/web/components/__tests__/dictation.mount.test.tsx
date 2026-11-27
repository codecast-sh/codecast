import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { fakeConvex, flush, freshDictationHarness, mountComposer, sayTo, toasts, type FakeHost } from "./fixtures/dictationComposer";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { dictationRunning } from "@codecast/shared/contracts/dictation";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// Dictation in the composers (MessageInput: the session composer and chat;
// the task comment box), driven through window.__dictationTestHost so every
// state runs without a microphone: hidden until the switch is on, the mic
// opening ✕ and "Listening…", words streaming into the box at the cursor,
// Esc putting the box back, Enter waiting for the last words and then sending
// them, a blocked mic saying why, and a regulated team's mic
// dimmed and saying why on a click.
// Run: bun test components/__tests__/dictation.mount.test.tsx

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

test("no mic while dictation is off", async () => {
  useInboxStore.setState({ currentUser: { _id: "u", dictation_enabled: false } as any } as any);
  const c = await mountComposer();
  expect(c.button("Dictate")).toBeNull();
  expect(c.button("Dictation settings")).toBeNull();
  await c.unmount();
});

test("the mic sits just before send, in the row or the foot that holds it", async () => {
  for (const opts of [{}, { bare: true, foot: true }]) {
    const c = await mountComposer(opts);
    const mic = c.button("Dictate")!;
    const send = c.container.querySelector('button[aria-label="Send"]')!;
    expect(mic).not.toBeNull();
    expect(c.button("Dictation settings")).not.toBeNull();
    // Same row as send, and before it.
    expect(mic.closest("div.flex")?.parentElement?.contains(send)).toBe(true);
    expect(mic.compareDocumentPosition(send) & w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await c.unmount();
  }
});

test("press the mic, words stream in at the end, Enter sends them", async () => {
  const c = await mountComposer({ initialDraft: "fix the" });
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  expect(c.button("Cancel dictation")).not.toBeNull();
  // ✕ is the recording's only control: Send, Enter or typing finish it.
  expect(c.button("Finish dictation")).toBeNull();
  expect(c.container.querySelector('[aria-label="Finishing dictation"]')).toBeNull();
  expect(c.button("Dictate")).toBeNull();

  await say((e) => e.onPartial("auth"));
  expect(c.textarea().value).toBe("fix the auth");
  await say((e) => e.onPartial("auth bug"));
  expect(c.textarea().value).toBe("fix the auth bug");
  await say((e) => e.onUtterance({ text: "auth bug." }));
  await say((e) => e.onPartial("Then ship"));
  expect(c.textarea().value).toBe("fix the auth bug. Then ship");

  await c.key("Enter");
  // Waiting for the last words: nothing sent yet.
  expect(c.container.querySelector('[data-dictation="finishing"]')).not.toBeNull();
  // The box is full already, so the spinner beside ✕ is what says words are still coming.
  expect(c.container.querySelector('[aria-label="Finishing dictation"]')).not.toBeNull();
  expect(c.container.querySelector('[data-dictate-slot]')!.parentElement!.hasAttribute("data-dictate-recording")).toBe(true);
  expect(c.sent).toEqual([]);
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
  expect(c.sent).toEqual(["fix the auth bug. Then ship"]);
  expect(c.button("Dictate")).not.toBeNull();
  await c.unmount();
});

test("✕ is secondary but readable (the full dim token, never the row's 40% tint), in the bare box and the dock", async () => {
  // Not an alpha step (text-sol-text-dim/55): .modern-style resolves those to
  // the solid token anyway. The 40% tint the row's other icons use measured
  // 1.7:1, too faint for the recording's only control.
  const rowSecondary = "text-[var(--sol-text-dim)]";
  const tone = async (opts: { bare?: boolean; foot?: boolean }) => {
    const c = await mountComposer(opts);
    await c.press("Dictate");
    const cls = c.button("Cancel dictation")!.className.split(/\s+/);
    const out = cls.includes(rowSecondary) && !cls.some((k) => /^text-sol-text-dim(\/\d+)?$/.test(k));
    await c.press("Cancel dictation");
    await c.unmount();
    return out;
  };
  expect(await tone({ bare: true, foot: true })).toBe(true);
  expect(await tone({})).toBe(true);
});

test("an empty box reads Listening… while recording", async () => {
  const c = await mountComposer();
  const before = c.textarea().placeholder;
  await c.press("Dictate");
  expect(c.textarea().placeholder).toBe("Listening…");
  await c.press("Cancel dictation");
  expect(c.textarea().placeholder).toBe(before);
  await c.unmount();
});

test("words go at the cursor, and Esc puts the box back exactly", async () => {
  const c = await mountComposer({ initialDraft: "use OLD here" });
  const ta = c.textarea();
  await act(async () => { ta.focus(); ta.setSelectionRange(4, 7); });
  await c.press("Dictate");
  await say((e) => e.onPartial("new"));
  expect(ta.value).toBe("use new here");
  expect(ta.selectionStart).toBe(7);

  await c.key("Escape");
  expect(ta.value).toBe("use OLD here");
  // The selection the words replaced is selected again.
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([4, 7]);
  expect(host.closed).toBe(1);
  expect(c.button("Dictate")).not.toBeNull();
  // Esc went to the recording only: the text is still there to send.
  expect(c.sent).toEqual([]);
  await c.unmount();
});

test("Enter while dictating waits for the last words, then sends them", async () => {
  const c = await mountComposer();
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  await say((e) => e.onPartial("ship it"));
  await c.key("Enter");
  // Finishing: nothing sent yet.
  expect(host.finishing).toBe(true);
  expect(c.sent).toEqual([]);
  await say((e) => e.onUtterance({ text: "ship it now." }));
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
  expect(c.sent).toEqual(["ship it now."]);
  expect(c.button("Dictate")).not.toBeNull();
  await c.unmount();
});

test("keys behave as before while dictation is idle", async () => {
  const c = await mountComposer({ initialDraft: "typed words" });
  await act(async () => { c.textarea().focus(); });
  await c.key("Enter");
  await flush();
  expect(c.sent).toEqual(["typed words"]);
  await c.unmount();
});

test("a blocked microphone says why once, and leaves the struck mic named by the reason", async () => {
  host.refuse = "Microphone permission denied";
  toasts.length = 0;
  const c = await mountComposer();
  await c.press("Dictate");
  expect(toasts).toEqual(["error: Microphone permission denied"]);
  // Named by its reason, and marked without colour (the grayscale tablet).
  const mic = c.button("Microphone permission denied")!;
  expect(mic).not.toBeNull();
  expect(mic.getAttribute("data-dictation-reason")).toBe("Microphone permission denied");
  expect(mic.querySelector("svg")!.getAttribute("class")).toContain("lucide-mic-off");
  expect(mic.className).toContain("text-sol-red");
  await c.unmount();
  expect(toasts.length).toBe(1);
});

test("the real microphone path names a refusal and a missing microphone", async () => {
  delete w.__dictationTestHost;
  const { dictationHost } = await import("../../lib/dictation/host");
  const callMedia = await import("../../lib/calls/callMedia");
  const reasons: string[] = [];
  for (const name of ["NotAllowedError", "NotFoundError"]) {
    (w.navigator as any).mediaDevices = { getUserMedia: () => Promise.reject(Object.assign(new Error(name), { name })) };
    const err = await dictationHost(() => ({ action: async () => null })).open({ onPartial() {}, onUtterance() {}, onFailed() {}, onDropped() {} }).catch((e: Error) => e);
    reasons.push((err as Error).message);
  }
  expect(reasons[1]).toBe("No microphone found");
  // A refusal reads as the app's own permission line for the microphone.
  expect(reasons[0]).toBe(await callMedia.mediaFailureReason("microphone", { name: "NotAllowedError" }));
  expect(reasons[0]).not.toBe("No microphone found");
});

test("any team of the person's without an OpenAI BAA dims the mic, and a click on it says why", async () => {
  // Clinic is one of the person's teams but not the one on screen: the
  // server's rule (dictation.authForDictation) checks every membership.
  useInboxStore.setState({
    teams: [
      { _id: "team_open", name: "Open", policy: {} },
      { _id: "team_clinic", name: "Clinic", policy: { regulated_data: true } },
    ],
    clientState: { ...useInboxStore.getState().clientState, ui: { ...(useInboxStore.getState().clientState.ui ?? {}), active_team_id: "team_open" } },
  } as any);
  toasts.length = 0;
  const c = await mountComposer();
  const line = "Dictation isn't available: Clinic has no BAA with OpenAI yet.";
  // Named by the reason, and still a press (a touch screen has no hover for the tooltip).
  const mic = c.button(line)!;
  expect([mic.disabled, mic.getAttribute("aria-disabled")]).toEqual([false, "true"]);
  expect(mic.getAttribute("data-dictation-reason")).toBe(line);
  // The struck mic: dimmed alone it read as the row's other quiet icons. Its caret
  // stays, dimmed, so the row keeps its width.
  expect(mic.querySelector("svg")!.getAttribute("class")).toContain("lucide-mic-off");
  const caret = c.button("Dictation settings")!;
  for (const b of [mic, caret]) expect(b.className).toContain("text-sol-text-dim/40");
  expect(mic.closest("[data-dictation]")!.querySelectorAll("[data-dictate-target]").length).toBe(2);
  await c.press(line);
  expect(toasts).toEqual([`error: ${line}`]);
  // The caret says the same, and neither starts a recording.
  await act(async () => { caret.click(); });
  expect(toasts).toEqual([`error: ${line}`, `error: ${line}`]);
  expect(c.button("Cancel dictation")).toBeNull();
  expect(dictationRunning()).toBe(false);
  await c.unmount();
});

test("while the microphone listens, and only then, a dot left of ✕ says it is on", async () => {
  // The microphone opens when the test says, so "starting" can be seen.
  let open: () => void = () => {};
  const real = w.__dictationTestHost.open;
  w.__dictationTestHost.open = (events: any, signal: any) => new Promise((resolve) => { open = () => resolve(real(events, signal)); });
  const c = await mountComposer();
  const dot = () => c.container.querySelector("[data-dictate-live]");
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  expect(c.container.querySelector("[data-dictation]")!.getAttribute("data-dictation")).toBe("starting");
  expect(dot()).toBeNull();
  await act(async () => { open(); });
  await flush();
  expect(dot()).not.toBeNull();
  expect(dot()!.getAttribute("aria-label")).toBe("Microphone on");
  // Before ✕, inside the recording's controls.
  expect(dot()!.compareDocumentPosition(c.button("Cancel dictation")!) & w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await say((e) => e.onPartial("words already in the box"));
  expect(dot()).not.toBeNull();
  await c.key("Enter");
  // Finishing: the mic is closing.
  expect(dot()).toBeNull();
  await act(async () => { host.endFinish!(); });
  await flush();
  expect(dot()).toBeNull();
  await c.unmount();
});

test("a recording that stopped by itself says why in its toast, and the idle mic is plain Dictate again", async () => {
  toasts.length = 0;
  const c = await mountComposer();
  await c.press("Dictate");
  await say((e) => e.onPartial("kept words"));
  await say((e) => e.onDropped());
  await act(async () => { host.endFinish?.(); });
  await flush();
  expect(toasts.length).toBe(1);
  const mic = c.button("Dictate")!;
  expect(mic).not.toBeNull();
  expect(mic.getAttribute("data-dictation-reason")).toBeNull();
  expect(mic.querySelector("svg")!.getAttribute("class")).toContain("lucide-mic ");
  await c.unmount();
});

test("typing into the box mid-recording stops it and keeps the person's text", async () => {
  toasts.length = 0;
  const c = await mountComposer();
  await c.press("Dictate");
  await say((e) => e.onPartial("hello"));
  const ta = c.textarea();
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  // Typed as React hears a keystroke (the other composer mount tests drive onChange the same way).
  await act(async () => {
    setter.call(ta, "hello there");
    const propsKey = Object.keys(ta).find((k) => k.startsWith("__reactProps"))!;
    (ta as any)[propsKey].onChange({ target: ta, currentTarget: ta, nativeEvent: new w.Event("input") });
  });
  await say((e) => e.onPartial("hello world"));
  expect(ta.value).toBe("hello there");
  const mic = c.button("Dictate")!;
  // The person's own typing stopped it: nothing to say, on the mic or in a toast.
  expect(mic.getAttribute("data-dictation-reason")).toBeNull();
  expect(toasts).toEqual([]);
  await c.unmount();
});

test("the caret menu lists the languages, the current one checked, and remembers a choice", async () => {
  w.localStorage.removeItem("codecast.dictation.language");
  const c = await mountComposer();
  const caret = c.button("Dictation settings")!;
  await act(async () => {
    caret.dispatchEvent(new w.PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
  });
  await flush();
  const menu = w.document.querySelector('[role="menu"]') as HTMLElement | null;
  expect(menu?.textContent).toContain("Dictation settings");
  expect(menu?.textContent).toContain("Language");
  const items = Array.from(w.document.querySelectorAll('[role="menuitemcheckbox"]')) as HTMLElement[];
  expect(items.length).toBe(22);
  expect(items.find((i) => i.getAttribute("aria-checked") === "true")?.textContent).toBe("Auto");
  const japanese = items.find((i) => i.textContent === "Japanese")!;
  await act(async () => { japanese.click(); });
  await flush();
  expect(w.localStorage.getItem("codecast.dictation.language")).toBe("ja");
  await c.unmount();
});

// ── The task comment box ──────────────────────────────────────────────────

test("task comment box: words stream in, Enter posts them once they are in, Esc restores", async () => {
  const posted: string[] = [];
  const realAdd = useInboxStore.getState().addTaskComment;
  useInboxStore.setState({ addTaskComment: ((_id: string, text: string) => { posted.push(text); }) as any } as any);
  const { TaskCommentComposer } = await import("../tasks/TaskCommentStream");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <TaskCommentComposer shortId="ct-1" autoOpen />
      </ConvexProvider>,
    );
  });
  const ta = container.querySelector("textarea") as HTMLTextAreaElement;
  const btn = (l: string) => container.querySelector(`button[aria-label="${l}"]`) as HTMLButtonElement | null;
  const key = async (k: string) => {
    await act(async () => { ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
    await flush();
  };
  expect(btn("Dictate")).not.toBeNull();
  await act(async () => { btn("Dictate")!.click(); });
  await flush();
  expect(ta.placeholder).toBe("Listening…");
  await say((e) => e.onPartial("looks good"));
  expect(ta.value).toBe("looks good");
  await key("Escape");
  expect(ta.value).toBe("");
  expect(container.querySelector("textarea")).not.toBeNull(); // Esc did not close the box

  await act(async () => { btn("Dictate")!.click(); });
  await flush();
  await say((e) => e.onPartial("ship"));
  await key("Enter");
  expect(posted).toEqual([]);
  await say((e) => e.onUtterance({ text: "ship it." }));
  await act(async () => { host.endFinish!(); });
  await flush();
  expect(posted).toEqual(["ship it."]);
  await act(async () => { root.unmount(); });
  container.remove();
  useInboxStore.setState({ addTaskComment: realAdd } as any);
});

test("task comment box: Enter before any words closes the mic, and the box stops saying Listening…", async () => {
  const { TaskCommentComposer } = await import("../tasks/TaskCommentStream");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <TaskCommentComposer shortId="ct-1" autoOpen />
      </ConvexProvider>,
    );
  });
  const ta = container.querySelector("textarea") as HTMLTextAreaElement;
  const btn = (l: string) => container.querySelector(`button[aria-label="${l}"]`) as HTMLButtonElement | null;
  const idle = ta.placeholder;
  await act(async () => { btn("Dictate")!.click(); });
  await flush();
  expect(ta.placeholder).toBe("Listening…");
  await act(async () => { ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await flush();
  // Finishing: the last words are awaited, but nothing is listening.
  expect(container.querySelector('[data-dictation="finishing"]')).not.toBeNull();
  expect(ta.placeholder).toBe(idle);
  await act(async () => { host.endFinish!(); });
  await flush();
  expect(ta.placeholder).toBe(idle);
  await act(async () => { root.unmount(); });
  container.remove();
});

// ── Review regressions ────────────────────────────────────────────────────

test("Send while dictating sends once, after the last words, without spinning", async () => {
  // Driven without act(): React commits the recording's end on its own
  // schedule, as in a browser, so a Send that decided on React's "active"
  // re-entered itself forever and froze the tab.
  const c = await mountComposer();
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  await say((e) => e.onPartial("ship it"));
  const send = c.container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
  expect(send).not.toBeNull();
  send.click();
  await new Promise((r) => setTimeout(r, 50));
  expect(host.finishing).toBe(true);
  expect(c.sent).toEqual([]);
  host.endFinish!();
  // A spinning promise loop starves timers: this resolving is the proof.
  await new Promise((r) => setTimeout(r, 200));
  expect(c.sent).toEqual(["ship it"]);
  expect(dictationRunning()).toBe(false);
  await c.unmount();
});

async function typeInto(ta: HTMLTextAreaElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(ta, v);
    const propsKey = Object.keys(ta).find((k) => k.startsWith("__reactProps"))!;
    (ta as any)[propsKey].onChange({ target: ta, currentTarget: ta, nativeEvent: new w.Event("input") });
  });
  await flush();
}

test("text typed before the first word is kept: Enter sends it, and the first word stops the recording instead of overwriting it", async () => {
  const a = await mountComposer({ initialDraft: "fix" });
  await act(async () => { a.textarea().focus(); });
  await a.press("Dictate");
  await typeInto(a.textarea(), "fix the login bug");
  await a.key("Enter");
  await act(async () => { host.endFinish?.(); });
  await flush();
  await flush();
  expect(a.sent).toEqual(["fix the login bug"]);
  await a.unmount();

  const b = await mountComposer({ initialDraft: "fix" });
  await act(async () => { b.textarea().focus(); });
  await b.press("Dictate");
  await typeInto(b.textarea(), "fix the login bug");
  await say((e) => e.onPartial("today"));
  expect(b.textarea().value).toBe("fix the login bug");
  expect(b.button("Cancel dictation")).toBeNull();
  expect(b.button("Dictate")!.getAttribute("data-dictation-reason")).toBeNull();
  await b.unmount();
});

test("Esc stands aside only in the box that is recording", async () => {
  const { dictatingIn } = await import("../../lib/dictation/useDictation");
  const a = await mountComposer();
  const b = await mountComposer();
  await act(async () => { a.textarea().focus(); });
  await a.press("Dictate");
  expect(dictatingIn(a.textarea())).toBe(true);
  // Esc in another box, or in the page, stays the surface's own.
  expect(dictatingIn(b.textarea())).toBe(false);
  expect(dictatingIn(w.document.body)).toBe(false);
  await a.key("Escape");
  expect(dictatingIn(a.textarea())).toBe(false);
  await a.unmount();
  await b.unmount();
});

test("a comment box closes on Esc while another box records, and cancels its own recording first", async () => {
  const { CommentComposer } = await import("../comments/CommentComposer");
  const other = await mountComposer();
  await act(async () => { other.textarea().focus(); });
  await other.press("Dictate");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  let closed = 0;
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <CommentComposer conversationId="jx70000000000000000000000comment" enabled authed onSubmit={() => {}} onClose={() => { closed++; }} />
      </ConvexProvider>,
    );
  });
  const ta = () => container.querySelector("textarea") as HTMLTextAreaElement;
  const esc = async () => {
    await act(async () => { ta().dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush();
  };
  await esc();
  expect(closed).toBe(1);
  expect(other.button("Cancel dictation")).not.toBeNull(); // the other box still records
  await act(async () => { other.button("Cancel dictation")!.click(); });
  await flush();

  // Idle, the foot offers Cancel; while this box records it says what Esc does.
  const foot = () => container.querySelector(".cc-cmt-composer-foot")!;
  expect(foot().querySelector("button")?.textContent).toBe("Cancel Esc");
  await act(async () => { ta().focus(); });
  await act(async () => { (container.querySelector('button[aria-label="Dictate"]') as HTMLButtonElement).click(); });
  await flush();
  expect(foot().querySelector("button")).toBeNull();
  expect(foot().textContent).toBe("Esc cancels dictation");
  expect(foot().querySelector("kbd")?.textContent).toBe("Esc");
  await esc();
  expect(foot().querySelector("button")?.textContent).toBe("Cancel Esc");
  expect(closed).toBe(1); // Esc went to the recording
  expect(container.querySelector('button[aria-label="Dictate"]')).not.toBeNull();
  await esc();
  expect(closed).toBe(2);
  await act(async () => { root.unmount(); });
  container.remove();
  await other.unmount();
});

test("a comment box: one Esc on the open language menu closes the menu, not the box", async () => {
  const { CommentComposer } = await import("../comments/CommentComposer");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  let closed = 0;
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <CommentComposer conversationId="jx70000000000000000000000comment" enabled authed onSubmit={() => {}} onClose={() => { closed++; }} />
      </ConvexProvider>,
    );
  });
  const caret = container.querySelector('button[aria-label="Dictation settings"]') as HTMLButtonElement;
  await act(async () => {
    caret.dispatchEvent(new w.PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
  });
  await flush();
  const menu = () => w.document.querySelector('[role="menu"]') as HTMLElement | null;
  expect(menu()).not.toBeNull();
  // Portalled to the body, but inside the box's React tree: its keydown reaches the box's capture handler.
  const item = menu()!.querySelector('[role="menuitemcheckbox"]') as HTMLElement;
  await act(async () => {
    item.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await flush();
  expect(menu()).toBeNull();
  expect(closed).toBe(0);
  // With no menu open, Esc in the box closes it as before.
  await act(async () => {
    container.querySelector("textarea")!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await flush();
  expect(closed).toBe(1);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("switching to the rich editor mid-recording carries the last words into it", async () => {
  // What the rich editor asks of a browser that jsdom lacks.
  const raf = (w as any).requestAnimationFrame;
  (w as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  const rects = { el: (w.Element.prototype as any).getClientRects, range: (w.Range.prototype as any).getClientRects, rangeBox: (w.Range.prototype as any).getBoundingClientRect };
  const none = () => Object.assign([], { item: () => null });
  (w.Element.prototype as any).getClientRects ??= none;
  (w.Range.prototype as any).getClientRects ??= none;
  (w.Range.prototype as any).getBoundingClientRect ??= () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  try {
  const c = await mountComposer();
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  await say((e) => e.onPartial("ship"));
  await c.key("e", { metaKey: true, shiftKey: true });
  // Still waiting for the last words: the box has not switched yet.
  expect(host.finishing).toBe(true);
  expect(c.textarea()).not.toBeNull();
  await say((e) => e.onUtterance({ text: "ship it now." }));
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
  expect(c.container.querySelector("textarea")).toBeNull();
  // The rich editor loads lazily.
  for (let i = 0; i < 100 && !c.q(".ProseMirror"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(c.q(".ProseMirror")?.textContent).toBe("ship it now.");
  await c.unmount();
  } finally {
    (w as any).requestAnimationFrame = raf;
    (w.Element.prototype as any).getClientRects = rects.el;
    (w.Range.prototype as any).getClientRects = rects.range;
    (w.Range.prototype as any).getBoundingClientRect = rects.rangeBox;
  }
});

test("a huddle, an unmute, a voice message and a room recording each finish a running dictation, keeping its words", async () => {
  const { finishRunningDictation } = await import("@codecast/shared/contracts/dictation");
  const fs = await import("node:fs");
  // Each path that takes the microphone hands it over first.
  const src = (f: string) => fs.readFileSync(new URL(`../../lib/calls/${f}`, import.meta.url), "utf8");
  // In this window and, over the dictation channel, in every other one.
  expect(src("callManager.ts")).toMatch(/export async function joinCall\([^)]*\)[^{]*\{\s*(\/\/[^\n]*\n\s*)*void finishDictationEverywhere\(\);/);
  expect(src("callManager.ts")).toMatch(/export async function setMuted\([^)]*\)[^{]*\{\s*if \(!muted\) void finishDictationEverywhere\(\);/);
  expect(src("walkie.ts")).toMatch(/export function startBurst\([^)]*\)[^{]*\{\s*(\/\/[^\n]*\n\s*)*void finishDictationEverywhere\(\);/);
  expect(src("recorder.ts")).toMatch(/void finishDictationEverywhere\(\);\s*setPhase\("starting"\);/);
  // And what that call does to a box: the words stay, the recording ends.
  const c = await mountComposer();
  await c.press("Dictate");
  await say((e) => e.onPartial("half a thought"));
  let done = false;
  await act(async () => { void finishRunningDictation().then(() => { done = true; }); });
  expect(host.finishing).toBe(true);
  await act(async () => { host.endFinish!(); });
  await flush();
  expect(done).toBe(true);
  expect(c.textarea().value).toBe("half a thought");
  expect(c.button("Dictate")).not.toBeNull();
  await c.unmount();
});

// ── Presses made while the last words are on their way ────────────────────
// The real pipe's finish() resolves when it closes, so a Cancel while
// finishing releases the wait: what was pressed must then not run.

test("composer: Enter then Esc while finishing sends nothing", async () => {
  const c = await mountComposer({ initialDraft: "draft before" });
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  await say((e) => e.onPartial("oops wrong words"));
  await c.key("Enter");
  expect(host.finishing).toBe(true);
  await c.key("Escape");
  await flush();
  await flush();
  expect(c.textarea().value).toBe("draft before");
  expect(c.sent).toEqual([]);
  await c.unmount();
});

test("composer: Send then ✕ while finishing sends nothing; Send twice sends once", async () => {
  const c = await mountComposer({ initialDraft: "draft" });
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  await say((e) => e.onPartial("wrong"));
  const send = () => c.container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
  await act(async () => { send().click(); });
  await flush();
  expect(host.finishing).toBe(true);
  await c.press("Cancel dictation");
  await flush();
  await flush();
  expect(c.textarea().value).toBe("draft");
  expect(c.sent).toEqual([]);

  host.finishing = false;
  await c.press("Dictate");
  await say((e) => e.onPartial("right words"));
  await act(async () => { send().click(); });
  await act(async () => { send().click(); });
  await flush();
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
  expect(c.sent).toEqual(["draft right words"]);
  await c.unmount();
});

test("the rich-editor switch pressed while finishing waits, and a Cancel keeps the textarea", async () => {
  const c = await mountComposer();
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  await say((e) => e.onPartial("ship"));
  await c.key("e", { metaKey: true, shiftKey: true });
  expect(host.finishing).toBe(true);
  await c.key("Escape");
  await flush();
  await flush();
  expect(c.container.querySelector("textarea")).not.toBeNull();
  expect(c.textarea().value).toBe("");
  await c.unmount();
});

async function mountTaskComments() {
  const posted: string[] = [];
  const realAdd = useInboxStore.getState().addTaskComment;
  useInboxStore.setState({ addTaskComment: ((_id: string, text: string) => { posted.push(text); }) as any } as any);
  const { TaskCommentComposer } = await import("../tasks/TaskCommentStream");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <TaskCommentComposer shortId="ct-1" autoOpen />
      </ConvexProvider>,
    );
  });
  const ta = () => container.querySelector("textarea") as HTMLTextAreaElement;
  const btn = (l: string) => container.querySelector(`button[aria-label="${l}"]`) as HTMLButtonElement | null;
  const key = async (k: string) => {
    await act(async () => { ta().dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
    await flush();
  };
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    useInboxStore.setState({ addTaskComment: realAdd } as any);
  };
  return { container, ta, btn, key, posted, unmount };
}

test("task comment: Enter twice while finishing posts once; Enter then Esc posts nothing", async () => {
  const m = await mountTaskComments();
  await act(async () => { m.btn("Dictate")!.click(); });
  await flush();
  await say((e) => e.onPartial("looks good"));
  await m.key("Enter");
  await m.key("Enter");
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
  expect(m.posted).toEqual(["looks good"]);

  await act(async () => { m.btn("Dictate")!.click(); });
  await flush();
  await say((e) => e.onPartial("never mind"));
  await m.key("Enter");
  await m.key("Escape");
  await flush();
  await flush();
  expect(m.posted).toEqual(["looks good"]);
  expect(m.ta().value).toBe("");
  await m.unmount();
});

test("task comment: the post button pressed twice while finishing posts once", async () => {
  const m = await mountTaskComments();
  await act(async () => { m.btn("Dictate")!.click(); });
  await flush();
  await say((e) => e.onPartial("ship it"));
  // The round arrow beside the mic.
  const target = m.container.querySelector("div.shrink-0 > button:last-child") as HTMLButtonElement;
  expect(target?.querySelector("svg")).toBeTruthy();
  expect(target.getAttribute("aria-label")).toBeNull();
  await act(async () => { target.click(); });
  await act(async () => { target.click(); });
  await flush();
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
  expect(m.posted).toEqual(["ship it"]);
  await m.unmount();
});

test("Esc belongs to a box still finishing after the newer recording was cancelled", async () => {
  const { dictatingIn } = await import("../../lib/dictation/useDictation");
  const a = await mountComposer();
  const b = await mountComposer();
  await act(async () => { a.textarea().focus(); });
  await a.press("Dictate");
  await say((e) => e.onPartial("keep me"));
  // B's press finishes A first; cancelling B leaves A still finishing.
  await act(async () => { b.textarea().focus(); });
  await b.press("Dictate");
  await b.press("Cancel dictation");
  expect(host.finishing).toBe(true);
  expect(a.button("Cancel dictation")).not.toBeNull();
  expect(dictatingIn(a.textarea())).toBe(true);
  expect(dictatingIn(b.textarea())).toBe(false);
  await act(async () => { host.endFinish!(); });
  await flush();
  expect(dictatingIn(a.textarea())).toBe(false);
  expect(a.textarea().value).toBe("keep me");
  await a.unmount();
  await b.unmount();
});

test("the real microphone path lets go of a microphone granted after Cancel, before minting a key", async () => {
  delete w.__dictationTestHost;
  const { dictationHost, DICTATION_ABANDONED } = await import("../../lib/dictation/host");
  let grant: (s: MediaStream) => void = () => {};
  let stopped = 0;
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const track = { stop: () => { stopped++; } };
  (w.navigator as any).mediaDevices = { getUserMedia: () => new Promise<MediaStream>((r) => { grant = r; }) };
  const minted: unknown[] = [];
  const signal = { aborted: false };
  const opening = dictationHost(() => ({ action: async (...a: unknown[]) => { minted.push(a); return null; } }))
    .open({ onPartial() {}, onUtterance() {}, onFailed() {}, onDropped() {} }, signal)
    .catch((e: Error) => e);
  await new Promise((r) => setTimeout(r, 0));
  signal.aborted = true;
  grant(stream);
  const err = await opening;
  expect((err as Error).message).toBe(DICTATION_ABANDONED);
  expect(stopped).toBe(1);
  await new Promise((r) => setTimeout(r, 20));
  expect(minted).toEqual([]);
});
