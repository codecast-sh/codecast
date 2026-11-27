import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

// The create-task dialog with dictation in its description: every submit (the
// Create button, Cmd/Ctrl+Enter from the title) waits for a recording's last
// words, and the description is read off the editor, whose own save lags by
// 500ms; Esc from the title cancels the recording instead of closing.
// Run: bun test components/__tests__/dictationCreateTask.mount.test.tsx

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
const created: any[] = [];
const realTaskActions = { ...(await import("../../lib/taskActions")) };
mock.module("../../lib/taskActions", () => ({ ...realTaskActions, createTaskAndAdopt: async (opts: any) => { created.push(opts); return null; } }));
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { _resetDictationForTests, type DictationHost, type DictationPipeEvents } from "@codecast/shared/contracts/dictation";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// What the rich editor asks of a browser that jsdom lacks.
const none = () => Object.assign([], { item: () => null });
(w.Element.prototype as any).getClientRects ??= none;
(w.Range.prototype as any).getClientRects ??= none;
(w.Range.prototype as any).getBoundingClientRect ??= () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
(w as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
(w.document as any).elementFromPoint ??= () => null;

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

let events: DictationPipeEvents | null = null;
let endFinish: (() => void) | null = null;
let finishing = false;
const host: DictationHost = {
  open: (e) => {
    events = e;
    return Promise.resolve({
      finish: () => new Promise<void>((r) => { finishing = true; endFinish = r; }),
      // As asrPipe does: closing releases a finish still waiting.
      close() { endFinish?.(); },
    });
  },
};

beforeEach(() => {
  _resetDictationForTests();
  created.length = 0;
  events = null;
  endFinish = null;
  finishing = false;
  w.__dictationTestHost = host;
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ teams: [], currentUser: { _id: "user_create_task", name: "Tester", dictation_enabled: true } as any } as any);
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mountModal() {
  const { CreateTaskModal } = await import("../CreateTaskModal");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  let closed = 0;
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <CreateTaskModal onClose={() => { closed++; }} />
      </ConvexProvider>,
    );
  });
  for (let i = 0; i < 100 && !container.querySelector(".ProseMirror"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const title = () => container.querySelector('input[placeholder="Task title"]') as HTMLInputElement;
  const editor = () => (container.querySelector(".ProseMirror") as any).editor;
  const button = (label: string) => container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  const create = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Create task")) as HTMLButtonElement;
  const setTitle = async (v: string) => {
    const el = title();
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(el, v);
    const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"))!;
    await act(async () => { (el as any)[propsKey].onChange({ target: el, currentTarget: el, nativeEvent: new w.Event("input") }); });
  };
  const keyOnTitle = async (key: string, init: Record<string, unknown> = {}) => {
    await act(async () => { title().dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
    await flush();
  };
  const say = async (fn: (e: DictationPipeEvents) => void) => {
    await act(async () => { fn(events!); });
    await flush();
  };
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
  return { container, title, editor, button, create, setTitle, keyOnTitle, say, closed: () => closed, unmount };
}

test("Create mid-recording waits for the last words and creates the task with them", async () => {
  const m = await mountModal();
  await m.setTitle("Fix login");
  await act(async () => { m.button("Dictate")!.click(); });
  await flush();
  await m.say((e) => e.onPartial("the redirect"));
  expect(m.editor().getText()).toBe("the redirect");
  await act(async () => { m.create().click(); });
  await flush();
  expect(finishing).toBe(true);
  expect(created).toEqual([]);
  await m.say((e) => e.onUtterance({ text: "the redirect loop." }));
  await act(async () => { endFinish!(); });
  await flush();
  expect(created.length).toBe(1);
  expect(created[0]).toMatchObject({ title: "Fix login", description: "the redirect loop." });
  await m.unmount();
});

test("Create right after typing sends what the editor shows, not its lagging save", async () => {
  const m = await mountModal();
  await m.setTitle("Fix login");
  await act(async () => { m.editor().commands.insertContent("typed just now"); });
  await act(async () => { m.create().click(); });
  await flush();
  expect(created.length).toBe(1);
  expect(created[0].description).toBe("typed just now");
  await m.unmount();
});

test("from the title: Cmd+Enter finishes the recording and creates; Esc cancels it and keeps the dialog", async () => {
  const m = await mountModal();
  await m.setTitle("Fix login");
  await act(async () => { m.button("Dictate")!.click(); });
  await flush();
  await m.say((e) => e.onPartial("scratch that"));
  await m.keyOnTitle("Escape");
  expect(m.closed()).toBe(0);
  expect(m.editor().getText()).toBe("");
  expect(m.button("Dictate")).not.toBeNull();

  await act(async () => { m.button("Dictate")!.click(); });
  await flush();
  await m.say((e) => e.onPartial("keep this"));
  await m.keyOnTitle("Enter", { metaKey: true });
  expect(finishing).toBe(true);
  expect(created).toEqual([]);
  await act(async () => { endFinish!(); });
  await flush();
  expect(created.length).toBe(1);
  expect(created[0].description).toBe("keep this");
  await m.unmount();
});

test("Create pressed twice while finishing makes one task", async () => {
  const m = await mountModal();
  await m.setTitle("Fix login");
  await act(async () => { m.button("Dictate")!.click(); });
  await flush();
  await m.say((e) => e.onPartial("the redirect loops"));
  await act(async () => { m.create().click(); });
  await m.keyOnTitle("Enter", { metaKey: true });
  await act(async () => { m.create().click(); });
  await flush();
  await act(async () => { endFinish!(); });
  await flush();
  await flush();
  expect(created.length).toBe(1);
  expect(created[0].description).toBe("the redirect loops");
  await m.unmount();
});

test("closing the dialog while finishing creates nothing", async () => {
  const m = await mountModal();
  await m.setTitle("Fix login");
  await act(async () => { m.button("Dictate")!.click(); });
  await flush();
  await m.say((e) => e.onPartial("never mind"));
  await act(async () => { m.create().click(); });
  await flush();
  expect(finishing).toBe(true);
  // The parent unmounts the dialog on close; the pipe closes with it.
  await m.unmount();
  await new Promise((r) => setTimeout(r, 20));
  expect(created).toEqual([]);
});

test("Create then Esc while finishing creates nothing and keeps the dialog", async () => {
  const m = await mountModal();
  await m.setTitle("Fix login");
  await act(async () => { m.button("Dictate")!.click(); });
  await flush();
  await m.say((e) => e.onPartial("scratch that"));
  await act(async () => { m.create().click(); });
  await flush();
  await m.keyOnTitle("Escape");
  await flush();
  expect(created).toEqual([]);
  expect(m.closed()).toBe(0);
  expect(m.editor().getText()).toBe("");
  await m.unmount();
});

test("the language menu opens above the dialog, and Esc on it closes the menu, not the dialog", async () => {
  const m = await mountModal();
  const caret = m.button("Dictation settings")!;
  await act(async () => {
    caret.dispatchEvent(new w.PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
  });
  await flush();
  const menu = () => w.document.querySelector('[role="menu"]') as HTMLElement | null;
  expect(menu()).not.toBeNull();
  // Portalled to the body: it must stack above the dialog's z-[10001] overlay.
  expect(menu()!.className).toContain("z-[10002]");
  const item = menu()!.querySelector('[role="menuitemcheckbox"]') as HTMLElement;
  await act(async () => {
    item.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await flush();
  expect(menu()).toBeNull();
  expect(m.closed()).toBe(0);
  // A second Esc, with no menu open, closes the dialog as before.
  await m.keyOnTitle("Escape");
  expect(m.closed()).toBe(1);
  await m.unmount();
});

test("Esc and Enter in a picker's search are the picker's: the recording keeps going", async () => {
  const m = await mountModal();
  await m.setTitle("Fix login");
  await act(async () => { m.button("Dictate")!.click(); });
  await flush();
  await m.say((e) => e.onPartial("the redirect"));
  const chip = (label: string) => [...m.container.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;
  const search = (placeholder: string) => m.container.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null;
  const press = async (el: HTMLElement, key: string, init: Record<string, unknown> = {}) => {
    await act(async () => { el.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
    await flush();
  };

  await act(async () => { chip("Assignee").click(); });
  await flush();
  expect(search("Search people and agents")).not.toBeNull();
  await press(search("Search people and agents")!, "Escape");
  expect(search("Search people and agents")).toBeNull();
  expect(m.button("Finish dictation")).not.toBeNull();
  expect(m.editor().getText()).toBe("the redirect");

  await act(async () => { chip("Labels").click(); });
  await flush();
  const labelSearch = search("Search or create a label")!;
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(labelSearch, "urgent");
  const propsKey = Object.keys(labelSearch).find((k) => k.startsWith("__reactProps"))!;
  await act(async () => { (labelSearch as any)[propsKey].onChange({ target: labelSearch, currentTarget: labelSearch }); });
  await press(labelSearch, "Enter");
  expect(chip("urgent")).toBeTruthy();
  expect(finishing).toBe(false);
  expect(created).toEqual([]);
  expect(m.button("Finish dictation")).not.toBeNull();

  // Back in the description, Esc is the recording's again.
  await press(m.container.querySelector(".ProseMirror") as HTMLElement, "Escape");
  expect(m.button("Dictate")).not.toBeNull();
  expect(m.editor().getText()).toBe("");
  await m.unmount();
});
