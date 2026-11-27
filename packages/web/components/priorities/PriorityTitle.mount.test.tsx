// The priority's title on /priorities (components/priorities/PriorityBlock
// PriorityTitleLink, PriorityTitleInput), mounted in jsdom over the list's
// fixtures (test-helpers/prioritiesList.tsx). Proves: the owner double-clicks
// it to rename in place (Enter saves through renamePriorityTitle, Escape takes
// it back); it stays a real link, a single click opening the page after the
// double-click window (on a fake clock) and a modified click, Enter or a tap
// at once; a slow double-click still renames; and Rename sits in the ⋯ for a
// touch screen only.
// Run: cd packages/web && bun test --isolate components/priorities/PriorityTitle.mount.test.tsx
import { expect, jest, test } from "bun:test";
import { installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
// Radix's focus scope walks the popover with a TreeWalker.
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { useLocation } = await import("react-router");
const { useInboxStore } = await import("../../store/inboxStore");
const { ROWS, block, mount, view } = await import("../../test-helpers/prioritiesList");

/** The router's path, read after each step: a click on a title that navigated moves it. */
let at = "";
function Where() {
  at = useLocation().pathname;
  return null;
}
const titleOf = (el: HTMLElement, id: string) => block(el, id).querySelector("[data-priority-title]") as HTMLElement;
const titleInput = (el: HTMLElement, id: string) => block(el, id).querySelector('[data-rename-input][aria-label="Priority title"]') as HTMLInputElement | null;
/** A pointer click with its click count, as a browser sends it (`detail`), plus any modifier. */
const click = (el: Element, init: Record<string, unknown> = {}) => {
  const e = new (window as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
  el.dispatchEvent(e);
  return e as MouseEvent;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * The title's click delay on a fake clock: `run` steps with timers frozen and
 * `advance` moves them by exactly `ms`, so no assertion hangs on how long the
 * machine took between two clicks.
 */
async function onFakeClock(run: (advance: (ms: number) => Promise<void>) => Promise<void>) {
  const { act } = React as any;
  jest.useFakeTimers();
  try {
    await run((ms) => act(async () => { jest.advanceTimersByTime(ms); }));
  } finally {
    jest.useRealTimers();
  }
}
/** A touch pointerdown: jsdom may have no PointerEvent, so a pointerdown event carrying the pointer type stands in. */
const touchDown = () => {
  const PE = (window as any).PointerEvent;
  if (PE) return new PE("pointerdown", { bubbles: true, pointerType: "touch" }) as Event;
  return Object.assign(new (window as any).MouseEvent("pointerdown", { bubbles: true }), { pointerType: "touch" }) as Event;
};

test("a double-click on the priority's title renames it in place: Enter saves through renamePriorityTitle, Escape takes it back", async () => {
  useInboxStore.getState().syncTable("priorities", ROWS as any);
  const sent: Array<[string, unknown[]]> = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: unknown[]) => { sent.push([action, args]); return null; });
  const page = await mount(<>{view({ rows: Object.values(useInboxStore.getState().priorities) })}<Where /></>);
  const { act } = React as any;
  const dbl = (el: Element) => act(async () => {
    click(el, { detail: 1 });
    click(el, { detail: 2 });
    el.dispatchEvent(new (window as any).MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
  });
  try {
    const before = titleOf(page.container, "pri-3").textContent;
    await onFakeClock(async (advance) => {
      await dbl(titleOf(page.container, "pri-3"));
      // The double-click never navigated, even past the single click's wait.
      await advance(1000);
      expect(at).toBe("/priorities");
    });
    const input = titleInput(page.container, "pri-3")!;
    expect(input).not.toBeNull();
    expect(input.value).toBe(before!);
    // Escape takes it back: the title as it was, nothing sent.
    await act(async () => {
      input.value = "Something else";
      input.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(titleInput(page.container, "pri-3")).toBeNull();
    expect(titleOf(page.container, "pri-3").textContent).toBe(before!);
    expect(sent.filter(([a]) => a === "renamePriorityTitle")).toEqual([]);
    // Enter saves: the store row paints at once and the rename rides dispatch.
    await dbl(titleOf(page.container, "pri-3"));
    await act(async () => {
      const box = titleInput(page.container, "pri-3")!;
      box.value = "Cut eval spend in half";
      box.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(titleInput(page.container, "pri-3")).toBeNull();
    const stored = (Object.values(useInboxStore.getState().priorities) as any[]).find((r) => r.short_id === "pri-3");
    expect(stored.title).toBe("Cut eval spend in half");
    for (let i = 0; i < 200 && !sent.some(([a]) => a === "renamePriorityTitle"); i++) await act(async () => { await wait(10); });
    expect(sent.filter(([a]) => a === "renamePriorityTitle").map(([, args]) => args)).toEqual([["pri-3", "Cut eval spend in half"]]);
  } finally {
    await page.unmount();
    (useInboxStore.getState() as any)._clearRuntimeBindings?.();
    useInboxStore.getState().syncTable("priorities", ROWS as any);
  }
}, 60_000);

test("the priority's title stays a link: a single click opens its page after a beat; a modified click or Enter opens it at once", async () => {
  const page = await mount(<>{view()}<Where /></>);
  const { act } = React as any;
  try {
    const title = titleOf(page.container, "pri-2");
    expect(title.tagName).toBe("A");
    expect(title.getAttribute("href")).toBe("/priorities/pri-2");
    // A single click waits for a second one, then navigates: still waiting at 399ms, gone at 400ms.
    await onFakeClock(async (advance) => {
      let e!: MouseEvent;
      await act(async () => { e = click(title); });
      expect(e.defaultPrevented).toBe(true);
      expect(at).toBe("/priorities");
      await advance(399);
      expect(at).toBe("/priorities");
      await advance(1);
      expect(at).toBe("/priorities/pri-2");
    });
  } finally {
    await page.unmount();
  }
  // Keyboard Enter on a link is a click with no pointer count: it navigates at once.
  const keyboard = await mount(<>{view()}<Where /></>);
  try {
    await act(async () => { click(titleOf(keyboard.container, "pri-2"), { detail: 0 }); });
    expect(at).toBe("/priorities/pri-2");
  } finally {
    await keyboard.unmount();
  }
  // A cmd/ctrl click is the browser's (a new tab): nothing here holds it back or moves this page.
  const modified = await mount(<>{view()}<Where /></>);
  try {
    await onFakeClock(async (advance) => {
      for (const mod of ["metaKey", "ctrlKey"]) {
        let e!: MouseEvent;
        await act(async () => { e = click(titleOf(modified.container, "pri-2"), { [mod]: true }); });
        expect(e.defaultPrevented).toBe(false);
        await advance(1000);
        expect(at).toBe("/priorities");
        expect(titleInput(modified.container, "pri-2")).toBeNull();
      }
    });
  } finally {
    await modified.unmount();
  }
}, 60_000);

test("a slow double-click (clicks 320ms apart) still renames and never navigates; a tap opens the page at once", async () => {
  const page = await mount(<>{view()}<Where /></>);
  const { act } = React as any;
  try {
    const title = titleOf(page.container, "pri-2");
    await onFakeClock(async (advance) => {
      await act(async () => { click(title, { detail: 1 }); });
      await advance(320);
      expect(at).toBe("/priorities");
      await act(async () => {
        click(title, { detail: 2 });
        title.dispatchEvent(new (window as any).MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
      });
      expect(titleInput(page.container, "pri-2")).not.toBeNull();
      await advance(1000);
      expect(at).toBe("/priorities");
    });
  } finally {
    await page.unmount();
  }
  // Touch renames through the ⋯, so a tap is a plain link: no wait.
  const tapped = await mount(<>{view()}<Where /></>);
  try {
    const title = titleOf(tapped.container, "pri-2");
    await act(async () => {
      title.dispatchEvent(touchDown());
      click(title, { detail: 1 });
    });
    expect(at).toBe("/priorities/pri-2");
  } finally {
    await tapped.unmount();
  }
}, 60_000);

test("Rename sits in the priority's ⋯ for a touch screen only, and opens the title in place", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    const menu = block(page.container, "pri-2").querySelector('[data-priority-menu="pri-2"]')!;
    await act(async () => { menu.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    const rename = document.querySelector('[role="menuitem"][data-act="rename"]') as HTMLElement;
    expect(rename.className).toContain("[@media(pointer:fine)]:hidden");
    await act(async () => { rename.click(); await wait(20); });
    expect(titleInput(page.container, "pri-2")).not.toBeNull();
    expect(document.activeElement).toBe(titleInput(page.container, "pri-2"));
  } finally {
    await page.unmount();
  }
}, 60_000);
