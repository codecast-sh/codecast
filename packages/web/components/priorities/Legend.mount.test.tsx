// The priorities legend (components/priorities/Legend), mounted in jsdom.
// Proves: it names the marks an open milestone draws with the same parts
// (parts DeployMark, UnknownTaskMark), the failed and not-yet-live deploys
// and a task not loaded yet included; and its close X presses 44px under a
// coarse pointer.
// Run: cd packages/web && bun test --isolate components/priorities/Legend.mount.test.tsx
import { expect, test } from "bun:test";
import { installDom } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/priorities");
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;

const React = await import("react");
const { act } = React as any;
const { Legend } = await import("./Legend");

const open = async () => {
  const page = await mountSurface(<Legend />);
  await act(async () => { (page.container.querySelector("[data-legend]") as HTMLElement).click(); });
  return page;
};
const row = (word: string) => document.querySelector(`[data-legend-row="${word}"]`) as HTMLElement;

test("the legend shows every deploy state and a task not loaded yet, drawn as an open milestone draws them", async () => {
  const page = await open();
  try {
    // Each state its own shape, so grayscale tells them apart: a plain rocket, the sessions' error mark, a dashed rocket.
    const live = row("Deploy, live").querySelector('[data-deploy-mark="live"]')!;
    expect(live.tagName.toLowerCase()).toBe("svg");
    expect(live.getAttribute("stroke-dasharray")).toBeNull();
    expect(live.getAttribute("class")).toContain("text-sol-green");
    expect(row("Deploy, failed").querySelector('[data-deploy-mark="failed"] [data-status-mark="error"]')).not.toBeNull();
    const pending = row("Deploy, not live yet").querySelector('[data-deploy-mark="pending"]')!;
    expect(pending.getAttribute("stroke-dasharray")).toBe("3 2");
    expect(pending.getAttribute("class")).toContain("text-sol-text-dim");
    const dot = row("Not loaded yet").querySelector('[data-task-status="unknown"]')!;
    expect(dot.className).toContain("rounded-full");
  } finally {
    await page.unmount();
  }
}, 30_000);

test("the legend shows Needs you both ways: the bordered milestone action, and a session row's bare mark", async () => {
  const page = await open();
  try {
    // The milestone's action is bordered; the session row's is the inbox mark alone, as an opened milestone draws it.
    expect(row("Needs you").querySelector("[data-status-mark]")!.closest("span.border")).not.toBeNull();
    const bare = row("Needs you (session)").querySelector('[data-status-mark="needs_you"]')!;
    expect(bare).not.toBeNull();
    expect(bare.closest("span.border")).toBeNull();
  } finally {
    await page.unmount();
  }
}, 30_000);

test("the legend's close X presses 44px under a coarse pointer: an 8px area around it", async () => {
  const page = await open();
  try {
    const dialog = document.querySelector('[role="dialog"]')!;
    // The close is the dialog's own last child; the dialog gives it its press area.
    const close = dialog.lastElementChild!;
    expect(close.tagName).toBe("BUTTON");
    expect(close.textContent).toContain("Close");
    for (const cls of ["[@media(pointer:coarse)]:[&>button:last-child]:after:absolute", "[@media(pointer:coarse)]:[&>button:last-child]:after:-inset-2", "[@media(pointer:coarse)]:[&>button:last-child]:after:content-['']"]) {
      expect(dialog.className).toContain(cls);
    }
  } finally {
    await page.unmount();
  }
}, 30_000);
