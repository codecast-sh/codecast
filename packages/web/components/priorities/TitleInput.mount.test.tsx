// Renaming a title in place (components/priorities/controls
// MilestoneTitleInput: milestones, and the priority's title on the list and
// its page), mounted in jsdom. Proves: Enter saves and Escape cancels; a blur
// saves only when the person left on purpose, by a press outside the box or
// Tab; a bare blur (an extension that swallows Escape, a window switch)
// cancels. On the list a bare blur leaves a priority's and a milestone's
// title as they were, sends nothing, and gives focus back to the title (a
// milestone's: its row).
// Run: cd packages/web && bun test --isolate components/priorities/TitleInput.mount.test.tsx
import { expect, test } from "bun:test";
import { installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/priorities");
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { act } = React as any;
const { MilestoneTitleInput } = await import("./controls");
const { useInboxStore } = await import("../../store/inboxStore");
const { ROWS, block, mount, view } = await import("../../test-helpers/prioritiesList");

const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: k, bubbles: true })); });
const pressOutside = () => act(async () => { document.body.dispatchEvent(new (window as any).Event("pointerdown", { bubbles: true })); });
const blur = (el: HTMLInputElement) => act(async () => { el.blur(); });
const typed = (el: HTMLInputElement, text: string) => act(async () => { el.value = text; });

/** One rename from mount to its end; returns what it handed back. */
async function rename(end: (input: HTMLInputElement) => Promise<void>) {
  const got: Array<string | null> = [];
  const page = await mountSurface(<MilestoneTitleInput title="Old title" onDone={(t) => got.push(t)} />);
  try {
    const input = page.container.querySelector("[data-rename-input]") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await typed(input, "New title");
    await end(input);
    return got;
  } finally {
    await page.unmount();
  }
}

test("Enter saves and Escape cancels", async () => {
  expect(await rename((i) => key(i, "Enter"))).toEqual(["New title"]);
  expect(await rename((i) => key(i, "Escape"))).toEqual([null]);
}, 30_000);

test("a blur after a press outside the box saves; a blur after Tab saves", async () => {
  expect(await rename(async (i) => { await pressOutside(); await blur(i); })).toEqual(["New title"]);
  expect(await rename(async (i) => { await key(i, "Tab"); await blur(i); })).toEqual(["New title"]);
}, 30_000);

test("a bare blur (no press, no key: an extension ate Escape, the window lost focus) cancels", async () => {
  expect(await rename((i) => blur(i))).toEqual([null]);
  // A press outside that kept the focus here, then more typing: still editing, so a later bare blur cancels.
  expect(await rename(async (i) => { await pressOutside(); await key(i, "s"); await blur(i); })).toEqual([null]);
  // A press inside the box is no leaving.
  expect(await rename(async (i) => { await act(async () => { i.dispatchEvent(new (window as any).Event("pointerdown", { bubbles: true })); }); await blur(i); })).toEqual([null]);
}, 30_000);

test("on the list, a bare blur leaves the priority's and a milestone's title as they were and sends nothing", async () => {
  useInboxStore.getState().syncTable("priorities", ROWS as any);
  const sent: string[] = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string) => { sent.push(action); return null; });
  const page = await mount(view({ rows: Object.values(useInboxStore.getState().priorities) }));
  try {
    const b = block(page.container, "pri-3");
    const title = b.querySelector("[data-priority-title]")!;
    const before = title.textContent;
    await act(async () => { title.dispatchEvent(new (window as any).MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })); });
    let input = b.querySelector('[data-rename-input][aria-label="Priority title"]') as HTMLInputElement;
    await typed(input, "Abandoned");
    await blur(input);
    expect(b.querySelector("[data-rename-input]")).toBeNull();
    expect(b.querySelector("[data-priority-title]")!.textContent).toBe(before);
    // Focus goes back to the title, as Escape's does, never to the page.
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(document.activeElement).toBe(b.querySelector("[data-priority-title]"));
    const ms = b.querySelector('[data-milestone="s1"] [data-milestone-title]')!;
    const msBefore = ms.textContent;
    await act(async () => { ms.dispatchEvent(new (window as any).MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })); });
    input = b.querySelector('[data-milestone="s1"] [data-rename-input]') as HTMLInputElement;
    await typed(input, "Abandoned too");
    await blur(input);
    expect(b.querySelector('[data-milestone="s1"] [data-milestone-title]')!.textContent).toBe(msBefore);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(document.activeElement).toBe(b.querySelector('[data-milestone="s1"] [role=button]'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(sent.filter((a) => a === "renamePriorityTitle" || a === "renamePriorityStep")).toEqual([]);
  } finally {
    await page.unmount();
    (useInboxStore.getState() as any)._clearRuntimeBindings?.();
    useInboxStore.getState().syncTable("priorities", ROWS as any);
  }
}, 60_000);
