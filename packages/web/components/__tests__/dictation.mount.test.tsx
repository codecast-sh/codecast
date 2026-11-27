import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { _resetDictationForTests, dictationRunning, type DictationHost, type DictationPipeEvents } from "@codecast/shared/contracts/dictation";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
// Entered from the composer, the graph reaches ChatMessage through
// messageMarkdown -> EntityIdPill -> TaskCommentStream; entering from
// ChatMessage closes that cycle on a lazy read (markdownMapCycles.guard).
import "../chat/ChatMessage";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";
import { holdTextareaTextNodes } from "../../lib/holdTextareaTextNode";

// The app installs this at boot: a textarea's defaultValue write that repeats
// its live value is skipped. Dictated words must still show with it on.
holdTextareaTextNodes(w);

// Dictation in the composers (MessageInput: the session composer and chat;
// the task comment box), driven through window.__dictationTestHost so every
// state runs without a microphone: hidden until the switch is on, the mic
// opening ✕/✓ and "Listening…", words streaming into the box at the cursor,
// ✓ keeping them, Esc putting the box back, Enter waiting for the last words
// and then sending them, a blocked mic saying why, and a regulated team's mic
// disabled.
// Run: bun test components/__tests__/dictation.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).action = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

/** A recognizer the test speaks through. */
function fakeHost() {
  const h = {
    events: null as DictationPipeEvents | null,
    refuse: null as string | null,
    closed: 0,
    finishing: false,
    endFinish: null as null | (() => void),
    host: null as unknown as DictationHost,
  };
  h.host = {
    open: (events) => {
      h.events = events;
      if (h.refuse) return Promise.reject(new Error(h.refuse));
      return Promise.resolve({
        finish: () =>
          new Promise<void>((resolve) => {
            h.finishing = true;
            h.endFinish = resolve;
          }),
        close: () => {
          h.closed++;
        },
      });
    },
  };
  return h;
}

let host: ReturnType<typeof fakeHost>;
let run = 0;

beforeEach(() => {
  _resetDictationForTests();
  host = fakeHost();
  w.__dictationTestHost = host.host;
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({
    sessions: {},
    conversations: {},
    pendingMessages: {},
    drafts: {},
    reviewComments: {},
    teams: [],
    currentSessionId: null,
    currentUser: { _id: "user_dictation_test", name: "Tester", dictation_enabled: true } as any,
  } as any);
});

afterEach(() => {
  delete w.__dictationTestHost;
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mountComposer(opts: { bare?: boolean; foot?: boolean; initialDraft?: string } = {}) {
  const sent: string[] = [];
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root: Root = createRoot(container);
  const draftKey = `chat-draft:dictation-${++run}`;
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <MessageInput
          conversationId={draftKey}
          bareComposer={opts.bare}
          initialDraft={opts.initialDraft}
          composerFoot={opts.foot ? <span data-foot-start /> : undefined}
          onGateSend={(content) => { sent.push(content); }}
        />
      </ConvexProvider>,
    );
  });
  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
  const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement;
  const button = (label: string) => container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  const press = async (label: string) => {
    const b = button(label);
    if (!b) throw new Error(`no ${label} button`);
    await act(async () => { b.click(); });
    await flush();
  };
  const key = async (k: string, init: Record<string, unknown> = {}) => {
    await act(async () => { textarea().dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
    await flush();
  };
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
  return { container, q, textarea, button, press, key, sent, unmount };
}

const say = async (fn: (e: DictationPipeEvents) => void) => {
  await act(async () => { fn(host.events!); });
  await flush();
};

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

test("press the mic, words stream in at the end, ✓ keeps them", async () => {
  const c = await mountComposer({ initialDraft: "fix the" });
  await c.press("Dictate");
  expect(c.button("Cancel dictation")).not.toBeNull();
  expect(c.button("Finish dictation")).not.toBeNull();
  expect(c.button("Dictate")).toBeNull();

  await say((e) => e.onPartial("auth"));
  expect(c.textarea().value).toBe("fix the auth");
  await say((e) => e.onPartial("auth bug"));
  expect(c.textarea().value).toBe("fix the auth bug");
  await say((e) => e.onUtterance({ text: "auth bug." }));
  await say((e) => e.onPartial("Then ship"));
  expect(c.textarea().value).toBe("fix the auth bug. Then ship");

  await c.press("Finish dictation");
  // Waiting for the last words: ✓ says so.
  expect(c.button("Finish dictation")!.getAttribute("aria-busy")).toBe("true");
  await act(async () => { host.endFinish!(); });
  await flush();
  expect(c.textarea().value).toBe("fix the auth bug. Then ship");
  expect(c.button("Dictate")).not.toBeNull();
  // The draft saw the words, as it sees typing.
  await c.unmount();
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

test("a blocked microphone leaves the mic tinted, saying why", async () => {
  host.refuse = "Microphone permission denied";
  const c = await mountComposer();
  await c.press("Dictate");
  const mic = c.button("Dictate")!;
  expect(mic).not.toBeNull();
  expect(mic.getAttribute("data-dictation-reason")).toBe("Microphone permission denied");
  expect(mic.className).toContain("text-sol-red");
  await c.unmount();
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

test("any team of the person's without an OpenAI BAA disables the mic, as the server refuses the mint", async () => {
  // Clinic is one of the person's teams but not the one on screen: the
  // server's rule (dictation.authForDictation) checks every membership.
  useInboxStore.setState({
    teams: [
      { _id: "team_open", name: "Open", policy: {} },
      { _id: "team_clinic", name: "Clinic", policy: { regulated_data: true } },
    ],
    clientState: { ...useInboxStore.getState().clientState, ui: { ...(useInboxStore.getState().clientState.ui ?? {}), active_team_id: "team_open" } },
  } as any);
  const c = await mountComposer();
  const mic = c.button("Dictate")!;
  expect(mic.disabled).toBe(true);
  expect(mic.getAttribute("data-dictation-reason")).toBe("AI features are off for Clinic: no BAA with OpenAI yet.");
  expect(c.button("Dictation settings")).toBeNull();
  await c.unmount();
});

test("typing into the box mid-recording stops it and keeps the person's text", async () => {
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
  expect(mic.getAttribute("data-dictation-reason")).toBe("Dictation stopped: the text changed");
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
  expect(b.button("Dictate")!.getAttribute("data-dictation-reason")).toBe("Dictation stopped: the text changed");
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

  await act(async () => { ta().focus(); });
  await act(async () => { (container.querySelector('button[aria-label="Dictate"]') as HTMLButtonElement).click(); });
  await flush();
  await esc();
  expect(closed).toBe(1); // Esc went to the recording
  expect(container.querySelector('button[aria-label="Dictate"]')).not.toBeNull();
  await esc();
  expect(closed).toBe(2);
  await act(async () => { root.unmount(); });
  container.remove();
  await other.unmount();
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
  expect(src("callManager.ts")).toMatch(/export async function joinCall\([^)]*\)[^{]*\{\s*(\/\/[^\n]*\n\s*)*void finishRunningDictation\(\);/);
  expect(src("callManager.ts")).toMatch(/export async function setMuted\([^)]*\)[^{]*\{\s*if \(!muted\) void finishRunningDictation\(\);/);
  expect(src("walkie.ts")).toMatch(/export function startBurst\([^)]*\)[^{]*\{\s*(\/\/[^\n]*\n\s*)*void finishRunningDictation\(\);/);
  expect(src("recorder.ts")).toMatch(/void finishRunningDictation\(\);\s*setPhase\("starting"\);/);
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
